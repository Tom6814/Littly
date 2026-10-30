/**
 * 控制台 HTTP 内核：极简路由表（:param 段匹配）+ 统一信封助手 + 请求解析。
 * 所有路由注册在 webServer 的单个 '/api' 前缀下，内部再按方法 + 路径分发，
 * 避免与其它插件的具体路由发生 webserver 层的 (kind,path) 冲突。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { UserRow } from '@littly/storage'

/** 注入的 webServer 最小结构面（host/webserver 的 named route 注册）。 */
export interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** multipart 解析出的单个文件。 */
export interface UploadedFile {
  field: string
  filename: string
  contentType: string
  data: Buffer
}

/** 鉴权后的请求上下文（路由处理函数的唯一入参）。 */
export interface ApiRequest {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  method: string
  params: Record<string, string>
  query: URLSearchParams
  /** JSON body 解析结果；无 body / 非 JSON 时为 undefined。 */
  body: unknown
  /** 原始请求体文本（JSON 请求保留原始串；HMAC 验签等场景需要）。 */
  rawBody?: string | undefined
  /** multipart 普通字段。 */
  fields: Record<string, string>
  /** multipart 文件。 */
  files: UploadedFile[]
  /** 当前登录用户；未登录为 null。 */
  user: UserRow | null
}

/** 鉴权策略。 */
export type AuthMode = 'public' | 'required' | 'admin'

interface RouteDef {
  method: string
  segments: string[]
  auth: AuthMode
  handler: (ctx: ApiRequest) => Promise<void> | void
}

/** 单个上传体积上限（20MB，覆盖角色卡 PNG / 相册图片 / 头像）。 */
const MAX_BODY_BYTES = 20 * 1024 * 1024

/** 统一成功信封。 */
export function json(res: ServerResponse, status: number, data: unknown): void {
  const payload = JSON.stringify(data)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** 统一错误信封（中文 message）。 */
export function err(res: ServerResponse, status: number, code: string, message: string): void {
  json(res, status, { error: { code, message } })
}

/**
 * B4：内部错误详情只进服务端日志，HTTP 响应统一脱敏（不再把 SQL/堆栈/路径回显给客户端）。
 * 由 index.ts 在装配时注入 logger；未注入时静默（绝不把详情写进响应）。
 */
let errorReporter: ((error: unknown, detail: { method: string; path: string; userId: string }) => void) | null = null

export function setErrorReporter(
  reporter: (error: unknown, detail: { method: string; path: string; userId: string }) => void,
): void {
  errorReporter = reporter
}

/** 上报一次内部错误（服务端日志留详情）。 */
export function reportInternalError(error: unknown, detail: { method: string; path: string; userId: string }): void {
  try {
    if (errorReporter !== null) {
      errorReporter(error, detail)
      return
    }
    // 未注入 logger 时至少进 stderr —— 详情绝不进 HTTP 响应。
    console.error(
      `[console-api] internal error ${detail.method} ${detail.path} user=${detail.userId || '-'}:`,
      error instanceof Error ? error.stack ?? error.message : error,
    )
  } catch {
    // 错误上报本身不得再抛
  }
}

/**
 * B5：后台 async 路由处理器的兜底。
 * 老代码里大量 `void (async () => { ... })()` 模式：handler 同步返回后，
 * async IIFE 内部的 reject 无人接管 → Node 默认把未处理 rejection 升级为进程退出。
 * 所有这类处理器改为 `fire(ctx, (async ...)())`：reject 被捕获 → 记日志 + 500 脱敏信封。
 */
export function fire(ctx: ApiRequest, promise: Promise<void>): void {
  void promise.catch((error: unknown) => {
    reportInternalError(error, { method: ctx.method, path: ctx.url.pathname, userId: ctx.user?.id ?? '' })
    if (!ctx.res.headersSent) {
      err(ctx.res, 500, 'internal', '服务器内部错误，请稍后重试')
    } else {
      ctx.res.destroy()
    }
  })
}

/** CORS 响应头：回显 Origin + 允许凭据（dev 模式 Vite 端口与 API 端口不同源）。 */
function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return
  res.setHeader('access-control-allow-origin', origin)
  res.setHeader('access-control-allow-credentials', 'true')
  res.setHeader('vary', 'origin')
}

function preflight(req: IncomingMessage, res: ServerResponse): void {
  applyCors(req, res)
  const allowHeaders = req.headers['access-control-request-headers']
  res.writeHead(204, {
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': typeof allowHeaders === 'string' ? allowHeaders : 'content-type',
    'access-control-max-age': '600',
  })
  res.end()
}

/** 读取完整请求体（带体积上限）。 */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buf.length
    if (size > MAX_BODY_BYTES) throw new Error('payload too large')
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

/** 按 boundary 切分 multipart/form-data。 */
function parseMultipart(raw: Buffer, contentType: string): { fields: Record<string, string>; files: UploadedFile[] } {
  const fields: Record<string, string> = {}
  const files: UploadedFile[] = []
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  const boundary = m?.[1] ?? m?.[2]
  if (!boundary) return { fields, files }
  const delimiter = Buffer.from(`--${boundary.trim()}`)
  // 按 --boundary 行切分；每段为 \r\nheaders\r\n\r\nbody\r\n
  let pos = raw.indexOf(delimiter)
  while (pos !== -1) {
    const next = raw.indexOf(delimiter, pos + delimiter.length)
    if (next === -1) break
    let segment = raw.subarray(pos + delimiter.length, next)
    // 段首的 \r\n 与终结符 '--' 处理
    if (segment[0] === 0x0d && segment[1] === 0x0a) segment = segment.subarray(2)
    const marker = segment.indexOf('\r\n\r\n')
    if (marker !== -1) {
      const headText = segment.subarray(0, marker).toString('utf8')
      let body = segment.subarray(marker + 4)
      if (body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) body = body.subarray(0, body.length - 2)
      const name = /name="([^"]*)"/i.exec(headText)?.[1] ?? ''
      const filename = /filename="([^"]*)"/i.exec(headText)?.[1]
      const partType = /content-type:\s*([^\r\n]+)/i.exec(headText)?.[1]?.trim() ?? 'application/octet-stream'
      if (filename !== undefined) {
        files.push({ field: name, filename, contentType: partType, data: Buffer.from(body) })
      } else if (name !== '') {
        fields[name] = body.toString('utf8')
      }
    }
    pos = next
  }
  return { fields, files }
}

function splitSegments(pathname: string): string[] {
  return pathname.split('/').filter((s) => s !== '')
}

function matchSegments(pattern: string[], actual: string[]): Record<string, string> | null {
  const params: Record<string, string> = {}
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]
    if (p === undefined) return null
    // '*' 只作末段：吞掉其余全部段（可为空）
    if (p === '*') {
      params['*'] = actual.slice(i).join('/')
      return params
    }
    const a = actual[i]
    if (a === undefined) return null
    if (p.startsWith(':')) {
      if (a === '') return null
      params[p.slice(1)] = a
    } else if (p !== a) {
      return null
    }
  }
  if (pattern.length !== actual.length) return null
  return params
}

/**
 * API 路由表。一次 webServer 注册承载全部控制台端点；
 * auth 在分发时统一裁决（401 / 403 信封）。
 */
export class Router {
  private readonly routes: RouteDef[] = []
  /** 会话解析器由 auth 模块注入（cookie → UserRow | null）。 */
  resolveUser: ((req: IncomingMessage) => UserRow | null) | null = null
  /**
   * B3：bot 归属守卫。请求若携带 botId（query 或 JSON body），非 admin 用户必须通过；
   * 由 registerContentRoutes / registerDataRoutes 等注入具体实现（deps.botOwnedBy）。
   */
  botGuard: ((ctx: ApiRequest, botId: string) => boolean) | null = null

  add(method: string, path: string, auth: AuthMode, handler: (ctx: ApiRequest) => Promise<void> | void): void {
    this.routes.push({ method: method.toUpperCase(), segments: splitSegments(path), auth, handler })
  }

  get(path: string, auth: AuthMode, handler: (ctx: ApiRequest) => Promise<void> | void): void {
    this.add('GET', path, auth, handler)
  }

  post(path: string, auth: AuthMode, handler: (ctx: ApiRequest) => Promise<void> | void): void {
    this.add('POST', path, auth, handler)
  }

  put(path: string, auth: AuthMode, handler: (ctx: ApiRequest) => Promise<void> | void): void {
    this.add('PUT', path, auth, handler)
  }

  patch(path: string, auth: AuthMode, handler: (ctx: ApiRequest) => Promise<void> | void): void {
    this.add('PATCH', path, auth, handler)
  }

  del(path: string, auth: AuthMode, handler: (ctx: ApiRequest) => Promise<void> | void): void {
    this.add('DELETE', path, auth, handler)
  }

  /** webServer handler 入口：解析请求 → 匹配 → 鉴权 → 执行。 */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    applyCors(req, res)
    if (req.method === 'OPTIONS') {
      preflight(req, res)
      return
    }
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://local')
    } catch {
      err(res, 400, 'bad_request', '请求路径不合法')
      return
    }
    const actual = splitSegments(url.pathname)
    const method = (req.method ?? 'GET').toUpperCase()

    let matched: RouteDef | null = null
    let pathMatched = false
    let params: Record<string, string> = {}
    for (const route of this.routes) {
      const p = matchSegments(route.segments, actual)
      if (p === null) continue
      pathMatched = true
      if (route.method === method) {
        matched = route
        params = p
        break
      }
    }
    if (!matched) {
      err(res, pathMatched ? 405 : 404, pathMatched ? 'method_not_allowed' : 'not_found', pathMatched ? '请求方法不支持' : '接口不存在')
      return
    }

    const user = this.resolveUser?.(req) ?? null
    if (matched.auth !== 'public' && user === null) {
      err(res, 401, 'unauthorized', '请先登录')
      return
    }
    if (matched.auth === 'admin' && user?.role !== 'admin') {
      err(res, 403, 'forbidden', '需要管理员权限')
      return
    }

    // 请求体解析（统一读一次；GET/HEAD 之外都宽容解析 JSON，DELETE 也能带 body）
    let body: unknown
    let rawBody: string | undefined
    let fields: Record<string, string> = {}
    let files: UploadedFile[] = []
    const contentType = String(req.headers['content-type'] ?? '')
    if (method !== 'GET' && method !== 'HEAD') {
      const raw = await readBody(req).catch(() => null)
      if (raw !== null && raw.length > 0) {
        if (contentType.includes('multipart/form-data')) {
          try {
            const parsed = parseMultipart(raw, contentType)
            fields = parsed.fields
            files = parsed.files
          } catch {
            err(res, 400, 'bad_request', '请求体解析失败')
            return
          }
        } else {
          try {
            const text = raw.toString('utf8')
            body = JSON.parse(text) as unknown
            rawBody = text
          } catch {
            if (method !== 'DELETE') {
              err(res, 400, 'bad_request', '请求体不是合法 JSON')
              return
            }
          }
        }
      }
    }

    const ctx: ApiRequest = {
      req,
      res,
      url,
      method,
      params,
      query: url.searchParams,
      body,
      rawBody,
      fields,
      files,
      user,
    }
    // B3：内容域归属校验 —— 请求里带 botId（query 或 JSON body）时校验归属。
    if (this.botGuard !== null && matched.auth !== 'public' && user !== null) {
      const bodyBot = bodyRecord(body)['botId']
      const botId =
        ctx.query.get('botId') ??
        (typeof bodyBot === 'string' && bodyBot !== '' ? bodyBot : null) ??
        (typeof fields['botId'] === 'string' && fields['botId'] !== '' ? fields['botId'] : null)
      if (botId !== null && !this.botGuard(ctx, botId)) {
        err(res, 403, 'forbidden', '无权访问该角色的内容')
        return
      }
    }
    try {
      await matched.handler(ctx)
    } catch (error) {
      // B4：详情只进日志，响应脱敏；B5：同步 throw 与 fire() 覆盖后台 reject。
      reportInternalError(error, { method, path: url.pathname, userId: user?.id ?? '' })
      if (!res.headersSent) {
        err(res, 500, 'internal', '服务器内部错误，请稍后重试')
      } else {
        res.destroy()
      }
    }
  }

  /** 挂载到 webServer。 */
  mount(web: WebServerLike): () => void {
    return web.register({
      kind: 'prefix',
      path: '/api',
      handler: (req, res) => {
        // B5：handle() 自身的失败（如 resolveUser/读体异常）也必须就地兜底，不能变成进程级 unhandledRejection。
        void this.handle(req, res).catch((error: unknown) => {
          reportInternalError(error, {
            method: (req.method ?? 'GET').toUpperCase(),
            path: req.url ?? '',
            userId: '',
          })
          if (!res.headersSent) {
            err(res, 500, 'internal', '服务器内部错误，请稍后重试')
          } else {
            res.destroy()
          }
        })
      },
    })
  }
}

/** body 为对象时取字段，否则 undefined。 */
export function bodyRecord(body: unknown): Record<string, unknown> {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) return body as Record<string, unknown>
  return {}
}

export function reqStr(body: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = body[k]
    if (typeof v === 'string') return v
    if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  }
  return undefined
}

export function reqNum(body: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = body[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
    if (typeof v === 'boolean') return v ? 1 : 0
  }
  return undefined
}

export function reqBool(body: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const k of keys) {
    const v = body[k]
    if (typeof v === 'boolean') return v
    if (v === 'true' || v === 1 || v === '1') return true
    if (v === 'false' || v === 0 || v === '0') return false
  }
  return undefined
}
