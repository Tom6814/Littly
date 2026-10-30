/**
 * iLink Bot API 协议客户端（微信 ClawBot 直连，零依赖 fetch）。
 *
 * 逐字对齐 openilink 官方 Go SDK（`/tmp/ois-go`，协议真源）：
 * - `client.go`：端点、`commonHeaders`/`buildHeaders`、doGet/doPost、GetUpdates/SendMessage/
 *   SendText/SendTyping/GetConfig/Push、context_token 缓存。
 * - `auth.go`：FetchQRCode/PollQRStatus/LoginWithQR 状态机（35s 长轮询、redirect、expired 换码）。
 * - `types.go`：全部请求/响应结构（字段名、枚举值逐字照抄）。
 * - `helpers.go`：encodeClientVersion、randomWechatUIN、generateClientID、extractText。
 *
 * 设计要点：
 * - 只做协议 I/O 与消息编解码，**不碰数据库/业务**（持久化见 ilink-store.ts，绑定会话见
 *   ilink-bind.ts，账号轮询见 ilink-account.ts）。
 * - 长轮询超时/网络错误是常态（网关 524、连接被断）：`pollQrStatus` 返回 `wait`，
 *   `getUpdates` 返回空响应（保留旧游标），绝不向上抛。
 * - `fetchImpl` 可注入，mock 测试用本地 node:http 即可全链路验证。
 */

/** 生产环境 iLink Bot API 端点（协议真源 DefaultBaseURL）。 */
export const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'
/** 二维码登录的 bot_type（SDK DefaultBotType = "3"）。 */
export const ILINK_BOT_TYPE = '3'
/** 兼容的渠道版本（SDK iLinkChannelVersion，进 base_info.channel_version 与请求头）。 */
export const ILINK_CHANNEL_VERSION = '2.1.6'
/** iLink-App-Id 固定值（SDK iLinkAppID）。 */
export const ILINK_APP_ID = 'bot'

/** 二维码状态长轮询超时（35s，SDK qrLongPollTimeout）。 */
export const QR_LONG_POLL_TIMEOUT_MS = 35_000
/** 消息长轮询默认超时（35s，SDK defaultLongPollTimeout）。 */
export const UPDATES_LONG_POLL_TIMEOUT_MS = 35_000
/** 普通 API 超时（15s，SDK defaultAPITimeout）。 */
export const API_TIMEOUT_MS = 15_000
/** bot 配置/输入状态超时（10s，SDK defaultConfigTimeout）。 */
export const CONFIG_TIMEOUT_MS = 10_000

/** 消息类型：1 = 用户消息，2 = bot 消息（types.go MessageType）。 */
export const MESSAGE_TYPE_USER = 1
export const MESSAGE_TYPE_BOT = 2
/** 消息状态：2 = 完成（types.go MessageState）。 */
export const MESSAGE_STATE_FINISH = 2
/** 消息条目类型（types.go MessageItemType）。 */
export const ITEM_TYPE_TEXT = 1
export const ITEM_TYPE_IMAGE = 2
export const ITEM_TYPE_VOICE = 3
export const ITEM_TYPE_FILE = 4
export const ITEM_TYPE_VIDEO = 5
/** 输入状态：1 = 正在输入，2 = 取消（types.go TypingStatus）。 */
export const TYPING = 1
export const CANCEL_TYPING = 2
/** 会话过期错误码（errcode/ret = -14 → 需要重新扫码）。 */
export const SESSION_EXPIRED_ERR_CODE = -14

// --- 协议数据结构（types.go 子集，字段名与 JSON tag 逐字一致） ---

/** 请求公共信息（types.go BaseInfo）。 */
export interface ILinkBaseInfo {
  channel_version?: string
}

/** 二维码响应（types.go QRCodeResponse）。 */
export interface ILinkQRCodeResponse {
  /** 二维码 id（轮询状态时的 qrcode 参数）。 */
  qrcode: string
  /** 待展示的二维码内容（实测是 `https://liteapp.weixin.qq.com/q/...` 文本，需客户端渲染成二维码）。 */
  qrcode_img_content: string
}

/** 扫码状态字面量（注意协议拼写是 `scaned`，只有一个 n）。 */
export type ILinkQRStatus = 'wait' | 'scaned' | 'scaned_but_redirect' | 'expired' | 'confirmed'

/** 扫码状态响应（types.go QRStatusResponse）。 */
export interface ILinkQRStatusResponse {
  status: ILinkQRStatus | string
  bot_token?: string
  ilink_bot_id?: string
  /** confirmed 后 API 端点（可能与登录端点不同 host）。 */
  baseurl?: string
  ilink_user_id?: string
  /** status=scaned_but_redirect 时的轮询 host（后续状态轮询切到 https://<host>）。 */
  redirect_host?: string
}

/** 扫码确认后的四元凭据（与 SPEC §3 的 {bot_token, baseurl, ilink_bot_id, ilink_user_id} 一致）。 */
export interface ILinkCredentials {
  bot_token: string
  baseurl: string
  ilink_bot_id: string
  ilink_user_id: string
}

/** 入站消息条目（types.go MessageItem 子集：文本/语音转写/引用 + 媒体位置信息）。 */
export interface ILinkMessageItem {
  type?: number
  msg_id?: string
  create_time_ms?: number
  update_time_ms?: number
  is_completed?: boolean
  ref_msg?: { message_item?: ILinkMessageItem; title?: string }
  text_item?: { text?: string }
  voice_item?: { text?: string; playtime?: number; media?: ILinkCDNMedia }
  image_item?: { media?: ILinkCDNMedia; url?: string; thumb_width?: number; thumb_height?: number }
  file_item?: { media?: ILinkCDNMedia; file_name?: string; len?: string }
  video_item?: { media?: ILinkCDNMedia; video_size?: number; play_length?: number }
}

/** CDN 媒体引用（types.go CDNMedia）。媒体收发今晚不做，只保留解析位。 */
export interface ILinkCDNMedia {
  encrypt_query_param?: string
  aes_key?: string
  encrypt_type?: number
  full_url?: string
}

/** 入站消息（types.go WeixinMessage）。 */
export interface ILinkMessage {
  seq?: number
  message_id?: number
  from_user_id?: string
  to_user_id?: string
  client_id?: string
  create_time_ms?: number
  update_time_ms?: number
  delete_time_ms?: number
  session_id?: string
  group_id?: string
  message_type?: number
  message_state?: number
  item_list?: ILinkMessageItem[]
  context_token?: string
}

/** getUpdates 响应（types.go GetUpdatesResp）。 */
export interface ILinkUpdatesResponse {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: ILinkMessage[]
  get_updates_buf?: string
  sync_buf?: string
  longpolling_timeout_ms?: number
}

/** 出站消息体（types.go WeixinMessage 的发侧子集）。 */
export interface ILinkOutboundMessage {
  to_user_id: string
  client_id: string
  message_type?: number
  message_state?: number
  context_token?: string
  item_list?: ILinkMessageItem[]
}

/** getConfig 响应（typing_ticket 用于 sendtyping）。 */
export interface ILinkConfigResponse {
  ret?: number
  errcode?: number
  errmsg?: string
  typing_ticket?: string
}

/** 客户端构造参数。 */
export interface ILinkClientOptions {
  /** 兼容旧配置名：API 端点（默认官方域）。 */
  baseUrl?: string | undefined
  /** bot_token（扫码确认前为空）。 */
  token?: string | undefined
  /** 注入的 fetch（mock 测试/代理用，默认全局 fetch）。 */
  fetchImpl?: typeof fetch | undefined
  /** 兼容旧配置名：消息长轮询超时覆盖。 */
  longPollTimeoutMs?: number | undefined
  /** 渠道版本（默认 ILINK_CHANNEL_VERSION）。 */
  version?: string | undefined
  /** 可选路由标签（SDK SKRouteTag）。 */
  routeTag?: string | undefined
}

/** 协议错误（HTTP 非 2xx / 响应体不是 JSON）。 */
export class ILinkError extends Error {
  readonly status: number | undefined
  readonly code: string
  constructor(message: string, code = 'ilink_error', status?: number) {
    super(message)
    this.name = 'ILinkError'
    this.code = code
    this.status = status
  }
}

/** API 级错误（HTTP 200 但 ret/errcode 非 0）。 */
export class ILinkApiError extends ILinkError {
  readonly ret: number
  readonly errcode: number
  constructor(ret: number, errcode: number, errmsg: string) {
    super(`ilink api error: ret=${String(ret)} errcode=${String(errcode)} errmsg=${errmsg}`, 'ilink_api', 200)
    this.name = 'ILinkApiError'
    this.ret = ret
    this.errcode = errcode
  }
  /** 是否会话过期（需要重新扫码）。 */
  get sessionExpired(): boolean {
    return this.errcode === SESSION_EXPIRED_ERR_CODE || this.ret === SESSION_EXPIRED_ERR_CODE
  }
}

// --- 协议工具函数（helpers.go 逐字移植） ---

/**
 * 渠道版本号编码成请求头 `iLink-App-ClientVersion` 的整数形式。
 * `"2.1.6"` → `(2<<16)|(1<<8)|6` = 132614。
 * @param version - 语义化版本串。
 * @returns 编码后的整数（无符号 32 位）。
 */
export function encodeClientVersion(version: string): number {
  const parts = version.split('.').map((p) => Number.parseInt(p, 10))
  const major = (Number.isFinite(parts[0]) ? (parts[0] as number) : 0) & 0xff
  const minor = (Number.isFinite(parts[1]) ? (parts[1] as number) : 0) & 0xff
  const patch = (Number.isFinite(parts[2]) ? (parts[2] as number) : 0) & 0xff
  return ((major << 16) | (minor << 8) | patch) >>> 0
}

/**
 * 生成 `X-WECHAT-UIN` 头：随机 32 位无符号整数 → 十进制字符串 → base64。
 * @returns base64 编码的随机 UIN。
 */
export function randomWechatUin(): string {
  const bytes = new Uint8Array(4)
  globalThis.crypto.getRandomValues(bytes)
  const n = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0
  return Buffer.from(String(n), 'utf8').toString('base64')
}

/**
 * 生成出站消息 client_id（`openclaw-weixin:<ms>-<hex8>`，SDK generateClientID 格式）。
 * @returns 消息幂等 id。
 */
export function generateClientId(): string {
  const bytes = new Uint8Array(4)
  globalThis.crypto.getRandomValues(bytes)
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `openclaw-weixin:${String(Date.now())}-${hex}`
}

/** 判断错误是否为超时/取消（长轮询下视为正常）。 */
function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err.name === 'AbortError') return true
  const code = (err as { cause?: { code?: string } }).cause?.code
  return code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT'
}

/** 取消息正文（helpers.go ExtractText 逐字移植：文本（含引用前缀）→ 语音转写 → 空串）。 */
export function extractText(message: ILinkMessage): string {
  const items = message.item_list ?? []
  for (const item of items) {
    if (item.type === ITEM_TYPE_TEXT && typeof item.text_item?.text === 'string') {
      let text = item.text_item.text
      const ref = item.ref_msg
      if (ref?.message_item !== undefined && !isMediaItem(ref.message_item)) {
        const refBody = typeof ref.message_item.text_item?.text === 'string' ? ref.message_item.text_item.text : ''
        const title = typeof ref.title === 'string' ? ref.title : ''
        if (title !== '' || refBody !== '') text = `[引用: ${title} | ${refBody}]\n${text}`
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

/** 是否媒体条目（ExtractText 判断引用前缀时用）。 */
function isMediaItem(item: ILinkMessageItem | undefined): boolean {
  if (item === undefined) return false
  return (
    item.type === ITEM_TYPE_IMAGE ||
    item.type === ITEM_TYPE_VIDEO ||
    item.type === ITEM_TYPE_FILE ||
    item.type === ITEM_TYPE_VOICE
  )
}

/** 从入站消息提取「可展示内容」的类型标签（文本/语音/图片/文件/视频）。 */
export function contentKind(message: ILinkMessage): 'text' | 'voice' | 'image' | 'file' | 'video' | 'unknown' {
  for (const item of message.item_list ?? []) {
    switch (item.type) {
      case ITEM_TYPE_TEXT:
        return 'text'
      case ITEM_TYPE_VOICE:
        return 'voice'
      case ITEM_TYPE_IMAGE:
        return 'image'
      case ITEM_TYPE_FILE:
        return 'file'
      case ITEM_TYPE_VIDEO:
        return 'video'
      default:
        break
    }
  }
  return 'unknown'
}

// --- 客户端 ---

/**
 * iLink Bot API 客户端（零依赖 fetch）。
 *
 * 生命周期：
 * ```ts
 * const client = new ILinkClient()                     // 扫码阶段（无 token）
 * const qr = await client.getBotQrCode()               // 拿二维码内容
 * const st = await client.pollQrStatus(qr.qrcode)      // 35s 长轮询
 * // st.status === 'confirmed' → new ILinkClient({ token: st.bot_token, baseUrl: st.baseurl })
 * ```
 */
export class ILinkClient {
  private token: string
  /** 当前 API base（confirmed 后可能被 baseurl 覆盖）。 */
  private baseUrl: string
  /** 登录/二维码专用 base（不随 baseurl 改变，重新扫码永远打官方域）。 */
  private readonly loginBaseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly version: string
  private readonly routeTag: string
  private readonly longPollTimeoutMs: number
  private readonly contextTokens = new Map<string, string>()

  constructor(options: ILinkClientOptions = {}) {
    this.token = options.token ?? ''
    this.baseUrl = stripTrailingSlash(options.baseUrl ?? ILINK_BASE_URL)
    this.loginBaseUrl = this.baseUrl
    this.fetchImpl = options.fetchImpl ?? fetch
    this.version = options.version ?? ILINK_CHANNEL_VERSION
    this.routeTag = options.routeTag ?? ''
    this.longPollTimeoutMs = options.longPollTimeoutMs ?? UPDATES_LONG_POLL_TIMEOUT_MS
  }

  /** 当前 bot_token。 */
  getToken(): string {
    return this.token
  }

  /** 当前 API base URL。 */
  getBaseUrl(): string {
    return this.baseUrl
  }

  /** 更新 bot_token（扫码 confirmed 后调用）。 */
  setToken(token: string): void {
    this.token = token
  }

  /** 更新 API base URL（confirmed 的 baseurl）。 */
  setBaseUrl(baseUrl: string): void {
    if (baseUrl !== '') this.baseUrl = stripTrailingSlash(baseUrl)
  }

  /** 缓存会话 context_token（按 from_user_id）。 */
  setContextToken(userId: string, token: string): void {
    if (userId !== '' && token !== '') this.contextTokens.set(userId, token)
  }

  /** 读缓存的 context_token。 */
  getContextToken(userId: string): string | undefined {
    return this.contextTokens.get(userId)
  }

  // --- HTTP 底座 ---

  /** 公共请求头（client.go commonHeaders）。 */
  private commonHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'iLink-App-Id': ILINK_APP_ID,
      'iLink-App-ClientVersion': String(encodeClientVersion(this.version)),
    }
    if (this.routeTag !== '') headers['SKRouteTag'] = this.routeTag
    return headers
  }

  /** POST 请求头（client.go buildHeaders）。 */
  private buildHeaders(bodyBytes: number): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.commonHeaders(),
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'Content-Length': String(bodyBytes),
      'X-WECHAT-UIN': randomWechatUin(),
    }
    const token = this.token.trim()
    if (token !== '') headers['Authorization'] = `Bearer ${token}`
    return headers
  }

  /** 拼 URL（base 补尾斜杠 + 端点去前导斜杠，等价 Go url.JoinPath）。 */
  private url(endpoint: string, params?: Record<string, string>, base = this.baseUrl): string {
    const path = endpoint.replace(/^\/+/, '')
    const u = new URL(`${stripTrailingSlash(base)}/${path}`)
    for (const [k, v] of Object.entries(params ?? {})) u.searchParams.set(k, v)
    return u.toString()
  }

  /** 发一次 HTTP 请求并按需 JSON 解析；非 2xx 抛 ILinkError。 */
  private async requestJson<T>(
    method: 'GET' | 'POST',
    url: string,
    body: string | undefined,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let text: string
    let status = 0
    try {
      const init: RequestInit = { method, headers, redirect: 'manual', signal: controller.signal }
      if (body !== undefined) init.body = body
      const response = await this.fetchImpl(url, init)
      status = response.status
      text = await response.text()
    } finally {
      clearTimeout(timer)
    }
    if (status < 200 || status >= 300) {
      throw new ILinkError(`ilink: http ${String(status)}: ${text.slice(0, 300)}`, 'ilink_http', status)
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(text)
    } catch (err) {
      throw new ILinkError(`ilink: response is not json: ${err instanceof Error ? err.message : String(err)}`, 'ilink_bad_json', status)
    }
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
      throw new ILinkError('ilink: response is not a JSON object', 'ilink_bad_json', status)
    }
    return decoded as T
  }

  /** POST JSON。 */
  private async postJson<T>(endpoint: string, payload: unknown, timeoutMs: number): Promise<T> {
    const body = JSON.stringify(payload)
    return this.requestJson<T>('POST', this.url(endpoint), body, this.buildHeaders(Buffer.byteLength(body, 'utf8')), timeoutMs)
  }

  /** GET（无 body）。 */
  private async getJson<T>(url: string, timeoutMs: number): Promise<T> {
    return this.requestJson<T>('GET', url, undefined, this.commonHeaders(), timeoutMs)
  }

  // --- 扫码绑定（auth.go） ---

  /**
   * 取登录二维码（GET /ilink/bot/get_bot_qrcode?bot_type=3）。
   * 永远打 loginBaseUrl（不随上一次登录的 baseurl 漂移），保证重新扫码可达。
   * @returns 二维码 id 与展示内容。
   */
  async getBotQrCode(): Promise<ILinkQRCodeResponse> {
    const url = this.url('ilink/bot/get_bot_qrcode', { bot_type: ILINK_BOT_TYPE }, this.loginBaseUrl)
    const resp = await this.getJson<ILinkQRCodeResponse>(url, API_TIMEOUT_MS)
    if (typeof resp.qrcode !== 'string' || resp.qrcode === '') {
      throw new ILinkError('ilink: qr response missing qrcode', 'ilink_bad_qr')
    }
    return { qrcode: resp.qrcode, qrcode_img_content: resp.qrcode_img_content ?? '' }
  }

  /**
   * 轮询扫码状态（GET /ilink/bot/get_qrcode_status，35s 长轮询）。
   * 超时/网络错误返回 `{status:'wait'}`（SDK PollQRStatus 语义），调用方继续轮询。
   * @param qrcode - 二维码 id。
   * @param options.baseUrl - 轮询端点覆盖（scaned_but_redirect 后的新 host）。
   */
  async pollQrStatus(qrcode: string, options: { baseUrl?: string | undefined } = {}): Promise<ILinkQRStatusResponse> {
    const base = options.baseUrl ?? this.loginBaseUrl
    const url = this.url('ilink/bot/get_qrcode_status', { qrcode }, base)
    try {
      return await this.getJson<ILinkQRStatusResponse>(url, QR_LONG_POLL_TIMEOUT_MS)
    } catch (err) {
      if (isTimeoutError(err)) return { status: 'wait' }
      // 网关 524/连接失败也是长轮询常态，按 wait 处理（SDK 一致）
      if (err instanceof ILinkError && err.code === 'ilink_http' && (err.status === 524 || err.status === 504 || err.status === 502)) {
        return { status: 'wait' }
      }
      throw err
    }
  }

  // --- 消息收发（client.go） ---

  /**
   * 拉增量消息（POST /ilink/bot/getupdates，长轮询）。
   * 超时/网络错误返回空响应并保留旧游标（SDK GetUpdates 语义），调用方继续轮询。
   * @param getUpdatesBuf - 上次的游标（空串 = 从头拉）。
   * @param options.timeoutMs - 覆盖长轮询超时。
   * @param options.signal - 取消（停轮询）。
   */
  async getUpdates(
    getUpdatesBuf = '',
    options: { timeoutMs?: number | undefined; signal?: AbortSignal | undefined } = {},
  ): Promise<ILinkUpdatesResponse> {
    const payload = { get_updates_buf: getUpdatesBuf, base_info: { channel_version: this.version } }
    const timeoutMs = options.timeoutMs !== undefined && options.timeoutMs > 0 ? options.timeoutMs : this.longPollTimeoutMs
    try {
      if (options.signal !== undefined) options.signal.throwIfAborted()
      return await this.postJson<ILinkUpdatesResponse>('ilink/bot/getupdates', payload, timeoutMs)
    } catch (err) {
      if (options.signal?.aborted === true) throw err
      if (isTimeoutError(err)) return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf }
      throw err
    }
  }

  /**
   * 发一条原始消息（POST /ilink/bot/sendmessage）。
   * API 级 ret/errcode 非 0 抛 ILinkApiError（含 sessionExpired 判定）。
   * @param msg - 出站消息体。
   */
  async sendMessage(msg: ILinkOutboundMessage): Promise<void> {
    const resp = await this.postJson<{ ret?: number; errcode?: number; errmsg?: string }>(
      'ilink/bot/sendmessage',
      { msg, base_info: { channel_version: this.version } },
      API_TIMEOUT_MS,
    )
    const ret = Number(resp.ret ?? 0)
    const errcode = Number(resp.errcode ?? 0)
    if (ret !== 0 || errcode !== 0) throw new ILinkApiError(ret, errcode, resp.errmsg ?? '')
  }

  /**
   * 发文本（需要该会话最近一次入站消息的 context_token）。
   * @param to - 收件人微信外部 id（入站 from_user_id 原值）。
   * @param text - 正文。
   * @param contextToken - 会话上下文令牌。
   * @returns 本条消息的 client_id / message_id。
   */
  async sendText(to: string, text: string, contextToken: string): Promise<{ clientId: string }> {
    const clientId = generateClientId()
    await this.sendMessage({
      to_user_id: to,
      client_id: clientId,
      message_type: MESSAGE_TYPE_BOT,
      message_state: MESSAGE_STATE_FINISH,
      context_token: contextToken,
      item_list: [{ type: ITEM_TYPE_TEXT, text_item: { text } }],
    })
    return { clientId }
  }

  /**
   * 主动推送文本（必须已有 context_token，对方先给 bot 发过消息）。
   * @param to - 收件人微信外部 id。
   * @param text - 正文。
   */
  async push(to: string, text: string): Promise<{ clientId: string }> {
    const token = this.getContextToken(to)
    if (token === undefined || token === '') {
      throw new ILinkError('ilink: no cached context token; user must send a message first', 'ilink_no_context_token')
    }
    return this.sendText(to, text, token)
  }

  /**
   * 发/取消输入中状态（POST /ilink/bot/sendtyping）。
   * @param userId - ilink_user_id。
   * @param typingTicket - getConfig 拿到的 typing_ticket（可为空）。
   * @param typing - true=正在输入，false=取消。
   */
  async sendTyping(userId: string, typingTicket: string, typing: boolean): Promise<void> {
    const resp = await this.postJson<{ ret?: number; errcode?: number; errmsg?: string }>(
      'ilink/bot/sendtyping',
      {
        ilink_user_id: userId,
        typing_ticket: typingTicket,
        status: typing ? TYPING : CANCEL_TYPING,
        base_info: { channel_version: this.version },
      },
      CONFIG_TIMEOUT_MS,
    )
    assertApiOk(resp)
  }

  /**
   * 取 bot 配置（POST /ilink/bot/getconfig）→ typing_ticket。
   * @param userId - ilink_user_id。
   * @param contextToken - 该会话 context_token。
   */
  async getConfig(userId: string, contextToken: string): Promise<ILinkConfigResponse> {
    const resp = await this.postJson<ILinkConfigResponse>(
      'ilink/bot/getconfig',
      { ilink_user_id: userId, context_token: contextToken, base_info: { channel_version: this.version } },
      CONFIG_TIMEOUT_MS,
    )
    assertApiOk(resp)
    return resp
  }
}

/** ret/errcode 非 0 时抛 ILinkApiError。 */
function assertApiOk(resp: { ret?: number; errcode?: number; errmsg?: string }): void {
  const ret = Number(resp.ret ?? 0)
  const errcode = Number(resp.errcode ?? 0)
  if (ret !== 0 || errcode !== 0) throw new ILinkApiError(ret, errcode, resp.errmsg ?? '')
}

/** 去尾斜杠（对应 Go ensureTrailingSlash 的反操作）。 */
function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}
