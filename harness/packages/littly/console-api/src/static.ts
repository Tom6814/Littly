/**
 * 控制台静态资源托管（SPA）。
 *
 * 为什么自己写而不直接用 dsh 的 @deepseek-ai/dsh-host-frontend-static：
 * 那个包的 index 渲染要先过 dsh connection 的浏览器鉴权；而 Littly 控制台有
 * 自己的账号体系（users 表 + 会话 cookie），登录页本身必须匿名可访问。
 * 所以这里按控制台自己的鉴权模型托管：静态资源匿名可取（index.html 里没有数据，
 * 数据一律走 /api/* 受保护端点）。
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
}

/** 控制台 dist 目录（默认相对 cwd；容器里是 /app/console/dist）。 */
export function consoleDistDir(): string {
  return process.env['LITTLY_CONSOLE_DIR'] ?? resolve(process.cwd(), 'console', 'dist')
}

function contentType(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/** 路径解析：只允许 dist 内的文件（越界 → null）。 */
export function resolveAsset(distRoot: string, pathname: string): string | null {
  const decoded = (() => {
    try {
      return decodeURIComponent(pathname)
    } catch {
      return pathname
    }
  })()
  const rel = normalize(decoded).replace(/^([/\\])+/, '')
  if (rel.split(/[/\\]/).includes('..')) return null
  const full = resolve(distRoot, rel)
  if (full !== distRoot && !full.startsWith(distRoot + sep)) return null
  return full
}

/**
 * 注册控制台静态托管（webserver fallback 位）。
 * @param register 注入 webserver 的 registerFallback
 * @param distRoot 控制台 dist 目录
 */
export function registerConsoleStatic(
  register: (fallback: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) => () => void,
  distRoot: string = consoleDistDir(),
): () => void {
  return register(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: { code: 'method_not_allowed', message: '方法不允许' } }))
      return
    }
    if (!existsSync(distRoot)) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: { code: 'not_found', message: '控制台静态资源未构建（缺少 console/dist）' } }))
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const asset = resolveAsset(distRoot, url.pathname)
    // 越界 → 403
    if (asset === null) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: { code: 'forbidden', message: '路径越界' } }))
      return
    }
    let target = asset
    if (!existsSync(target) || statSync(target).isDirectory()) {
      const index = join(distRoot, 'index.html')
      if (!existsSync(index)) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: { code: 'not_found', message: '控制台静态资源缺失' } }))
        return
      }
      // SPA：未知路径回 index.html（前端路由）
      target = index
    }
    const type = contentType(target)
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-type': type })
      res.end()
      return
    }
    if (type.startsWith('text/') || type.includes('json') || type.includes('javascript')) {
      const body = await readFile(target)
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' })
      res.end(body)
      return
    }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=86400' })
    createReadStream(target).pipe(res)
  })
}
