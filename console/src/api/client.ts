/**
 * 统一 API 客户端。
 * - 基地址来自 VITE_API_BASE（默认 http://localhost:3000；开发模式可留空走 Vite 代理）。
 * - Cookie 携带 httpOnly JWT（credentials: include）。
 * - 成功信封 { data: ... }，失败信封 { error: { code, message } }（中文 message）。
 * - 401 时自动跳转 /login（登录/注册接口除外）。
 */

export const API_BASE: string = (import.meta.env.VITE_API_BASE ?? 'http://localhost:3000').replace(/\/+$/, '');

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export type QueryValue = string | number | boolean | null | undefined;

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const url = `${API_BASE}${path}`;
  if (!query) return url;
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === null || v === undefined || v === '') continue;
    search.set(k, String(v));
  }
  const qs = search.toString();
  return qs ? `${url}?${qs}` : url;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readErrorEnvelope(body: unknown): { code: string; message: string } {
  if (isRecord(body) && isRecord(body.error)) {
    const code = typeof body.error.code === 'string' ? body.error.code : 'error';
    const message = typeof body.error.message === 'string' ? body.error.message : '请求失败，请稍后再试';
    return { code, message };
  }
  if (typeof body === 'string' && body) return { code: 'error', message: body };
  return { code: 'error', message: '请求失败，请稍后再试' };
}

/** 信封解包：兼容 {data:...} 与后端直接返回的裸值。 */
function unwrapData(body: unknown): unknown {
  if (isRecord(body) && 'data' in body && !('error' in body)) return body.data;
  return body;
}

function redirectToLogin(): void {
  const here = window.location.pathname + window.location.search;
  if (window.location.pathname === '/login' || window.location.pathname === '/register') return;
  const next = encodeURIComponent(here);
  window.location.assign(`/login?next=${next}`);
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  formData?: FormData;
  query?: Record<string, QueryValue>;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, formData, query, signal } = options;
  let res: Response;
  try {
    res = await fetch(buildUrl(path, query), {
      method,
      credentials: 'include',
      signal,
      headers: formData
        ? undefined
        : body !== undefined
          ? { 'Content-Type': 'application/json' }
          : undefined,
      body: formData ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network', '无法连接服务器，请检查后端是否启动');
  }

  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    redirectToLogin();
    throw new ApiError(401, 'unauthorized', '登录已过期，请重新登录');
  }

  const text = await res.text();
  let parsed: unknown;
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    const e = readErrorEnvelope(parsed);
    throw new ApiError(res.status, e.code, e.message);
  }
  return unwrapData(parsed) as T;
}

/* ---------- 防御性窄化工具（后端并行开发，字段形状以运行时为准） ---------- */

export function pickArray<T>(data: unknown, ...keys: string[]): T[] {
  if (Array.isArray(data)) return data as T[];
  if (isRecord(data)) {
    for (const k of keys) {
      const v = data[k];
      if (Array.isArray(v)) return v as T[];
    }
  }
  return [];
}

export function pickRecord(data: unknown, ...keys: string[]): Record<string, unknown> | undefined {
  if (isRecord(data)) {
    for (const k of keys) {
      const v = data[k];
      if (isRecord(v)) return v;
    }
  }
  return undefined;
}

export function asStr(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

export function asNum(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function asBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

/** 读取对象里第一个存在的键值。 */
export function firstOf(rec: Record<string, unknown> | undefined, ...keys: string[]): unknown {
  if (!rec) return undefined;
  for (const k of keys) {
    if (k in rec && rec[k] !== undefined && rec[k] !== null) return rec[k];
  }
  return undefined;
}

export const http = {
  get: <T>(path: string, query?: Record<string, QueryValue>, signal?: AbortSignal) =>
    request<T>(path, { method: 'GET', query, signal }),
  post: <T>(path: string, body?: unknown, query?: Record<string, QueryValue>) =>
    request<T>(path, { method: 'POST', body, query }),
  put: <T>(path: string, body?: unknown, query?: Record<string, QueryValue>) =>
    request<T>(path, { method: 'PUT', body, query }),
  patch: <T>(path: string, body?: unknown, query?: Record<string, QueryValue>) =>
    request<T>(path, { method: 'PATCH', body, query }),
  del: <T>(path: string, query?: Record<string, QueryValue>) =>
    request<T>(path, { method: 'DELETE', query }),
  upload: <T>(path: string, formData: FormData, query?: Record<string, QueryValue>) =>
    request<T>(path, { method: 'POST', formData, query }),
};

/** 下载二进制（如角色卡 PNG 导出）。 */
export async function downloadFile(path: string, fallbackName: string, query?: Record<string, QueryValue>): Promise<void> {
  const res = await fetch(buildUrl(path, query), { credentials: 'include' });
  if (!res.ok) {
    const e = readErrorEnvelope(await res.text().catch(() => undefined));
    throw new ApiError(res.status, e.code, e.message);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const match = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition);
  const name = match ? decodeURIComponent(match[1]) : fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
