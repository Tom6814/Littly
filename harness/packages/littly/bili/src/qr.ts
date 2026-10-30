/**
 * B 站 passport 扫码登录（HTTP 直连）+ 零依赖 QR PNG。
 *
 * 为什么不用 `bili login`：CLI 的 login 是纯 TTY 交互（rich 终端二维码），
 * 非 TTY 下没有任何输出，无法从中拿到二维码给浏览器渲染（/tmp/bili-spec.md §0）。
 * 所以控制台扫码走 passport 官方 web 接口：
 *
 *   GET  https://passport.bilibili.com/x/passport-login/web/qrcode/generate
 *        → {code:0, data:{url, qrcode_key}}
 *   GET  https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=...
 *        → {code:0, data:{code, message, url, refresh_token}} + Set-Cookie(SESSDATA/bili_jct/DedeUserID/...)
 *
 * `data.code`：0 成功；86101 未扫码；86090 已扫码待确认；86038 二维码过期。
 * 成功后由本模块把 Cookie 写进 CLI 的 credential.json（schema 见 credential.ts），
 * 再交给 service 跑 `bili status --json` 复核。
 *
 * 会话只存在内存（3 分钟 TTL）；进程重启后前端重新 QR start 即可（扫码本来就是短生命周期）。
 */
import { randomBytes } from 'node:crypto'
import { cookieJarFrom, setCookieLines, type BiliCookieJar } from './credential.ts'
import { qrTextToPngDataUrl } from './qr-encoder.ts'

/** passport 默认源（测试/私有代理可覆盖）。 */
export const PASSPORT_BASE_URL = 'https://passport.bilibili.com'
/** 二维码有效期（与 passport generate 的 180s 对齐）。 */
export const QR_EXPIRES_IN_MS = 180_000

const GENERATE_PATH = '/x/passport-login/web/qrcode/generate'
const POLL_PATH = '/x/passport-login/web/qrcode/poll'

/** 扫码四态（error 单独用 status='error' + message）。 */
export type QrPollStatus = 'wait' | 'scaned' | 'confirmed' | 'expired' | 'error'

/** fetch 的最小结构面（测试注入 mock 用）。 */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>

/** 二维码生成结果。 */
export interface QrGenerateResult {
  /** passport 的 qrcode_key（轮询用）。 */
  qrcodeKey: string
  /** 编码进二维码的登录 URL（前端可展示/兜底）。 */
  link: string
  /** PNG data URL（`<img src>` 直接用）。 */
  qrDataUrl: string
}

/** 单次轮询结果。 */
export interface QrPollResult {
  status: QrPollStatus
  /** status=error/expired 时的可读说明。 */
  message?: string | undefined
  /** 扫码成功时从 Set-Cookie / 跳转 URL 归一化出的 Cookie。 */
  cookies?: BiliCookieJar | undefined
  /** passport 原始 code（0/86101/86090/86038，排障用）。 */
  code?: number | undefined
  /** 是否从跳转 URL 兜底取到 Cookie（排障用）。 */
  source?: 'set-cookie' | 'redirect-url' | 'mixed' | undefined
}

/** qr.ts 的可注入配置。 */
export interface QrClientOptions {
  /** passport 源，默认 PASSPORT_BASE_URL。 */
  passportBaseUrl?: string | undefined
  /** fetch 实现（测试注入）。 */
  fetchImpl?: FetchLike | undefined
  /** 单次请求超时（毫秒），默认 15000。 */
  timeoutMs?: number | undefined
  /** 二维码 TTL（毫秒），默认 180000。 */
  expiresInMs?: number | undefined
}

interface PassportEnvelope<T> {
  code?: number
  message?: string
  data?: T
}

interface GenerateData {
  url?: string
  qrcode_key?: string
}

interface PollData {
  code?: number
  message?: string
  url?: string
  refresh_token?: string
}

/** 一次二维码会话（内存）。 */
export interface QrSession {
  sessionId: string
  qrcodeKey: string
  link: string
  qrDataUrl: string
  createdAt: number
  expiresAt: number
}

/** 内置 fetch 的简易超时包装（AbortController）。 */
async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, Math.max(1000, timeoutMs))
  try {
    return await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** 解析 passport JSON；非 JSON / HTTP 失败给可读错误。 */
async function readEnvelope<T>(res: Response, operation: string): Promise<PassportEnvelope<T>> {
  const text = await res.text().catch(() => '')
  if (!res.ok) {
    throw new Error(`passport ${operation} HTTP ${String(res.status)}：${text.slice(0, 200)}`)
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object') throw new Error('not object')
    const rec = parsed as Record<string, unknown>
    const envelope: PassportEnvelope<T> = {}
    if (typeof rec['code'] === 'number') envelope.code = rec['code']
    if (typeof rec['message'] === 'string') envelope.message = rec['message']
    if (rec['data'] !== undefined) envelope.data = rec['data'] as T
    return envelope
  } catch {
    throw new Error(`passport ${operation} 返回非 JSON：${text.slice(0, 200)}`)
  }
}

/**
 * 生成二维码（generate）。
 * @param options - passport 源 / fetch / 超时。
 * @returns qrcode_key + 登录 URL + PNG data URL。
 */
export async function qrGenerate(options: QrClientOptions = {}): Promise<QrGenerateResult> {
  const base = (options.passportBaseUrl ?? PASSPORT_BASE_URL).replace(/\/+$/, '')
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 15_000
  const res = await fetchWithTimeout(fetchImpl, `${base}${GENERATE_PATH}`, timeoutMs)
  const envelope = await readEnvelope<GenerateData>(res, 'qrcode/generate')
  if (envelope.code !== 0) {
    throw new Error(`passport 生成二维码失败（code=${String(envelope.code)}）：${envelope.message ?? ''}`)
  }
  const url = typeof envelope.data?.url === 'string' ? envelope.data.url : ''
  const qrcodeKey = typeof envelope.data?.qrcode_key === 'string' ? envelope.data.qrcode_key : ''
  if (url === '' || qrcodeKey === '') {
    throw new Error('passport 生成二维码失败：响应缺少 url / qrcode_key')
  }
  return { qrcodeKey, link: url, qrDataUrl: qrTextToPngDataUrl(url) }
}

/**
 * 轮询一次二维码状态（poll）。
 * @param qrcodeKey - generate 返回的 key。
 * @param options - passport 源 / fetch / 超时。
 * @returns wait/scaned/confirmed/expired/error 与（成功时）Cookie。
 */
export async function qrPollOnce(qrcodeKey: string, options: QrClientOptions = {}): Promise<QrPollResult> {
  const base = (options.passportBaseUrl ?? PASSPORT_BASE_URL).replace(/\/+$/, '')
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 15_000
  const url = `${base}${POLL_PATH}?qrcode_key=${encodeURIComponent(qrcodeKey)}`
  const res = await fetchWithTimeout(fetchImpl, url, timeoutMs)
  const setCookie = setCookieLines(res.headers)
  const envelope = await readEnvelope<PollData>(res, 'qrcode/poll')
  if (envelope.code !== 0) {
    return { status: 'error', message: `passport 轮询失败（code=${String(envelope.code)}）：${envelope.message ?? ''}`, code: envelope.code }
  }
  const data = envelope.data ?? {}
  const code = typeof data.code === 'number' ? data.code : -1
  if (code === 0) {
    const redirectUrl = typeof data.url === 'string' ? data.url : ''
    const jar = cookieJarFrom(setCookie, redirectUrl)
    if (jar.ac_time_value === '' && typeof data.refresh_token === 'string') jar.ac_time_value = data.refresh_token
    if (jar.sessdata === '') {
      return {
        status: 'error',
        message: '扫码已确认，但 passport 没有返回 SESSDATA（Set-Cookie 可能被代理/浏览器拦截），请重试或改用浏览器 Cookie 提取。',
        code,
      }
    }
    const source = setCookie.length > 0 && redirectUrl !== '' ? 'mixed' : setCookie.length > 0 ? 'set-cookie' : 'redirect-url'
    return { status: 'confirmed', cookies: jar, code, source }
  }
  if (code === 86101) return { status: 'wait', code }
  if (code === 86090) return { status: 'scaned', code }
  if (code === 86038) return { status: 'expired', message: '二维码已过期，请重新获取。', code }
  return {
    status: 'error',
    message: `passport 返回未知状态 code=${String(code)}：${typeof data.message === 'string' ? data.message : ''}`,
    code,
  }
}

/** 二维码会话的内存存储（3 分钟 TTL，进程重启清空）。 */
export class QrSessionStore {
  private readonly sessions = new Map<string, QrSession>()
  private readonly expiresInMs: number

  constructor(expiresInMs: number = QR_EXPIRES_IN_MS) {
    this.expiresInMs = Math.max(30_000, Math.round(expiresInMs) || QR_EXPIRES_IN_MS)
  }

  /**
   * 新建会话。
   * @param gen - qrGenerate 结果。
   * @param nowMs - 当前时间（测试注入）。
   * @returns 会话。
   */
  create(gen: QrGenerateResult, nowMs: number = Date.now()): QrSession {
    const sessionId = randomBytes(12).toString('base64url')
    const session: QrSession = {
      sessionId,
      qrcodeKey: gen.qrcodeKey,
      link: gen.link,
      qrDataUrl: gen.qrDataUrl,
      createdAt: nowMs,
      expiresAt: nowMs + this.expiresInMs,
    }
    this.sessions.set(sessionId, session)
    // 防泄漏：顺带清理过期项（会话量级极小）。
    for (const [id, s] of this.sessions) if (nowMs > s.expiresAt) this.sessions.delete(id)
    return session
  }

  /**
   * 取会话；不存在返回 null（过期由调用方判定后 remove）。
   * @param sessionId - 会话 id。
   * @returns 会话或 null。
   */
  get(sessionId: string): QrSession | null {
    if (sessionId === '') return null
    return this.sessions.get(sessionId) ?? null
  }

  /**
   * 删除会话。
   * @param sessionId - 会话 id。
   */
  remove(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /** 当前会话数（测试/排障用）。 */
  size(): number {
    return this.sessions.size
  }
}
