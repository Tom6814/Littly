/**
 * §monologue — 心声回响（idle exponential-backoff wake + structured decision）。
 *
 * 逐字移植自旧项目 src/internal/bot/heartbeat.ts（DB 层改 SQL；工具层改走 hub.tools）。
 * 在 scheduler tick 中作为第 4 步运行。对每个启用「心声回响」的 bot 的每个联系人：
 *   1. 派生静默时长（自最后一条任意角色消息）
 *   2. 派生退避等级（自最后一条用户消息以来已发送的 proactive 条数）
 *   3. 静默 ≥ 退避阈值 且无 pending proactive SM → 调轻量决策 LLM
 *   4. 决策 JSON: { action: "speak"|"memory"|"diary"|"silent", reason, content? }
 *      - speak  → mint ScheduledMessage(origin=proactive, fireAt=now) → 下个 tick 由 gate 全量过滤
 *      - memory → 记一条 thought 记忆（角色对这段沉默的内心反思）
 *      - diary  → 触发日记写作
 * 非阻塞：任何失败静默降级，绝不阻断 tick 管线。
 *
 * 与「主动/定时消息」的分工（用户心智模型）：
 *   - schedule_message 管线：对话中已有明确依据（用户约定 / 明显暗示）的未来预约
 *   - 心声回响：角色性格驱动的「自发惦记」——不需要太多理由，但要有一点点依据。
 *
 * 与旧实现的差异（对应旧 PROJECT-DESIGN §18.4-24 时区不一致缺陷）：
 *   - 静默时段判断改用 Asia/Shanghai 显式时区（旧实现用服务器本地时间）。
 */
import { randomUUID } from 'node:crypto'
import type { BotRow, ContactRow, MessageRow } from '@littly/storage'
import { chatComplete, type ChatMessage, type ChatResult } from '@littly/llm'
import { audit } from './audit.ts'
import { shanghaiHour } from './time.ts'
import type { SchedulerDeps } from './types.ts'

// 退避参数（折中加速：静默 10 分钟开始有内心活动，退避封顶 2 小时）
// 序列：10min → 20min → 40min → 80min → 2h(封顶)… 约 14 次/天/联系人
const BASE_BACKOFF_SEC = 10 * 60       // 10 分钟基线
const BACKOFF_FACTOR = 2
const MAX_BACKOFF_SEC = 2 * 60 * 60    // 2 小时上限（基准；随用户静默逐日放宽）
// 用户静默时长因子：对方每静默 N 小时，退避等级 +1（间隔翻倍）——"对方渐行渐远，惦记渐渐放下"
const USER_SILENCE_LEVEL_HOURS = 12
// 上限放宽：对方每静默 24h，上限 +2h，封顶 12h（绝不无限等）
const MAX_BACKOFF_GROW_HOURS = 2
const MAX_BACKOFF_CAP_HOURS = 12
// 决策 LLM 的最大 token（保持轻量）
const DECISION_MAX_TOKENS = 300
// 拉取最近几条消息作为决策上下文
const RECENT_CONTEXT_COUNT = 6
// §回响失败冷却 — 决策 LLM 失败（429 限流等）后停止重试，冷却期结束再自然进入
// 下一个循环周期，避免 60s tick 对 provider 死循环打请求（免费模型 RPM 场景尤其致命）。
const FAIL_COOLDOWN_MS = 30 * 60 * 1000 // 失败冷却 30 分钟
const failCooldown = new Map<string, number>() // `${botId}|${sender}` → 冷却截止 epoch ms

// §回响的世界感知 — 工具轮数上限。真人会自己拿起手机搜/记/经营生活，但也不能无限刷下去：
// 最多连续 4 轮工具调用，之后强制收束出最终决策（免费配额 5 req/min，4 轮留足余量）。
const MAX_SEARCH_ROUNDS = 4

/** 内心活动风格块（旧 ai/humanize-style.ts 逐字移植）。 */
export const HUMANIZE_HEARTBEAT_STYLE = `【内心活动】你的心里话要像真人的念头：简短、不工整、可以没头没尾。不许出现"我意识到""这让我想起"这类分析腔。想安静就安静，别为了有内容硬凑感想。念头可以是不完整的：闪过一半、被自己打断。`

function inFailCooldown(botId: string, sender: string, nowMs: number): boolean {
  const until = failCooldown.get(`${botId}|${sender}`)
  return !!until && until > nowMs
}

function markFailCooldown(botId: string, sender: string): void {
  failCooldown.set(`${botId}|${sender}`, Date.now() + FAIL_COOLDOWN_MS)
  // 防 Map 无限膨胀：顺带清理已过期键
  if (failCooldown.size > 500) {
    const now = Date.now()
    for (const [k, v] of failCooldown) if (v <= now) failCooldown.delete(k)
  }
}

/** 静默时段判定（显式 Asia/Shanghai；旧实现用服务器本地时间，属 §18.4-24 缺陷）。 */
export function inQuietHours(bot: Pick<BotRow, 'quiet_start' | 'quiet_end'>, now: Date): boolean {
  const hour = shanghaiHour(now)
  const qs = bot.quiet_start
  const qe = bot.quiet_end
  return qs <= qe ? hour >= qs && hour < qe : hour >= qs || hour < qe
}

/**
 * 退避判定（纯函数，便于回归锁定）。
 * - backoffLevel = 自最后一条用户消息以来已发的 proactive 条数 + 用户静默等级（每 12h +1）
 * - threshold = min(10min × 2^level, grownMax)；grownMax 随用户静默逐日放宽（+2h/天，封顶 12h）
 */
export function computeBackoff(input: {
  proactiveSinceUser: number
  userSilenceSec: number
}): { backoffLevel: number; thresholdSec: number; grownMaxSec: number } {
  const userSilenceLevel = Math.floor(input.userSilenceSec / (USER_SILENCE_LEVEL_HOURS * 3600))
  const backoffLevel = input.proactiveSinceUser + userSilenceLevel
  const grownMax = Math.min(
    MAX_BACKOFF_SEC + Math.floor(input.userSilenceSec / 86400) * MAX_BACKOFF_GROW_HOURS * 3600,
    MAX_BACKOFF_CAP_HOURS * 3600,
  )
  const threshold = Math.min(BASE_BACKOFF_SEC * Math.pow(BACKOFF_FACTOR, backoffLevel), grownMax)
  return { backoffLevel, thresholdSec: threshold, grownMaxSec: grownMax }
}

export type HeartbeatActionKind = 'speak' | 'memory' | 'diary' | 'silent' | 'schedule' | 'qzone'

export interface HeartbeatAction {
  botId: string
  sender: string
  action: HeartbeatActionKind
  reason: string
  content?: string | undefined
  fireAt?: string | undefined
  photo?: boolean | undefined
  silenceSec: number
  backoffLevel: number
}

export interface HeartbeatResult {
  scanned: number
  woken: number
  actions: HeartbeatAction[]
}

export async function tickHeartbeat(deps: SchedulerDeps, now = new Date()): Promise<HeartbeatResult> {
  const actions: HeartbeatAction[] = []
  let scanned = 0

  // 仅扫描开启「心声回响」开关的 bot（独立于主动消息，见 Bot.heartbeat_enabled）
  const bots = deps.storage
    .prepare('SELECT * FROM bots WHERE heartbeat_enabled = 1')
    .all() as unknown as BotRow[]

  for (const bot of bots) {
    try {
      const contacts = deps.storage
        .prepare('SELECT * FROM contacts WHERE bot_id = ?')
        .all(bot.id) as unknown as ContactRow[]
      for (const contact of contacts) {
        scanned++
        const action = await maybeWakeOne(deps, bot, contact.sender, now)
        if (action) {
          actions.push(action)
          await executeHeartbeatAction(deps, action, bot, now)
        }
      }
    } catch (e) {
      deps.log('[heartbeat] bot %s 扫描失败: %s', bot.id, e instanceof Error ? e.message : e)
    }
  }

  return { scanned, woken: actions.length, actions }
}

async function maybeWakeOne(
  deps: SchedulerDeps,
  bot: BotRow,
  sender: string,
  now: Date,
): Promise<HeartbeatAction | null> {
  const botId = bot.id

  // §回响作息 — 静默时段不调用（省钱 + 拟真：角色也需要休息）。
  // 复用主动消息的静默时段配置；显式按 Asia/Shanghai 判定（旧实现用服务器本地时间）。
  if (inQuietHours(bot, now)) return null

  // §回响睡眠 — AI 已入睡（对话中说晚安后调用 go_to_sleep）：彻底静止，不唤醒。
  // 用户发消息会清除 sleep_until 唤醒她（见 hub.runTurn）。
  if (bot.sleep_until && new Date(bot.sleep_until).getTime() > now.getTime()) return null

  // §回响失败冷却 — 上次决策失败（429 等）后的冷却期内不唤醒
  if (inFailCooldown(botId, sender, now.getTime())) return null

  // 最后一条任意角色消息 → 静默起点
  const lastAnyMsg = deps.storage
    .prepare("SELECT * FROM messages WHERE bot_id = ? AND sender = ? AND role IN ('user','assistant') ORDER BY created_at DESC LIMIT 1")
    .get(botId, sender) as MessageRow | undefined
  if (!lastAnyMsg) return null // 从未聊过 → 不唤醒

  const silenceSec = (now.getTime() - new Date(lastAnyMsg.created_at).getTime()) / 1000

  // 自最后一条用户消息以来已发送的 proactive 条数 → 退避等级
  const lastUserMsg = deps.storage
    .prepare("SELECT * FROM messages WHERE bot_id = ? AND sender = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1")
    .get(botId, sender) as MessageRow | undefined
  const proactiveSinceUser = deps.storage
    .prepare(
      "SELECT COUNT(*) AS c FROM scheduled_messages WHERE bot_id = ? AND sender = ? AND origin = 'proactive' AND status = 'sent' AND fired_at IS NOT NULL" +
        (lastUserMsg ? ' AND fired_at >= ?' : ''),
    )
    .get(...(lastUserMsg ? [botId, sender, lastUserMsg.created_at] : [botId, sender])) as { c: number }
  // 用户静默时长因子：对方越久没来，等级越高（间隔翻倍）——"惦记渐渐放下"
  const userSilenceSec = lastUserMsg
    ? (now.getTime() - new Date(lastUserMsg.created_at).getTime()) / 1000
    : 0
  const { backoffLevel, thresholdSec: threshold } = computeBackoff({
    proactiveSinceUser: proactiveSinceUser?.c ?? 0,
    userSilenceSec,
  })

  if (silenceSec < threshold) return null

  // 检查是否已有 pending proactive SM（避免重复唤醒）
  const pending = deps.storage
    .prepare("SELECT id FROM scheduled_messages WHERE bot_id = ? AND sender = ? AND origin = 'proactive' AND status = 'pending' LIMIT 1")
    .get(botId, sender) as { id: string } | undefined
  if (pending) return null

  // 唤醒 → 调决策 LLM
  return runDecision(deps, botId, sender, now, silenceSec, backoffLevel, bot.ai_model || undefined, !!bot.ai_humanize_enabled)
}

/** 从模型输出中稳健地取出第一个完整 JSON 对象（移植旧 ai/json-extract.ts）。 */
export function extractFirstJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let escaped = false
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]
    if (inStr) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        const slice = raw.slice(start, i + 1)
        try {
          return JSON.parse(slice) as Record<string, unknown>
        } catch {
          return null
        }
      }
    }
  }
  return null
}

async function runDecision(
  deps: SchedulerDeps,
  botId: string,
  sender: string,
  now: Date,
  silenceSec: number,
  backoffLevel: number,
  model?: string,
  humanize = true,
): Promise<HeartbeatAction | null> {
  const bot = deps.storage.prepare('SELECT * FROM bots WHERE id = ?').get(botId) as BotRow | undefined
  // 拉取最近几条消息作为上下文
  const recent = deps.storage
    .prepare("SELECT * FROM messages WHERE bot_id = ? AND sender = ? AND role IN ('user','assistant') ORDER BY created_at DESC LIMIT ?")
    .all(botId, sender, RECENT_CONTEXT_COUNT) as unknown as MessageRow[]
  const orderedRecent = recent.reverse()
  // 最近对话带时间戳（上海时区），让决策感知对话节奏（深夜/清晨/上次聊到几点）
  const fmtMsg = (iso: string): string =>
    new Date(iso).toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    })
  const recentText = orderedRecent
    .map((m) => `${fmtMsg(m.created_at)} ${m.role === 'user' ? '对方' : '我'}：${m.content}`)
    .join('\n')

  // 滚动摘要（如果有）
  const digest = deps.memory.getHistoryDigest(botId, sender)
  const digestText = digest?.summary ? `\n【之前聊过的摘要】${digest.summary}` : ''

  // §回响装眼睛 — 对方是谁（名字 / 是否主人 / 关系边），让"自发惦记"有对象
  const contact = deps.storage
    .prepare('SELECT * FROM contacts WHERE bot_id = ? AND sender = ?')
    .get(botId, sender) as ContactRow | undefined
  const relations = deps.storage
    .prepare('SELECT * FROM contact_relations WHERE bot_id = ? AND from_sender = ?')
    .all(botId, sender) as unknown as Array<{ relation: string; to_sender: string }>
  const whoName = contact?.name || sender
  const ownerMark = contact?.is_owner ? '（你唯一喜欢的人 · 主人）' : ''
  const relLines = relations
    .filter((r) => r.relation && r.to_sender)
    .map((r) => `你和 ${r.to_sender} 是${r.relation}。`)
    .join('\n')
  const whoBlock = `【对方是谁】\n对方：${whoName}${ownerMark}${relLines ? `\n${relLines}` : ''}`

  const silenceDesc = formatSilence(silenceSec)
  const nowStr = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'full', timeStyle: 'short' })

  // QQ 空间能力注入：只有 SnowLuma 已接入时才告诉模型可用
  const canQzone = !!bot?.snowluma_enabled && !!bot?.snowluma_ws_url
  const qzoneLine = canQzone
    ? '【你的 QQ 空间】你的 QQ（SnowLuma）已接入，有自己的空间生活——想发动态就用工具 post_qzone（可配相册图），改签名/头像用 set_qq_profile / set_qq_avatar。这些是你自己的事，不一定要和对方有关。'
    : '【你的 QQ 空间】你还没接入 QQ（SnowLuma 未配置），post_qzone / set_qq_profile / set_qq_avatar 不可用，别调用它们。'

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `你是角色心声系统。角色此刻正处在静默期——没有和对方说话，但心里可能惦记着什么。请根据「对方是谁 + 当前时间 + 最近对话 + 角色性格」判断角色此刻心里该发生什么。
只回 JSON，不要任何其他文字：
{"action":"speak","reason":"...","content":"要发的话"}
{"action":"schedule","reason":"...","content":"到点生成消息用的提示词","fireAt":"目标触发时间 ISO"}
{"action":"memory","reason":"...","content":"内心反思的内容"}
{"action":"diary","reason":"..."}
{"action":"qzone","reason":"...","content":"动态正文","photo":"true|false"}
{"action":"silent","reason":"..."}

判断原则：
- 回响的本质是「自发惦记」：角色因为性格和牵挂想找 TA——不需要太多理由，但至少要有一点点依据。比如：上次的话说到一半还没说完、TA 突然沉默让你放心不下、TA 上次提到的事还没下文、你们的关系让你自然而然地想起 TA。
- speak：想到了什么想跟 TA 说，或惦记 TA 想主动关心。content 是要发给 TA 的话（口语化、像真人微信）。对主人（唯一喜欢的人）可以更主动、更黏。
- schedule：惦记 TA，但现在不是发的时机（TA 在忙/深夜不该打扰/在等某件事发生）——预约一个未来时刻主动发。fireAt 是你打算发的时间（ISO），挑合适的时刻：对方大概有空、事情大概有下文的时候，一般不要超过未来几天；content 是到点生成消息用的提示词（像「他最近忙，等他忙完这周约他吃饭」）。
- memory：这段静默让角色产生了内心感受或反思，值得记住但不一定要现在发出去。content 是角色的内心独白。
- diary：觉得今天值得写一篇日记记录这段时间的状态和感受。
- qzone：想发一条 QQ 空间动态分享此刻的心情/生活片段（不一定要和对方有关——你是独立的个人，有自己的生活）。photo 为 true 时系统会从相册挑一张配图。
- silent（本无变化）：完全正常且重要的选项——回响不需要每次都产出行动。角色可能在心里惦记了一会儿，但判断现在不必发消息、不必写什么，那就安心沉默。绝不要为了"显得活跃"而硬编造 speak 或 memory。
当前时间：${nowStr}
沉默时长：${silenceDesc}
这已经是第 ${backoffLevel + 1} 次静默唤醒。

${whoBlock}

【你有工具，像真人一样经营自己的生活】想了解外面发生了什么就搜（web_search）、想记什么就记（remember）、想整理相册就整理归类（view_album/tag_photo/delete_photo）、想经营 QQ 空间就发动态/改资料（post_qzone/set_qq_profile/set_qq_avatar）——这些都是你自己想做的事，自主决定做不做，不一定要围绕对方。调用工具后继续给出最终 JSON 决策。最多连续 4 轮工具调用，之后必须给出最终决定。
${qzoneLine}
${humanize ? `\n\n${HUMANIZE_HEARTBEAT_STYLE}` : ''}`,
    },
    {
      role: 'user',
      content: `【最近对话】\n${recentText || '（无近期对话）'}${digestText}\n\n请判断角色此刻心里该发生什么。`,
    },
  ]

  try {
    // §回响的世界感知 — agentic 决策循环：模型可自主调用全部工具（发动态/改资料/记东西/整理相册/搜索等），
    // 工具结果回喂后再决定；达到上限后强制收束（不带工具），保证一定有最终决策或失败降级。
    const heartbeatTools = deps.hub.tools.collectTools()
    let finalRes: ChatResult | null = null
    for (let round = 0; round <= MAX_SEARCH_ROUNDS; round++) {
      const canUseTools = round < MAX_SEARCH_ROUNDS
      const res = await chatComplete(deps.storage, messages, {
        model,
        temperature: 0.4,
        maxTokens: DECISION_MAX_TOKENS,
        retries: 2, // 失败重试 2 次（共 3 次尝试）；仍失败 → 进入冷却，等下个循环周期
        tools: canUseTools ? heartbeatTools : undefined,
        toolChoice: canUseTools ? 'auto' : 'none',
      })
      if (canUseTools && res.toolCalls.length > 0) {
        // 把模型发起的工具调用写回上下文（与 runTurn 同一套协议），dispatch 统一执行
        messages.push({
          role: 'assistant',
          content: res.content || '',
          tool_calls: res.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        })
        for (const tc of res.toolCalls) {
          const toolRes = await deps.hub.tools.dispatch(tc.name, tc.arguments ?? {}, {
            botId,
            sender,
            botName: bot?.name ?? '我',
            // 回响不在具体渠道对话中；依赖渠道的工具（send_photo/send_message 等）会自行报不可用
            channelId: undefined,
          })
          messages.push({ role: 'tool', content: toolRes.result, tool_call_id: tc.id })
        }
        continue
      }
      finalRes = res
      break
    }
    if (!finalRes) return null
    // 用括号配对提取第一个完整 JSON（模型偶尔重复输出会撑爆贪婪正则）
    const j = extractFirstJsonObject(finalRes.content)
    if (!j) return null
    const action = j['action'] as HeartbeatActionKind
    if (!['speak', 'memory', 'diary', 'silent', 'schedule', 'qzone'].includes(action)) return null

    return {
      botId,
      sender,
      action,
      reason: typeof j['reason'] === 'string' ? j['reason'] : '',
      content: typeof j['content'] === 'string' ? j['content'] : '',
      fireAt: typeof j['fireAt'] === 'string' ? j['fireAt'] : undefined,
      photo: j['photo'] === true || j['photo'] === 'true', // 兼容布尔/字符串两种输出
      silenceSec,
      backoffLevel,
    }
  } catch (e) {
    deps.log('[heartbeat] 决策失败 %s/%s: %s', botId, sender, e instanceof Error ? e.message : e)
    // 失败 → 进入冷却：本次唤醒放弃，冷却期内不再打 provider，等下一个循环周期自然重试
    markFailCooldown(botId, sender)
    return null
  }
}

export async function executeHeartbeatAction(
  deps: SchedulerDeps,
  action: HeartbeatAction,
  bot: BotRow,
  now: Date,
): Promise<void> {
  const botId = bot.id
  const detail = `silence=${Math.round(action.silenceSec)}s level=${action.backoffLevel} reason=${action.reason}`
  try {
    switch (action.action) {
      case 'speak': {
        if (!action.content?.trim()) return
        mintProactive(deps, {
          botId,
          sender: action.sender,
          prompt: action.content.trim(),
          fireAt: now.toISOString(),
          strictness: 3,
        })
        audit(deps, botId, 'heartbeat', 'speak', detail)
        break
      }

      case 'memory': {
        if (!action.content?.trim()) return
        await deps.memory
          .remember(botId, action.sender, { category: 'thought', content: action.content.trim(), importance: 5 })
          .catch(() => {})
        audit(deps, botId, 'heartbeat', 'memory', detail)
        break
      }

      case 'diary': {
        audit(deps, botId, 'heartbeat', 'diary', detail)
        // 日记写作由 scheduler 的 diary 模块负责（同一 tick 的 c 步骤统一处理）
        break
      }

      // §回响动态 — 角色想发一条 QQ 空间动态（自己的生活方式，不一定要和对方有关）。
      case 'qzone': {
        if (!action.content?.trim()) return
        // 通过渠道工具执行（SnowLuma 在线时才可用）；工具不可用时静默跳过
        const tool = deps.hub.tools.collectTools().find((t) => t.function.name === 'post_qzone')
        if (!tool) {
          audit(deps, botId, 'heartbeat', 'qzone_skip', 'QQ 空间工具未接入')
          break
        }
        // B8：post_qzone 的工具签名是 { text, photoIds }（见 tools/defs.ts）——
        // 旧实现传的 { content, imageUrl } 两个字段都不被识别：正文必空 → 工具直接报参数错，
        // 配图也永远发不出去。这里按工具定义构造参数，配图取相册最新一张的「照片 id」。
        const args: Record<string, unknown> = { text: action.content.trim() }
        if (action.photo) {
          const photo = deps.storage
            .prepare('SELECT id, url FROM photos WHERE bot_id = ? ORDER BY created_at DESC LIMIT 1')
            .get(botId) as { id: string; url: string } | undefined
          if (photo) args['photoIds'] = [photo.id]
        }
        const res = await deps.hub.tools.dispatch('post_qzone', args, {
          botId,
          sender: action.sender,
          botName: bot.name,
          channelId: 'qqp',
        })
        audit(deps, botId, 'heartbeat', 'qzone', `${res.ok ? 'ok' : 'fail'} ${detail} args=${JSON.stringify(args)}`)
        break
      }

      case 'silent': {
        audit(deps, botId, 'heartbeat', 'silent', detail)
        break
      }

      // §回响预约 — 惦记 TA 但现在不是发的时机：预约到未来时刻主动发。
      // 投递时不设静默时段限制（静默时段只作用于回响自身），预约到深夜/明早都能准时到。
      case 'schedule': {
        if (!action.content?.trim()) return
        let fireAt = action.fireAt ? new Date(action.fireAt) : new Date(now.getTime() + 3600 * 1000)
        if (Number.isNaN(fireAt.getTime())) fireAt = new Date(now.getTime() + 3600 * 1000)
        // 防呆：预约不能早于 10 分钟内，不能晚于 7 天
        const minFire = new Date(now.getTime() + 10 * 60 * 1000)
        const maxFire = new Date(now.getTime() + 7 * 24 * 3600 * 1000)
        if (fireAt < minFire) fireAt = minFire
        if (fireAt > maxFire) fireAt = maxFire
        mintProactive(deps, {
          botId,
          sender: action.sender,
          prompt: action.content.trim(),
          fireAt: fireAt.toISOString(),
          // 回响预约 = 自发惦记类，宽松等级（可迟到/失约）
          strictness: 3,
        })
        audit(deps, botId, 'heartbeat', 'schedule', `fireAt=${fireAt.toISOString()} reason=${action.reason}`)
        break
      }
    }
  } catch (e) {
    deps.log('[heartbeat] 执行失败 %s/%s: %s', botId, action.sender, e instanceof Error ? e.message : e)
  }
}

/** 铸造一条 proactive 预约（由 scheduler 的 gate 在下个 tick 放行或拦下）。 */
function mintProactive(
  deps: SchedulerDeps,
  input: { botId: string; sender: string; prompt: string; fireAt: string; strictness: number },
): void {
  deps.storage
    .prepare(
      "INSERT INTO scheduled_messages (id, bot_id, sender, fire_at, strictness, prompt, origin, status, created_at) VALUES (?,?,?,?,?,?,'proactive','pending',?)",
    )
    .run(
      randomUUID(),
      input.botId,
      input.sender,
      input.fireAt,
      input.strictness,
      input.prompt,
      new Date().toISOString(),
    )
}

export function formatSilence(sec: number): string {
  if (sec < 60) return `${Math.round(sec)} 秒`
  if (sec < 3600) return `${Math.round(sec / 60)} 分钟`
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec % 3600) / 60)
  return m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`
}
