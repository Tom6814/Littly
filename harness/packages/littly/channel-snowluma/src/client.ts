/**
 * SnowLuma（QQ 账号，OneBot v11）正向 WebSocket 客户端。
 *
 * - 鉴权：Node 原生 WebSocket 不支持自定义 header，统一走 `?access_token=` query
 *   参数（SnowLuma 契约 §1.3）。
 * - 多账号：一连接一账号，monitor 按 `${botId}:${snowluma_account || 'default'}` 键控；
 *   多个 bot 可共用一个 SnowLuma 实例（事件按 self_id 过滤，见 inbound）。
 * - echo RPC：{action, params, echo: `sl_<botId>_<seq>`}，pending 表 10s 超时。
 * - 重连：close / error 后 reconnectMs 退避重连，双向事件只排一次（guard 双重调度）。
 * - 入站事件经 deps.onMessage 注入（index.ts 接 inbound.ts），本模块不感知业务流。
 */
import type { LittlyStorage, BotRow } from '@littly/storage'
import type { LittlyHub } from '@littly/agents'

export interface OneBotEnvelope {
  status?: string
  retcode?: number
  data?: unknown
  /** 信封失败描述（契约 §1：{status, retcode, data, message, wording}；事件体的 message 单列） */
  wording?: string
  echo?: string
  post_type?: string
  message_type?: string
  sub_type?: string
  self_id?: number
  user_id?: number
  group_id?: number
  raw_message?: string
  /** 事件消息体：CQ 字符串或段数组（契约 §4） */
  message?: unknown
  sender?: { user_id?: number; nickname?: string; card?: string }
}

export interface OneBotVersionInfo {
  app_name?: string
  protocol_version?: string
}

export interface SnowlumaDeps {
  storage: LittlyStorage
  hub: LittlyHub
  log: (msg: string, ...args: unknown[]) => void
  /** 入站事件处理（index.ts 注入，实现在 inbound.ts） */
  onMessage: (bot: BotRow, ev: OneBotEnvelope) => Promise<void>
  /** bot 自身昵称（get_login_info，懒取缓存；群聊 @提及门需要） */
  getSelfNickname: (bot: BotRow) => Promise<string>
  /** 相册相对路径 → 绝对公网 URL（SnowLuma 服务端拉取 http URL，契约 §4） */
  photoPublicUrl: (url: string) => string
  reconnectMs: number
}

export interface SnowlumaMonitor {
  readonly botId: string
  readonly key: string
  ws: WebSocket
  pending: Map<string, { resolve: (v: OneBotEnvelope | null) => void; timer: NodeJS.Timeout }>
  reconnectTimer: NodeJS.Timeout | null
  stopped: boolean
  /** 连接时能力探测结果（get_version_info） */
  version: OneBotVersionInfo | null
}

const monitors = new Map<string, SnowlumaMonitor>()
let echoSeq = 0

export function monitorKey(botId: string, account: string): string {
  return `${botId}:${account || 'default'}`
}

export function getMonitor(key: string): SnowlumaMonitor | undefined {
  return monitors.get(key)
}

export function buildWsUrl(raw: string, token: string): string {
  const sep = raw.includes('?') ? '&' : '?'
  return token ? `${raw}${sep}access_token=${encodeURIComponent(token)}` : raw
}

function isEnvelopeOk(res: OneBotEnvelope | null): boolean {
  // 契约 §1：信封 200 仍可能是业务失败，必须查 retcode===0（status ok 兜底）
  return !!res && (res.retcode === 0 || res.status === 'ok')
}

/** 通过已建立的 WS 调用 OneBot 动作；无连接/超时/发送失败返回 null。 */
export function callSnowluma(
  mon: SnowlumaMonitor,
  action: string,
  params: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<OneBotEnvelope | null> {
  if (mon.stopped || mon.ws.readyState !== WebSocket.OPEN) return Promise.resolve(null)
  echoSeq = (echoSeq + 1) % 1_000_000
  const echo = `sl_${mon.botId}_${echoSeq}`
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      mon.pending.delete(echo)
      resolve(null)
    }, timeoutMs)
    mon.pending.set(echo, { resolve, timer })
    try {
      mon.ws.send(JSON.stringify({ action, params, echo }))
    } catch {
      clearTimeout(timer)
      mon.pending.delete(echo)
      resolve(null)
    }
  })
}

/** 按 botId 路由的通用动作调用（monitor 键从 bots 行读取）。 */
export async function callBotAction(
  storage: LittlyStorage,
  botId: string,
  action: string,
  params: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<OneBotEnvelope | null> {
  const bot = storage
    .prepare('SELECT snowluma_account FROM bots WHERE id = ?')
    .get(botId) as { snowluma_account: string } | undefined
  if (!bot) return null
  const mon = monitors.get(monitorKey(botId, bot.snowluma_account))
  if (!mon) return null
  return callSnowluma(mon, action, params, timeoutMs)
}

// --- 连接管理 ---

async function ensureSnowlumaMonitor(deps: SnowlumaDeps, botId: string): Promise<boolean> {
  const bot = deps.storage.prepare('SELECT * FROM bots WHERE id = ?').get(botId) as BotRow | undefined
  if (!bot || !bot.snowluma_enabled || !bot.snowluma_ws_url) {
    stopMonitor(botId)
    return false
  }
  const key = monitorKey(botId, bot.snowluma_account)
  if (monitors.has(key)) return true

  let ws: WebSocket
  try {
    ws = new WebSocket(buildWsUrl(bot.snowluma_ws_url, bot.snowluma_token))
  } catch (err) {
    deps.log('[snowluma] 无法创建连接 (bot=%s): %s', bot.name, String(err))
    return false
  }

  const mon: SnowlumaMonitor = {
    botId,
    key,
    ws,
    pending: new Map(),
    reconnectTimer: null,
    stopped: false,
    version: null,
  }

  const scheduleReconnect = (): void => {
    if (mon.stopped) return
    if (ws.readyState === WebSocket.OPEN) return
    if (mon.reconnectTimer) return // guard：error + close 双事件只排一次
    mon.reconnectTimer = setTimeout(() => {
      mon.reconnectTimer = null
      if (mon.stopped) return
      if (ws.readyState === WebSocket.OPEN) return
      if (monitors.get(key) === mon) monitors.delete(key)
      void ensureSnowlumaMonitor(deps, botId).catch(() => {})
    }, deps.reconnectMs)
  }

  ws.addEventListener('open', () => {
    if (mon.reconnectTimer) {
      clearTimeout(mon.reconnectTimer)
      mon.reconnectTimer = null
    }
    deps.log('[snowluma] ws 已连接 (bot=%s, %s)', bot.name, bot.snowluma_ws_url)
    // 能力探测：get_version_info（契约 §6；get_cookies 等扩展动作在首次使用时懒探测）
    void callSnowluma(mon, 'get_version_info', {}).then((res) => {
      if (isEnvelopeOk(res) && res) {
        mon.version = (res.data ?? null) as OneBotVersionInfo | null
        deps.log(
          '[snowluma] 能力探测: app=%s protocol=%s (bot=%s)',
          mon.version?.app_name ?? 'unknown',
          mon.version?.protocol_version ?? 'unknown',
          bot.name,
        )
      }
    }).catch(() => {})
  })

  ws.addEventListener('message', (ev: MessageEvent) => {
    let payload: OneBotEnvelope
    try {
      payload = JSON.parse(String(ev.data)) as OneBotEnvelope
    } catch {
      return
    }
    // API 回包：按 echo 匹配 pending 回调
    if (payload.echo && mon.pending.has(payload.echo)) {
      const waiter = mon.pending.get(payload.echo)
      if (waiter) {
        mon.pending.delete(payload.echo)
        clearTimeout(waiter.timer)
        waiter.resolve(payload)
      }
      return
    }
    // 事件推送：message（私聊 friend / 群聊 @提及），其余事件今晚不接
    if (payload.post_type === 'message') {
      void deps.onMessage(bot, payload).catch((err) =>
        deps.log('[snowluma] 处理消息失败 (bot=%s): %s', bot.name, String(err)),
      )
    }
  })

  ws.addEventListener('close', () => {
    // 失败速断：挂起调用立即返回 null
    for (const waiter of mon.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.resolve(null)
    }
    mon.pending.clear()
    if (mon.stopped || monitors.get(key) !== mon) return
    monitors.delete(key)
    deps.log('[snowluma] ws 断开 (bot=%s) — %ds 后重连', bot.name, Math.round(deps.reconnectMs / 1000))
    scheduleReconnect()
  })

  ws.addEventListener('error', (ev: Event) => {
    // DOM WebSocketEventMap 的 error 是纯 Event；底层错误经 ErrorEvent 断言读取
    const errEv = ev as ErrorEvent
    const detail = errEv.error instanceof Error ? errEv.error.message : errEv.message
    deps.log('[snowluma] ws error (bot=%s): %s', bot.name, detail || 'unknown')
    scheduleReconnect()
  })

  monitors.set(key, mon)
  return true
}

function closeMonitor(mon: SnowlumaMonitor): void {
  mon.stopped = true
  if (mon.reconnectTimer) {
    clearTimeout(mon.reconnectTimer)
    mon.reconnectTimer = null
  }
  for (const waiter of mon.pending.values()) {
    clearTimeout(waiter.timer)
    waiter.resolve(null)
  }
  mon.pending.clear()
  try {
    mon.ws.close()
  } catch {
    /* ignore */
  }
}

function stopMonitor(botId: string): void {
  for (const mon of [...monitors.values()]) {
    if (mon.botId !== botId) continue
    closeMonitor(mon)
    monitors.delete(mon.key)
  }
}

/** 停止全部 monitor（插件卸载时调用）。 */
export function stopAllSnowlumaMonitors(): void {
  for (const mon of [...monitors.values()]) {
    closeMonitor(mon)
    monitors.delete(mon.key)
  }
}

// --- 自愈：补启缺失 monitor（幂等） ---

export async function ensureAllSnowlumaMonitors(deps: SnowlumaDeps): Promise<number> {
  const bots = deps.storage
    .prepare("SELECT * FROM bots WHERE snowluma_enabled = 1 AND snowluma_ws_url != ''")
    .all() as BotRow[]
  let started = 0
  for (const bot of bots) {
    if (await ensureSnowlumaMonitor(deps, bot.id)) started++
  }
  return started
}
