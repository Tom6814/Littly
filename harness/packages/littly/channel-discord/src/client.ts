/**
 * Discord 官方 API 传输层（Gateway WebSocket v10 + REST v10）。
 *
 * 旧 monolith 对应文件：src/internal/channel/discord.ts（本文件为其传输部分）。
 * - Gateway：每个启用的 bot 一条连接（monitors 按 botId 键控），断线自愈重连；
 *   Hello(op=10) → 心跳 + Identify(op=2)；Dispatch(op=0) → 落 seq + MESSAGE_CREATE；
 *   op=7 Reconnect → close；op=9 Invalid Session → 报错。
 * - REST：发消息 POST /channels/{channel_id}/messages；主动投递缺地址时
 *   POST /users/{user_id}/channels 现开 DM。
 * - 邀请链接：https://discord.com/api/oauth2/authorize?client_id=...&permissions=2048&scope=bot
 *
 * 入站事件经 deps.onMessage 注入（index.ts 接 inbound.ts），本模块不感知业务流。
 */
import type { BotRow, LittlyStorage } from '@littly/storage'
import type { LittlyHub } from '@littly/agents'

/** Discord REST API 根地址（v10）。 */
export const DISCORD_API = 'https://discord.com/api/v10'

/** intents：GUILDS(1<<0) + GUILD_MESSAGES(1<<9) + DIRECT_MESSAGES(1<<12) + MESSAGE_CONTENT(1<<15) */
export const DISCORD_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15)

/** 邀请链接权限：Send Messages */
export const DISCORD_INVITE_PERMISSIONS = 2048

/** Gateway 协议版本（query v=10）。 */
const DISCORD_GATEWAY_VERSION = 10

/** Discord 未下发 heartbeat_interval 时的兜底周期（协议默认值）。 */
const DEFAULT_HEARTBEAT_MS = 30000

/** 消息作者（MESSAGE_CREATE 的 author 字段）。 */
export interface DiscordAuthor {
  id?: string
  username?: string
  global_name?: string | null
  bot?: boolean
}

/** 消息附件。 */
export interface DiscordAttachment {
  id?: string
  url?: string
  content_type?: string
  filename?: string
}

/** MESSAGE_CREATE 事件 payload（只取用到的字段）。 */
export interface DiscordMessage {
  id: string
  channel_id: string
  /** 1 = DM */
  channel_type?: number
  guild_id?: string
  author?: DiscordAuthor
  content?: string
  attachments?: DiscordAttachment[]
}

/** Gateway 下行 payload（op 0 dispatch / op 10 hello）。 */
interface DiscordGatewayPayload {
  op?: number
  s?: number
  t?: string
  /** op 0 → MESSAGE_CREATE 事件体；op 10 → hello（含 heartbeat_interval）。 */
  d?: DiscordMessage & { heartbeat_interval?: number }
}

/** 插件依赖（index.ts 组装后注入）。 */
export interface DiscordDeps {
  storage: LittlyStorage
  hub: LittlyHub
  log: (msg: string, ...args: unknown[]) => void
  /** 入站消息处理（index.ts 注入，实现在 inbound.ts） */
  onMessage: (bot: BotRow, msg: DiscordMessage) => Promise<void>
  /** 相册相对路径 → 绝对公网 URL（Discord 侧要自己拉图再上传） */
  photoPublicUrl: (url: string) => string
  /** 断线重连退避（毫秒） */
  reconnectMs: number
}

/** 旧 sendToDiscordHumanized 的返回形状。 */
export interface DiscordSendResult {
  ok: boolean
  sent: number
  error?: string | undefined
}

// --- 邀请链接（BindDialog 展示，类似 t.me 深链） ---

/**
 * 生成 Discord bot 邀请链接。
 * @param clientId - 应用（bot）client id。
 * @returns 带 Send Messages 权限的 oauth2 授权链接。
 */
export function createDiscordInvite(clientId: string): string {
  return `https://discord.com/api/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&permissions=${DISCORD_INVITE_PERMISSIONS}&scope=bot`
}

// --- 低层 API ---

/**
 * 调 Discord REST（POST + JSON）。
 * @param token - Bot token。
 * @param method - API 路径（以 / 开头）。
 * @param body - 请求体；省略则不带 body。
 * @returns 解析后的 JSON 响应。
 */
export async function discordCall<T = unknown>(token: string, method: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bot ${token}`,
    },
  }
  if (body !== undefined) init.body = JSON.stringify(body)
  const res = await fetch(`${DISCORD_API}${method}`, init)
  if (!res.ok) {
    throw new Error(`discord ${method} failed: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`)
  }
  return (await res.json()) as T
}

/**
 * Create DM：user_id → channel_id（主动投递缺地址时用）。
 * @param token - Bot token。
 * @param userId - 目标用户 id。
 * @returns 新建的 DM channel id。
 */
export async function createDmChannel(token: string, userId: string): Promise<string> {
  const ch = await discordCall<{ id: string }>(token, `/users/${userId}/channels`, {})
  return ch.id
}

/**
 * 发单条文本到指定 channel（失败只告警不抛，与旧 sendDiscordText 一致）。
 * @param deps - 插件依赖（日志用）。
 * @param bot - bot 行（取 token 与名字）。
 * @param channelId - 目标 channel id。
 * @param text - 消息正文。
 * @returns 发送成功返回 true，失败返回 false。
 */
export async function sendDiscordText(deps: DiscordDeps, bot: BotRow, channelId: string, text: string): Promise<boolean> {
  const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bot ${bot.discord_bot_token}`,
    },
    body: JSON.stringify({ content: text }),
  })
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200)
    deps.log('[discord] send failed (bot=%s): %s %s', bot.name, String(res.status), detail)
    return false
  }
  return true
}

/**
 * 投递地址解析：优先用入站存的 DM channel_id（contacts.external_id）；
 * 缺省用 channel_identities 的 user id 动态 Create DM。
 * @param deps - 插件依赖（存储与日志）。
 * @param bot - bot 行（取 token）。
 * @param sender - 会话标识（未绑定为 discord_&lt;userId&gt;，已绑定为用户 id）。
 * @returns 可投递的 DM channel id；没有则空串。
 */
export async function resolveDiscordChannelId(deps: DiscordDeps, bot: BotRow, sender: string): Promise<string> {
  const contact = deps.storage
    .prepare('SELECT external_id FROM contacts WHERE bot_id = ? AND sender = ?')
    .get(bot.id, sender) as { external_id: string } | undefined
  let channelId = contact?.external_id ?? ''
  if (channelId) return channelId
  const identity = deps.storage
    .prepare('SELECT external_id FROM channel_identities WHERE user_id = ? AND channel = ?')
    .get(sender, 'discord') as { external_id: string } | undefined
  if (identity?.external_id) {
    try {
      channelId = await createDmChannel(bot.discord_bot_token, identity.external_id)
    } catch (err) {
      deps.log('[discord] create DM failed (bot=%s): %s', bot.name, err instanceof Error ? err.message : String(err))
    }
  }
  return channelId
}

/**
 * 出站主入口（被动回复 / 主动投递）。
 * @param deps - 插件依赖。
 * @param bot - bot 行（token / 启用状态）。
 * @param sender - 会话标识。
 * @param text - 消息正文。
 * @returns 旧 DiscordSendResult 形状（ok / sent / error）。
 */
export async function sendToDiscordHumanized(
  deps: DiscordDeps,
  bot: BotRow,
  sender: string,
  text: string,
): Promise<DiscordSendResult> {
  if (!bot.discord_enabled || !bot.discord_bot_token) return { ok: false, sent: 0, error: 'Discord 未启用' }
  if (!text.trim()) return { ok: true, sent: 0 }

  const channelId = await resolveDiscordChannelId(deps, bot, sender)
  if (!channelId) {
    return { ok: false, sent: 0, error: '没有 Discord DM 投递地址（对方需要先给 bot 发过消息）' }
  }

  const ok = await sendDiscordText(deps, bot, channelId, text)
  return ok ? { ok: true, sent: 1 } : { ok: false, sent: 0, error: 'Discord 发送失败' }
}

/**
 * 发图片给 Discord 联系人（相册图）：解析 DM channelId → multipart 上传文件。
 * @param deps - 插件依赖。
 * @param bot - bot 行（token / 启用状态）。
 * @param sender - 会话标识。
 * @param imageUrl - 图片 URL（绝对地址）。
 * @param caption - 配图文案（可选）。
 * @returns sent 表示是否发送成功；失败带 error 文案。
 */
export async function sendToDiscordImage(
  deps: DiscordDeps,
  bot: BotRow,
  sender: string,
  imageUrl: string,
  caption?: string,
): Promise<{ sent: boolean; error?: string | undefined }> {
  if (!bot.discord_enabled || !bot.discord_bot_token) return { sent: false, error: 'Discord 未启用' }
  const channelId = await resolveDiscordChannelId(deps, bot, sender)
  if (!channelId) return { sent: false, error: '没有 Discord 投递地址（对方需要先给 bot 发过消息）' }
  try {
    const img = await fetch(imageUrl).then((res) => res.arrayBuffer())
    const form = new FormData()
    form.append('file', new Blob([img]), 'photo.png')
    if (caption) form.append('payload_json', JSON.stringify({ content: caption }))
    const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${bot.discord_bot_token}` },
      body: form,
    })
    if (!res.ok) return { sent: false, error: `Discord 发送失败 ${res.status}` }
    return { sent: true }
  } catch (err) {
    return { sent: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// --- Gateway WebSocket 长连接监听（每个已启用 bot 一个连接，断线自愈重连） ---

interface DiscordMonitor {
  botId: string
  ws: WebSocket
  heartbeatTimer: NodeJS.Timeout | null
  reconnectTimer: NodeJS.Timeout | null
  /** 最近一次 dispatch 的 seq（心跳回传用） */
  lastS: number | null
  stopped: boolean
}

const monitors = new Map<string, DiscordMonitor>()

/**
 * 取某个 bot 的 Gateway 连接状态。
 * @param botId - bot id。
 * @returns 连接状态；未连接则 undefined。
 */
export function getDiscordMonitor(botId: string): DiscordMonitor | undefined {
  return monitors.get(botId)
}

/**
 * 启动某个 bot 的 Gateway 连接（幂等：已连接直接返回 true）。
 * @param deps - 插件依赖。
 * @param botId - bot id。
 * @returns 连接已建立（或此前已建立）返回 true。
 */
export async function startDiscordMonitor(deps: DiscordDeps, botId: string): Promise<boolean> {
  const bot = deps.storage.prepare('SELECT * FROM bots WHERE id = ?').get(botId) as BotRow | undefined
  if (!bot || !bot.discord_enabled || !bot.discord_bot_token) return false
  if (monitors.has(bot.id)) return true

  // 拿 Gateway 地址（/gateway/bot 需要鉴权）
  let wsUrl = ''
  try {
    const res = await fetch(`${DISCORD_API}/gateway/bot`, {
      headers: { Authorization: `Bot ${bot.discord_bot_token}` },
    })
    const json = (await res.json().catch(() => ({}))) as { url?: string }
    if (!res.ok || !json.url) {
      deps.log('[discord] get gateway failed (bot=%s): %s', bot.name, String(res.status))
      return false
    }
    wsUrl = `${json.url}?v=${DISCORD_GATEWAY_VERSION}&encoding=json`
  } catch (err) {
    deps.log('[discord] get gateway error (bot=%s): %s', bot.name, err instanceof Error ? err.message : String(err))
    return false
  }

  const ws = new WebSocket(wsUrl)
  const mon: DiscordMonitor = { botId: bot.id, ws, heartbeatTimer: null, reconnectTimer: null, lastS: null, stopped: false }

  const send = (payload: Record<string, unknown>): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload))
  }
  const beat = (): void => send({ op: 1, d: mon.lastS })

  const scheduleReconnect = (): void => {
    if (mon.stopped) return
    if (mon.reconnectTimer) return
    mon.reconnectTimer = setTimeout(() => {
      mon.reconnectTimer = null
      if (mon.stopped) return
      if (monitors.get(bot.id) === mon) monitors.delete(bot.id)
      void startDiscordMonitor(deps, bot.id).catch(() => {})
    }, deps.reconnectMs)
  }

  ws.addEventListener('open', () => {
    deps.log('[discord] gateway 已连接 (bot=%s)', bot.name)
  })

  ws.addEventListener('message', (ev: MessageEvent) => {
    let payload: DiscordGatewayPayload
    try {
      payload = JSON.parse(String(ev.data)) as DiscordGatewayPayload
    } catch {
      return
    }
    switch (payload.op) {
      case 10: // Hello → 心跳周期 + Identify
        if (mon.heartbeatTimer) clearInterval(mon.heartbeatTimer)
        mon.heartbeatTimer = setInterval(beat, payload.d?.heartbeat_interval ?? DEFAULT_HEARTBEAT_MS)
        send({
          op: 2,
          d: {
            token: bot.discord_bot_token,
            intents: DISCORD_INTENTS,
            properties: { $os: 'linux', $browser: 'littly', $device: 'littly' },
          },
        })
        break
      case 0: // Dispatch
        if (typeof payload.s === 'number') {
          mon.lastS = payload.s
          // 持久化 seq 供断线续传（参考，v1 简单重连即可）
          try {
            deps.storage.prepare('UPDATE bots SET discord_last_sequence = ? WHERE id = ?').run(payload.s, bot.id)
          } catch {
            /* ignore */
          }
        }
        if (payload.t === 'MESSAGE_CREATE' && payload.d) {
          void deps.onMessage(bot, payload.d).catch((err) =>
            deps.log('[discord] handle message failed (bot=%s): %s', bot.name, err instanceof Error ? err.message : String(err)),
          )
        }
        break
      case 1: // Heartbeat Request
        beat()
        break
      case 7: // Reconnect
        ws.close()
        break
      case 9: // Invalid Session
        deps.log('[discord] invalid session (bot=%s)', bot.name)
        break
      default:
        break
    }
  })

  ws.addEventListener('close', () => {
    if (mon.heartbeatTimer) {
      clearInterval(mon.heartbeatTimer)
      mon.heartbeatTimer = null
    }
    if (mon.stopped) return
    if (monitors.get(bot.id) === mon) monitors.delete(bot.id)
    deps.log('[discord] gateway 断开 (bot=%s) — %ds 后重连', bot.name, Math.round(deps.reconnectMs / 1000))
    scheduleReconnect()
  })

  ws.addEventListener('error', () => {
    deps.log('[discord] gateway error (bot=%s)', bot.name)
  })

  monitors.set(bot.id, mon)
  return true
}

/** 停止全部 monitor（插件卸载时调用）。 */
export function stopAllDiscordMonitors(): void {
  for (const mon of [...monitors.values()]) {
    mon.stopped = true
    if (mon.heartbeatTimer) {
      clearInterval(mon.heartbeatTimer)
      mon.heartbeatTimer = null
    }
    if (mon.reconnectTimer) {
      clearTimeout(mon.reconnectTimer)
      mon.reconnectTimer = null
    }
    try {
      mon.ws.close()
    } catch {
      /* ignore */
    }
    monitors.delete(mon.botId)
  }
}

/**
 * 自愈：补启缺失 monitor（幂等；进程重启 / bot 后台启用均覆盖）。
 * @param deps - 插件依赖。
 * @returns 本次新启动的连接数。
 */
export async function ensureDiscordMonitors(deps: DiscordDeps): Promise<number> {
  const bots = deps.storage
    .prepare("SELECT * FROM bots WHERE discord_enabled = 1 AND discord_bot_token != ''")
    .all() as BotRow[]
  let started = 0
  for (const bot of bots) {
    if (monitors.has(bot.id)) continue
    if (await startDiscordMonitor(deps, bot.id)) started++
  }
  return started
}
