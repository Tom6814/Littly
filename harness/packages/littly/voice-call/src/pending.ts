// 来电请求暂存（内存级）：普通聊天里 AI 调用 start_call 工具时登记，
// 前端轮询端点领取后弹「来电」接听框。常驻进程内有效；进程重启自然清空
// （MVP 可接受——来电通知本身是短生命周期事件）。
//
// 旧 monolith src/internal/voice-call/pending.ts 忠实移植。
// 唯一增量：nowMs 可注入（默认 Date.now()），只为让 TTL 过期可被测试观测；
// 不传时行为与旧实现逐字一致。

export interface PendingCall {
  id: string
  botId: string
  sender: string
  reason: string // 为什么打这通电话（AI 给的）
  topic: string // 想聊的话题（AI 给的，可空）
  createdAt: number
}

export const PENDING_TTL_MS = 90 * 1000 // 90s 未接自动过期

const store = new Map<string, PendingCall>()

export function addPendingCall(
  botId: string,
  sender: string,
  reason: string,
  topic: string,
  nowMs: number = Date.now(),
): PendingCall {
  const call: PendingCall = {
    id: `${nowMs}-${Math.random().toString(36).slice(2, 8)}`,
    botId,
    sender,
    reason,
    topic,
    createdAt: nowMs,
  }
  store.set(call.id, call)
  return call
}

// 列出某 bot 的待接来电（顺带清理过期项）
export function listPendingCalls(botId: string, nowMs: number = Date.now()): PendingCall[] {
  const out: PendingCall[] = []
  for (const [id, c] of store) {
    if (nowMs - c.createdAt > PENDING_TTL_MS) {
      store.delete(id)
    } else if (c.botId === botId) {
      out.push(c)
    }
  }
  return out
}

// 接听时消费（删除），返回来电信息；不存在返回 null
export function consumePendingCall(id: string): PendingCall | null {
  const c = store.get(id) ?? null
  if (c) store.delete(id)
  return c
}
