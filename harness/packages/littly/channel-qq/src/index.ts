/**
 * @littly/channel-qq — QQ 双渠道插件（SnowLuma OneBot v11 + 官方 QQBot）。
 *
 * 背景：旧的 @littly/channel-snowluma 与 @littly/channel-qq-official 全部废弃；
 * 本包基于 MIT 的 dsh-lane-bridge（CNranger1124，派生自 Derpyu520/qq-bridge）重写，
 * 只保留 SnowLuma 与官方 QQBot 两个渠道，并深度接入本仓库：
 * - 入站 → hub.enqueueBufferedMessage({channelId:'snowluma'|'qqp'})（落库即入缓冲，
 *   拟人化分条与投递由 hub 完成）；
 * - 出站 → hub.registerChannel 回调本包 manager（回到「来的地方」：群回群、私聊回私聊；
 *   QQBot 被动回复窗口 5min / 60min 事件语义由 manager.recentMessageId 维护）；
 * - 配置在 bots 表（snowluma_* / qq_* 列）；SnowLuma 由用户自行安装运行（不代装/不代启，
 *   遵守其非商业自托管 EULA）。
 *
 * 许可：MIT（见 LICENSE / NOTICE；适配器代码派生自 dsh-lane-bridge 与 qq-bridge）。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { LittlyStorage } from '@littly/storage'
import type { LittlyHub } from '@littly/agents'
import { QqChannelManager, type QqChannelKind, type QqLogLine, type QqProbeResult, type QqStatusResult } from './manager.ts'
import { handleInboundMessage, resolveExternalId } from './inbound.ts'
import { registerQqChannelTools } from './tools.ts'

export const name = 'littly-channel-qq'

export const inject = ['tools', 'littlyPersona', 'littlyStorage', 'littlyHub']

export interface Config {
  /** 对外基地址（相册相对路径 → QQ 拉取用）；空则读 LITTLY_PUBLIC_URL / 本机 PORT。 */
  publicBaseUrl: string
  /** 自愈扫描间隔（毫秒，下限 5000）。 */
  selfHealMs: number
}

export const Config: z<Config> = z.object({
  publicBaseUrl: z.string().default(''),
  selfHealMs: z.number().default(60_000),
})

export interface QqChannelService {
  status(): QqStatusResult
  logs(tail?: number): QqLogLine[]
  probe(kind: QqChannelKind, botId?: string): Promise<QqProbeResult>
  sync(): Promise<void>
  stopAll(): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    littlyChannelQq: QqChannelService
  }
}

function makePhotoPublicUrl(config: Config): (url: string) => string {
  return (url: string): string => {
    if (/^https?:\/\//.test(url)) return url
    const base = (config.publicBaseUrl || process.env['LITTLY_PUBLIC_URL'] || `http://127.0.0.1:${process.env['PORT'] ?? '3000'}`).replace(/\/+$/, '')
    return url.startsWith('/') ? `${base}${url}` : `${base}/${url}`
  }
}

/** 适配器 id → manager 渠道种类。 */
function adapterKindOf(channelId: string): QqChannelKind {
  return channelId === 'snowluma' ? 'snowluma' : 'qqbot'
}

/** 装配 QQ 双渠道（注册 hub 出站 + 启动 manager + 渠道工具）。 */
export function apply(ctx: Context, config: Config = {} as Config): void {
  const storage = ctx.littlyStorage as LittlyStorage
  const hub = ctx.littlyHub as LittlyHub
  const photoPublicUrl = makePhotoPublicUrl(config)
  const log = (msg: string, ...args: unknown[]): void => ctx.logger.info(msg, ...args)

  const manager = new QqChannelManager({
    storage,
    log,
    publicBaseUrl: config.publicBaseUrl,
    onMessage: (message, bot) => {
      void handleInboundMessage({ storage, hub, manager, log, photoPublicUrl }, bot, adapterKindOf(message.channel), message)
        .catch((error: unknown) => log('[channel-qq] 入站处理失败: %s', String((error as Error)?.message ?? error)))
    },
  })

  // --- 出站：hub 投递回调 ---
  const sendTo = async (channelId: string, botId: string, sender: string, text: string) => {
    const kind = adapterKindOf(channelId)
    const last = manager.lastInbound(botId, sender)
    const externalId = last?.externalId ?? resolveExternalId({ storage, hub, manager, log, photoPublicUrl }, botId, sender, 'qqp')
    if (externalId === '') throw new Error('没有 QQ 会话地址（对方需要先给 bot 发过消息）')
    const replyToId = manager.recentMessageId(botId, kind, externalId)
    const conversation = {
      channel: channelId,
      kind: last?.kind ?? ('private' as const),
      externalId,
      reply: true,
      ...(replyToId !== '' ? { replyToId } : {}),
    }
    const result = await manager.send(botId, kind, conversation, [text])
    return { ok: result.ok, sent: result.sent, ...(result.error !== undefined ? { error: result.error } : {}) }
  }

  hub.registerChannel('snowluma', {
    sendText: (botId, sender, text) => sendTo('snowluma', botId, sender, text),
    sendPhoto: async (botId, sender, photoUrl, caption) => {
      const last = manager.lastInbound(botId, sender)
      const externalId = last?.externalId ?? resolveExternalId({ storage, hub, manager, log, photoPublicUrl }, botId, sender, 'qqp')
      if (externalId === '') throw new Error('没有 QQ 会话地址（对方需要先给 bot 发过消息）')
      return manager.sendPhoto(botId, { channel: 'snowluma', kind: last?.kind ?? 'private', externalId }, photoPublicUrl(photoUrl), caption)
    },
    photoPublicUrl,
  })
  hub.registerChannel('qqp', {
    sendText: (botId, sender, text) => sendTo('qqp', botId, sender, text),
  })

  // --- 渠道工具（仅 SnowLuma 能力；QQBot 调用会得到可读错误） ---
  registerQqChannelTools({ manager, photoPublicUrl, storage }, hub.tools)

  // --- 生命周期：启动 + 60s 自愈 + 卸载清理 ---
  ctx.effect(() => {
    void manager.sync().catch((error: unknown) => log('[channel-qq] 初始同步失败: %s', String((error as Error)?.message ?? error)))
    const interval = Math.max(5000, Math.round(config.selfHealMs ?? 60_000))
    const timer = setInterval(() => {
      void manager.sync()
    }, interval)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    return () => {
      clearInterval(timer)
      void manager.stopAll()
    }
  }, 'littly-channel-qq: manager')

  ctx.provide('littlyChannelQq', {
    status: () => manager.status(),
    logs: (tail?: number) => manager.logs(tail),
    probe: (kind: QqChannelKind, botId?: string) => manager.probe(kind, botId),
    sync: () => manager.sync(),
    stopAll: () => manager.stopAll(),
  })

  ctx.logger.info('littly channel-qq ready（SnowLuma OneBot v11 + 官方 QQBot）')
}

export { QqChannelManager } from './manager.ts'
export type { QqChannelKind, QqStatusResult, QqChannelStatus, QqLogLine, QqProbeResult } from './manager.ts'
export { handleInboundMessage, resolveExternalId, channelMeta, shouldProcessGroupMessage, importInboundPhotos } from './inbound.ts'
export { tryHandleBinding, promoteContact } from './binding.ts'
export { registerQqChannelTools } from './tools.ts'
export { SnowLumaAdapter, segmentsToText, mentionsOf, imagesOf } from './adapters/snowluma.ts'
export { QqbotAdapter } from './adapters/qqbot.ts'
export { OneBotWsClient } from './adapters/onebot-ws.ts'
export { ChannelAdapter } from './adapters/base.ts'
export type { InboundMessage, OutboundConversation, ChannelAdapterStatus } from './adapters/base.ts'
export type { QqbotSdkLike, QqbotBotLike } from './adapters/qqbot.ts'
export type { WebSocketLike } from './adapters/onebot-ws.ts'
