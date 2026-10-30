/**
 * @littly/channel-qq-official — QQ 官方开放平台渠道插件（q.qq.com，每个角色独立机器人）。
 *
 * - 每个启用的 bot（qq_enabled=1 且有 AppID/AppSecret）一条 WS 连接，monitor 按 botId 键控。
 * - 入站 → inbound.handleQQMessage（绑定拦截 → 身份归一化 → 联系人）→ hub.enqueueBufferedMessage。
 * - 出站 → hub.registerChannel('qq', { sendText })：拟人化分条与片间延迟由 hub 完成，
 *   本插件只发单条文本（旧实现同样只发 msg_type=0 文本）。
 * - 自愈：60s 幂等扫描 bots 表，补启缺失的 monitor（进程重启 / bot 后台启用均覆盖）。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { BotRow, LittlyStorage } from '@littly/storage'
import type { LittlyHub } from '@littly/agents'
import { ensureQQMonitors, sendQQText, stopAllQQMonitors, type QqDeps } from './client.ts'
import { handleQQMessage, resolveQqOpenid } from './inbound.ts'
import { recallQqEvent } from './event-context.ts'

export const name = 'littly-channel-qq-official'

export const inject = ['littlyStorage', 'littlyHub']

/** 插件配置。 */
export interface Config {
  /** 断线重连退避（毫秒），下限 1000 */
  reconnectMs: number
}

export const Config: z<Config> = z.object({
  reconnectMs: z.number().default(5000),
})

const SELF_HEAL_MS = 60_000

/**
 * 出站发文本（hub 逐片调用；本函数只发单条）。
 * @param deps - 插件依赖
 * @param botId - bot 行 id
 * @param sender - 会话发送方键
 * @param text - 文本内容
 * @returns 发送结果（ok/sent/error）
 */
export async function sendQqText(
  deps: QqDeps,
  botId: string,
  sender: string,
  text: string,
): Promise<{ ok: boolean; sent?: number | undefined; error?: string | undefined }> {
  const bot = deps.storage.prepare('SELECT * FROM bots WHERE id = ?').get(botId) as BotRow | undefined
  if (!bot || !bot.qq_enabled || !bot.qq_app_id || !bot.qq_app_secret) {
    return { ok: false, sent: 0, error: 'QQ 未启用' }
  }
  if (!text.trim()) return { ok: true, sent: 0 }

  const openid = resolveQqOpenid(deps, botId, sender)
  if (!openid) {
    return { ok: false, sent: 0, error: '没有 QQ openid（对方需要先给 bot 发过消息）' }
  }
  // §B7：主链路回复优先走「被动回复」—— 带最近 60 分钟内的入站 event_id，
  // 否则会被 QQ 当主动推送（每月仅 4 条配额）。
  const eventId = recallQqEvent(botId, openid)
  const ok = await sendQQText(deps, bot, openid, text, { eventId })
  return ok ? { ok: true, sent: 1 } : { ok: false, sent: 0, error: 'QQ 发送失败' }
}

/**
 * 插件入口。
 * @param ctx - Cordis 上下文
 * @param config - 插件配置
 */
export function apply(ctx: Context, config: Config): void {
  const storage = ctx.littlyStorage as LittlyStorage
  const hub = ctx.littlyHub as LittlyHub
  const reconnectMs = Math.max(1000, Math.round(config.reconnectMs) || 5000)
  const log = (msg: string, ...args: unknown[]): void => ctx.logger.info(msg, ...args)
  const deps: QqDeps = {
    storage,
    hub,
    log,
    onMessage: (bot, payload) => handleQQMessage(deps, bot, payload),
    reconnectMs,
  }

  hub.registerChannel('qq', {
    sendText: (botId, sender, text) => sendQqText(deps, botId, sender, text),
  })
  // 被动回复窗口：QQ 官方主动推送每月 4 条，回复必须带前置 event_id（由入站绑定回复携带）
  // sendPhoto / callAction：QQ 官方开放平台旧实现只发文本，不注册（hub 对缺失渠道回明确错误）

  // 自愈：60s 幂等扫描
  ctx.effect(() => {
    const timer = setInterval(() => {
      void ensureQQMonitors(deps).catch((err) => log('[qq] 自愈失败: %s', String(err)))
    }, SELF_HEAL_MS)
    return () => {
      clearTimeout(timer)
      stopAllQQMonitors()
    }
  }, 'littly-channel-qq-official.self-heal')

  void ensureQQMonitors(deps).catch((err) => log('[qq] 启动失败: %s', String(err)))
  ctx.logger.info('littly qq official channel ready (reconnectMs=%d)', reconnectMs)
}
