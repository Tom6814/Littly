/**
 * iLink 持久化层：凭据 / 消息游标 / context_token（24h 窗口）/ 绑定会话 / 名片码缓存。
 *
 * 存储位置（全部落 SQLite `global_settings` KV，跨进程重启可用；不新增表）：
 * - `ilink.cred.<botId>`  = 凭据 JSON {bot_token, baseurl, ilink_bot_id, ilink_user_id, savedAt}
 *   **权威副本**；同时镜像到 `bots` 表既有 wx_* 列（wx_enabled/wx_hub_bot_id/wx_push_token/
 *   wx_push_endpoint），兼容历史数据与 console-api 既有渠道配置回显。
 * - `ilink.buf.<botId>`   = get_updates_buf 游标（重启后续拉，不丢消息）
 * - `ilink.ctx.<botId>.<sender>` = context_token JSON {token, at}（at = 最后入站毫秒；24h 窗口判定）
 * - `ilink.bind.<sessionId>` = 扫码会话 JSON（模块重载/服务重启后仍能轮询到确认）
 * - `ilink.friend.<botId>` = 名片二维码缓存 JSON {dataUrl, payload, expiresAt}
 *
 * 为什么凭据主副本放 global_settings 而不是 bots 列：四个字段里 `ilink_user_id` 在 bots
 * 表没有对应列；放一处 JSON 保证「扫码确认原子落四个值」，bots 列只做镜像（老 webhook /
 * 控制台渠道页继续可读）。
 */
import type { BotRow, LittlyStorage } from '@littly/storage'
import type { ILinkCredentials } from './ilink-client.ts'

const CRED_PREFIX = 'ilink.cred.'
const BUF_PREFIX = 'ilink.buf.'
const CTX_PREFIX = 'ilink.ctx.'
const BIND_PREFIX = 'ilink.bind.'
const FRIEND_PREFIX = 'ilink.friend.'

/** context_token 保鲜窗口：入站后 24h 内可主动发消息（hub 语义 contextTokenMaxAge）。 */
export const CONTEXT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000
/** 二维码有效期（iLink 未下发精确 TTL；服务端在 expired 后换码，这里给前端展示用）。 */
export const QR_TTL_MS = 5 * 60 * 1000

// --- KV 底座 ---

/** 读 KV。 */
function getSetting(storage: LittlyStorage, key: string): string | undefined {
  const row = storage.prepare('SELECT value FROM global_settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value
}

/** 写 KV（覆盖）。 */
function setSetting(storage: LittlyStorage, key: string, value: string): void {
  storage
    .prepare('INSERT INTO global_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value)
}

/** 删 KV。 */
function delSetting(storage: LittlyStorage, key: string): void {
  storage.prepare('DELETE FROM global_settings WHERE key = ?').run(key)
}

// --- 凭据 ---

/** 读某 bot 的 iLink 凭据（缺字段/坏 JSON 视为未绑定）。 */
export function getCredentials(storage: LittlyStorage, botId: string): ILinkCredentials | null {
  const raw = getSetting(storage, `${CRED_PREFIX}${botId}`)
  if (raw === undefined || raw === '') return null
  try {
    const parsed = JSON.parse(raw) as Partial<ILinkCredentials>
    if (typeof parsed.bot_token !== 'string' || parsed.bot_token === '' || typeof parsed.ilink_bot_id !== 'string') return null
    return {
      bot_token: parsed.bot_token,
      baseurl: typeof parsed.baseurl === 'string' ? parsed.baseurl : '',
      ilink_bot_id: parsed.ilink_bot_id,
      ilink_user_id: typeof parsed.ilink_user_id === 'string' ? parsed.ilink_user_id : '',
    }
  } catch {
    return null
  }
}

/**
 * 保存凭据（global_settings 权威 + bots.wx_* 镜像），并标记渠道启用。
 * @param storage - 业务存储。
 * @param botId - 目标 bot id。
 * @param creds - 扫码确认得到的四元凭据。
 */
export function saveCredentials(storage: LittlyStorage, botId: string, creds: ILinkCredentials): void {
  setSetting(storage, `${CRED_PREFIX}${botId}`, JSON.stringify({ ...creds, savedAt: Date.now() }))
  storage
    .prepare('UPDATE bots SET wx_enabled = 1, wx_hub_bot_id = ?, wx_push_token = ?, wx_push_endpoint = ? WHERE id = ?')
    .run(creds.ilink_bot_id, creds.bot_token, creds.baseurl, botId)
}

/**
 * 清凭据（登出）：删权威副本与游标/context_token，停用渠道；**保留**身份绑定与历史消息。
 * @param storage - 业务存储。
 * @param botId - 目标 bot id。
 */
export function clearCredentials(storage: LittlyStorage, botId: string): void {
  delSetting(storage, `${CRED_PREFIX}${botId}`)
  delSetting(storage, `${BUF_PREFIX}${botId}`)
  delSetting(storage, `${FRIEND_PREFIX}${botId}`)
  // 清该 bot 的全部 context_token（按前缀扫，量小）
  const rows = storage.prepare('SELECT key FROM global_settings WHERE key LIKE ?').all(`${CTX_PREFIX}${botId}.%`) as unknown as Array<{ key: string }>
  for (const row of rows) delSetting(storage, row.key)
  storage
    .prepare("UPDATE bots SET wx_enabled = 0, wx_hub_bot_id = '', wx_push_token = '', wx_push_endpoint = '' WHERE id = ?")
    .run(botId)
}

/** 列出所有已绑定凭据的 bot（自愈/批次启动用）。 */
export function listBoundBotIds(storage: LittlyStorage): string[] {
  const rows = storage.prepare('SELECT key FROM global_settings WHERE key LIKE ?').all(`${CRED_PREFIX}%`) as unknown as Array<{ key: string }>
  return rows
    .map((row) => row.key.slice(CRED_PREFIX.length))
    .filter((botId) => botId !== '' && getCredentials(storage, botId) !== null)
}

// --- 消息游标 ---

/** 读 get_updates_buf 游标（空串 = 从头拉）。 */
export function getSyncBuf(storage: LittlyStorage, botId: string): string {
  return getSetting(storage, `${BUF_PREFIX}${botId}`) ?? ''
}

/** 写游标（空值忽略，保持旧游标）。 */
export function setSyncBuf(storage: LittlyStorage, botId: string, buf: string): void {
  if (buf === '') return
  setSetting(storage, `${BUF_PREFIX}${botId}`, buf)
}

// --- context_token（含 24h 窗口判定） ---

/** context_token 状态：令牌 + 最后入站时间。 */
export interface ContextTokenState {
  token: string
  /** 最后一次入站消息的毫秒时间戳。 */
  at: number
}

/** 读某会话的 context_token 状态（兼容历史纯字符串值）。 */
export function getContextTokenState(storage: LittlyStorage, botId: string, sender: string): ContextTokenState | null {
  if (sender === '') return null
  const raw = getSetting(storage, `${CTX_PREFIX}${botId}.${sender}`)
  if (raw === undefined || raw === '') return null
  try {
    const parsed = JSON.parse(raw) as Partial<ContextTokenState>
    if (typeof parsed.token === 'string' && parsed.token !== '') {
      return { token: parsed.token, at: typeof parsed.at === 'number' ? parsed.at : 0 }
    }
  } catch {
    // 历史值是裸 token 字符串
    return { token: raw, at: 0 }
  }
  return null
}

/** 读某会话的 context_token（纯令牌；窗口新鲜度由调用方判断）。 */
export function getContextToken(storage: LittlyStorage, botId: string, sender: string): string {
  return getContextTokenState(storage, botId, sender)?.token ?? ''
}

/**
 * 保存入站消息的 context_token（同时刷新 24h 窗口起点）。
 * @param storage - 业务存储。
 * @param botId - bot id。
 * @param sender - 微信外部 id（from_user_id 原值）。
 * @param token - context_token。
 * @param at - 入站时刻（毫秒，默认 now）。
 */
export function setContextToken(storage: LittlyStorage, botId: string, sender: string, token: string, at = Date.now()): void {
  if (sender === '' || token === '') return
  setSetting(storage, `${CTX_PREFIX}${botId}.${sender}`, JSON.stringify({ token, at } satisfies ContextTokenState))
}

/**
 * 会话是否在 24h 窗口内（可以带 context_token 主动发消息）。
 * @param storage - 业务存储。
 * @param botId - bot id。
 * @param sender - 微信外部 id。
 * @param now - 当前毫秒（可注入测试）。
 */
export function hasFreshContextToken(storage: LittlyStorage, botId: string, sender: string, now = Date.now()): boolean {
  const state = getContextTokenState(storage, botId, sender)
  if (state === null) return false
  return now - state.at <= CONTEXT_TOKEN_TTL_MS
}

/** 读某 bot 最近一次入站时刻（控制台展示 24h 窗口状态）。 */
export function getLastInboundAt(storage: LittlyStorage, botId: string): number {
  const rows = storage.prepare('SELECT value FROM global_settings WHERE key LIKE ?').all(`${CTX_PREFIX}${botId}.%`) as unknown as Array<{ value: string }>
  let latest = 0
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.value) as Partial<ContextTokenState>
      if (typeof parsed.at === 'number' && parsed.at > latest) latest = parsed.at
    } catch {
      continue
    }
  }
  return latest
}

// --- 扫码会话 ---

/** 绑定会话对外状态（API 契约：wait / scanned / expired / confirmed，失败时 failed）。 */
export type WechatBindStatus = 'wait' | 'scanned' | 'expired' | 'confirmed' | 'failed'

/** 扫码会话持久化状态。 */
export interface ILinkBindSessionState {
  id: string
  botId: string
  /** 发起绑定的登录用户（确认后用于认领微信身份）。 */
  userId: string
  status: WechatBindStatus
  /** 当前二维码 id（轮询用）。 */
  qrcode: string
  /** 当前二维码 data URL（直接给前端 <img>）。 */
  qrDataUrl: string
  /** 二维码原始载荷（qrcode_img_content，排障/审计用）。 */
  payload: string
  /** 已刷新次数（超过 3 次失败）。 */
  refreshCount: number
  /** 会话截止毫秒。 */
  expiresAt: number
  error?: string | undefined
  /** confirmed 后的凭据（缓存给断线重连的客户端取回）。 */
  credentials?: ILinkCredentials | undefined
  updatedAt: number
}

/** 读扫码会话；已过 TTL 返回 null。 */
export function getBindSession(storage: LittlyStorage, sessionId: string): ILinkBindSessionState | null {
  if (sessionId === '') return null
  const raw = getSetting(storage, `${BIND_PREFIX}${sessionId}`)
  if (raw === undefined || raw === '') return null
  try {
    const state = JSON.parse(raw) as ILinkBindSessionState
    if (state.expiresAt > 0 && Date.now() > state.expiresAt) return null
    return state
  } catch {
    return null
  }
}

/** 写扫码会话。 */
export function setBindSession(storage: LittlyStorage, state: ILinkBindSessionState): void {
  setSetting(storage, `${BIND_PREFIX}${state.id}`, JSON.stringify(state))
}

/** 删除扫码会话。 */
export function deleteBindSession(storage: LittlyStorage, sessionId: string): void {
  if (sessionId === '') return
  delSetting(storage, `${BIND_PREFIX}${sessionId}`)
}

// --- 名片二维码缓存 ---

/** 名片二维码缓存状态。 */
export interface FriendQrState {
  dataUrl: string
  payload: string
  expiresAt: number
}

/** 读名片二维码缓存；过期返回 null。 */
export function getFriendQr(storage: LittlyStorage, botId: string): FriendQrState | null {
  const raw = getSetting(storage, `${FRIEND_PREFIX}${botId}`)
  if (raw === undefined || raw === '') return null
  try {
    const parsed = JSON.parse(raw) as FriendQrState
    if (typeof parsed.dataUrl !== 'string' || parsed.dataUrl === '') return null
    if (typeof parsed.expiresAt === 'number' && Date.now() > parsed.expiresAt) return null
    return parsed
  } catch {
    return null
  }
}

/** 写名片二维码缓存，同时镜像到 bots.wx_friend_* 列（控制台渠道页可读）。 */
export function setFriendQr(storage: LittlyStorage, botId: string, state: FriendQrState): void {
  setSetting(storage, `${FRIEND_PREFIX}${botId}`, JSON.stringify(state))
  storage
    .prepare('UPDATE bots SET wx_friend_display_enabled = 1, wx_friend_qrcode = ? WHERE id = ?')
    .run(state.payload, botId)
}

/** 清名片二维码缓存与展示开关。 */
export function clearFriendQr(storage: LittlyStorage, botId: string): void {
  delSetting(storage, `${FRIEND_PREFIX}${botId}`)
  storage.prepare("UPDATE bots SET wx_friend_display_enabled = 0, wx_friend_qrcode = '' WHERE id = ?").run(botId)
}

/** 取 bot 行。 */
export function loadBot(storage: LittlyStorage, botId: string): BotRow | undefined {
  return storage.prepare('SELECT * FROM bots WHERE id = ?').get(botId) as BotRow | undefined
}
