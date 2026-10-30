/**
 * ChannelAdapter 抽象（移植自 dsh-lane-bridge `lib/channels/base.js`，MIT）。
 *
 * 适配器只负责传输层：把入站消息归一化成统一形状、把出站消息交给对应协议；
 * 不碰 hub 会话 / 业务存储 / 人格（那些在 inbound.ts / manager.ts 里做）。
 */
import { EventEmitter } from 'node:events'

/** 统一入站消息（适配器产出）。 */
export interface InboundMessage {
  /** hub 渠道 id：'snowluma' | 'qqp' */
  channel: string
  kind: 'group' | 'private'
  /** 会话外部 id：SnowLuma 为群号/QQ 号；QQBot 为 groupOpenid/userOpenid */
  externalId: string
  senderId: string
  senderName: string
  text: string
  images: Array<{ url?: string; path?: string; mediaType?: string; name?: string }>
  replyToId?: string | undefined
  mentionsBot?: boolean
  replyToBot?: boolean
  raw?: unknown
}

/** 适配器状态（manager/console 展示）。 */
export interface ChannelAdapterState {
  connected: boolean
  selfId: string
  nickname: string
  lastError: string
  lastEventAt: number
}

/** 适配器状态快照。 */
export interface ChannelAdapterStatus extends ChannelAdapterState {
  id: string
  kind: string
  started: boolean
}

/** 出站会话目标。 */
export interface OutboundConversation {
  channel: string
  kind: 'group' | 'private'
  externalId: string
  /** 回复意图：true=回复刚收到的消息（可用被动回复窗口），false=主动推送 */
  reply?: boolean
  replyToId?: string
  replyToAt?: number
}

/** 适配器日志接口（只依赖 warn/info/debug）。 */
export interface AdapterLogger {
  info?: (msg: string, ...args: unknown[]) => void
  warn?: (msg: string, ...args: unknown[]) => void
  debug?: (msg: string, ...args: unknown[]) => void
  error?: (msg: string, ...args: unknown[]) => void
}

export interface ChannelAdapterOptions {
  id: string
  kind: string
  logger?: AdapterLogger | null
}

/** 渠道适配器基类：状态 + 事件 + 生命周期契约。 */
export class ChannelAdapter extends EventEmitter {
  readonly id: string
  readonly kind: string
  readonly logger: AdapterLogger | null
  started = false
  state: ChannelAdapterState = { connected: false, selfId: '', nickname: '', lastError: '', lastEventAt: 0 }

  constructor({ id, kind, logger = null }: ChannelAdapterOptions) {
    super()
    this.id = id
    this.kind = kind
    this.logger = logger
  }

  status(): ChannelAdapterStatus {
    return { id: this.id, kind: this.kind, started: this.started, ...this.state }
  }

  setStatus(patch: Partial<ChannelAdapterState>): void {
    this.state = { ...this.state, ...patch }
    this.emit('status', this.status())
  }

  setError(error: unknown): void {
    this.setStatus({ lastError: String((error as { message?: unknown } | null)?.message ?? error ?? '').slice(0, 300), connected: false })
  }

  emitMessage(message: Partial<InboundMessage> & { kind?: unknown; externalId?: unknown }): void {
    this.state.lastEventAt = Date.now()
    this.emit('message', {
      channel: this.id,
      kind: message.kind === 'private' ? 'private' : 'group',
      externalId: String(message.externalId ?? ''),
      senderId: String(message.senderId ?? ''),
      senderName: String(message.senderName ?? ''),
      text: String(message.text ?? '').trim(),
      images: Array.isArray(message.images) ? message.images : [],
      ...(message.replyToId !== undefined ? { replyToId: String(message.replyToId) } : {}),
      mentionsBot: message.mentionsBot === true,
      replyToBot: message.replyToBot === true,
      raw: message.raw,
    } satisfies InboundMessage)
  }

  async start(): Promise<void> {
    throw new Error(`${this.kind} adapter does not implement start()`)
  }

  async stop(): Promise<void> {
    this.started = false
    this.setStatus({ connected: false })
  }

  async send(_conversation: OutboundConversation, _messages: string[]): Promise<unknown[]> {
    throw new Error(`${this.kind} adapter does not implement send()`)
  }
}
