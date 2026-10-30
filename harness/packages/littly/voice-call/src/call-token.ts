/**
 * B2 安全修复：`/call` WebSocket 握手令牌。
 *
 * 修复前 `/call?botId=..&sender=..` 完全无鉴权 —— 任何人知道 botId 就能连上、
 * 冒充任意 sender 开一场通话（消耗 Deepgram/TTS 额度、把伪造内容写进聊天记录）。
 *
 * 修复后：浏览器先 `POST /api/call/token`（走控制台正常的 httpOnly 会话 cookie），
 * 服务端校验登录态后签发一枚短时（120s）HMAC 令牌；握手时**只信令牌载荷里的
 * botId/sender**，URL 上自报的同名参数只用于一致性比对（不一致直接拒绝）。
 * 令牌签名密钥复用 console-api 的 `platform.secret`（与 JWT 同一秘密，均由
 * GlobalSetting 持久化），因此 WS 服务端无需知道用户表也能独立验签。
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

/** 令牌有效期（毫秒）：够手快连上即可，越短越安全。 */
export const CALL_TOKEN_TTL_MS = 120_000

export interface CallTokenPayload {
  botId: string
  sender: string
  /** 签发者用户 id（审计/归属用；握手鉴权本身只依赖签名）。 */
  userId: string
  /** 过期时刻（毫秒时间戳）。 */
  exp: number
}

function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('base64url')
}

/** 签发短时通话令牌。 */
export function signCallToken(
  secret: string,
  payload: Omit<CallTokenPayload, 'exp'> & { exp?: number },
  now: number = Date.now(),
): string {
  const exp = payload.exp ?? now + CALL_TOKEN_TTL_MS
  const body = Buffer.from(
    JSON.stringify({ botId: payload.botId, sender: payload.sender, userId: payload.userId, exp }),
    'utf8',
  ).toString('base64url')
  return `${body}.${sign(secret, body)}`
}

/** 校验通话令牌；签名不符 / 格式坏 / 过期 → null。 */
export function verifyCallToken(secret: string, token: string, now: number = Date.now()): CallTokenPayload | null {
  if (secret === '' || token === '') return null
  const dot = token.lastIndexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null
  const body = token.slice(0, dot)
  const signature = token.slice(dot + 1)
  const expected = sign(secret, body)
  const a = Buffer.from(signature, 'base64url')
  const b = Buffer.from(expected, 'base64url')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const rec = parsed as Record<string, unknown>
  if (typeof rec['botId'] !== 'string' || rec['botId'] === '') return null
  if (typeof rec['sender'] !== 'string' || rec['sender'] === '') return null
  if (typeof rec['exp'] !== 'number' || !Number.isFinite(rec['exp'])) return null
  if (rec['exp'] < now) return null
  return {
    botId: rec['botId'],
    sender: rec['sender'],
    userId: typeof rec['userId'] === 'string' ? rec['userId'] : '',
    exp: rec['exp'],
  }
}
