/**
 * QQ 官方开放平台网关客户端（旧 src/internal/channel/qq.ts 的传输层移植）。
 *
 * - 鉴权：AppID + AppSecret → access_token（到期前 10 分钟续期，缓存在 bots 表）。
 * - 长连接：wss://api.bot.qq.com/websocket/；Hello(op=10) → 心跳 + Identify(op=2)。
 * - 发消息：POST /v2/users/{user_openid}/messages；带 event_id 时命中 60 分钟被动回复窗口。
 */
import type { BotRow, LittlyStorage } from '@littly/storage'
import type { LittlyHub } from '@littly/agents'

/** 网关长连接地址（QQ 官方开放平台）。 */
export const QQ_WS = 'wss://api.bot.qq.com/websocket/'
/** access_token 换取地址（AppID + AppSecret 换 token）。 */
export const QQ_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
/** 开放平台 API 根地址。 */
export const QQ_API = 'https://api.sgroup.qq.com'
/** intents：GROUP_AND_C2C_EVENT = 1 << 25（单聊 C2C + 群聊 @） */
export const QQ_INTENTS = 1 << 25
/** access_token 续期提前量（秒）：到期前 10 分钟换新 */
const TOKEN_RENEW_MARGIN_SEC = 600
/** access_token 默认有效期（秒）：官方未返回 expires_in 时兜底 */
const TOKEN_DEFAULT_TTL_SEC = 7200
/** 服务端未给心跳周期时的兜底间隔（毫秒） */
const DEFAULT_HEARTBEAT_MS = 30_000

/** C2C_MSG_RECEIVE 事件 payload（只取用到的字段）。 */
export interface QqC2CMessage {
  id: string
  author?: { user_openid?: string }
  content?: string
  msg_id?: string
  event_id?: string
  timestamp?: number
}

/** 插件依赖（index.ts 组装后注入 client / inbound）。 */
export interface QqDeps {
  storage: LittlyStorage
  hub: LittlyHub
  log: (msg: string, ...args: unknown[]) => void
  /** 入站事件处理（index.ts 注入，实现在 inbound.ts） */
  onMessage: (bot: BotRow, payload: QqC2CMessage) => Promise<void>
  /** 断线重连退避（毫秒） */
  reconnectMs: number
}

/** bots 表里本渠道用到的列。 */
interface QqCredentialRow {
  id: string
  name: string
  qq_enabled: number
  qq_app_id: string
  qq_app_secret: string
  qq_access_token: string
  qq_token_expires_at: string | null
}

/** 发送选项：eventId 命中 60 分钟被动回复窗口。 */
export interface QqSendOptions {
  /** 触发本次回复的前置事件 id（命中被动回复窗口） */
  eventId?: string | undefined
}

// --- access_token（AppID:AppSecret 换取，缓存到 bots 字段，提前 10 分钟续期） ---

/**
 * 校验 AppID/AppSecret 是否有效（config 保存前验证，不写库）。
 * @param appId - 开放平台 AppID
 * @param appSecret - 开放平台 AppSecret
 * @returns 能换到 access_token 即为有效
 */
export async function verifyQqCredentials(appId: string, appSecret: string): Promise<boolean> {
  try {
    const res = await fetch(QQ_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId, clientSecret: appSecret }),
    })
    const json = (await res.json().catch(() => ({}))) as { access_token?: string }
    return res.ok && !!json.access_token
  } catch {
    // 网络失败按"凭据无效"处理：调用方据此拒绝保存，不写库
    return false
  }
}

/**
 * 取 access_token：缓存未过期直接用，过期则用 AppID/AppSecret 换新并写回 bots 表。
 * bots.qq_token_expires_at 存 Unix 秒（十进制字符串）。
 * @param deps - 插件依赖
 * @param botId - bot 行 id
 * @returns 可用的 access_token
 * @throws 换 token 失败（HTTP 状态随错误信息带出）
 */
export async function getQqAccessToken(deps: QqDeps, botId: string): Promise<string> {
  const bot = deps.storage
    .prepare('SELECT id, name, qq_enabled, qq_app_id, qq_app_secret, qq_access_token, qq_token_expires_at FROM bots WHERE id = ?')
    .get(botId) as QqCredentialRow | undefined
  if (!bot) throw new Error('bot not found')
  const nowSec = Math.floor(Date.now() / 1000)
  const expiresAtSec = Number.parseInt(bot.qq_token_expires_at ?? '', 10) || 0
  if (bot.qq_access_token && expiresAtSec > nowSec + TOKEN_RENEW_MARGIN_SEC) return bot.qq_access_token

  const res = await fetch(QQ_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: bot.qq_app_id, clientSecret: bot.qq_app_secret }),
  })
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number }
  if (!json.access_token) {
    throw new Error(`qq getAccessToken failed: ${res.status} ${res.statusText}`)
  }
  const expiresAt = nowSec + (json.expires_in ?? TOKEN_DEFAULT_TTL_SEC) - TOKEN_RENEW_MARGIN_SEC
  deps.storage
    .prepare('UPDATE bots SET qq_access_token = ?, qq_token_expires_at = ? WHERE id = ?')
    .run(json.access_token, String(expiresAt), bot.id)
  return json.access_token
}

// --- 出站底层 ---

/**
 * 构造发送体：被动回复带上 event_id 命中 60 分钟被动窗口（每条事件最多 5 次），
 * 不带 event_id 即为主动推送（每月 4 条配额）。
 * @param text - 文本内容
 * @param eventId - 触发本次回复的前置事件 id（可选）
 * @returns 发送体（content + msg_type，可选 event_id）
 */
export function buildQqMessageBody(text: string, eventId?: string | undefined): Record<string, unknown> {
  const body: Record<string, unknown> = { content: text, msg_type: 0 }
  if (eventId) body.event_id = eventId
  return body
}

/**
 * 发一条 QQ 消息（文本）。HTTP 失败返回 false，不抛异常。
 * @param deps - 插件依赖
 * @param bot - 发送方 bot 行
 * @param openid - 接收方 user_openid
 * @param text - 文本内容
 * @param opts - 发送选项（eventId 命中被动回复窗口）
 * @returns 是否发送成功
 */
export async function sendQQText(
  deps: QqDeps,
  bot: BotRow,
  openid: string,
  text: string,
  opts?: QqSendOptions | undefined,
): Promise<boolean> {
  const token = await getQqAccessToken(deps, bot.id)
  const body = buildQqMessageBody(text, opts?.eventId)
  const res = await fetch(`${QQ_API}/v2/users/${openid}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${token}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    deps.log(
      '[qq] send failed (bot=%s): %s %s',
      bot.name,
      res.status,
      (await res.text().catch(() => '')).slice(0, 200),
    )
    return false
  }
  return true
}

// --- WebSocket 长连接监听（每个已启用 bot 一个连接，断线自愈重连） ---

/** 连接状态：stopped=true 时不再重连（插件卸载）。 */
interface QqMonitor {
  ws: WebSocket
  stopped: boolean
  reconnectTimer: ReturnType<typeof setTimeout> | null
}

const monitors = new Map<string, QqMonitor>()

/**
 * 取某 bot 的长连接。
 * @param botId - bot 行 id
 * @returns 连接实例；未连接返回 undefined
 */
export function getQqMonitor(botId: string): WebSocket | undefined {
  return monitors.get(botId)?.ws
}

/**
 * 启动某 bot 的长连接（已连接则直接返回成功）。
 * @param deps - 插件依赖
 * @param bot - bot 行
 * @returns 是否连上了
 */
export async function startQQMonitor(deps: QqDeps, bot: BotRow): Promise<boolean> {
  if (!bot.qq_enabled || !bot.qq_app_id || !bot.qq_app_secret) return false
  if (monitors.has(bot.id)) return true

  let token = ''
  try {
    token = await getQqAccessToken(deps, bot.id)
  } catch (err) {
    deps.log('[qq] 获取 access_token 失败 (bot=%s): %s', bot.name, err instanceof Error ? err.message : String(err))
    return false
  }

  const ws = new WebSocket(QQ_WS)
  const monitor: QqMonitor = { ws, stopped: false, reconnectTimer: null }
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let lastS = 0

  const send = (payload: Record<string, unknown>): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload))
  }
  const beat = (): void => send({ op: 1, d: lastS })

  ws.addEventListener('open', () => {
    deps.log('[qq] ws 已连接 (bot=%s)', bot.name)
  })

  ws.addEventListener('message', (ev: MessageEvent) => {
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(String(ev.data)) as Record<string, unknown>
    } catch {
      return
    }
    const op = typeof payload.op === 'number' ? payload.op : -1
    switch (op) {
      case 10: // Hello → 心跳周期 + Identify
        if (heartbeatTimer) clearInterval(heartbeatTimer)
        heartbeatTimer = setInterval(beat, helloHeartbeatMs(payload.d))
        send({ op: 2, d: { token: `QQBot ${token}`, intents: QQ_INTENTS, shard: [0, 1] } })
        break
      case 0: // Dispatch
        if (typeof payload.s === 'number') lastS = payload.s
        if (payload.t === 'C2C_MSG_RECEIVE' && payload.d) {
          const message = parseC2CMessage(payload.d)
          if (message) {
            void deps.onMessage(bot, message).catch((err) =>
              deps.log('[qq] handle message failed (bot=%s): %s', bot.name, String(err)),
            )
          }
        }
        break
      case 7: // Reconnect
        ws.close()
        break
      case 9: // Invalid Session
        deps.log('[qq] invalid session (bot=%s)', bot.name)
        break
    }
  })

  ws.addEventListener('close', () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    if (monitor.stopped) return
    monitors.delete(bot.id)
    deps.log('[qq] ws 断开 (bot=%s) — %ds 后重连', bot.name, Math.round(deps.reconnectMs / 1000))
    monitor.reconnectTimer = setTimeout(() => {
      monitor.reconnectTimer = null
      if (monitor.stopped) return
      void startQQMonitor(deps, bot).catch(() => {})
    }, deps.reconnectMs)
  })

  ws.addEventListener('error', () => {
    deps.log('[qq] ws error (bot=%s)', bot.name)
  })

  monitors.set(bot.id, monitor)
  return true
}

/** 停止全部长连接（插件卸载时调用；停止后不再重连）。 */
export function stopAllQQMonitors(): void {
  for (const monitor of [...monitors.values()]) {
    monitor.stopped = true
    if (monitor.reconnectTimer) {
      clearTimeout(monitor.reconnectTimer)
      monitor.reconnectTimer = null
    }
    try {
      monitor.ws.close()
    } catch {
      // 关闭失败不影响其余连接的清理
    }
  }
  monitors.clear()
}

/**
 * 自愈：补启缺失的连接（幂等）。
 * @param deps - 插件依赖
 * @returns 本次新启动的连接数
 */
export async function ensureQQMonitors(deps: QqDeps): Promise<number> {
  const bots = deps.storage
    .prepare("SELECT * FROM bots WHERE qq_enabled = 1 AND qq_app_id != '' AND qq_app_secret != ''")
    .all() as BotRow[]
  let started = 0
  for (const bot of bots) {
    if (monitors.has(bot.id)) continue
    if (await startQQMonitor(deps, bot)) started++
  }
  return started
}

// --- 载荷解析（wire 边界校验） ---

/** 取 Hello 帧的心跳周期（毫秒），缺省 30s。 */
function helloHeartbeatMs(d: unknown): number {
  if (typeof d !== 'object' || d === null) return DEFAULT_HEARTBEAT_MS
  const interval = (d as { heartbeat_interval?: unknown }).heartbeat_interval
  return typeof interval === 'number' && interval > 0 ? interval : DEFAULT_HEARTBEAT_MS
}

/**
 * 解析 C2C_MSG_RECEIVE 的 d 字段：只取用到的字段，畸形载荷丢弃。
 * @param raw - 网关下发的原始载荷
 * @returns 解析结果；非对象载荷返回 null
 */
export function parseC2CMessage(raw: unknown): QqC2CMessage | null {
  if (typeof raw !== 'object' || raw === null) return null
  const src = raw as Record<string, unknown>
  const authorRaw = src.author
  const author = typeof authorRaw === 'object' && authorRaw !== null ? (authorRaw as Record<string, unknown>) : null
  const openid = author && typeof author.user_openid === 'string' ? author.user_openid : ''
  const content = typeof src.content === 'string' ? src.content : ''
  const msgId = typeof src.msg_id === 'string' ? src.msg_id : undefined
  const eventId = typeof src.event_id === 'string' ? src.event_id : undefined
  const timestamp = typeof src.timestamp === 'number' ? src.timestamp : undefined
  return {
    id: typeof src.id === 'string' ? src.id : '',
    author: { user_openid: openid },
    content,
    ...(msgId !== undefined ? { msg_id: msgId } : {}),
    ...(eventId !== undefined ? { event_id: eventId } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
  }
}
