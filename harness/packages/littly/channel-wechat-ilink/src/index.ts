/**
 * @littly/channel-wechat-ilink — 微信渠道插件（iLink 直连 + openilink-hub 桥接 Webhook）。
 *
 * - 渠道 id = 'wechat'（与旧项目一致；hub 场景文案表里也是 wechat）。
 * - 入站：桥接 Webhook（handleWechatWebhook，供 console-api 路由挂载）或 iLink 长轮询
 *   → inbound.processWechatMessage → hub.enqueueBufferedMessage（缓冲窗口由 hub 调度，
 *   保持"恰好一次"模型调用契约，绝不直接调模型）。
 * - 出站：hub.registerChannel('wechat', { sendText })：拟人化分条与片间延迟由 hub 完成，
 *   本插件只发单条文本（iLink push）。
 * - 自愈：60s 幂等扫描 bots 表，补启缺失的 iLink monitor。
 * - SDK：@openilink/openilink-sdk-node 不在本 workspace 内，本包自带零依赖 fetch 实现
 *   （见 ilink.ts 的「SDK 接缝」一节），宿主也可注入官方 SDK 客户端。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { BotRow, LittlyStorage } from '@littly/storage'
import type { LittlyHub } from '@littly/agents'
import {
  ensureILinkMonitors,
  stopAllILinkMonitors,
  type ILinkDeps,
} from './ilink.ts'
import { processWechatMessage, pushWechatText, type WechatInboundDeps } from './inbound.ts'

export const name = 'littly-channel-wechat-ilink'

export const inject = ['littlyStorage', 'littlyHub']

/** 插件配置。 */
export interface Config {
  /** 自愈扫描间隔（毫秒）：补启缺失的 iLink monitor */
  selfHealMs: number
}

export const Config: z<Config> = z.object({
  selfHealMs: z.number().default(60_000),
})

const SELF_HEAL_MS = 60_000

// --- 出站 ---

/**
 * 微信出站发文本（hub 逐片调用；本函数只发单条）。
 * @param deps - 插件依赖。
 * @param botId - 目标 bot id。
 * @param sender - 会话主键（可能是绑定后的 userId）。
 * @param text - 文本内容。
 * @returns 发送结果。
 */
export async function sendWechatText(
  deps: WechatInboundDeps,
  botId: string,
  sender: string,
  text: string,
): Promise<{ ok: boolean; sent?: number | undefined; error?: string | undefined }> {
  const bot = deps.storage.prepare('SELECT * FROM bots WHERE id = ?').get(botId) as BotRow | undefined
  if (!bot) return { ok: false, error: '角色不存在' }
  // 旧项目出站只看 bot_token（wx_enabled 不参与判定），保持一致。
  const ok = await pushWechatText(deps, bot, sender, text)
  if (!ok) return { ok: false, error: '微信推送失败（对方需先给 bot 发过消息，或缺少 bot_token）' }
  return { ok: true, sent: 1 }
}

// --- 插件入口 ---

/**
 * 插件装配：注册出站渠道 + 启动 iLink monitor + 自愈扫描。
 * @param ctx - Cordis 上下文。
 * @param config - 插件配置。
 */
export function apply(ctx: Context, config: Config): void {
  const storage: LittlyStorage = ctx.littlyStorage
  const hub: LittlyHub = ctx.littlyHub
  const selfHealMs = Math.max(1_000, Math.round(config.selfHealMs) || SELF_HEAL_MS)
  const log = (msg: string, ...args: unknown[]): void => {
    ctx.logger.info(msg, ...args)
  }

  const deps: WechatInboundDeps & ILinkDeps = {
    storage,
    hub,
    log,
    onMessage: (bot: BotRow, fromUser: string, text: string): Promise<void> =>
      processWechatMessage(deps, bot, fromUser, text),
  }

  hub.registerChannel('wechat', {
    sendText: (botId, sender, text) => sendWechatText(deps, botId, sender, text),
  })
  // TODO(M2)：sendPhoto / startCall —— iLink 侧图片与语音通话能力旧项目未接入，不注册
  // （hub 对缺失渠道回明确错误）。

  // 自愈：60s 幂等扫描
  ctx.effect(() => {
    const timer = setInterval(() => {
      void ensureILinkMonitors(deps).catch((err: unknown) => {
        log('[wechat] 自愈失败: %s', String(err))
      })
    }, selfHealMs)
    return () => {
      clearInterval(timer)
      stopAllILinkMonitors()
    }
  }, 'littly-channel-wechat-ilink.self-heal')

  void ensureILinkMonitors(deps).catch((err: unknown) => {
    log('[wechat] 启动失败: %s', String(err))
  })
  ctx.logger.info('littly wechat-ilink channel ready (selfHeal=%dms)', selfHealMs)
}

export { handleWechatWebhook } from './webhook.ts'
export type { WechatWebhookDeps, WechatWebhookResult } from './webhook.ts'
