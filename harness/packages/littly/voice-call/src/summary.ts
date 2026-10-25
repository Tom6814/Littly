// 通话结束后的「回响」——AI 根据本次通话提炼：
//   1. 值得记住的 → 写入记忆（Memory，去重）
//   2. 可能要做的事 → 预约提醒（ScheduledMessage，origin=promise）
// 设计要点：通话中为了「快」不跑工具（关思考、无工具），所以记忆/待办
// 不靠工具循环，而是在通话结束后由这一次轻量总结统一落库。任何失败静默降级。
//
// 旧 monolith src/internal/voice-call/summary.ts 忠实移植；差异只有三处（均因新仓约束）：
//   - Prisma → 原生 SQL / @littly/memory 的 remember()；
//   - audit_logs.category 不允许 'call_summary'（CHECK 约束），改用
//     category='heartbeat' + action='call_summary'（语义仍是「回响」）；
//   - 时间不再依赖服务器本地时区：模型给的裸时间按 Asia/Shanghai 解释。
import { randomUUID } from 'node:crypto'
import { chatComplete, type ChatMessage } from '@littly/llm'
import type { BotRow, LittlyStorage } from '@littly/storage'
import type { LittlyMemory } from '@littly/memory'
import { extractFirstJsonObject } from './json-extract.ts'

const SUMMARY_MAX_TOKENS = 600

const SUMMARY_SYSTEM = `你是角色的心声整理系统。角色刚刚和对方通完一次语音电话。请从通话记录里提炼两样东西：
1. memories：值得记住的信息（对方说的话、双方聊到的安排、角色对这段对话的感受、关系进展等），作为角色的长期记忆。
2. todos：接下来可能要做的事情（对方提到的约定、角色自己答应的事、下次要聊的话题、想为对方做的事等），作为待办提醒。

只输出一个 JSON 对象，不要 markdown 代码块，不要任何其它文字：
{"memories":[{"content":"记忆内容","importance":1-5}],"todos":[{"what":"待办内容","fireAt":"可选 ISO 时间（拿不准就空字符串）"}]}

要求：
- content 用第三人称中性口吻写，像角色自己的笔记；每条约 10-40 字，具体、可检索。
- importance 默认 3；关系进展、对方重要个人信息、有情感分量的 → 4-5；琐碎小事 → 1-2。
- todos 的 fireAt：如果对话里明确了时间（今晚/明天/下周等）就写对应的 ISO 时间（按北京时间），否则空字符串，系统会自动安排合适时间。
- 没有值得记的就给空数组，不要硬编。`

/** 待办钳制窗口：最早 10 分钟后，最晚 7 天后（与旧实现一致）。 */
export const TODO_MIN_DELAY_MS = 10 * 60 * 1000
export const TODO_MAX_DELAY_MS = 7 * 24 * 3600 * 1000
/** 明确时间缺失/过期时的兜底：30 分钟后（给 AI 一个自然惦记的起点）。 */
export const TODO_FALLBACK_DELAY_MS = 30 * 60 * 1000

/** 摘要所需的依赖。 */
export interface SummaryDeps {
  storage: LittlyStorage
  memory: LittlyMemory
  log: (msg: string, ...args: unknown[]) => void
}

/**
 * 解析模型给的 fireAt：
 * - 带时区（Z / ±HH:MM）→ 直接按绝对时刻；
 * - 裸时间（'2026-10-25T20:00' 之类）→ 按北京时间（Asia/Shanghai）解释
 *   （旧实现在服务器本地时区解析；新仓禁用服务器本地时区，故显式固定为北京时间）。
 */
export function parseFireAt(raw: string | undefined): number | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s) return null
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)
  let ms: number
  if (hasZone) {
    ms = new Date(s).getTime()
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    ms = new Date(`${s}T00:00:00+08:00`).getTime()
  } else {
    ms = new Date(`${s.replace(' ', 'T')}+08:00`).getTime()
  }
  return Number.isNaN(ms) ? null : ms
}

/**
 * 待办触发时间的钳制（旧 summary.ts 的钳制逻辑逐字移植）：
 * 缺失/非法/已过期 → now+30min；随后钳制到 [now+10min, now+7d]。
 * @returns 触发时刻（epoch 毫秒）
 */
export function clampFireAt(raw: string | undefined, nowMs: number): number {
  const parsed = parseFireAt(raw)
  let fireAt = parsed === null ? nowMs : parsed
  if (fireAt <= nowMs) fireAt = nowMs + TODO_FALLBACK_DELAY_MS
  const minFire = nowMs + TODO_MIN_DELAY_MS
  const maxFire = nowMs + TODO_MAX_DELAY_MS
  if (fireAt < minFire) fireAt = minFire
  if (fireAt > maxFire) fireAt = maxFire
  return fireAt
}

// 通话结束后自动触发；fire-and-forget，绝不阻塞通话关闭
export async function summarizeCall(
  deps: SummaryDeps,
  bot: BotRow,
  sender: string,
  transcript: string,
): Promise<void> {
  if (!transcript.trim()) return
  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `【本次通话记录】\n${transcript}` },
    ]
    const res = await chatComplete(deps.storage, messages, {
      model: bot.ai_model || undefined,
      temperature: 0.4,
      maxTokens: SUMMARY_MAX_TOKENS,
      retries: 1,
    })
    const j = extractFirstJsonObject(res.content)
    if (!j) return

    const botId = bot.id
    let memN = 0
    let todoN = 0

    // 记忆落库（去重：同一内容不重复写）
    if (Array.isArray(j['memories'])) {
      for (const m of j['memories'] as Array<Record<string, unknown>>) {
        const content = typeof m?.content === 'string' ? m.content.trim() : ''
        if (!content) continue
        if (await deps.memory.findDuplicateMemory(botId, sender, content)) continue
        const importance = Math.min(5, Math.max(1, Number(m?.importance) || 3))
        await deps.memory.remember(botId, sender, { category: 'fact', content, importance })
        memN++
      }
    }

    // 待办落库：明确时间用 fireAt，否则 30 分钟后（给 AI 一个自然惦记的起点）
    const nowMs = Date.now()
    if (Array.isArray(j['todos'])) {
      for (const t of j['todos'] as Array<Record<string, unknown>>) {
        const what = typeof t?.what === 'string' ? t.what.trim() : ''
        if (!what) continue
        const fireAtMs = clampFireAt(typeof t?.fireAt === 'string' ? t.fireAt : undefined, nowMs)
        deps.storage
          .prepare(
            'INSERT INTO scheduled_messages (id, bot_id, sender, fire_at, tolerance, strictness, prompt, origin, status, channel, content, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            randomUUID(),
            botId,
            sender,
            new Date(fireAtMs).toISOString(),
            null,
            2, // 中等履约：可迟到几分钟
            what,
            'promise',
            'pending',
            'web',
            '',
            new Date(nowMs).toISOString(),
          )
        todoN++
      }
    }

    // §audit_logs.category 的 CHECK 约束没有 'call_summary'；旧代码的「回响」语义
    // 归到 'heartbeat' 类别，用 action='call_summary' 保留原意。
    deps.storage
      .prepare('INSERT INTO audit_logs (id, bot_id, category, action, detail, created_at) VALUES (?,?,?,?,?,?)')
      .run(randomUUID(), botId, 'heartbeat', 'call_summary', `memories=${memN} todos=${todoN}`, new Date(nowMs).toISOString())
  } catch (e) {
    deps.log('[voice-call] summarize failed: %s', e instanceof Error ? e.message : e)
  }
}
