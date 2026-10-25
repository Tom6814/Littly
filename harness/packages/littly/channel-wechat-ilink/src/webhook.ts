/**
 * 桥接 Webhook（openilink-hub → 本服务）——旧 internal/channel/wechat.ts 的
 * handleWechatEnvelope / verifyWechatSignature / seenEvent 的逐字移植。
 *
 * 入站契约（spec §9）：
 * 1. url_verification → 回显 challenge（**先于验签与 bot 路由**，旧项目即如此）。
 * 2. 其它事件 → 按 envelope.bot.id 找到启用中的 bot → HMAC 验签 → 幂等 → 解析 → 异步处理。
 * 3. 一律 reply_async（200 + {reply_async:true}），处理在后台跑。
 *
 * 验签算法：sha256 = HMAC-SHA256(secret, `${timestamp}:${rawBody}`)（hex，小写比较，
 * timingSafeEqual 等长比较）；时间戳与服务器时钟相差超过 5 分钟即视为过期。
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { BotRow, LittlyStorage } from '@littly/storage'
import type { LittlyHub } from '@littly/agents'
import { processWechatMessage, type WechatPushFn } from './inbound.ts'

const FRESHNESS_MS = 5 * 60 * 1000
const EVENT_TTL_MS = 10 * 60 * 1000
const EVENT_CAP = 5000

/** 桥接事件体（openilink-hub 事件格式 + 旧自定义格式）。 */
export interface WechatEvent {
  id?: string
  type?: string
  // openilink-hub（微信 ClawBot / iLink）事件格式：event.data.sender.id / event.data.content
  data?: {
    sender?: { id?: string; role?: string }
    content?: string
    msg_type?: string
    message_id?: number
    group?: unknown
    command?: string
    text?: string
  }
  // 旧自定义格式（兼容保留）
  from_user?: string
  text?: string
}

/** 桥接 webhook 信封。 */
export interface WechatEnvelope {
  v?: number
  type?: string
  trace_id?: string
  installation_id?: string
  challenge?: string
  bot?: { id?: string }
  event?: WechatEvent
}

/** 桥接 webhook 处理依赖。 */
export interface WechatWebhookDeps {
  storage: LittlyStorage
  hub: LittlyHub
  log: (msg: string, ...args: unknown[]) => void
  /** 出站推送（默认走 iLink 直连；测试可注入假实现） */
  push?: WechatPushFn | undefined
}

/** 桥接 webhook 处理结果（HTTP 状态码 + 响应体）。 */
export interface WechatWebhookResult {
  status: number
  body: Record<string, unknown>
}

/** 幂等去重表（event.id → 首次出现时间）。 */
const seenEvents = new Map<string, number>()

/**
 * 幂等判定：同一 event.id 在 TTL 内只放行一次。
 * @param id - 事件 id。
 * @returns true = 已见过（应短路）。
 */
export function seenEvent(id?: unknown): boolean {
  if (!id || typeof id !== 'string') return false
  const now = Date.now()
  if (seenEvents.size >= EVENT_CAP) {
    for (const [k, t] of seenEvents) {
      if (now - t > EVENT_TTL_MS) seenEvents.delete(k)
    }
  }
  const prev = seenEvents.get(id)
  if (prev !== undefined && now - prev <= EVENT_TTL_MS) return true
  while (seenEvents.size >= EVENT_CAP) {
    const oldest = seenEvents.keys().next().value
    if (oldest === undefined) break
    seenEvents.delete(oldest)
  }
  seenEvents.set(id, now)
  return false
}

/** 清空幂等表（测试用）。 */
export function clearSeenEvents(): void {
  seenEvents.clear()
}

/**
 * HMAC 验签。
 * @param secret - bots.wx_verify_secret（HMAC 密钥）。
 * @param timestamp - 请求头 x-timestamp（秒级时间戳）。
 * @param rawBody - 原始请求体（逐字，不能先 parse 再拼）。
 * @param signature - 请求头 x-signature（`sha256=<hex>`）。
 * @returns 验签是否通过。
 */
export function verifyWechatSignature(
  secret: string | null | undefined,
  timestamp: string | null,
  rawBody: string,
  signature: string | null | undefined,
): boolean {
  if (!secret || !timestamp || !signature) return false
  if (!signature.startsWith('sha256=')) return false
  const hex = signature.slice('sha256='.length)
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false
  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return false
  if (Math.abs(Date.now() - ts * 1000) > FRESHNESS_MS) return false
  const expected = createHmac('sha256', secret).update(`${timestamp}:${rawBody}`).digest('hex')
  const a = Buffer.from(expected, 'hex')
  const b = Buffer.from(hex.toLowerCase(), 'hex')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** 按 envelope.bot.id 找启用中的 bot（桥接侧 bot.id = bots.wx_hub_bot_id）。 */
function findHubBot(storage: LittlyStorage, hubBotId: string): BotRow | undefined {
  if (!hubBotId) return undefined
  return storage
    .prepare('SELECT * FROM bots WHERE wx_hub_bot_id = ? AND wx_enabled = 1')
    .get(hubBotId) as BotRow | undefined
}

/**
 * 桥接 Webhook 主入口：challenge 回显 → bot 路由 → 验签 → 幂等 → 解析 → 异步处理。
 *
 * 供 console-api 路由挂载：把 HTTP 层的原始 body 与两个请求头传进来即可。
 * @param rawBody - 原始请求体字符串。
 * @param meta - 请求头 x-timestamp / x-signature。
 * @param deps - 插件依赖。
 * @returns HTTP 状态码与响应体。
 */
export async function handleWechatWebhook(
  rawBody: string,
  meta: { timestamp: string | null; signature: string | null },
  deps: WechatWebhookDeps,
): Promise<WechatWebhookResult> {
  let envelope: WechatEnvelope | null
  try {
    envelope = JSON.parse(rawBody) as WechatEnvelope | null
  } catch {
    return { status: 400, body: { error: 'invalid json' } }
  }

  if (envelope?.type === 'url_verification') {
    return { status: 200, body: { challenge: envelope.challenge ?? '' } }
  }

  const hubBotId = envelope?.bot?.id ?? ''
  const bot = findHubBot(deps.storage, hubBotId)
  if (!bot) return { status: 404, body: { error: 'unknown bot' } }

  if (!verifyWechatSignature(bot.wx_verify_secret, meta.timestamp, rawBody, meta.signature)) {
    return { status: 401, body: { error: 'invalid signature' } }
  }

  const event = envelope?.event
  if (event?.id && seenEvent(event.id)) {
    return { status: 200, body: { reply_async: true } }
  }

  // §openilink-hub 事件解析：message.text → event.data.sender.id / event.data.content；
  // command 事件 → data.command + data.text；兼容旧自定义 from_user/text。
  const fromUser = event?.data?.sender?.id ?? event?.from_user ?? ''
  const text =
    event?.data?.content ??
    event?.text ??
    (event?.data?.command ? `${event.data.command} ${event.data.text ?? ''}`.trim() : '')
  if (!fromUser || !text) {
    return { status: 400, body: { error: 'sender and content required' } }
  }

  void processWechatMessage(deps, bot, fromUser, text).catch((err: unknown) => {
    deps.log('wechat process failed: %s', String(err))
  })
  return { status: 200, body: { reply_async: true } }
}
