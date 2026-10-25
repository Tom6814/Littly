/**
 * 到期预约消息（旧 bot/scheduler.ts 的移植基线）。
 *
 * 流程：due 扫描 → gate（promise 永远放行；proactive 过三道闸）→ hub.runTurn 生成
 * 并按 scheduled.channel 投递（拟人化分条在 hub 内完成）→ 状态落库 + 审计。
 *
 * 履约等级语义（与旧 strictness 对齐）：
 * - 1 严格：模型被指示必须直接发出（不允许改期/失约工具）。
 * - 2 中等：可改期 1~5 分钟（schedule_message 重新登记 + cancel_schedule 本条）。
 * - 3 宽松：可改期 1~30 分钟，可失约（remember 记 thought + cancel_schedule）。
 * 改期/失约经 runTurn 的工具循环落地，最终回复保持为空 → 不落库不投递（hub 沉默语义）。
 */
import type { LittlyStorage, BotRow, ScheduledMessageRow } from '@littly/storage'
import type { ChatResponse } from '@littly/agents'
import { audit } from './audit.ts'
import { shanghaiDateStr, shanghaiDayStartIso } from './time.ts'
import type { SchedulerDeps } from './types.ts'

export interface TickFiredMessage {
  id: string
  botId: string
  sender: string
  origin: string
  status: 'sent' | 'failed' | 'cancelled'
  failReason: string
}

const DUE_TAKE = 20

export async function processScheduledMessages(deps: SchedulerDeps, now: Date): Promise<TickFiredMessage[]> {
  // tickStart 用于识别本回合内模型经 schedule_message 重新登记的新预约
  const tickStartIso = new Date(now.getTime() - 1000).toISOString()
  const due = deps.storage
    .prepare("SELECT * FROM scheduled_messages WHERE status = 'pending' AND fire_at <= ? ORDER BY fire_at ASC LIMIT ?")
    .all(now.toISOString(), DUE_TAKE) as ScheduledMessageRow[]
  const fired: TickFiredMessage[] = []
  for (const sm of due) {
    fired.push(await processOne(deps, sm, now, tickStartIso))
  }
  return fired
}

// --- gate（§8.4，proactive 三道闸） ---

function gateProactive(deps: SchedulerDeps, bot: BotRow, sm: ScheduledMessageRow, now: Date): string | null {
  if (!bot.proactive_enabled) return '主动消息总开关已关闭'
  // 每日上限：当日（Asia/Shanghai）已履约的 proactive 数（旧语义按 sentAt 计数）
  const dayStartIso = shanghaiDayStartIso(shanghaiDateStr(now))
  const todayRow = deps.storage
    .prepare(
      "SELECT COUNT(*) AS c FROM scheduled_messages WHERE bot_id = ? AND sender = ? AND origin = 'proactive' AND status = 'sent' AND fired_at IS NOT NULL AND fired_at >= ?",
    )
    .get(bot.id, sm.sender, dayStartIso) as { c: number }
  if (todayRow.c >= bot.proactive_daily_limit) {
    return `今日主动消息已达上限（${bot.proactive_daily_limit} 条）`
  }
  // 最小间隔
  const last = deps.storage
    .prepare(
      "SELECT fired_at FROM scheduled_messages WHERE bot_id = ? AND sender = ? AND origin = 'proactive' AND status = 'sent' AND fired_at IS NOT NULL ORDER BY fired_at DESC LIMIT 1",
    )
    .get(bot.id, sm.sender) as { fired_at: string } | undefined
  if (last) {
    const elapsedSec = (now.getTime() - new Date(last.fired_at).getTime()) / 1000
    if (elapsedSec < bot.proactive_min_interval) {
      const wait = Math.ceil(bot.proactive_min_interval - elapsedSec)
      return `距上一条主动消息不足最小间隔，还需 ${wait}s`
    }
  }
  return null
}

// --- 履约等级 ---

function clampStrictness(v: number): number {
  const n = Math.round(v)
  if (!Number.isFinite(n)) return 1
  return Math.max(1, Math.min(3, n))
}

function strictnessInstruction(strictness: number): string {
  if (strictness === 1) {
    return '履约等级 1-严格：这条约定必须履约，准时发出，没有迟到或失约的选项。即便你此刻有点不想发，消息也必须到（可以带上真实的小情绪，但人要出现）。直接输出要发给 TA 的话，禁止调用 cancel_schedule / schedule_message。'
  }
  if (strictness === 2) {
    return '履约等级 2-中等：可以迟到几分钟（1~5 分钟内发出都正常），但失约不是本等级的选项。若决定延后：先调用 schedule_message 工具按同样的 prompt/origin/strictness 重新登记一个 fireAt 在 60~300 秒后的新预约，再调用 cancel_schedule 工具取消本条预约，然后保持回复为空。若决定现在发：直接输出要发给 TA 的话，不要调用任何工具。'
  }
  return '履约等级 3-宽松：迟到（先 schedule_message 重新登记 1~30 分钟内的新预约，再 cancel_schedule 取消本条）和失约（先调用 remember 工具记一条 category=thought 的心里话，再调用 cancel_schedule 取消本条）都是完全正常的选择，请按你的性格、习惯、记忆和当下情绪诚实决定——不要为了显得可靠而硬发，也不要为了显得随意而硬鸽。延后或失约时最后保持回复为空。若决定现在发：直接输出要发给 TA 的话，不要调用任何工具。'
}

// --- 状态落库 ---

function markStatus(
  storage: LittlyStorage,
  id: string,
  status: 'sent' | 'failed' | 'cancelled',
  reason: string,
  firedAt: string | null,
): void {
  if (status === 'sent') {
    storage
      .prepare("UPDATE scheduled_messages SET status = 'sent', failure_reason = '', fired_at = ? WHERE id = ?")
      .run(firedAt ?? new Date().toISOString(), id)
    return
  }
  if (status === 'cancelled') {
    storage
      .prepare("UPDATE scheduled_messages SET status = 'cancelled', failure_reason = ? WHERE id = ? AND status = 'pending'")
      .run(reason, id)
    return
  }
  storage
    .prepare("UPDATE scheduled_messages SET status = 'failed', failure_reason = ? WHERE id = ? AND status = 'pending'")
    .run(reason, id)
}

// --- 单条处理 ---

async function processOne(deps: SchedulerDeps, sm: ScheduledMessageRow, now: Date, tickStartIso: string): Promise<TickFiredMessage> {
  const base: TickFiredMessage = { id: sm.id, botId: sm.bot_id, sender: sm.sender, origin: sm.origin, status: 'sent', failReason: '' }
  const bot = deps.storage.prepare('SELECT * FROM bots WHERE id = ?').get(sm.bot_id) as BotRow | undefined
  if (!bot) {
    markStatus(deps.storage, sm.id, 'failed', 'bot 不存在', null)
    return { ...base, status: 'failed', failReason: 'bot 不存在' }
  }

  // gate — promise（用户亲口约定）永远放行；proactive 过三道闸
  if (sm.origin !== 'promise') {
    const rejection = gateProactive(deps, bot, sm, now)
    if (rejection) {
      markStatus(deps.storage, sm.id, 'cancelled', rejection, null)
      audit(deps, sm.bot_id, 'proactive_gate', 'cancel', `sender=${sm.sender} id=${sm.id} reason=${rejection}`)
      return { ...base, status: 'cancelled', failReason: rejection }
    }
  }

  // 生成 + 投递：完整对话回合；渠道由 scheduled.channel 决定（web=仅站内可见）
  const strictness = clampStrictness(sm.strictness)
  const channel = sm.channel || 'web'
  const text = [
    sm.prompt,
    '【系统触发：你之前登记的一条预约到点了】',
    `本条预约 id：${sm.id}`,
    strictnessInstruction(strictness),
    '表达要求像真人：句尾不加句号、可以拆几条短句换行、口语化；不要重复最近说过的话；不要出现「预约」「系统」之类的字眼。',
  ].join('\n')

  let response: ChatResponse
  try {
    response = await deps.hub.runTurn({ botId: sm.bot_id, sender: sm.sender, text, channelId: channel })
  } catch (err) {
    const reason = `生成失败：${String(err).slice(0, 200)}`
    markStatus(deps.storage, sm.id, 'failed', reason, null)
    audit(deps, sm.bot_id, 'scheduled_fire', 'fail', `sender=${sm.sender} id=${sm.id} ${reason}`)
    return { ...base, status: 'failed', failReason: reason }
  }

  // 履约判定：模型按指示用工具自行改期/失约（cancel_schedule 生效）或直接发出
  const rowNow = deps.storage
    .prepare('SELECT status FROM scheduled_messages WHERE id = ?')
    .get(sm.id) as { status: string } | undefined
  if (rowNow?.status === 'cancelled') {
    const rescheduled = deps.storage
      .prepare(
        "SELECT id, fire_at FROM scheduled_messages WHERE bot_id = ? AND sender = ? AND prompt = ? AND status = 'pending' AND created_at >= ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(sm.bot_id, sm.sender, sm.prompt, tickStartIso) as { id: string; fire_at: string } | undefined
    if (rescheduled) {
      audit(deps, sm.bot_id, 'scheduled_fire', 'delay', `sender=${sm.sender} id=${sm.id} rescheduled to ${rescheduled.id} @ ${rescheduled.fire_at}`)
      return { ...base, status: 'cancelled', failReason: `迟到了，重排至 ${rescheduled.fire_at}` }
    }
    // 失约：模型没写 thought 记忆时兜底补一条（影响后续态度）
    const remembered = response.toolCalls.some((tc) => tc.name === 'remember')
    if (!remembered) {
      await deps.memory
        .remember(sm.bot_id, sm.sender, { category: 'thought', content: `这次没能赴约：${sm.prompt.slice(0, 100)}`, importance: 4 })
        .catch(() => {})
    }
    audit(deps, sm.bot_id, 'scheduled_fire', 'skip', `sender=${sm.sender} id=${sm.id} reason=模型决定失约`)
    return { ...base, status: 'cancelled', failReason: '失约：模型决定这次不发' }
  }

  if (!response.reply.trim()) {
    // 沉默：无法在 runTurn 之外补发投递 → 记失败（旧行为的 prompt 兜底需二次投递，暂不支持）
    const reason = 'AI 未生成内容'
    markStatus(deps.storage, sm.id, 'failed', reason, null)
    audit(deps, sm.bot_id, 'scheduled_fire', 'fail', `sender=${sm.sender} id=${sm.id} ${reason}`)
    return { ...base, status: 'failed', failReason: reason }
  }

  // 正常履约：runTurn 已完成站内落库 + 渠道投递（delivery_status 在消息行上）
  markStatus(deps.storage, sm.id, 'sent', '', now.toISOString())
  deps.storage.prepare('UPDATE scheduled_messages SET content = ? WHERE id = ?').run(response.reply, sm.id)
  audit(deps, sm.bot_id, 'scheduled_fire', 'send', `sender=${sm.sender} id=${sm.id} origin=${sm.origin} channel=${channel}`)
  return base
}
