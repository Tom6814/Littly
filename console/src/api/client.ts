/**
 * 统一 API 客户端。
 * - 基地址：默认空（同源，走 Vite 代理 /api → 127.0.0.1:3000）；可用 VITE_API_BASE 覆盖。
 * - 凭证：httpOnly Cookie JWT（credentials: 'include'）。
 * - 信封：成功 { data: ... }，失败 { error: { code, message } }（中文 message）。
 * - 401：自动跳 /login（登录/注册接口除外）。
 */
export const API_BASE: string = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '')

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export type QueryValue = string | number | boolean | null | undefined

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const url = `${API_BASE}${path}`
  if (!query) return url
  const search = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v === null || v === undefined || v === '') continue
    search.set(k, String(v))
  }
  const qs = search.toString()
  return qs ? `${url}?${qs}` : url
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function readErrorEnvelope(body: unknown): { code: string; message: string } {
  if (isRecord(body) && isRecord(body.error)) {
    const code = typeof body.error.code === 'string' ? body.error.code : 'error'
    const message =
      typeof body.error.message === 'string' ? body.error.message : '请求失败，请稍后再试'
    return { code, message }
  }
  if (typeof body === 'string' && body) return { code: 'error', message: body }
  return { code: 'error', message: '请求失败，请稍后再试' }
}

/** 信封解包：兼容 {data:...} 与后端直接返回的裸值。 */
export function unwrapData(body: unknown): unknown {
  if (isRecord(body) && 'data' in body && !('error' in body)) return body.data
  return body
}

function redirectToLogin(): void {
  const { pathname } = window.location
  if (pathname === '/login' || pathname === '/register') return
  const next = encodeURIComponent(pathname + window.location.search)
  window.location.assign(`/login?next=${next}`)
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  formData?: FormData
  query?: Record<string, QueryValue>
  signal?: AbortSignal
  /** 不让 401 自动跳登录（用于 session bootstrap 探测）。 */
  silentUnauthorized?: boolean
  /** 允许非 2xx 而不抛错（用于契约未就绪的探测接口）。 */
  allowAnyStatus?: boolean
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, formData, query, signal, silentUnauthorized, allowAnyStatus } = options

  let res: Response
  try {
    res = await fetch(buildUrl(path, query), {
      method,
      credentials: 'include',
      signal,
      headers: formData ? undefined : body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: formData ?? (body !== undefined ? JSON.stringify(body) : undefined),
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    throw new ApiError(0, 'network_error', '网络连接失败，请检查后端服务是否已启动')
  }

  const text = await res.text()
  let payload: unknown = null
  if (text !== '') {
    try {
      payload = JSON.parse(text) as unknown
    } catch {
      payload = text
    }
  }

  if (!res.ok) {
    const { code, message } = readErrorEnvelope(payload)
    if (res.status === 401 && !silentUnauthorized) redirectToLogin()
    if (allowAnyStatus) return { __status: res.status, __body: payload } as T
    throw new ApiError(res.status, code, message)
  }

  return unwrapData(payload) as T
}

export const http = {
  get: <T>(path: string, query?: Record<string, QueryValue>, opts?: RequestOptions) =>
    request<T>(path, { ...opts, query }),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>(path, { ...opts, method: 'POST', body }),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>(path, { ...opts, method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>(path, { ...opts, method: 'PATCH', body }),
  del: <T>(path: string, opts?: RequestOptions) =>
    request<T>(path, { ...opts, method: 'DELETE' }),
  /** multipart 上传（角色卡 PNG / 头像 / 相册）。 */
  upload: <T>(path: string, formData: FormData, opts?: RequestOptions) =>
    request<T>(path, { ...opts, method: 'POST', formData }),
}

/** 窄化助手：数组 / 记录 / 字符串 / 数字 / 布尔。 */
export function pickArray(v: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(v)) return v
  if (isRecord(v)) {
    for (const k of keys) {
      const hit = v[k]
      if (Array.isArray(hit)) return hit
    }
  }
  return []
}

export function pickRecord(v: unknown, ...keys: string[]): Record<string, unknown> | undefined {
  if (!isRecord(v)) return undefined
  for (const k of keys) {
    const hit = v[k]
    if (isRecord(hit)) return hit
  }
  return v
}

export function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

export function asNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export function asBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

export function firstOf(rec: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (rec[k] !== undefined && rec[k] !== null) return rec[k]
  }
  return undefined
}
