/**
 * 极简 OneBot v11 正向 WebSocket 客户端（移植自 dsh-lane-bridge `lib/channels/onebot-ws.js`，MIT）。
 *
 * 为什么自己写而不依赖 @snowluma/sdk：SDK 的 ESM 产物需要 postinstall patch，
 * 插件应「装完即用」；这里只保 JSON action 帧、echo 关联、重连、事件分发这些必需能力。
 * 依赖 Node 22+ 的全局 WebSocket；测试可注入 FakeSocket（globalThis.WebSocket 替换）。
 */
const OPEN = 1

export interface OneBotFrame {
  status?: string
  retcode?: number
  data?: unknown
  wording?: string
  echo?: string | number
  post_type?: string
  message_type?: string
  sub_type?: string
  self_id?: number
  user_id?: number
  group_id?: number
  message_id?: number | string
  raw_message?: string
  message?: unknown
  sender?: { user_id?: number; nickname?: string; card?: string }
  time?: number
  [key: string]: unknown
}

export interface OneBotWsOptions {
  url: string
  accessToken?: string
  logger?: { info?: (msg: string, ...args: unknown[]) => void; warn?: (msg: string, ...args: unknown[]) => void } | null
  reconnect?: boolean
  /** 测试注入：替换全局 WebSocket 构造函数。 */
  webSocketFactory?: ((url: string) => WebSocketLike) | null
}

/** 最小 WebSocket 结构面（浏览器/Node 全局 WebSocket 兼容）。 */
export interface WebSocketLike {
  readyState: number
  url?: string
  close(): void
  send(data: string): void
  addEventListener(name: 'open' | 'close' | 'error' | 'message', handler: (event: { code?: number; reason?: string; data?: unknown; error?: unknown }) => void): void
}

interface PendingEntry {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

function withToken(url: string, token: string): string {
  if (!token) return url
  try {
    const parsed = new URL(url)
    parsed.searchParams.set('access_token', token)
    return parsed.toString()
  } catch {
    return url
  }
}

/** OneBot v11 正向 WS 客户端。 */
export class OneBotWsClient {
  readonly url: string
  readonly accessToken: string
  readonly logger: OneBotWsOptions['logger']
  readonly reconnect: boolean
  private readonly webSocketFactory: ((url: string) => WebSocketLike) | null
  socket: WebSocketLike | null = null
  opened = false
  private closedByUser = false
  private readonly pending = new Map<string, PendingEntry>()
  private echo = 0
  private retry = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private connectPromise: Promise<void> | null = null
  private readonly handlers: { open: Array<() => void>; close: Array<(info: { code?: number; reason?: string }) => void>; error: Array<(error: Error) => void>; event: Array<(event: OneBotFrame) => void> } = {
    open: [], close: [], error: [], event: [],
  }

  constructor({ url, accessToken = '', logger = null, reconnect = true, webSocketFactory = null }: OneBotWsOptions) {
    this.url = String(url || 'ws://127.0.0.1:3001')
    this.accessToken = String(accessToken || '')
    this.logger = logger
    this.reconnect = reconnect !== false
    this.webSocketFactory = webSocketFactory
  }

  private createSocket(url: string): WebSocketLike {
    if (this.webSocketFactory !== null) return this.webSocketFactory(url)
    const ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket
    if (typeof ctor !== 'function') throw new Error('当前 Node 运行时不提供 WebSocket（需要 Node 22+）')
    return new ctor(url)
  }

  on(event: 'open', handler: () => void): () => void
  on(event: 'close', handler: (info: { code?: number; reason?: string }) => void): () => void
  on(event: 'error', handler: (error: Error) => void): () => void
  on(event: 'event', handler: (event: OneBotFrame) => void): () => void
  on(event: 'open' | 'close' | 'error' | 'event', handler: (...args: never[]) => void): () => void {
    const list = this.handlers[event] as Array<(...args: never[]) => void>
    list.push(handler)
    return () => {
      const target = this.handlers[event] as Array<(...args: never[]) => void>
      const index = target.indexOf(handler)
      if (index >= 0) target.splice(index, 1)
    }
  }

  private emit(event: 'open' | 'close' | 'error' | 'event', payload?: unknown): void {
    for (const handler of this.handlers[event] as Array<(arg: unknown) => void>) {
      try {
        handler(payload)
      } catch (error) {
        this.logger?.warn?.(`[channel-qq] OneBot 事件处理失败：${(error as Error)?.message ?? String(error)}`)
      }
    }
  }

  connect(): Promise<void> {
    if (this.opened) return Promise.resolve()
    if (this.connectPromise !== null) return this.connectPromise
    this.closedByUser = false
    const url = withToken(this.url, this.accessToken)
    this.connectPromise = new Promise<void>((resolve, reject) => {
      let settled = false
      let socket: WebSocketLike
      try {
        socket = this.createSocket(url)
      } catch (error) {
        reject(error as Error)
        return
      }
      this.socket = socket
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { socket.close() } catch { /* ignore */ }
        reject(new Error('连接 OneBot WebSocket 超时'))
      }, 10_000)
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error !== undefined) reject(error)
        else resolve()
      }
      socket.addEventListener('open', () => {
        this.opened = true
        this.retry = 0
        this.emit('open')
        finish()
      })
      socket.addEventListener('error', (event) => {
        this.emit('error', (event.error as Error | undefined) ?? new Error('OneBot WebSocket error'))
        finish(new Error('OneBot WebSocket 连接失败'))
      })
      socket.addEventListener('close', (event) => {
        this.opened = false
        this.socket = null
        this.rejectPending(new Error('OneBot WebSocket 已关闭'))
        this.emit('close', { code: event.code, reason: event.reason })
        finish(new Error('OneBot WebSocket 在连接建立前关闭'))
        this.scheduleReconnect()
      })
      socket.addEventListener('message', (event) => {
        this.handleMessage(event.data)
      })
    }).finally(() => {
      this.connectPromise = null
    })
    return this.connectPromise
  }

  private scheduleReconnect(): void {
    if (!this.reconnect || this.closedByUser || this.retryTimer !== null) return
    this.retry += 1
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.retry, 6))
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.closedByUser) return
      this.connect().catch((error: unknown) => {
        this.logger?.warn?.(`[channel-qq] OneBot 重连失败：${(error as Error)?.message ?? String(error)}`)
      })
    }, delay)
    // 不阻塞进程退出（插件卸载时 close 会清掉）
    ;(this.retryTimer as unknown as { unref?: () => void }).unref?.()
  }

  private handleMessage(data: unknown): void {
    let frame: OneBotFrame
    try {
      frame = JSON.parse(typeof data === 'string' ? data : Buffer.from(data as Uint8Array).toString('utf8')) as OneBotFrame
    } catch {
      return
    }
    if (!frame || typeof frame !== 'object') return
    if (frame.echo !== undefined && this.pending.has(String(frame.echo))) {
      const entry = this.pending.get(String(frame.echo))
      if (entry === undefined) return
      this.pending.delete(String(frame.echo))
      clearTimeout(entry.timer)
      if (frame.status === 'failed' || (frame.retcode !== undefined && frame.retcode !== 0)) {
        entry.reject(new Error(String(frame.wording ?? frame.message ?? `OneBot ${frame.retcode ?? 'failed'}`)))
      } else {
        entry.resolve(frame.data)
      }
      return
    }
    if (frame.post_type !== undefined) this.emit('event', frame)
  }

  private rejectPending(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  async request(action: string, params: Record<string, unknown> = {}, opts: { timeoutMs?: number } = {}): Promise<unknown> {
    if (!this.opened) await this.connect()
    const echo = `littly-${++this.echo}`
    const socket = this.socket
    if (socket === null || socket.readyState !== OPEN) throw new Error('OneBot WebSocket 未连接')
    const timeoutMs = opts.timeoutMs ?? 30_000
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error(`OneBot ${action} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this.pending.set(echo, { resolve, reject, timer })
      try {
        socket.send(JSON.stringify({ action, params, echo }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(echo)
        reject(error as Error)
      }
    })
  }

  close(): void {
    this.closedByUser = true
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.rejectPending(new Error('OneBot 客户端已关闭'))
    try { this.socket?.close() } catch { /* ignore */ }
    this.socket = null
    this.opened = false
  }
}
