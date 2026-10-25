/**
 * @littly/channel-snowluma — QQ 账号渠道插件（SnowLuma / OneBot v11 正向 WS 客户端）。
 *
 * - 每个启用的 bot（snowluma_enabled=1 且有 ws_url）一条 WS 连接，monitor 按
 *   `${botId}:${snowluma_account || 'default'}` 键控；多个 bot 可共用一个 SnowLuma 实例。
 * - 入站 → inbound.handleSnowlumaEvent（私聊 friend + 群聊 @提及）→ hub.enqueueBufferedMessage。
 * - 出站 → hub.registerChannel('qqp', { sendText, sendPhoto, callAction, photoPublicUrl })：
 *   拟人化分条与片间延迟由 hub 完成，本插件只发单条 / 单图。
 * - 渠道工具：send_qq_face / set_qq_profile / set_qq_avatar / post_qzone。
 * - 自愈：60s 幂等扫描 bots 表，补启缺失的 monitor。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { BotRow, LittlyStorage } from '@littly/storage'
import type { LittlyHub } from '@littly/agents'
import {
  callBotAction,
  callSnowluma,
  ensureAllSnowlumaMonitors,
  getMonitor,
  monitorKey,
  stopAllSnowlumaMonitors,
  type OneBotEnvelope,
  type SnowlumaDeps,
} from './client.ts'
import { handleSnowlumaEvent, resolveQqpUin, sendPrivateText } from './inbound.ts'
import { registerSnowlumaTools } from './tools.ts'

export const name = 'littly-channel-snowluma'

export const inject = ['littlyStorage', 'littlyHub']

export interface Config {
  /** 断线重连退避（毫秒），下限 1000 */
  reconnectMs: number
  /** 对外可访问的基地址（相册图 → SnowLuma 服务端拉取用）；空则用 env / 默认本机端口 */
  publicBaseUrl: string
}

export const Config: z<Config> = z.object({
  reconnectMs: z.number().default(5000),
  publicBaseUrl: z.string().default(''),
})

const SELF_HEAL_MS = 60_000

// botId → { nick, at } 昵称缓存
const selfNickCache = new Map<string, { nick: string; at: number }>()

// --- bot 自身昵称（get_login_info，懒取缓存；群聊 @提及门需要） ---

// botId → { nick, at }；空结果也缓存 5 分钟，避免连接抖动时每条群消息都打 RPC
const SELF_NICK_TTL_MS = 5 * 60_000

async function getSelfNickname(deps: SnowlumaDeps, bot: BotRow): Promise<string> {
  const cached = selfNickCache.get(bot.id)
  if (cached && Date.now() - cached.at < SELF_NICK_TTL_MS) return cached.nick
  let nick = ''
  const res = await callBotAction(deps.storage, bot.id, 'get_login_info', {})
  if (res && (res.retcode === 0 || res.status === 'ok')) {
    const data = res.data as { nickname?: unknown } | null
    if (typeof data?.nickname === 'string') nick = data.nickname
  }
  selfNickCache.set(bot.id, { nick, at: Date.now() })
  return nick
}

// --- 相册相对路径 → 绝对公网 URL ---

function makePhotoPublicUrl(config: Config): (url: string) => string {
  return (url: string): string => {
    if (/^https?:\/\//.test(url)) return url
    const base = (
      config.publicBaseUrl ||
      process.env.LITTLY_PUBLIC_URL ||
      `http://127.0.0.1:${process.env.PORT || 3000}`
    ).replace(/\/+$/, '')
    return url.startsWith('/') ? `${base}${url}` : `${base}/${url}`
  }
}

// --- 出站 ---

export async function sendQqpText(
  deps: SnowlumaDeps,
  botId: string,
  sender: string,
  text: string,
): Promise<{ ok: boolean; sent?: number | undefined; error?: string | undefined }> {
  const uin = resolveQqpUin(deps, botId, sender)
  if (!uin) throw new Error('没有 QQ uin（对方需要先给 bot 发过消息）')
  await sendPrivateText(deps, botId, uin, text)
  return { ok: true, sent: 1 }
}

async function sendQqpPhoto(
  deps: SnowlumaDeps,
  botId: string,
  sender: string,
  photoUrl: string,
  caption?: string,
): Promise<{ ok: boolean; error?: string | undefined }> {
  const uin = resolveQqpUin(deps, botId, sender)
  if (!uin) throw new Error('没有 QQ uin（对方需要先给 bot 发过消息）')
  // SnowLuma 服务端拉取 http(s) URL（契约 §4 媒体来源优先级）
  const segments: Array<{ type: string; data: Record<string, unknown> }> = [
    { type: 'image', data: { url: deps.photoPublicUrl(photoUrl) } },
  ]
  if (caption) segments.push({ type: 'text', data: { text: caption } })
  const res = await callBotAction(deps.storage, botId, 'send_private_msg', {
    user_id: Number(uin),
    message: segments,
  })
  if (!res) throw new Error('SnowLuma 连接不可用或响应超时')
  if (!(res.retcode === 0 || res.status === 'ok')) {
    throw new Error(`SnowLuma 发图失败: retcode=${String(res.retcode)} ${String(res.wording ?? '').slice(0, 200)}`)
  }
  return { ok: true }
}

/**
 * bridge.callAction 不携带 botId（hub 既定契约）：单实例场景直接路由；多实例时渠道
 * 工具应走 registerChannelTool 的 exec（内部有 ctx.botId 精确路由）。内置工具均不
 * 依赖此入口，故这里只在已连接 monitor 中顺序取第一个可用者。
 */
async function callAnyAction(
  deps: SnowlumaDeps,
  action: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const bots = deps.storage
    .prepare('SELECT id, snowluma_account FROM bots WHERE snowluma_enabled = 1')
    .all() as Array<{ id: string; snowluma_account: string }>
  for (const b of bots) {
    const mon = getMonitor(monitorKey(b.id, b.snowluma_account))
    if (!mon) continue
    const res = await callSnowluma(mon, action, params)
    if (res) return res as Record<string, unknown>
  }
  return null
}

// --- 插件入口 ---

export function apply(ctx: Context, config: Config): void {
  const storage = ctx.littlyStorage as LittlyStorage
  const hub = ctx.littlyHub as LittlyHub
  const reconnectMs = Math.max(1000, Math.round(config.reconnectMs) || 5000)
  const log = (msg: string, ...args: unknown[]): void => ctx.logger.info(msg, ...args)
  const deps: SnowlumaDeps = {
    storage,
    hub,
    log,
    onMessage: (bot, ev: OneBotEnvelope) => handleSnowlumaEvent(deps, bot, ev),
    getSelfNickname: (bot) => getSelfNickname(deps, bot),
    photoPublicUrl: makePhotoPublicUrl(config),
    reconnectMs,
  }

  hub.registerChannel('qqp', {
    sendText: (botId, sender, text) => sendQqpText(deps, botId, sender, text),
    sendPhoto: (botId, sender, url, caption) => sendQqpPhoto(deps, botId, sender, url, caption),
    callAction: (action, params) => callAnyAction(deps, action, params),
    photoPublicUrl: deps.photoPublicUrl,
    // startCall：OneBot 无语音通话能力，不注册（hub 对缺失渠道回明确错误）
  })

  registerSnowlumaTools(deps)

  // 自愈：60s 幂等扫描
  ctx.effect(() => {
    const timer = setInterval(() => {
      void ensureAllSnowlumaMonitors(deps).catch((err) => log('[snowluma] 自愈失败: %s', String(err)))
    }, SELF_HEAL_MS)
    return () => {
      clearInterval(timer)
      stopAllSnowlumaMonitors()
    }
  }, 'littly-channel-snowluma.self-heal')

  void ensureAllSnowlumaMonitors(deps).catch((err) => log('[snowluma] 启动失败: %s', String(err)))
  ctx.logger.info('littly snowluma channel ready (reconnectMs=%d)', reconnectMs)
}
