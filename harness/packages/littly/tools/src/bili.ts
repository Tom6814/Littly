/**
 * bilibili sidecar 客户端（bili-agent CLI 的 HTTP wrapper）。
 *
 * 定位（docs/BILI-INTEGRATION.md）：sidecar 是「她自己的 bilibili 账号」——
 * 她会真的刷 B 站、当 UP 主，而不是替主人代管账号。
 *
 * 三条调用面：
 * 1. AI 侧：bili 元工具 → POST /cmd（子命令白名单 + 写操作默认 dry-run + 限频审计，由 sidecar 强制）
 * 2. 控制台侧：GET /auth/status、POST /auth/qr/start、GET /auth/qr/status（两步扫码登录，人扫）
 * 3. MCP 侧：harness 挂 `bili mcp serve`（stdio），工具名 mcp__bili__<tool>
 *
 * 所有路径与响应形状都对齐 sidecars/bili/wrapper.py 的实测契约。
 */

export interface BiliSidecarEnv {
  baseUrl: string
  token: string
  /** 是否配置了 sidecar（未配置时工具直接报不可用，不做无谓网络往返）。 */
  configured: boolean
}

export function biliEnv(): BiliSidecarEnv {
  const baseUrl = (process.env['BILI_SIDECAR_URL'] || 'http://127.0.0.1:3010').replace(/\/+$/, '')
  const token = process.env['BILI_SIDECAR_TOKEN'] || ''
  return { baseUrl, token, configured: process.env['BILI_SIDECAR_URL'] !== undefined || process.env['BILI_SIDECAR_TOKEN'] !== undefined }
}

/** sidecar 统一响应信封：{ok, data} 或 {ok:false, error:{code,message}} */
export interface BiliEnvelope {
  ok: boolean
  data?: unknown
  error?: { code?: string; message?: string; hint?: string; detail?: unknown }
}

export class BiliSidecarError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'BiliSidecarError'
    this.code = code
    this.status = status
  }
}

interface RawResponse {
  status: number
  body: unknown
}

/** 对 sidecar 发一次请求（统一超时、token 头、错误信封解析）。 */
export async function biliFetch(
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<RawResponse> {
  const env = biliEnv()
  const controller = new AbortController()
  const timeoutMs = init.timeoutMs ?? 60_000
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers: Record<string, string> = {}
    if (env.token) headers['X-Bili-Token'] = env.token
    if (init.body !== undefined) headers['content-type'] = 'application/json'
    const res = await fetch(`${env.baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: controller.signal,
    })
    const text = await res.text()
    let body: unknown
    try {
      body = text ? JSON.parse(text) : {}
    } catch {
      body = { output: text }
    }
    return { status: res.status, body }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new BiliSidecarError('timeout', `bilibili sidecar 超时（${timeoutMs}ms）`, 504)
    }
    throw new BiliSidecarError('unavailable', `bilibili sidecar 不可达：${err instanceof Error ? err.message : String(err)}`, 502)
  } finally {
    clearTimeout(timer)
  }
}

/** 把 sidecar 的错误体（FastAPI HTTPException.detail 或 {ok:false,error}）解析成可读错误。 */
export function biliErrorOf(status: number, body: unknown): BiliSidecarError {
  const rec = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const detail = (typeof rec['detail'] === 'object' && rec['detail'] !== null ? rec['detail'] : {}) as Record<string, unknown>
  const errRec = (typeof detail['error'] === 'object' && detail['error'] !== null ? detail['error'] : rec['error']) as
    | Record<string, unknown>
    | undefined
  const code = typeof errRec?.['code'] === 'string' ? errRec['code'] : status === 404 ? 'not_found' : 'sidecar_error'
  const message = typeof errRec?.['message'] === 'string' ? errRec['message'] : `bilibili sidecar 返回 ${status}`
  return new BiliSidecarError(code, message, status)
}

/** 执行白名单内的 bili 子命令（写操作默认由 sidecar 强制 dry-run）。 */
export async function biliRunCommand(argv: string[], dryRun?: boolean): Promise<{
  exitCode: number
  dryRun: boolean
  result: BiliEnvelope
}> {
  const { status, body } = await biliFetch('/cmd', {
    method: 'POST',
    body: { argv, ...(dryRun === undefined ? {} : { dry_run: dryRun }) },
    timeoutMs: 300_000,
  })
  if (status >= 400) throw biliErrorOf(status, body)
  const rec = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const envelope = (typeof rec['result'] === 'object' && rec['result'] !== null ? rec['result'] : {}) as BiliEnvelope
  return {
    exitCode: typeof rec['exit_code'] === 'number' ? rec['exit_code'] : 0,
    dryRun: rec['dry_run'] === true,
    result: envelope,
  }
}

/** 账号登录状态。 */
export async function biliAuthStatus(): Promise<BiliEnvelope> {
  const { status, body } = await biliFetch('/auth/status')
  if (status >= 400) throw biliErrorOf(status, body)
  const rec = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  return (typeof rec['result'] === 'object' && rec['result'] !== null ? rec['result'] : {}) as BiliEnvelope
}

/** 生成登录二维码（第一步，人扫）。 */
export async function biliQrStart(): Promise<Record<string, unknown>> {
  const { status, body } = await biliFetch('/auth/qr/start', { method: 'POST' })
  if (status >= 400) throw biliErrorOf(status, body)
  return (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
}

/** 轮询二维码状态（第二步）。 */
export async function biliQrStatus(sessionId: string): Promise<Record<string, unknown>> {
  const { status, body } = await biliFetch(`/auth/qr/status?session_id=${encodeURIComponent(sessionId)}`)
  if (status >= 400) throw biliErrorOf(status, body)
  return (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
}
