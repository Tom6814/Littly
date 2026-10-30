/**
 * B7：QQ 官方「被动回复窗口」事件上下文。
 *
 * QQ 官方开放平台的 C2C 回复分两种：
 * - **被动回复**：带上触发本次对话的入站 `event_id`，命中 60 分钟窗口（每条事件最多 5 次）；
 * - **主动推送**：不带 event_id，每月只有 4 条配额。
 *
 * 修复前的 bug：只有「绑定结果」那一条回复带了 event_id（入站函数里直接传），
 * 真正的主链路（hub 缓冲合并后调用 channel.sendText）完全拿不到上下文 ——
 * 于是每条 AI 回复都被当成主动推送，4 条/月用光就再也发不出去。
 *
 * 修复：按 (botId, openid) 记录最近一次入站 event_id（TTL 60 分钟），
 * 出站 sendText 时自动取出来带上。绑定回复仍显式携带（优先级更高，语义相同）。
 */

/** 被动回复窗口 = 60 分钟（QQ 官方文档）。 */
export const QQ_EVENT_TTL_MS = 60 * 60 * 1000

/** 内存里最多保留的上下文条数（防泄漏；按写入时间淘汰最旧）。 */
const MAX_ENTRIES = 2000

interface EventContext {
  eventId: string
  at: number
}

const contexts = new Map<string, EventContext>()

function keyOf(botId: string, openid: string): string {
  return `${botId}\u0000${openid}`
}

/**
 * 记录一次入站事件的 event_id（同一 (bot,openid) 覆盖为最新）。
 * @param botId - bot 行 id
 * @param openid - 对方 user_openid
 * @param eventId - 入站事件 id；缺省时忽略（无被动窗口可用）
 * @param now - 当前时间（测试可注入）
 */
export function rememberQqEvent(botId: string, openid: string, eventId: string | undefined, now: number = Date.now()): void {
  if (botId === '' || openid === '' || eventId === undefined || eventId === '') return
  contexts.set(keyOf(botId, openid), { eventId, at: now })
  if (contexts.size <= MAX_ENTRIES) return
  // 简单淘汰：先删过期项，仍超限则删最早写入的
  for (const [key, value] of contexts) {
    if (now - value.at > QQ_EVENT_TTL_MS) contexts.delete(key)
  }
  while (contexts.size > MAX_ENTRIES) {
    const oldest = contexts.keys().next()
    if (oldest.done === true) break
    contexts.delete(oldest.value)
  }
}

/**
 * 取最近一次入站 event_id（TTL 内有效）。
 * @param botId - bot 行 id
 * @param openid - 对方 user_openid
 * @param now - 当前时间（测试可注入）
 * @returns 有效 event_id；缺失/过期返回 undefined（退化为主动推送）
 */
export function recallQqEvent(botId: string, openid: string, now: number = Date.now()): string | undefined {
  const key = keyOf(botId, openid)
  const found = contexts.get(key)
  if (found === undefined) return undefined
  if (now - found.at > QQ_EVENT_TTL_MS) {
    contexts.delete(key)
    return undefined
  }
  return found.eventId
}

/** 清空上下文（测试隔离用）。 */
export function clearQqEvents(): void {
  contexts.clear()
}
