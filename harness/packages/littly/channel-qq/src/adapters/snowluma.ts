/**
 * SnowLuma 适配器（移植自 lane-bridge `lib/channels/snowluma.js`，MIT）。
 *
 * SnowLuma 把 QQ 会话桥成 OneBot v11；本适配器负责：
 * - 建立/维持 OneBot WS（onebot-ws.ts），登录信息（get_login_info）；
 * - 入站事件 → 统一 InboundMessage（@/回复判定、图片）；
 * - 出站 send_private_msg / send_group_msg（segment 数组）。
 * 配置来自 bots 行（snowluma_enabled/ws_url/token/account），支持 SNOWLUMA_HOME 自动发现。
 */
import { ChannelAdapter, type AdapterLogger, type OutboundConversation } from './base.ts'
import { OneBotWsClient, type OneBotFrame, type WebSocketLike } from './onebot-ws.ts'
import { discoverSnowLumaEndpoint } from './snowluma-discovery.ts'

/** SnowLuma 适配器配置。 */
export interface SnowLumaConfig {
  wsUrl?: string
  accessToken?: string
  /** SNOWLUMA_HOME（自动发现 onebot_<uin>.json） */
  homeDir?: string
  /** 多账号：只接受 self_id === account 的事件（空=宽松放行） */
  account?: string
}

export interface SnowLumaAdapterOptions {
  id?: string
  config: SnowLumaConfig
  logger?: AdapterLogger | null
  /** 测试注入：替换全局 WebSocket。 */
  webSocketFactory?: ((url: string) => WebSocketLike) | null
}

/** OneBot segment → 文本（与 lane-bridge 行为一致）。 */
export function segmentText(segment: unknown): string {
  if (segment === null || typeof segment !== 'object') return ''
  const rec = segment as { type?: unknown; data?: Record<string, unknown> }
  const type = String(rec.type ?? '')
  const data = rec.data ?? {}
  switch (type) {
    case 'text': return String(data['text'] ?? '')
    case 'at': return data['qq'] === 'all' ? '@全体成员 ' : `@${String(data['name'] ?? data['qq'] ?? '某人')} `
    case 'image': return '[图片]'
    case 'face': return '[表情]'
    case 'record': return '[语音]'
    case 'video': return '[视频]'
    case 'file': return '[文件]'
    case 'forward': return '[转发消息]'
    case 'json':
    case 'xml': return '[卡片消息]'
    case 'reply': return ''
    default: return type !== '' ? `[${type}]` : ''
  }
}

/** segments/raw_message → 文本。 */
export function segmentsToText(segments: unknown, rawMessage = ''): string {
  if (Array.isArray(segments) && segments.length > 0) {
    return (segments as unknown[]).map(segmentText).join('').trim()
  }
  return String(rawMessage ?? '').trim()
}

/** @/回复判定。 */
export function mentionsOf(segments: unknown, selfId: string): { mentionsBot: boolean; replyToBot: boolean } {
  if (!Array.isArray(segments)) return { mentionsBot: false, replyToBot: false }
  return {
    mentionsBot: selfId !== '' && (segments as Array<{ type?: unknown; data?: { qq?: unknown } }>).some(
      (segment) => segment?.type === 'at' && String(segment.data?.qq ?? '') === selfId,
    ),
    replyToBot: (segments as Array<{ type?: unknown }>).some((segment) => segment?.type === 'reply'),
  }
}

/** 图片 URL 提取。 */
export function imagesOf(segments: unknown): Array<{ url: string; mediaType: string }> {
  if (!Array.isArray(segments)) return []
  return (segments as Array<{ type?: unknown; data?: { url?: unknown; file?: unknown } }>)
    .filter((segment) => segment?.type === 'image')
    .map((segment) => {
      const raw = String(segment.data?.url ?? '')
      const file = String(segment.data?.file ?? '')
      return { url: raw !== '' ? raw : /^https?:\/\//iu.test(file) ? file : '', mediaType: '' }
    })
    .filter((image) => image.url !== '')
}

/** SnowLuma（OneBot v11）渠道适配器。 */
export class SnowLumaAdapter extends ChannelAdapter {
  private readonly config: SnowLumaConfig
  client: OneBotWsClient | null = null
  private readonly webSocketFactory: ((url: string) => WebSocketLike) | null

  constructor({ id = 'snowluma', config, logger = null, webSocketFactory = null }: SnowLumaAdapterOptions) {
    super({ id, kind: 'snowluma', logger })
    this.config = config
    this.webSocketFactory = webSocketFactory
  }

  override async start(): Promise<void> {
    let url = String(this.config.wsUrl ?? '')
    let accessToken = String(this.config.accessToken ?? '')
    const discovered = url === '' || accessToken === ''
      ? discoverSnowLumaEndpoint({ homeDir: String(this.config.homeDir ?? ''), wsUrl: url, accessToken })
      : null
    if (discovered !== null) {
      url = discovered.wsUrl
      accessToken = discovered.accessToken
      this.logger?.info?.(`[channel-qq] SnowLuma 端点来自 ${discovered.source}（uin ${discovered.uin}）`)
    }
    if (url === '') url = 'ws://127.0.0.1:3001'
    this.started = true
    this.setStatus({ lastError: '', connected: false })
    try {
      const client = new OneBotWsClient({
        url,
        accessToken,
        logger: this.logger === null ? null : {
          info: (msg: string, ...args: unknown[]) => { this.logger?.info?.(msg, ...args) },
          warn: (msg: string, ...args: unknown[]) => { this.logger?.warn?.(msg, ...args) },
        },
        webSocketFactory: this.webSocketFactory,
      })
      this.client = client
      client.on('open', () => {
        this.setStatus({ connected: true, lastError: '' })
        this.logger?.info?.('[channel-qq] SnowLuma 已连接')
        void client.request('get_login_info', {}, { timeoutMs: 8000 })
          .then((info) => {
            const rec = info as { user_id?: unknown; nickname?: unknown } | null
            this.setStatus({ selfId: String(rec?.user_id ?? ''), nickname: String(rec?.nickname ?? '') })
          })
          .catch(() => {})
      })
      client.on('close', (info) => {
        this.setStatus({ connected: false, lastError: info?.reason ? String(info.reason) : '连接已关闭' })
      })
      client.on('error', (error) => {
        this.setError(error)
        this.logger?.warn?.(`[channel-qq] SnowLuma 连接错误：${error.message}`)
      })
      client.on('event', (event: OneBotFrame) => {
        void this.handleEvent(event)
      })
      await client.connect()
    } catch (error) {
      this.setError(error)
      this.logger?.warn?.(`[channel-qq] SnowLuma 启动失败：${(error as Error)?.message ?? String(error)}`)
    }
  }

  private async handleEvent(event: OneBotFrame): Promise<void> {
    if (event.post_type !== 'message') return
    const selfId = String(event.self_id ?? this.state.selfId ?? '')
    const senderId = String(event.sender?.user_id ?? event.user_id ?? '')
    if (senderId !== '' && senderId === selfId) return
    if (this.config.account !== undefined && this.config.account !== '' && event.self_id !== undefined && String(event.self_id) !== this.config.account) return
    const segments = event.message
    const text = segmentsToText(segments, event.raw_message ?? '')
    const { mentionsBot, replyToBot } = mentionsOf(segments, selfId)
    const images = imagesOf(segments)
    const isPrivate = event.message_type === 'private'
    const isGroup = event.message_type === 'group'
    if (!isPrivate && !isGroup) return
    const externalId = isGroup ? String(event.group_id ?? '') : senderId
    if (externalId === '') return
    // 群聊 @ 门在 inbound 层做（需要 bot 昵称回退），这里只把 mentionsBot 带出去
    this.emitMessage({
      kind: isPrivate ? 'private' : 'group',
      externalId,
      senderId,
      senderName: String(event.sender?.card || event.sender?.nickname || senderId),
      text,
      images,
      ...(event.message_id !== undefined ? { replyToId: String(event.message_id) } : {}),
      mentionsBot,
      replyToBot,
      raw: event,
    })
  }

  /** 通过连接调用 OneBot 动作（渠道工具用）。 */
  async callAction(action: string, params: Record<string, unknown>, timeoutMs = 10_000): Promise<OneBotFrame | null> {
    const client = this.client
    if (client === null || !this.state.connected) return null
    try {
      const data = await client.request(action, params, { timeoutMs })
      return { status: 'ok', retcode: 0, data }
    } catch {
      return null
    }
  }

  override async send(conversation: OutboundConversation, messages: string[]): Promise<Array<{ ok: boolean; id?: string }>> {
    const client = this.client
    if (client === null || !this.state.connected) throw new Error('SnowLuma 未连接')
    const action = conversation.kind === 'group' ? 'send_group_msg' : 'send_private_msg'
    const target = conversation.kind === 'group' ? { group_id: Number(conversation.externalId) } : { user_id: Number(conversation.externalId) }
    const results: Array<{ ok: boolean; id?: string }> = []
    for (const text of messages) {
      const payload = await client.request(action, { ...target, message: text }, { timeoutMs: 15_000 }) as { message_id?: unknown } | null
      results.push({ ok: true, ...(payload?.message_id !== undefined ? { id: String(payload.message_id) } : {}) })
    }
    return results
  }

  /** 发图片（相册 URL → SnowLuma 服务端拉取）。 */
  async sendImage(conversation: OutboundConversation, imageUrl: string, caption?: string): Promise<void> {
    const client = this.client
    if (client === null || !this.state.connected) throw new Error('SnowLuma 未连接')
    const action = conversation.kind === 'group' ? 'send_group_msg' : 'send_private_msg'
    const target = conversation.kind === 'group' ? { group_id: Number(conversation.externalId) } : { user_id: Number(conversation.externalId) }
    const segments: Array<{ type: string; data: Record<string, unknown> }> = [{ type: 'image', data: { url: imageUrl } }]
    if (caption !== undefined && caption !== '') segments.push({ type: 'text', data: { text: caption } })
    await client.request(action, { ...target, message: segments }, { timeoutMs: 20_000 })
  }
}
