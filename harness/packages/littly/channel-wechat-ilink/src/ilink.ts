/**
 * iLink 直连 transport（微信 ClawBot / iLink 协议）——旧 internal/channel/ilink.ts 的移植。
 *
 * §SDK 接缝 ——
 * 旧项目依赖 @openilink/openilink-sdk-node（扫码登录 loginWithQr / 长轮询 monitor /
 * 主动推送 push）。该包不在本仓库 workspace 内（pnpm-lock.yaml 里没有），且无网络
 * 不可安装，因此本文件把 SDK 收敛成一个**窄接口 ILinkClient**（插件只用到 6 个方法），
 * 并自带一份零依赖的 fetch 实现 FetchILinkClient——协议细节（端点、请求体、请求头、
 * 长轮询退避、扫码状态机）逐字对齐官方 SDK 0.6.0 的 dist/client.js。
 * 宿主若自行安装了官方 SDK，调用
 *   setILinkClientFactory(createSdkILinkClientFactory(await import('@openilink/openilink-sdk-node')))
 * 即可无缝切回官方实现，无需改动本包其它文件。
 *
 * §Bot 凭证映射（沿用 bots 表既有列）——
 *   wx_enabled       = 是否启用
 *   wx_hub_bot_id    = iLink bot_id（微信 ClawBot 的 Bot 标识）
 *   wx_push_token    = iLink bot_token（连接凭证）
 *   wx_push_endpoint = iLink base_url（自定义端点，可空）
 */
import { randomBytes, randomUUID } from 'node:crypto'
import type { BotRow, LittlyStorage } from '@littly/storage'
import { getBindSession, setBindSession, deleteBindSession, getSyncBuf, setSyncBuf, getContextToken, setContextToken } from './ilink-store.ts'

// --- iLink 协议常量（对齐官方 SDK dist/constants.js） ---

const ILINK_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
const ILINK_APP_ID = 'bot'
const ILINK_CHANNEL_VERSION = '2.1.6'
const ILINK_BOT_TYPE = '3'
const ITEM_TYPE_TEXT = 1
const MESSAGE_TYPE_BOT = 2
const MESSAGE_STATE_FINISH = 2
const SESSION_EXPIRED_ERR_CODE = -14

const LONG_POLL_TIMEOUT_MS = 35_000
const API_TIMEOUT_MS = 15_000
const QR_LONG_POLL_TIMEOUT_MS = 35_000
const QR_MAX_REFRESH = 3
const MAX_CONSECUTIVE_FAILURES = 3
const BACKOFF_DELAY_MS = 30_000
const RETRY_DELAY_MS = 2_000
const SESSION_EXPIRED_PAUSE_MS = 3_600_000

// --- 协议消息形状（官方 SDK dist/types.ts 的子集） ---

/** iLink 文本条目（item_list 里 type=1 的载荷）。 */
export interface ILinkTextItem {
  text?: string
}

/** iLink 语音条目（item_list 里 type=3 的载荷，text 为语音转写）。 */
export interface ILinkVoiceItem {
  text?: string
}

/** iLink 消息条目（文本 / 图片 / 语音 / 文件 / 视频 + 引用）。 */
export interface ILinkMessageItem {
  type?: number
  msg_id?: string
  ref_msg?: { message_item?: ILinkMessageItem; title?: string }
  text_item?: ILinkTextItem
  voice_item?: ILinkVoiceItem
  [key: string]: unknown
}

/** iLink 入站消息。 */
export interface ILinkMessage {
  seq?: number
  message_id?: number
  from_user_id?: string
  to_user_id?: string
  client_id?: string
  create_time_ms?: number
  message_type?: number
  item_list?: ILinkMessageItem[]
  context_token?: string
  [key: string]: unknown
}

/** 扫码登录回调（on_qrcode 首帧二维码、on_scanned 已扫码、on_expired 二维码过期）。 */
export interface ILinkLoginCallbacks {
  on_qrcode?: (url: string) => void
  on_scanned?: () => void
  on_expired?: (attempt: number, maxAttempts: number) => void
}

/** 扫码登录结果：connected=false 时 message 为失败原因。 */
export interface ILinkLoginResult {
  connected: boolean
  bot_token?: string
  bot_id?: string
  base_url?: string
  user_id?: string
  message: string
}

/** 长轮询监听选项（游标 / 错误 / 会话过期 / 继续条件）。 */
export interface ILinkMonitorOptions {
  initial_buf?: string
  on_buf_update?: (buf: string) => void
  on_error?: (error: Error) => void
  on_session_expired?: () => void
  should_continue?: () => boolean
}

/** 客户端构造参数（端点 / 注入的 fetch 实现）。 */
export interface ILinkClientOptions {
  /** iLink base_url（留空用官方端点） */
  baseUrl?: string | undefined
  /** 注入的 fetch 实现（测试 / 代理用） */
  fetchImpl?: typeof fetch | undefined
}

/**
 * 窄 SDK 接口：本插件只用到的 6 个方法。
 * 官方 SDK 的 Client 与本文件自带的 FetchILinkClient 都满足它。
 */
export interface ILinkClient {
  loginWithQr(callbacks?: ILinkLoginCallbacks, timeoutMs?: number): Promise<ILinkLoginResult>
  monitor(handler: (message: ILinkMessage) => void | Promise<void>, options?: ILinkMonitorOptions): Promise<void>
  push(to: string, text: string): Promise<string>
  getContextToken(userId: string): string | undefined
  setContextToken(userId: string, token: string): void
}

/** 客户端工厂（接缝注入点）。 */
export type ILinkClientFactory = (token: string, options: ILinkClientOptions) => ILinkClient | Promise<ILinkClient>

// --- 文本抽取（逐字移植官方 SDK dist/message-helper.js） ---

const ITEM_TYPE_IMAGE = 2
const ITEM_TYPE_VOICE = 3
const ITEM_TYPE_FILE = 4
const ITEM_TYPE_VIDEO = 5

function isMediaItem(item: ILinkMessageItem | undefined): boolean {
  if (!item) return false
  return (
    item.type === ITEM_TYPE_IMAGE ||
    item.type === ITEM_TYPE_VIDEO ||
    item.type === ITEM_TYPE_FILE ||
    item.type === ITEM_TYPE_VOICE
  )
}

/**
 * 取消息正文：优先 text_item（含引用前缀），其次语音转写；都没有则空串。
 * @param message - iLink 入站消息。
 * @returns 正文文本；无正文返回空串。
 */
export function extractText(message: ILinkMessage): string {
  const items = message.item_list ?? []
  for (const item of items) {
    if (item.type === ITEM_TYPE_TEXT && typeof item.text_item?.text === 'string') {
      let text = item.text_item.text
      const ref = item.ref_msg
      if (ref?.message_item && !isMediaItem(ref.message_item)) {
        const refBody = typeof ref.message_item.text_item?.text === 'string' ? ref.message_item.text_item.text : ''
        const title = typeof ref.title === 'string' ? ref.title : ''
        if (title !== '' || refBody !== '') {
          text = `[引用: ${title} | ${refBody}]\n${text}`
        }
      }
      return text
    }
  }
  for (const item of items) {
    if (item.type === ITEM_TYPE_VOICE && typeof item.voice_item?.text === 'string' && item.voice_item.text !== '') {
      return item.voice_item.text
    }
  }
  return ''
}

// --- 自带的 fetch 实现（官方 SDK 的零依赖等价子集） ---

interface ILinkUpdatesResponse {
  ret?: number | string
  errcode?: number | string
  errmsg?: string
  msgs?: ILinkMessage[]
  get_updates_buf?: string
  sync_buf?: string
  longpolling_timeout_ms?: number
}

interface ILinkQRCodeResponse {
  qrcode?: string
  qrcode_img_content?: string
}

interface ILinkQRStatusResponse {
  status?: string
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
  redirect_host?: string
}

/** 把 "2.1.6" 之类的版本号编码成官方 SDK 的整数形式。 */
function encodeClientVersion(version: string): number {
  const parts = version.split('.').map(Number)
  const major = (parts[0] ?? 0) & 0xff
  const minor = (parts[1] ?? 0) & 0xff
  const patch = (parts[2] ?? 0) & 0xff
  return (major << 16) | (minor << 8) | patch
}

/**
 * 零依赖 iLink 客户端（fetch 实现）。
 * 端点、请求体、请求头与长轮询状态机逐字对齐官方 SDK 0.6.0。
 */
export class FetchILinkClient implements ILinkClient {
  private token: string
  private baseUrl: string
  private loginBaseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly contextTokens = new Map<string, string>()

  constructor(token = '', options: ILinkClientOptions = {}) {
    this.token = token
    this.baseUrl = options.baseUrl ?? ILINK_DEFAULT_BASE_URL
    this.loginBaseUrl = options.baseUrl ?? ILINK_DEFAULT_BASE_URL
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /**
   * 设置连接凭证。
   * @param token - iLink bot_token。
   */
  setToken(token: string): void {
    this.token = token
  }

  /**
   * 设置 iLink 端点。
   * @param baseUrl - iLink base_url。
   */
  setBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl
  }

  getContextToken(userId: string): string | undefined {
    return this.contextTokens.get(userId)
  }

  setContextToken(userId: string, token: string): void {
    this.contextTokens.set(userId, token)
  }

  // --- HTTP 底座 ---

  private buildUrl(endpoint: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`
  }

  private commonHeaders(): Record<string, string> {
    return {
      'iLink-App-Id': ILINK_APP_ID,
      'iLink-App-ClientVersion': String(encodeClientVersion(ILINK_CHANNEL_VERSION)),
    }
  }

  private buildHeaders(body: string | undefined, extraHeaders: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.commonHeaders(),
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': Buffer.from(randomBytes(4).readUInt32BE(0).toString(10)).toString('base64'),
      ...extraHeaders,
    }
    if (typeof body === 'string') headers['Content-Length'] = String(Buffer.byteLength(body))
    const token = this.token.trim()
    if (token) headers['Authorization'] = `Bearer ${token}`
    return headers
  }

  private async requestText(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: string | undefined,
    timeoutMs: number,
  ): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, timeoutMs)
    const init: RequestInit = {
      method,
      headers,
      redirect: 'manual',
      signal: controller.signal,
    }
    if (body !== undefined) init.body = body
    let response: Response
    try {
      response = await this.fetchImpl(url, init)
    } catch (err) {
      throw new Error(`ilink: HTTP request failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      clearTimeout(timer)
    }
    const text = await response.text()
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`ilink: http ${String(response.status)}: ${text}`)
    }
    return text
  }

  private decodeJson(body: string, operation: string): unknown {
    let decoded: unknown
    try {
      decoded = JSON.parse(body)
    } catch (err) {
      throw new Error(`Failed to decode ${operation} response: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
      throw new Error(`${operation} response is not a JSON object.`)
    }
    return decoded
  }

  private async doPost(endpoint: string, payload: unknown, timeoutMs: number): Promise<string> {
    const body = JSON.stringify(payload)
    return this.requestText(
      'POST',
      this.buildUrl(endpoint),
      this.buildHeaders(body, { 'Content-Type': 'application/json' }),
      body,
      timeoutMs,
    )
  }

  private async doGetText(url: string, timeoutMs: number): Promise<string> {
    return this.requestText('GET', url, this.commonHeaders(), undefined, timeoutMs)
  }

  // --- 协议动作 ---

  /**
   * 拉取增量消息（长轮询）。
   * @param getUpdatesBuf - 上一次的服务端游标。
   * @param timeoutMs - 长轮询超时（毫秒）。
   * @returns 服务端响应（含 msgs 与新游标）。
   */
  async getUpdates(getUpdatesBuf = '', timeoutMs = LONG_POLL_TIMEOUT_MS): Promise<ILinkUpdatesResponse> {
    const request = { get_updates_buf: getUpdatesBuf, base_info: { channel_version: ILINK_CHANNEL_VERSION } }
    try {
      const body = await this.doPost('ilink/bot/getupdates', request, timeoutMs)
      return this.decodeJson(body, 'getUpdates') as ILinkUpdatesResponse
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf }
      }
      throw err
    }
  }

  /**
   * 发送一条 iLink 消息体。
   * @param message - 出站消息体。
   */
  async sendMessage(message: Record<string, unknown>): Promise<void> {
    await this.doPost(
      'ilink/bot/sendmessage',
      { msg: message, base_info: { channel_version: ILINK_CHANNEL_VERSION } },
      API_TIMEOUT_MS,
    )
  }

  /**
   * 发文本（需 context_token）。
   * @param to - 收件人微信外部 id。
   * @param text - 文本内容。
   * @param contextToken - 会话上下文令牌。
   * @returns 本条消息的 client_id。
   */
  async sendText(to: string, text: string, contextToken: string): Promise<string> {
    const clientId = `openclaw-weixin:${String(Date.now())}-${randomBytes(4).toString('hex')}`
    await this.sendMessage({
      from_user_id: '',
      to_user_id: to,
      client_id: clientId,
      message_type: MESSAGE_TYPE_BOT,
      message_state: MESSAGE_STATE_FINISH,
      context_token: contextToken,
      item_list: [{ type: ITEM_TYPE_TEXT, text_item: { text } }],
    })
    return clientId
  }

  /**
   * 主动推送：必须已有 context_token（对方先给本 bot 发过消息）。
   * @param to - 收件人微信外部 id。
   * @param text - 文本内容。
   * @returns 本条消息的 client_id。
   */
  async push(to: string, text: string): Promise<string> {
    const token = this.getContextToken(to)
    if (!token) throw new Error('ilink: no cached context token; user must send a message first')
    return this.sendText(to, text, token)
  }

  /**
   * 拉取登录二维码。
   * @returns 二维码载荷（qrcode / qrcode_img_content）。
   */
  async fetchQRCode(): Promise<ILinkQRCodeResponse> {
    const savedBaseUrl = this.baseUrl
    this.baseUrl = this.loginBaseUrl
    try {
      const url = new URL(this.buildUrl('ilink/bot/get_bot_qrcode'))
      url.searchParams.set('bot_type', ILINK_BOT_TYPE)
      const body = await this.doGetText(url.toString(), API_TIMEOUT_MS)
      return this.decodeJson(body, 'fetchQRCode') as ILinkQRCodeResponse
    } finally {
      this.baseUrl = savedBaseUrl
    }
  }

  /**
   * 轮询二维码状态（长轮询）。
   * @param qrcode - 二维码 id。
   * @param baseUrl - 轮询端点（redirect 时切到新主机）。
   * @returns 状态载荷。
   */
  async pollQRStatus(qrcode: string, baseUrl?: string): Promise<ILinkQRStatusResponse> {
    const base = (baseUrl || this.baseUrl).replace(/\/+$/, '')
    const url = new URL(`${base}/ilink/bot/get_qrcode_status`)
    url.searchParams.set('qrcode', qrcode)
    try {
      const body = await this.doGetText(url.toString(), QR_LONG_POLL_TIMEOUT_MS)
      return this.decodeJson(body, 'pollQRStatus') as ILinkQRStatusResponse
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return { status: 'wait' }
      throw err
    }
  }

  /** 扫码登录：取码 → 轮询状态（scaned / scaned_but_redirect / expired / confirmed）。 */
  async loginWithQr(callbacks: ILinkLoginCallbacks = {}, timeoutMs = 480_000): Promise<ILinkLoginResult> {
    const deadline = Date.now() + timeoutMs
    const qrBaseUrl = this.loginBaseUrl
    const qr = await this.fetchQRCode()
    let currentQr = qr.qrcode ?? ''
    callbacks.on_qrcode?.(qr.qrcode_img_content ?? '')
    let scannedNotified = false
    let refreshCount = 1
    let pollBaseUrl = qrBaseUrl
    while (Date.now() <= deadline) {
      const status = await this.pollQRStatus(currentQr, pollBaseUrl)
      switch (status.status ?? 'wait') {
        case 'scaned':
          if (!scannedNotified) {
            scannedNotified = true
            callbacks.on_scanned?.()
          }
          break
        case 'scaned_but_redirect':
          if (status.redirect_host) pollBaseUrl = `https://${status.redirect_host}`
          break
        case 'expired': {
          refreshCount += 1
          if (refreshCount > QR_MAX_REFRESH) {
            return { connected: false, message: 'QR code expired too many times' }
          }
          callbacks.on_expired?.(refreshCount, QR_MAX_REFRESH)
          const refreshedQr = await this.fetchQRCode()
          currentQr = refreshedQr.qrcode ?? ''
          scannedNotified = false
          callbacks.on_qrcode?.(refreshedQr.qrcode_img_content ?? '')
          break
        }
        case 'confirmed': {
          const botId = status.ilink_bot_id ?? ''
          if (botId === '') return { connected: false, message: 'server did not return bot ID' }
          this.token = status.bot_token ?? ''
          if (status.baseurl) this.baseUrl = status.baseurl
          return {
            connected: true,
            bot_token: status.bot_token ?? '',
            bot_id: botId,
            base_url: status.baseurl ?? '',
            user_id: status.ilink_user_id ?? '',
            message: 'connected',
          }
        }
        default:
          break
      }
      await this.sleep(1_000)
    }
    return { connected: false, message: 'login timeout' }
  }

  /** 长轮询监听（退避重试 + 会话过期暂停 + 游标推进）。 */
  async monitor(
    handler: (message: ILinkMessage) => void | Promise<void>,
    options: ILinkMonitorOptions = {},
  ): Promise<void> {
    let buf = options.initial_buf ?? ''
    let failures = 0
    let nextTimeoutMs: number | undefined
    const onError = options.on_error ?? ((): void => {})
    while (this.shouldContinue(options.should_continue)) {
      let response: ILinkUpdatesResponse
      try {
        response = await this.getUpdates(buf, nextTimeoutMs ?? LONG_POLL_TIMEOUT_MS)
      } catch (err) {
        failures += 1
        onError(new Error(`getUpdates (${String(failures)}/${String(MAX_CONSECUTIVE_FAILURES)}): ${err instanceof Error ? err.message : String(err)}`))
        await this.sleep(failures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS, options.should_continue)
        if (failures >= MAX_CONSECUTIVE_FAILURES) failures = 0
        continue
      }
      if (typeof response.longpolling_timeout_ms === 'number' && response.longpolling_timeout_ms > 0) {
        nextTimeoutMs = response.longpolling_timeout_ms
      }
      const ret = Number(response.ret ?? 0)
      const errCode = Number(response.errcode ?? 0)
      if (ret !== 0 || errCode !== 0) {
        const sessionExpired = errCode === SESSION_EXPIRED_ERR_CODE || ret === SESSION_EXPIRED_ERR_CODE
        if (sessionExpired) {
          options.on_session_expired?.()
          onError(new Error(`ilink: api error ret=${String(ret)} errcode=${String(errCode)} errmsg=${response.errmsg ?? ''}`))
          failures = 0
          await this.sleep(SESSION_EXPIRED_PAUSE_MS, options.should_continue)
          continue
        }
        failures += 1
        onError(new Error(`getUpdates (${String(failures)}/${String(MAX_CONSECUTIVE_FAILURES)}): errcode=${String(errCode)} ${response.errmsg ?? ''}`))
        await this.sleep(failures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS, options.should_continue)
        if (failures >= MAX_CONSECUTIVE_FAILURES) failures = 0
        continue
      }
      failures = 0
      if (response.get_updates_buf) {
        buf = response.get_updates_buf
        options.on_buf_update?.(buf)
      }
      for (const message of response.msgs ?? []) {
        if (message.context_token && message.from_user_id) {
          this.contextTokens.set(message.from_user_id, message.context_token)
        }
        await handler(message)
      }
    }
  }

  private shouldContinue(callback: (() => boolean) | undefined): boolean {
    return callback ? callback() : true
  }

  private async sleep(ms: number, shouldContinue?: () => boolean): Promise<void> {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (shouldContinue && !this.shouldContinue(shouldContinue)) return
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 250)
      })
    }
  }
}

// --- SDK 接缝注入点 ---

let clientFactory: ILinkClientFactory = (token: string, options: ILinkClientOptions): ILinkClient =>
  new FetchILinkClient(token, options)

/**
 * 替换客户端工厂（宿主注入官方 SDK 客户端时用）。传 null 恢复默认 fetch 实现。
 * @param factory - 客户端工厂；null 表示恢复默认。
 */
export function setILinkClientFactory(factory: ILinkClientFactory | null): void {
  clientFactory = factory ?? ((token, options) => new FetchILinkClient(token, options))
}

/**
 * 取当前客户端工厂。
 * @returns 客户端工厂。
 */
export function getILinkClientFactory(): ILinkClientFactory {
  return clientFactory
}

/**
 * 把官方 SDK 的模块对象适配成本包的窄接口。
 * @param sdkModule - `@openilink/openilink-sdk-node` 的模块对象（宿主自行 import 后传入）。
 * @returns 可直接交给 setILinkClientFactory 的工厂。
 */
export function createSdkILinkClientFactory(sdkModule: unknown): ILinkClientFactory {
  const sdk = sdkModule as
    | { Client?: new (token?: string, config?: Record<string, unknown>) => ILinkClient }
    | null
    | undefined
  const ClientCtor = sdk?.Client
  if (typeof ClientCtor !== 'function') {
    throw new Error('ilink: SDK 模块缺少 Client 导出')
  }
  return (token: string, options: ILinkClientOptions): ILinkClient => {
    const config: Record<string, unknown> = {}
    if (options.baseUrl) config['base_url'] = options.baseUrl
    return new ClientCtor(token, config)
  }
}

// --- 扫码绑定会话（内存缓存 + global_settings 持久化） ---
// dev 模式下模块重编译会清空模块级 Map，会话一旦写库，轮询接口仍能从
// DB 找回同一 session 继续扫码确认，避免"会话不存在"误报。

/** 扫码绑定会话状态（内存缓存 + global_settings 双写）。 */
export interface ILinkBindState {
  status: 'wait' | 'scanned' | 'expired' | 'confirmed' | 'failed'
  qrImg: string
  error?: string | undefined
  result?: { botId: string; botToken: string; baseUrl?: string | undefined; iLinkUserId?: string | undefined } | undefined
  expiresAt: number
}

const bindSessions = new Map<string, ILinkBindState>()
const BIND_TTL_MS = 5 * 60 * 1000

function persistBind(storage: LittlyStorage, session: string, state: ILinkBindState): void {
  bindSessions.set(session, state)
  setBindSession(storage, session, state)
}

function readBind(storage: LittlyStorage, session: string): ILinkBindState | null {
  const mem = bindSessions.get(session)
  if (mem && Date.now() <= mem.expiresAt) return mem
  if (mem) bindSessions.delete(session)
  // 内存 miss/过期 → 兜底读 DB（模块重载后内存清空，靠这里恢复）
  const stored = getBindSession(storage, session)
  if (stored) bindSessions.set(session, stored)
  return stored
}

function removeBind(storage: LittlyStorage, session: string): void {
  bindSessions.delete(session)
  deleteBindSession(storage, session)
}

/** 插件侧运行时依赖（storage / log）；monitor 之外的调用只需要这些。 */
export interface ILinkRuntimeDeps {
  storage: LittlyStorage
  log: (msg: string, ...args: unknown[]) => void
}

/** 插件侧依赖（index.ts 组装；onMessage 注入 inbound 的处理入口，避免模块环）。 */
export interface ILinkDeps extends ILinkRuntimeDeps {
  /** 入站消息处理（index.ts 注入，实现在 inbound.ts） */
  onMessage: (bot: BotRow, fromUser: string, text: string) => Promise<void>
}

// --- 微信身份认领 ---

/**
 * iLink 扫码确认后，把扫码者的微信身份（ilink_user_id）绑定到当前登录用户。
 * 与 TG 绑定码 / 微信绑定码同一套 ChannelIdentity 模型：
 *   1. 该微信外部身份已被其他账号占用 → 冲突，绝不静默抢占（§6.3）
 *   2. 换号：移除该用户原有 wechat 身份（自己的数据，安全自替换）
 *   3. 晋升：该微信身份在所有角色下未绑定的同名 Contact 认领为登录用户（历史记忆全保留）
 * @param storage - 业务存储。
 * @param botId - 当前 bot id（用于本 bot 下的即时认领）。
 * @param userId - 平台用户 id（扫码者）。
 * @param wxExternalId - 微信外部 id（iLink user_id）。
 */
export async function claimWechatIdentity(
  storage: LittlyStorage,
  botId: string,
  userId: string,
  wxExternalId: string,
): Promise<void> {
  const taken = storage
    .prepare('SELECT user_id FROM channel_identities WHERE channel = ? AND external_id = ?')
    .get('wechat', wxExternalId) as { user_id: string } | undefined
  if (taken && taken.user_id !== userId) {
    return
  }
  const now = new Date().toISOString()
  storage.db.exec('BEGIN IMMEDIATE')
  try {
    storage
      .prepare('DELETE FROM channel_identities WHERE user_id = ? AND channel = ?')
      .run(userId, 'wechat')
    storage
      .prepare('INSERT INTO channel_identities (id, user_id, channel, external_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), userId, 'wechat', wxExternalId, now)
    // 晋升：该微信身份在所有角色下未绑定的 Contact 认领为登录用户
    storage
      .prepare("UPDATE contacts SET user_id = ? WHERE channel = 'wechat' AND user_id IS NULL AND (sender = ? OR external_id = ?)")
      .run(userId, wxExternalId, wxExternalId)
    storage.db.exec('COMMIT')
  } catch (err) {
    storage.db.exec('ROLLBACK')
    throw err
  }
  // 本 bot 下的联系人即时认领（该角色当前账号）
  storage
    .prepare("UPDATE contacts SET user_id = ? WHERE bot_id = ? AND channel = 'wechat' AND user_id IS NULL AND (sender = ? OR external_id = ?)")
    .run(userId, botId, wxExternalId, wxExternalId)
}

// --- 扫码绑定 ---

/**
 * 发起扫码绑定：后台跑 loginWithQr 完整流程（自动刷新二维码、处理 redirect_host），
 * 前端通过 session id 轮询状态。
 * @param deps - 插件依赖（storage / log / onMessage）。
 * @param botId - 目标 bot（凭证写入该行）。
 * @param userId - 当前登录用户（扫码者）；绑定确认后用它认领扫码者的微信身份。
 * @param timeoutMs - 扫码登录超时（毫秒）。
 * @returns 会话 id 与首帧二维码内容。
 */
export async function startILinkBind(
  deps: ILinkDeps,
  botId: string,
  userId?: string,
  timeoutMs = 4 * 60 * 1000,
): Promise<{ session: string; qrImg: string }> {
  const session = `ilink-bind-${botId}-${String(Date.now())}`
  const state: ILinkBindState = { status: 'wait', qrImg: '', expiresAt: Date.now() + BIND_TTL_MS }
  persistBind(deps.storage, session, state)
  setTimeout(() => {
    removeBind(deps.storage, session)
  }, BIND_TTL_MS + 1000)

  const client = await getILinkClientFactory()('', {})
  // 首帧二维码就绪的 Promise：SDK 的 fetchQRCode 是网络往返，on_qrcode 异步触发，
  // 不等它就返回会让前端拿到空 qrImg 显示不出来。用一次性 resolve 等首个二维码到位。
  let firstQrResolve: (() => void) | null = null
  const firstQrReady = new Promise<void>((resolve) => {
    firstQrResolve = resolve
  })
  const settleFirst = (): void => {
    firstQrResolve?.()
    firstQrResolve = null
  }

  // 登录确认成功 → 立即落库并启动监听（不依赖前端轮询触发，否则轮询一停 token 永远不落库）
  const commitBind = async (res: ILinkLoginResult): Promise<void> => {
    const result = {
      botId: res.bot_id ?? '',
      botToken: res.bot_token ?? '',
      baseUrl: res.base_url,
      iLinkUserId: res.user_id,
    }
    // 先写库成功再置 confirmed：写库失败时状态必须保持 failed，
    // 否则前端显示"绑定成功"但 token 没落库、monitor 没启动，消息收发全失灵。
    if (!result.botToken) {
      state.status = 'failed'
      state.error = '服务端未返回 bot_token（绑定未成功）'
      persistBind(deps.storage, session, { ...state })
      deps.log('[ilink] 登录返回空 token (botId=%s)', botId)
      return
    }
    try {
      deps.storage
        .prepare('UPDATE bots SET wx_enabled = 1, wx_hub_bot_id = ?, wx_push_token = ?, wx_push_endpoint = ? WHERE id = ?')
        .run(result.botId, result.botToken, result.baseUrl ?? '', botId)
      // §身份认领 — 扫码者（当前登录用户）的微信身份写入 ChannelIdentity，
      // 之后该微信号发来的消息会被 promoteContact 认领为本人，而不是新联系人。
      if (userId && result.iLinkUserId) {
        await claimWechatIdentity(deps.storage, botId, userId, result.iLinkUserId)
      }
      const bot = deps.storage.prepare('SELECT * FROM bots WHERE id = ?').get(botId) as BotRow | undefined
      if (bot) void startILinkMonitor(deps, bot)
      state.result = result
      state.status = 'confirmed'
      deps.log(
        '[ilink] 绑定成功 (bot=%s): bot_id=%s token=✓%s',
        bot?.name ?? botId,
        result.botId,
        userId ? ` identity=${result.iLinkUserId}` : '',
      )
    } catch (err) {
      state.status = 'failed'
      state.error = `凭证写入失败: ${err instanceof Error ? err.message : String(err)}`
      deps.log('[ilink] 绑定成功但写库失败 (botId=%s): %s', botId, String(err))
    }
    persistBind(deps.storage, session, { ...state })
  }

  client
    .loginWithQr(
      {
        on_qrcode: (img: string) => {
          state.qrImg = img
          if (state.status !== 'scanned') state.status = 'wait'
          persistBind(deps.storage, session, { ...state })
          deps.log('[ilink] 二维码已获取 (botId=%s, len=%s)', botId, String(img.length))
          settleFirst()
        },
        on_scanned: () => {
          state.status = 'scanned'
          persistBind(deps.storage, session, { ...state })
          deps.log('[ilink] 已扫码，等待确认 (botId=%s)', botId)
        },
        on_expired: () => {
          state.status = 'expired'
          persistBind(deps.storage, session, { ...state })
          deps.log('[ilink] 二维码过期，自动刷新 (botId=%s)', botId)
        },
      },
      timeoutMs,
    )
    .then(async (res) => {
      if (res.connected) {
        await commitBind(res)
      } else {
        state.status = 'failed'
        state.error = res.message
        persistBind(deps.storage, session, { ...state })
        deps.log('[ilink] 登录失败 (botId=%s): %s', botId, res.message)
      }
    })
    .catch((err: unknown) => {
      state.status = 'failed'
      state.error = err instanceof Error ? err.message : String(err)
      persistBind(deps.storage, session, { ...state })
      deps.log('[ilink] 登录异常 (botId=%s): %s', botId, String(err))
    })
    .finally(() => {
      // 登录流程结束（成功/失败/超时）也解锁首帧等待，避免接口挂着
      settleFirst()
    })

  // 等待首个二维码（fetchQRCode 默认 15s 超时）→ 前端首帧就能拿到真实二维码内容
  await Promise.race([
    firstQrReady,
    new Promise<void>((r) => {
      setTimeout(r, 20_000)
    }),
  ])
  return { session, qrImg: state.qrImg }
}

/**
 * 轮询绑定状态；confirmed 时把凭证写入对应 Bot 并启动消息监听。
 * @param deps - 插件依赖。
 * @param session - 扫码会话 id。
 * @param botId - 目标 bot id（写入凭证）。
 * @returns 当前绑定状态。
 */
export async function pollILinkBind(
  deps: ILinkDeps,
  session: string,
  botId?: string,
): Promise<ILinkBindState> {
  const state = readBind(deps.storage, session)
  if (!state) return { status: 'failed', qrImg: '', error: '会话不存在或已过期，请重新扫码', expiresAt: Date.now() }

  if (state.status === 'confirmed' && state.result && botId) {
    try {
      deps.storage
        .prepare('UPDATE bots SET wx_enabled = 1, wx_hub_bot_id = ?, wx_push_token = ?, wx_push_endpoint = ? WHERE id = ?')
        .run(state.result.botId, state.result.botToken, state.result.baseUrl ?? '', botId)
      // 绑定成功 → 立即启动消息监听
      const bot = deps.storage.prepare('SELECT * FROM bots WHERE id = ?').get(botId) as BotRow | undefined
      if (bot) void startILinkMonitor(deps, bot)
      removeBind(deps.storage, session)
    } catch (err) {
      state.status = 'failed'
      state.error = err instanceof Error ? err.message : String(err)
      persistBind(deps.storage, session, { ...state })
    }
  }
  return { ...state }
}

// --- 消息监听（长轮询后台任务） ---

const monitors = new Map<string, { client: ILinkClient; stop: () => void }>()

/**
 * 自愈：模块重载/进程重启后内存 Map 清空，但 token 已入库。
 * 定时调用，把「已绑定但没在监听」的 bot 补启动（幂等，已在跑则跳过）。
 * @param deps - 插件依赖。
 * @returns 本次新启动的 monitor 数量。
 */
export async function ensureILinkMonitors(deps: ILinkDeps): Promise<number> {
  const bots = deps.storage
    .prepare("SELECT * FROM bots WHERE wx_enabled = 1 AND wx_push_token != ''")
    .all() as BotRow[]
  let started = 0
  for (const bot of bots) {
    if (monitors.has(bot.id)) continue
    if (await startILinkMonitor(deps, bot)) started++
  }
  return started
}

/**
 * 为已绑定 iLink 的 bot 启动 monitor；幂等（已在跑则跳过）。
 * @param deps - 插件依赖。
 * @param bot - 目标 bot 行。
 * @returns 是否已在监听（含本次启动）。
 */
export async function startILinkMonitor(deps: ILinkDeps, bot: BotRow): Promise<boolean> {
  if (!bot.wx_enabled || !bot.wx_push_token) {
    deps.log('[ilink] 跳过监听 (bot=%s): wx_enabled=%s wx_push_token=%s', bot.name, String(bot.wx_enabled), bot.wx_push_token ? '✓' : '空')
    return false
  }
  if (monitors.has(bot.id)) return true

  const client = await getILinkClientFactory()(
    bot.wx_push_token,
    bot.wx_push_endpoint ? { baseUrl: bot.wx_push_endpoint } : {},
  )
  const initialBuf = getSyncBuf(deps.storage, bot.id)
  let running = true

  deps.log('[ilink] 启动监听 (bot=%s, botId=%s, endpoint=%s)', bot.name, bot.id, bot.wx_push_endpoint || '默认')
  const task = client
    .monitor(
      async (msg) => {
        try {
          deps.log('[ilink] 收到消息 (bot=%s, from=%s, hasText=%s)', bot.name, msg.from_user_id ?? '?', extractText(msg) ? '✓' : '✗')
          await handleILinkMessage(deps, bot, msg)
        } catch (err) {
          deps.log('[ilink] handle msg failed (bot=%s): %s', bot.name, String(err))
        }
      },
      {
        initial_buf: initialBuf,
        on_buf_update: (buf: string) => {
          setSyncBuf(deps.storage, bot.id, buf)
        },
        on_error: (e: Error) => {
          deps.log('[ilink] monitor error (bot=%s): %s', bot.name, e.message)
        },
        on_session_expired: () => {
          deps.log('[ilink] session expired (bot=%s) — 需要重新扫码绑定', bot.name)
        },
        should_continue: () => running,
      },
    )
    .catch((err: unknown) => {
      monitors.delete(bot.id)
      deps.log('[ilink] monitor stopped (bot=%s): %s', bot.name, String(err))
    })
  monitors.set(bot.id, { client, stop: () => { running = false } })
  // 保持 task 引用防 GC（monitor 是长循环，正常不会 resolve）
  void task
  return true
}

/** 停止全部 monitor（插件卸载时调用；让长轮询循环在下一轮退出）。 */
export function stopAllILinkMonitors(): void {
  for (const entry of [...monitors.values()]) entry.stop()
  monitors.clear()
}

/** iLink 入站消息 → 会话状态存储 → 正常入站链路。 */
async function handleILinkMessage(deps: ILinkDeps, bot: BotRow, msg: ILinkMessage): Promise<void> {
  const sender = msg.from_user_id ?? ''
  if (!sender) return
  // 持久化 context_token：跨重启后 push 仍可用
  if (msg.context_token) setContextToken(deps.storage, bot.id, sender, msg.context_token)
  const text = extractText(msg)
  if (!text) return
  await deps.onMessage(bot, sender, text)
}

// --- 主动发送（供 inbound 的 pushWechatText 使用） ---

/**
 * iLink 主动推送文本。
 * @param deps - 插件依赖。
 * @param bot - 目标 bot 行（凭证来源）。
 * @param toUser - 目标微信外部 id（原始 from_user_id）。
 * @param text - 文本内容。
 * @returns 是否推送成功。
 */
export async function pushILinkText(
  deps: ILinkRuntimeDeps,
  bot: BotRow,
  toUser: string,
  text: string,
): Promise<boolean> {
  if (!bot.wx_push_token || !toUser) {
    deps.log('[ilink] push 被跳过 (bot=%s): wx_push_token=%s toUser=%s', bot.name, bot.wx_push_token ? '✓' : '空', toUser)
    return false
  }
  const client = await getILinkClientFactory()(
    bot.wx_push_token,
    bot.wx_push_endpoint ? { baseUrl: bot.wx_push_endpoint } : {},
  )
  // SDK 内存 context_token 缓存重启即失 → 用持久化的恢复
  const ctx = getContextToken(deps.storage, bot.id, toUser)
  if (ctx && !client.getContextToken(toUser)) client.setContextToken(toUser, ctx)
  if (!client.getContextToken(toUser)) {
    deps.log('[ilink] push 缺少 context_token (bot=%s, to=%s) — 对方尚未给本 bot 发过消息，无法主动推送', bot.name, toUser)
    return false
  }
  deps.log('[ilink] push (bot=%s, to=%s, len=%s)', bot.name, toUser, String(text.length))
  await client.push(toUser, text)
  return true
}
