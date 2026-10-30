/**
 * 官方 QQ Bot 适配器（移植自 lane-bridge `lib/channels/qqbot.js`，MIT）。
 *
 * 用 `@tencent-connect/qqbot-nodejs` 直接持有连接与「会话→消息」映射（不另起桥进程）。
 * - 入站：message 事件 → InboundMessage（c2c/group、@ 判定、附件图片、msg id）。
 * - 出站：被动回复（带 msg_id，5 分钟内、每条最多 5 次）优先；主动消息需显式 allowActive。
 * 测试通过 `loadQqbotModule` 注入 FakeBot（无需真实开放平台凭据）。
 */
import { ChannelAdapter, type AdapterLogger, type OutboundConversation } from './base.ts'

/** QQ Bot SDK 的最小结构面（测试可注入 Fake）。 */
export interface QqbotSdkLike {
  QQBot: new (options: { appId: string; appSecret: string; logger?: AdapterLogger }) => QqbotBotLike
}
export interface QqbotBotLike {
  on(event: string, handler: (...args: never[]) => void): void
  start(): Promise<unknown> | unknown
  stop(): unknown
  sendText(target: { scope: 'c2c' | 'group'; targetId: string; msgId?: string }, text: string): Promise<{ id?: string }>
}

export interface QqbotConfig {
  appId?: string
  appSecret?: string
  /** 是否允许主动消息（默认 false：只做被动回复，避免 40034105） */
  allowActive?: boolean
}

export interface QqbotAdapterOptions {
  id?: string
  config: QqbotConfig
  logger?: AdapterLogger | null
  /** 测试注入：返回 fake SDK（默认动态 import @tencent-connect/qqbot-nodejs）。 */
  loadQqbotModule?: (() => Promise<QqbotSdkLike>) | null
}

let sdkPromise: Promise<QqbotSdkLike> | null = null
function loadSdk(): Promise<QqbotSdkLike> {
  sdkPromise ??= import('@tencent-connect/qqbot-nodejs').then((mod) => mod as unknown as QqbotSdkLike)
  return sdkPromise
}

function loggerFacade(logger: AdapterLogger | null): AdapterLogger {
  return {
    debug: (msg: string, ...args: unknown[]) => { logger?.debug?.(msg, ...args) },
    info: (msg: string, ...args: unknown[]) => { logger?.info?.(msg, ...args) },
    warn: (msg: string, ...args: unknown[]) => { logger?.warn?.(msg, ...args) },
    error: (msg: string, ...args: unknown[]) => { logger?.error?.(msg, ...args) },
  }
}

/** 官方 QQ Bot 渠道适配器。 */
export class QqbotAdapter extends ChannelAdapter {
  private readonly config: QqbotConfig
  private readonly loadQqbotModule: (() => Promise<QqbotSdkLike>) | null
  bot: QqbotBotLike | null = null

  constructor({ id = 'qqbot', config, logger = null, loadQqbotModule = null }: QqbotAdapterOptions) {
    super({ id, kind: 'qqbot', logger })
    this.config = config
    this.loadQqbotModule = loadQqbotModule
  }

  override async start(): Promise<void> {
    const appId = String(this.config.appId ?? '').trim()
    const appSecret = String(this.config.appSecret ?? '').trim()
    this.started = true
    this.setStatus({ lastError: '', connected: false })
    if (appId === '' || appSecret === '') {
      this.setError('未配置 appId / appSecret')
      return
    }
    let sdk: QqbotSdkLike
    try {
      sdk = this.loadQqbotModule !== null ? await this.loadQqbotModule() : await loadSdk()
    } catch (error) {
      this.setError(`缺少 @tencent-connect/qqbot-nodejs：${(error as Error)?.message ?? String(error)}`)
      return
    }
    try {
      const bot = new sdk.QQBot({ appId, appSecret, logger: loggerFacade(this.logger) })
      this.bot = bot
      bot.on('ready', (data: { user?: { id?: unknown; username?: unknown } }) => {
        this.setStatus({ connected: true, selfId: String(data?.user?.id ?? data?.user?.username ?? ''), lastError: '' })
      })
      bot.on('resumed', () => this.setStatus({ connected: true }))
      bot.on('disconnected', (event: { reason?: unknown }) => {
        this.setStatus({ connected: false, lastError: String(event?.reason ?? '连接断开') })
      })
      bot.on('error', (error: Error) => {
        this.setError(error)
        this.logger?.warn?.(`[channel-qq] QQ Bot 错误：${error?.message ?? String(error)}`)
      })
      bot.on('message', (_ctx: unknown, msg: QqbotMessageLike) => {
        try {
          this.handleMessage(msg)
        } catch (error) {
          this.logger?.warn?.(`[channel-qq] QQ Bot 入站消息处理失败：${(error as Error)?.message ?? String(error)}`)
        }
      })
      void Promise.resolve(bot.start()).catch((error: unknown) => {
        this.setError(error)
        this.logger?.warn?.(`[channel-qq] QQ Bot 启动失败：${(error as Error)?.message ?? String(error)}`)
      })
    } catch (error) {
      this.setError(error)
      this.logger?.warn?.(`[channel-qq] QQ Bot 初始化失败：${(error as Error)?.message ?? String(error)}`)
    }
  }

  private handleMessage(msg: QqbotMessageLike): void {
    if (!msg || msg.senderIsBot === true) return
    const rawEventType = String(msg.rawEventType ?? '')
    const isPrivate = msg.kind === 'c2c' || msg.kind === 'dm'
    const externalId = String(msg.replyTarget?.targetId ?? msg.groupOpenid ?? msg.channelId ?? msg.senderId ?? '')
    if (externalId === '') return
    const selfIds = new Set<string>([this.state.selfId, msg.selfId, msg.botId].map((v) => String(v ?? '').trim()).filter((v) => v !== ''))
    const mentionList = Array.isArray(msg.mentions) ? msg.mentions : []
    const mentionedById = mentionList.some((item) => {
      const rec = item as { is_you?: unknown; id?: unknown; member_openid?: unknown; user_openid?: unknown; name?: unknown }
      const id = String(rec.id ?? rec.member_openid ?? rec.user_openid ?? '')
      return rec.is_you === true || selfIds.has(id)
    })
    const mentionedByText = [...selfIds].some((id) => String(msg.content ?? '').includes(`<@${id}>`))
    const rawText = String(msg.content ?? '').replace(/<@!?[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim()
    const attachments = Array.isArray(msg.attachments) ? msg.attachments : []
    const text = rawText !== '' ? rawText : attachments.length > 0 ? '[图片]' : ''
    const images = attachments.slice(0, 8).map((attachment) => {
      const rec = attachment as { url?: unknown; file_url?: unknown; content_type?: unknown; name?: unknown }
      return { url: String(rec.url ?? rec.file_url ?? ''), mediaType: String(rec.content_type ?? ''), name: String(rec.name ?? '') }
    }).filter((image) => image.url !== '')
    this.emitMessage({
      kind: isPrivate ? 'private' : 'group',
      externalId,
      senderId: String(msg.senderId ?? ''),
      senderName: String(msg.senderName ?? ''),
      text,
      images,
      ...(msg.messageId !== undefined ? { replyToId: String(msg.messageId) } : {}),
      mentionsBot: rawEventType === 'GROUP_AT_MESSAGE_CREATE' || mentionedById || mentionedByText,
      replyToBot: Boolean(msg.refMsgIdx),
      raw: { kind: msg.kind, rawEventType, messageId: msg.messageId, timestamp: msg.timestamp, mentionCount: mentionList.length, selfIds: [...selfIds] },
    })
  }

  override async stop(): Promise<void> {
    this.started = false
    try {
      this.bot?.stop()
    } catch {
      // ignore
    }
    this.bot = null
    this.setStatus({ connected: false })
  }

  /**
   * 发送文本：被动回复优先（带 msg_id，5 分钟窗口/每条最多 5 次）；否则主动消息。
   * 被动回复过期且允许主动消息时自动降级（避免慢模型丢回复）。
   */
  override async send(conversation: OutboundConversation, messages: string[]): Promise<Array<{ ok: boolean; id?: string }>> {
    if (this.bot === null) throw new Error('QQ Bot 未连接')
    const allowActive = this.config.allowActive === true
    const replyToId = String(conversation.replyToId ?? '').trim()
    const passive = conversation.reply === true && replyToId !== ''
    if (!passive && !allowActive) {
      const scope = conversation.kind === 'private' ? '私聊' : '群'
      throw new Error(`QQ ${scope}主动消息没有权限：这次发送不是「回复刚收到的消息」（缺少 msg_id）。需要在配置里允许主动消息。`)
    }
    const target: { scope: 'c2c' | 'group'; targetId: string; msgId?: string } = {
      scope: conversation.kind === 'private' ? 'c2c' : 'group',
      targetId: String(conversation.externalId),
      ...(passive ? { msgId: replyToId } : {}),
    }
    const results: Array<{ ok: boolean; id?: string }> = []
    const queue = passive ? messages.slice(0, 5) : messages
    if (passive && messages.length > 5) {
      this.logger?.warn?.(`[channel-qq] QQ 被动回复上限 5 条，已丢弃 ${messages.length - 5} 条（${conversation.externalId}）`)
    }
    for (const message of queue) {
      const text = String(message ?? '').trim()
      if (text === '') continue
      try {
        const sent = await this.bot.sendText(target, text)
        results.push({ ok: true, ...(sent?.id !== undefined ? { id: String(sent.id) } : {}) })
      } catch (error) {
        const text2 = String((error as Error)?.message ?? error)
        const expired = /40034005|40034128|msg_id\s*已过期|回复消息msg_id已过期/u.test(text2)
        if (passive && allowActive && expired) {
          this.logger?.warn?.(`[channel-qq] 被动回复已过期，改发主动消息（${conversation.externalId}）`)
          const sent = await this.bot.sendText({ scope: target.scope, targetId: target.targetId }, text)
          results.push({ ok: true, ...(sent?.id !== undefined ? { id: String(sent.id) } : {}) })
          continue
        }
        throw this.decorateSendError(error, { active: !passive && !expired, expired })
      }
    }
    return results
  }

  private decorateSendError(error: unknown, opts: { active: boolean; expired?: boolean }): Error {
    const message = String((error as Error)?.message ?? error)
    const matched = QQ_SEND_ERROR_HINTS.find(([pattern]) => pattern.test(message))
    if (matched === undefined) {
      if (opts.expired === true) return new Error(`${message} （被动回复已过期：msg_id 只有 5 分钟有效期；模型这次回复太慢了）`)
      if (!opts.active || !/无权限|not allowed|permission|403/iu.test(message)) return error as Error
      return new Error(`${message} （这是主动消息：机器人需要具备主动消息权限）`)
    }
    return new Error(`${message} （${matched[1]}）`)
  }
}

/** QQ Bot SDK message 形状（只取用到的字段）。 */
export interface QqbotMessageLike {
  kind?: string
  rawEventType?: string
  senderIsBot?: boolean
  senderId?: string
  senderName?: string
  content?: string
  messageId?: string
  timestamp?: number
  refMsgIdx?: unknown
  mentions?: unknown[]
  attachments?: unknown[]
  replyTarget?: { targetId?: string }
  groupOpenid?: string
  channelId?: string
  selfId?: string
  botId?: string
}

/** 平台发送错误 → 可操作的中文提示（顺序敏感）。 */
const QQ_SEND_ERROR_HINTS: Array<[RegExp, string]> = [
  [/40034105|主动消息发送失败[，,]\s*无权限/u, '主动消息无权限 40034105：机器人没有主动发送能力（未上线/沙箱，或开放平台未开启主动消息）'],
  [/40034100|主动消息发送超过频控/u, '主动消息超出频控 40034100：认证 60qpm / 未认证 30qpm'],
  [/40034005|40034024|40034026|40034128|消息ID已过期|msg_id\s*已过期|被动回复时间或次数超限/u, '被动回复已失效：msg_id 只有 5 分钟有效期、同一条最多回复 5 次'],
  [/40034101|40054003|机器人非群成员|机器人不是群成员/u, '机器人不在这个群里，先把机器人拉进群'],
  [/40054002|机器人被禁言/u, '机器人在这个群里被禁言'],
  [/40054005|消息被去重/u, '消息被判重复：同一 msg_id 的 msg_seq 必须递增'],
  [/40054007|消息长度超限/u, '消息太长（40054007）'],
  [/40054010|不允许发送URL/u, '这条消息不允许包含 URL（40054010）'],
  [/40054016|机器人已下线/u, '机器人已下线（40054016）'],
]
