/**
 * @littly/channel-wechat-ilink — 微信渠道插件（iLink 直连，自研协议客户端，不依赖 openilink-hub）。
 *
 * 能力（照 openilink-hub 的做法，自己实现一份）：
 * - 扫码绑定：控制台取二维码 → 微信扫码确认 → 落四元凭据 {bot_token, baseurl, ilink_bot_id,
 *   ilink_user_id}（global_settings 权威 + bots.wx_* 镜像）→ 立即启动消息轮询。
 * - 收发消息：getUpdates 长轮询（游标持久化、自动重连/退避/会话过期）+ sendmessage 出站
 *   （按会话 context_token，遵守 24h 窗口）+ sendtyping / getconfig。
 * - 名片二维码：好友扫码加她（协议只有 bot 绑定码，见 ilink-bind.ts 的说明）。
 * - 入站路由：绑定码拦截 / 身份归一化沿用 binding.ts；普通消息走 hub（缓冲入队，hub 到期后
 *   runTurn(channelId='wechat')）或 direct 模式立即 runTurn。
 *
 * 服务键 `littlyWechat`：console-api 的 /api/wechat/* 通过它下发起绑定/状态/登出操作
 * （见 console-api/src/routes-wechat.ts）。插件名与装配行保持不变：
 * `littly-channel-wechat-ilink` / `@littly/channel-wechat-ilink`。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { BotRow, LittlyStorage } from '@littly/storage'
import type { LittlyHub } from '@littly/agents'
import { ILinkAccountManager, type ILinkAccountStatus } from './ilink-account.ts'
import {
  ILinkBindService,
  createFriendQr,
  type FriendQrResult,
  type StartBindResult,
} from './ilink-bind.ts'
import type { ILinkBindSessionState } from './ilink-store.ts'
import {
  clearCredentials,
  getCredentials,
  getFriendQr,
  getLastInboundAt,
  listBoundBotIds,
  loadBot,
  saveCredentials,
} from './ilink-store.ts'
import {
  WECHAT_CHANNEL_ID,
  claimWechatIdentity,
  createDirectDispatcher,
  processWechatMessage,
  resolveWechatTarget,
  type WechatDispatchFn,
  type WechatInboundDeps,
  type WechatPushFn,
} from './inbound.ts'

export const name = 'littly-channel-wechat-ilink'

export const inject = ['littlyStorage', 'littlyHub']

/** 插件配置。 */
export interface Config {
  /** 自愈扫描间隔（毫秒）：补启缺失的长轮询。 */
  selfHealMs: number
  /** 入站分发模式：buffered=hub 缓冲窗口（默认，拟人化合并）；direct=立即 runTurn 秒回。 */
  inboundMode: 'buffered' | 'direct'
  /** 绑定二维码会话有效期（毫秒）。 */
  bindTtlMs: number
}

export const Config: z<Config> = z.object({
  selfHealMs: z.number().default(60_000),
  inboundMode: z.union([z.const('buffered'), z.const('direct')]).default('buffered'),
  bindTtlMs: z.number().default(5 * 60 * 1000),
})

/** 控制台状态视图（GET /api/wechat/status 的数据源）。 */
export interface WechatStatusView {
  /** 是否已绑定 iLink 凭据。 */
  bound: boolean
  /** 目标 bot id。 */
  botId: string
  /** iLink bot 标识（bots.wx_hub_bot_id）。 */
  ilinkBotId?: string | undefined
  /** 扫码确认者的 iLink user id。 */
  ilinkUserId?: string | undefined
  /** 长轮询状态：connected / session_expired / error / stopped。 */
  status: ILinkAccountStatus
  /** 24h 窗口是否新鲜（可以主动发消息）。 */
  windowFresh: boolean
  /** 最近一次入站毫秒时间戳（0 = 从未）。 */
  lastInboundAt: number
  /** 已缓存的名片二维码（无/过期则不下发）。 */
  friendQrDataUrl?: string | undefined
  /** 名片二维码过期时刻。 */
  friendQrExpiresAt?: number | undefined
}

/** 「名片二维码」语义说明（iLink 只有 bot 绑定码，此字段供前端展示文案依据）。 */
export const FRIEND_QR_NOTE =
  'iLink 协议只有 bot 绑定二维码（get_bot_qrcode?bot_type=3），没有独立的「名片码」接口；' +
  '好友扫这张码即可在微信里加她（进入与 bot 的会话）。绑定码与名片码内容同源，这是协议事实。'

/** 服务接口（console-api 通过 ctx.get('littlyWechat') 使用）。 */
export interface WechatService {
  /** 发起扫码绑定（缺省 bot = 第一个 bot）。 */
  startBind(input?: { botId?: string | undefined; userId?: string | undefined }): Promise<StartBindResult>
  /** 读扫码会话快照。 */
  getBind(sessionId: string): ILinkBindSessionState | null
  /** 生成/刷新名片二维码。 */
  friendQr(botId?: string | undefined): Promise<FriendQrResult>
  /** 当前绑定/运行状态。 */
  status(botId?: string | undefined): WechatStatusView
  /** 登出：清凭据 + 停轮询 + 清名片码缓存。 */
  logout(botId?: string | undefined): Promise<{ ok: boolean; botId: string }>
  /** 出站发送（控制台调试/主动消息用）。 */
  sendText(botId: string, toUserId: string, text: string): Promise<{ clientId: string }>
  /** 自愈：启动所有已绑定 bot 的轮询（幂等）。 */
  ensureMonitors(): number
  /** 停止全部（插件卸载）。 */
  stop(): void
  /** 24h 窗口状态（某会话）。 */
  windowFresh(botId: string, sender: string): boolean
  /** 默认 bot 行（控制台未显式指定 botId 时）。 */
  defaultBot(): BotRow | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    littlyWechat: WechatService
  }
}

/** 默认 bot：按创建时间取第一个（单用户部署即「她」）。 */
function pickDefaultBot(storage: LittlyStorage): BotRow | undefined {
  return storage.prepare('SELECT * FROM bots ORDER BY created_at ASC LIMIT 1').get() as BotRow | undefined
}

/** 解析 botId：显式传入优先，否则默认 bot。 */
function resolveBot(storage: LittlyStorage, botId: string | undefined): BotRow | undefined {
  if (botId !== undefined && botId !== '') return loadBot(storage, botId)
  return pickDefaultBot(storage)
}

/**
 * 插件装配：注册出站渠道 + 服务键 + 启动已绑定账号的轮询 + 自愈扫描。
 * @param ctx - Cordis 上下文。
 * @param config - 插件配置。
 */
export function apply(ctx: Context, config: Config): void {
  const storage: LittlyStorage = ctx.littlyStorage
  const hub: LittlyHub = ctx.littlyHub
  const log = (msg: string, ...args: unknown[]): void => {
    ctx.logger.info(msg, ...args)
  }
  const selfHealMs = Math.max(1_000, Math.round(config.selfHealMs) || 60_000)
  const bindTtlMs = Math.max(30_000, Math.round(config.bindTtlMs) || 5 * 60 * 1000)
  // --- 账号运行时（长轮询 + 出站） ---
  const accounts = new ILinkAccountManager({
    storage,
    log,
    onInbound: async ({ botId, fromUserId, text }): Promise<void> => {
      const bot = loadBot(storage, botId)
      if (bot === undefined) {
        log('[wechat] 入站丢弃：bot %s 不存在', botId)
        return
      }
      await processWechatMessage(inboundDeps, bot, fromUserId, text)
    },
  })

  // --- 出站推送（webhook 桥 / direct 分发 / hub 渠道共用） ---
  const push: WechatPushFn = async (bot, toUser, text): Promise<boolean> => {
    const target = resolveWechatTarget(storage, bot.id, toUser)
    if (target === null) return false
    try {
      await accounts.sendText(bot.id, target.toUser, text)
      return true
    } catch (err) {
      log('[wechat] 出站失败 (bot=%s, to=%s): %s', bot.name, toUser, err instanceof Error ? err.message : String(err))
      return false
    }
  }

  // --- 入站分发：默认缓冲（hub 到期后 runTurn channelId='wechat'）；direct = 立即 runTurn ---
  const dispatch: WechatDispatchFn | undefined = config.inboundMode === 'direct' ? createDirectDispatcher(hub, push) : undefined

  const inboundDeps: WechatInboundDeps = {
    storage,
    hub,
    log,
    push,
    ...(dispatch !== undefined ? { dispatch } : {}),
  }

  // --- 扫码绑定服务 ---
  const binds = new ILinkBindService({
    storage,
    log,
    onConfirmed: async ({ botId, userId, credentials }): Promise<void> => {
      saveCredentials(storage, botId, credentials)
      // 扫码者身份认领（与绑定码同一套身份模型）
      if (credentials.ilink_user_id !== '') claimWechatIdentity(storage, botId, userId, credentials.ilink_user_id)
      // 用新凭据立即（重）启动消息轮询
      accounts.restart(botId)
    },
  })

  // --- 服务键：console-api /api/wechat/* 的唯一入口 ---
  const service: WechatService = {
    async startBind(input = {}): Promise<StartBindResult> {
      const bot = resolveBot(storage, input.botId)
      if (bot === undefined) throw new Error('还没有角色：请先在控制台创建 bot 再绑定微信')
      return binds.startBind({ botId: bot.id, userId: input.userId ?? '', ttlMs: bindTtlMs })
    },
    getBind(sessionId: string): ILinkBindSessionState | null {
      return binds.get(sessionId)
    },
    async friendQr(botId?: string): Promise<FriendQrResult> {
      const bot = resolveBot(storage, botId)
      if (bot === undefined) throw new Error('还没有角色：请先在控制台创建 bot 再生成名片码')
      return createFriendQr({ storage, log }, bot.id, bindTtlMs)
    },
    status(botId?: string): WechatStatusView {
      const bot = resolveBot(storage, botId)
      if (bot === undefined) {
        return { bound: false, botId: '', status: 'stopped', windowFresh: false, lastInboundAt: 0 }
      }
      const credentials = getCredentials(storage, bot.id)
      const friend = getFriendQr(storage, bot.id)
      const lastInboundAt = getLastInboundAt(storage, bot.id)
      const view: WechatStatusView = {
        bound: credentials !== null,
        botId: bot.id,
        status: accounts.status(bot.id),
        windowFresh: lastInboundAt > 0 && Date.now() - lastInboundAt < 24 * 60 * 60 * 1000,
        lastInboundAt,
      }
      if (credentials !== null) {
        view.ilinkBotId = credentials.ilink_bot_id
        view.ilinkUserId = credentials.ilink_user_id
      }
      if (friend !== null) {
        view.friendQrDataUrl = friend.dataUrl
        view.friendQrExpiresAt = friend.expiresAt
      }
      return view
    },
    async logout(botId?: string): Promise<{ ok: boolean; botId: string }> {
      const bot = resolveBot(storage, botId)
      if (bot === undefined) return { ok: false, botId: '' }
      accounts.stop(bot.id)
      clearCredentials(storage, bot.id)
      binds.cancelForBot(bot.id)
      log('[wechat] 已登出 (bot=%s)：凭据/游标/context_token 已清，历史消息与身份绑定保留', bot.name)
      return { ok: true, botId: bot.id }
    },
    sendText(botId: string, toUserId: string, text: string): Promise<{ clientId: string }> {
      return accounts.sendText(botId, toUserId, text)
    },
    ensureMonitors(): number {
      return accounts.ensureAll()
    },
    stop(): void {
      accounts.stopAll()
      binds.cancelAll()
    },
    windowFresh(botId: string, sender: string): boolean {
      const target = resolveWechatTarget(storage, botId, sender)
      return target !== null && target.windowFresh
    },
    defaultBot(): BotRow | undefined {
      return pickDefaultBot(storage)
    },
  }

  ctx.provide('littlyWechat', service)

  // hub 出站渠道：hub 逐片回调（拟人化拆分由 hub 做），这里只发单条。
  hub.registerChannel(WECHAT_CHANNEL_ID, {
    sendText: async (botId: string, sender: string, text: string) => {
      try {
        // sender 可能是归一化后的 userId → 解析回原始微信 id
        const target = resolveWechatTarget(storage, botId, sender)
        if (target === null) return { ok: false, error: '解析不到微信投递地址' }
        await accounts.sendText(botId, target.toUser, text)
        return { ok: true, sent: 1 }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  })

  // 自愈：定期补启「有凭据但没在轮询」的 bot（幂等）
  ctx.effect(() => {
    const timer = setInterval(() => {
      try {
        const started = accounts.ensureAll()
        if (started > 0) log('[wechat] 自愈：补启 %d 个消息轮询', started)
      } catch (err) {
        log('[wechat] 自愈失败: %s', err instanceof Error ? err.message : String(err))
      }
    }, selfHealMs)
    return () => {
      clearInterval(timer)
      service.stop()
    }
  }, 'littly-channel-wechat-ilink.self-heal')

  // 启动时点亮已绑定账号
  const started = accounts.ensureAll()
  log(
    'littly wechat-ilink ready (mode=%s, selfHeal=%dms, bound=%d, started=%d)',
    config.inboundMode,
    selfHealMs,
    listBoundBotIds(storage).length,
    started,
  )
}

export { handleWechatWebhook } from './webhook.ts'
export type { WechatWebhookDeps, WechatWebhookResult } from './webhook.ts'
export { ILinkClient } from './ilink-client.ts'
export type { ILinkCredentials, ILinkMessage, ILinkQRStatusResponse } from './ilink-client.ts'
export { ILinkBindService, createFriendQr } from './ilink-bind.ts'
export { ILinkAccountManager } from './ilink-account.ts'
export {
  processWechatMessage,
  pushWechatText,
  resolveWechatTarget,
  wechatSenderKey,
  createDirectDispatcher,
  claimWechatIdentity,
  WECHAT_CHANNEL_ID,
} from './inbound.ts'
export {
  getCredentials,
  saveCredentials,
  clearCredentials,
  getSyncBuf,
  setSyncBuf,
  getContextToken,
  setContextToken,
  hasFreshContextToken,
  getContextTokenState,
  getBindSession,
  setBindSession,
  deleteBindSession,
  getFriendQr,
  setFriendQr,
  clearFriendQr,
  listBoundBotIds,
  CONTEXT_TOKEN_TTL_MS,
  QR_TTL_MS,
} from './ilink-store.ts'
export { qrContentToDataUrl, encodeQr, qrToPng, qrTextToPngDataUrl } from './ilink-qr.ts'
export type { FriendQrState, ILinkBindSessionState, WechatBindStatus } from './ilink-store.ts'
export type { StartBindResult, FriendQrResult } from './ilink-bind.ts'
export type { ILinkAccountStatus } from './ilink-account.ts'
