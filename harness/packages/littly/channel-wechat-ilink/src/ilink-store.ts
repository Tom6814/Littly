/**
 * §iLink 持久化 — 微信 ClawBot (iLink) 直连所需的跨重启状态。
 *
 * - sync_buf：消息同步游标（服务重启后从断点继续拉取，避免丢消息）。
 * - context_token：每个用户最近一条消息的上下文令牌（SDK 内存缓存重启即失，
 *   主动推送 push 需要它；缺了会 NoContextTokenError）。
 * - bind_session：扫码绑定会话（模块重载/服务重启时内存 Map 会丢，
 *   持久化后轮询接口仍能找到会话继续扫码确认）。
 *
 * 都存 global_settings KV，key 按 botId/sender 隔离（前缀与旧项目逐字一致）。
 */
import type { LittlyStorage } from '@littly/storage'
import type { ILinkBindState } from './ilink.ts'

const SYNC_PREFIX = 'ilink.sync.'
const CTX_PREFIX = 'ilink.ctx.'
const BIND_PREFIX = 'ilink.bind.'

/**
 * 读消息同步游标。
 * @param storage - 业务存储。
 * @param botId - bot id。
 * @returns 游标字符串；无则空串。
 */
export function getSyncBuf(storage: LittlyStorage, botId: string): string {
  const row = storage
    .prepare('SELECT value FROM global_settings WHERE key = ?')
    .get(`${SYNC_PREFIX}${botId}`) as { value: string } | undefined
  return row?.value ?? ''
}

/**
 * 写消息同步游标（空值忽略，与旧项目一致）。
 * @param storage - 业务存储。
 * @param botId - bot id。
 * @param buf - 游标字符串。
 */
export function setSyncBuf(storage: LittlyStorage, botId: string, buf: string): void {
  if (!buf) return
  const key = `${SYNC_PREFIX}${botId}`
  storage
    .prepare('INSERT INTO global_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, buf)
}

/**
 * 读用户最近一条消息的 context_token。
 * @param storage - 业务存储。
 * @param botId - bot id。
 * @param sender - 微信外部 id。
 * @returns context_token；无则空串。
 */
export function getContextToken(storage: LittlyStorage, botId: string, sender: string): string {
  if (!sender) return ''
  const row = storage
    .prepare('SELECT value FROM global_settings WHERE key = ?')
    .get(`${CTX_PREFIX}${botId}.${sender}`) as { value: string } | undefined
  return row?.value ?? ''
}

/**
 * 写用户最近一条消息的 context_token（缺 sender / token 时忽略）。
 * @param storage - 业务存储。
 * @param botId - bot id。
 * @param sender - 微信外部 id。
 * @param token - context_token。
 */
export function setContextToken(storage: LittlyStorage, botId: string, sender: string, token: string): void {
  if (!sender || !token) return
  const key = `${CTX_PREFIX}${botId}.${sender}`
  storage
    .prepare('INSERT INTO global_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, token)
}

// --- 扫码绑定会话持久化 ---

/**
 * 读扫码绑定会话；已过 TTL 的会话视为失效。
 * @param storage - 业务存储。
 * @param session - 会话 id。
 * @returns 会话状态；不存在或已过期返回 null。
 */
export function getBindSession(storage: LittlyStorage, session: string): ILinkBindState | null {
  if (!session) return null
  const row = storage
    .prepare('SELECT value FROM global_settings WHERE key = ?')
    .get(`${BIND_PREFIX}${session}`) as { value: string } | undefined
  if (!row?.value) return null
  try {
    const state = JSON.parse(row.value) as ILinkBindState
    // 已过 TTL 的会话视为失效
    if (state.expiresAt && Date.now() > state.expiresAt) return null
    return state
  } catch {
    return null
  }
}

/**
 * 写扫码绑定会话。
 * @param storage - 业务存储。
 * @param session - 会话 id。
 * @param state - 会话状态。
 */
export function setBindSession(storage: LittlyStorage, session: string, state: ILinkBindState): void {
  if (!session) return
  const key = `${BIND_PREFIX}${session}`
  storage
    .prepare('INSERT INTO global_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(state))
}

/**
 * 删除扫码绑定会话。
 * @param storage - 业务存储。
 * @param session - 会话 id。
 */
export function deleteBindSession(storage: LittlyStorage, session: string): void {
  if (!session) return
  storage.prepare('DELETE FROM global_settings WHERE key = ?').run(`${BIND_PREFIX}${session}`)
}
