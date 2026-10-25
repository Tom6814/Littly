/**
 * @littly/channel-discord — Discord 官方 API 渠道插件（Gateway v10 长连接 + REST v10）。
 *
 * 旧 monolith 对应文件：src/internal/channel/discord.ts。
 * - 每个启用的 bot（discord_enabled=1 且有 token）一条 Gateway 连接，monitor 按 botId 键控。
 * - 入站 → inbound.handleDiscordMessage（只收 DM）→ hub.enqueueBufferedMessage。
 * - 出站 → hub.registerChannel('discord', { sendText, sendPhoto, photoPublicUrl })：
 *   拟人化分条与片间延迟由 hub 完成，本插件只发单条 / 单图。
 * - 绑定：Discord 用户私聊机器人发送「绑定 XXXXXX」（6 位绑定码，与微信同款）。
 * - 自愈：60s 幂等扫描 bots 表，补启缺失的 monitor。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { BotRow, LittlyStorage } from '@littly/storage'
import type { LittlyHub } from '@littly/agents'
import {
  ensureDiscordMonitors,
  sendToDiscordHumanized,
  sendToDiscordImage,
  stopAllDiscordMonitors,
  type DiscordDeps,
  type DiscordMessage,
} from './client.ts'
import { handleDiscordMessage } from './inbound.ts'

export const name = 'littly-channel-discord'

export const inject = ['littlyStorage', 'littlyHub']

/** 插件配置。 */
export interface Config {
  /** 断线重连退避（毫秒），下限 1000 */
  reconnectMs: number
  /** 对外可访问的基地址（相册图 → Discord 拉取用）；空则用 env / 默认本机端口 */
  publicBaseUrl: string
}

export const Config: z<Config> = z.object({
  reconnectMs: z.number().default(5000),
  publicBaseUrl: z.string().default(''),
})

const SELF_HEAL_MS = 60_000

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

/**
 * 出站文本投递（hub → ChannelSender.sendText）。
 * @param deps - 插件依赖。
 * @param botId - 目标 bot id。
 * @param sender - 会话标识。
 * @param text - 消息正文。
 * @returns hub 约定的发送结果。
 */
export async function sendDiscordTextToContact(
  deps: DiscordDeps,
  botId: string,
  sender: string,
  text: string,
): Promise<{ ok: boolean; sent?: number | undefined; error?: string | undefined }> {
  const bot = deps.storage.prepare('SELECT * FROM bots WHERE id = ?').get(botId) as BotRow | undefined
  if (!bot) return { ok: false, error: 'bot not found' }
  const res = await sendToDiscordHumanized(deps, bot, sender, text)
  return res.ok ? { ok: true, sent: res.sent } : { ok: false, error: res.error }
}

/**
 * 出站图片投递（hub → ChannelSender.sendPhoto）。
 * @param deps - 插件依赖。
 * @param botId - 目标 bot id。
 * @param sender - 会话标识。
 * @param photoUrl - 相册图片 URL（相对路径会先转绝对地址）。
 * @param caption - 配图文案（可选）。
 * @returns hub 约定的发送结果。
 */
export async function sendDiscordPhoto(
  deps: DiscordDeps,
  botId: string,
  sender: string,
  photoUrl: string,
  caption?: string,
): Promise<{ ok: boolean; error?: string | undefined }> {
  const bot = deps.storage.prepare('SELECT * FROM bots WHERE id = ?').get(botId) as BotRow | undefined
  if (!bot) return { ok: false, error: 'bot not found' }
  const res = await sendToDiscordImage(deps, bot, sender, deps.photoPublicUrl(photoUrl), caption)
  return res.sent ? { ok: true } : { ok: false, error: res.error }
}

// --- 插件入口 ---

export function apply(ctx: Context, config: Config): void {
  const storage = ctx.littlyStorage as LittlyStorage
  const hub = ctx.littlyHub as LittlyHub
  const reconnectMs = Math.max(1000, Math.round(config.reconnectMs) || 5000)
  const log = (msg: string, ...args: unknown[]): void => ctx.logger.info(msg, ...args)
  const deps: DiscordDeps = {
    storage,
    hub,
    log,
    onMessage: (bot: BotRow, msg: DiscordMessage) => handleDiscordMessage(deps, bot, msg),
    photoPublicUrl: makePhotoPublicUrl(config),
    reconnectMs,
  }

  hub.registerChannel('discord', {
    sendText: (botId: string, sender: string, text: string) => sendDiscordTextToContact(deps, botId, sender, text),
    sendPhoto: (botId: string, sender: string, url: string, caption?: string) =>
      sendDiscordPhoto(deps, botId, sender, url, caption),
    photoPublicUrl: deps.photoPublicUrl,
    // startCall：Discord 无语音通话能力，不注册（hub 对缺失渠道回明确错误）
  })

  // 自愈：60s 幂等扫描
  ctx.effect(() => {
    const timer = setInterval(() => {
      void ensureDiscordMonitors(deps).catch((err) => log('[discord] 自愈失败: %s', String(err)))
    }, SELF_HEAL_MS)
    return () => {
      clearInterval(timer)
      stopAllDiscordMonitors()
    }
  }, 'littly-channel-discord.self-heal')

  void ensureDiscordMonitors(deps).catch((err) => log('[discord] 启动失败: %s', String(err)))
  ctx.logger.info('littly discord channel ready (reconnectMs=%d)', reconnectMs)
}
