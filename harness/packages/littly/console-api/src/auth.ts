/**
 * 鉴权：手写 JWT（HS256，node:crypto HMAC）+ httpOnly Cookie 会话 + scrypt 口令哈希。
 * JWT 密钥来自 GlobalSetting platform.secret（首次启动自动生成并持久化）。
 */
import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { LittlyStorage, UserRow } from '@littly/storage'

export const COOKIE_NAME = 'littly_token'
const TOKEN_TTL_SECONDS = 7 * 24 * 3600

interface JwtPayload {
  sub: string
  role: string
  iat: number
  exp: number
}

function b64urlJson(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function hmac(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data, 'utf8').digest('base64url')
}

/** 签发 HS256 JWT。 */
export function signToken(userId: string, role: string, secret: string): string {
  const now = Math.floor(Date.now() / 1000)
  const header = b64urlJson({ alg: 'HS256', typ: 'JWT' })
  const payload = b64urlJson({ sub: userId, role, iat: now, exp: now + TOKEN_TTL_SECONDS } satisfies JwtPayload)
  const signature = hmac(`${header}.${payload}`, secret)
  return `${header}.${payload}.${signature}`
}

/** 校验 JWT；无效 / 过期返回 null。 */
export function verifyToken(token: string, secret: string): JwtPayload | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, payload, signature] = parts as [string, string, string]
  const expected = hmac(`${header}.${payload}`, secret)
  const a = Buffer.from(signature, 'base64url')
  const b = Buffer.from(expected, 'base64url')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const rec = parsed as Record<string, unknown>
  if (typeof rec.sub !== 'string' || typeof rec.exp !== 'number') return null
  if (rec.exp * 1000 < Date.now()) return null
  return { sub: rec.sub, role: typeof rec.role === 'string' ? rec.role : 'user', iat: typeof rec.iat === 'number' ? rec.iat : 0, exp: rec.exp }
}

/** scrypt 口令哈希：`scrypt:<salt-hex>:<hash-hex>`。 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 64)
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`
}

/** 校验口令。 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  const saltHex = parts[1]
  const hashHex = parts[2]
  if (!saltHex || !hashHex) return false
  try {
    const salt = Buffer.from(saltHex, 'hex')
    const expected = Buffer.from(hashHex, 'hex')
    const actual = scryptSync(password, salt, expected.length)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

/** 读取（必要时生成并持久化）JWT 签名密钥。 */
export function ensureSecret(storage: LittlyStorage): string {
  const existing = storage.getSetting('platform.secret')
  if (existing !== null && existing.length >= 32) return existing
  const secret = randomBytes(48).toString('hex')
  storage.setSetting('platform.secret', secret)
  return secret
}

function cookieValue(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie
  if (typeof header !== 'string' || header === '') return null
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim())
  }
  return null
}

/** 会话中心：持有密钥与存储，提供 cookie 解析 / 下发。 */
export class SessionManager {
  private readonly secret: string

  constructor(private readonly storage: LittlyStorage) {
    this.secret = ensureSecret(storage)
  }

  /** 从请求 Cookie 解析当前用户；无效返回 null。 */
  userFromRequest(req: IncomingMessage): UserRow | null {
    const token = cookieValue(req, COOKIE_NAME)
    if (token === null) return null
    const payload = verifyToken(token, this.secret)
    if (payload === null) return null
    const row = this.storage.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub) as UserRow | undefined
    return row ?? null
  }

  /** 下发会话 Cookie（httpOnly + SameSite=Lax）。 */
  setCookie(res: ServerResponse, userId: string, role: string): void {
    const token = signToken(userId, role, this.secret)
    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${String(TOKEN_TTL_SECONDS)}`,
    )
  }

  /** 清除会话 Cookie。 */
  clearCookie(res: ServerResponse): void {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
  }
}

/** 注册首个用户 → admin；其余按 platform.register_open 门控。 */
export function createUser(storage: LittlyStorage, username: string, password: string): { user: UserRow } | { error: string } {
  const trimmed = username.trim()
  if (trimmed.length < 2 || trimmed.length > 32) return { error: '用户名长度需在 2-32 个字符之间' }
  if (password.length < 6) return { error: '密码至少 6 位' }
  const existing = storage.prepare('SELECT id FROM users WHERE username = ?').get(trimmed)
  if (existing !== undefined) return { error: '用户名已被占用' }
  const count = storage.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }
  const firstUser = count.c === 0
  if (!firstUser) {
    const open = storage.getSetting('platform.register_open')
    if (open === 'false') return { error: '注册已关闭，请联系管理员' }
  }
  const row: UserRow = {
    id: randomUUID(),
    username: trimmed,
    password_hash: hashPassword(password),
    role: firstUser ? 'admin' : 'user',
    created_at: new Date().toISOString(),
  }
  storage.prepare('INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?,?,?,?,?)')
    .run(row.id, row.username, row.password_hash, row.role, row.created_at)
  return { user: row }
}
