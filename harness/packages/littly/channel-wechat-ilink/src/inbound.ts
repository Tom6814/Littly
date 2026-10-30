/**
 * 微信入站路由：绑定拦截 → 身份归一化 → 联系人 upsert → 交给 hub。
 *
 * 契约（与旧实现一致的业务语义，电源换成了自研 iLink 直连）：
 * - 绑定码 `绑定 XXXXXX` 命中即**短路**（返回 handled=true，不入模型），回复走渠道发送；
 * - 已绑定平台的微信身份（channel_identities）把消息归并到绑定用户的会话线
 *   （sender=userId），与网页端共用历史/记忆；未绑定则用渠道原生合成键 `<wxid>@im.wechat`；
 * - 入站**不直接调模型**：默认走 `hub.enqueueBufferedMessage`（channel_id='wechat'），
 *   hub 在缓冲窗口到期后调用 `runTurn({channelId:'wechat'})`，保持「恰好一次」契约。
 *   `inboundMode='direct'` 时改用 `createDirectDispatcher`：立即 `hub.runTurn({channelId:'wechat'})`
 *   并把回复按 context_token 逐片发回（适合即时回复场景）。
 */
import { randomUUID } from 'node:crypto'
import type { BotRow, LittlyStorage } from '@littly/storage'
import type { LittlyHub } from '@littly/agents'
import { promoteContact, tryHandleBinding } from './binding.ts'
import { ILinkClient, type ILinkCredentials } from './ilink-client.ts'
import { getContextTokenState, getCredentials, hasFreshContextToken } from './ilink-store.ts'

/** 微信渠道 id（会话线 / 联系人 channel / 缓冲 channel_id 三处一致）。 */
export const WECHAT_CHANNEL_ID = 'wechat'

/**
 * 渠道原生合成键：`<wxid>@im.wechat`。
 * iLink 的 from_user_id 原生即此形；裸 wxid 幂等补后缀。
 * @param externalId - 渠道原生外部 id。
 * @returns 渠道原生合成键。
 */
export function wechatSenderKey(externalId: string): string {
  return externalId.includes('@im.wechat') ? externalId : `${externalId}@im.wechat`
}

/** 出站推送函数签名（bot 行 → 微信外部 id → 文本 → 是否成功）。 */
export type WechatPushFn = (bot: BotRow, toUser: string, text: string) => Promise<boolean>

/** 入站分发函数签名（默认缓冲入队；直接模式注入 runTurn 分发器）。 */
export type WechatDispatchFn = (input: { bot: BotRow; sender: string; text: string }) => Promise<void> | void

/** 微信渠道入站依赖（存储 / hub / 日志 / 可注入的出站推送与分发器）。 */
export interface WechatInboundDeps {
  storage: LittlyStorage
  hub: LittlyHub
  log: (msg: string, ...args: unknown[]) => void
  /** 出站推送（默认自建 iLink 客户端；index.ts 注入账号管理器；测试注入假实现）。 */
  push?: WechatPushFn | undefined
  /** 入站分发（缺省 = hub 缓冲入队）。 */
  dispatch?: WechatDispatchFn | undefined
}

/**
 * 微信入站主入口：绑定短路 → 身份归一化 → 联系人 → 分发。
 * @param deps - 插件依赖。
 * @param bot - 命中的 bot 行。
 * @param fromUser - 渠道原生外部 id（`<wxid>@im.wechat`）。
 * @param text - 消息正文。
 */
export async function processWechatMessage(
  deps: WechatInboundDeps,
  bot: BotRow,
  fromUser: string,
  text: string,
): Promise<void> {
  const push = deps.push ?? ((b: BotRow, to: string, t: string): Promise<boolean> => pushWechatText(deps, b, to, t))

  // 1) 绑定拦截：命中即短路（含失败提示），绝不再走模型
  const binding = await tryHandleBinding(deps.storage, { channel: WECHAT_CHANNEL_ID, externalId: fromUser, text })
  if (binding.handled) {
    if (binding.reply !== undefined && binding.reply !== '') await push(bot, fromUser, binding.reply)
    return
  }

  // 2) 身份归一化：已绑定平台的微信账号归并到绑定用户会话线（与 Web/TG 共用历史）
  const identity = deps.storage
    .prepare('SELECT user_id FROM channel_identities WHERE channel = ? AND external_id = ?')
    .get(WECHAT_CHANNEL_ID, fromUser) as { user_id: string } | undefined
  const sender = identity?.user_id ?? wechatSenderKey(fromUser)

  // 3) 联系人 upsert（name/external_id 保留原始微信 id 作为投递地址；channel 更新为最近活跃渠道）
  const now = new Date().toISOString()
  const existing = deps.storage
    .prepare('SELECT id FROM contacts WHERE bot_id = ? AND sender = ?')
    .get(bot.id, sender) as { id: string } | undefined
  if (existing !== undefined) {
    deps.storage
      .prepare('UPDATE contacts SET name = ?, channel = ?, updated_at = ? WHERE id = ?')
      .run(fromUser, WECHAT_CHANNEL_ID, now, existing.id)
  } else {
    deps.storage
      .prepare('INSERT INTO contacts (id, bot_id, sender, name, external_id, channel, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(randomUUID(), bot.id, sender, fromUser, fromUser, WECHAT_CHANNEL_ID, now, now)
  }
  promoteContact(deps.storage, bot.id, WECHAT_CHANNEL_ID, fromUser)

  // 4) 分发：默认缓冲（hub 到期后 runTurn channelId='wechat'）；direct 模式立即 runTurn
  if (deps.dispatch !== undefined) {
    await deps.dispatch({ bot, sender, text })
  } else {
    deps.hub.enqueueBufferedMessage({ botId: bot.id, sender, text, channelId: WECHAT_CHANNEL_ID })
  }
}

/**
 * 直接模式分发器：立即 `hub.runTurn({channelId:'wechat'})`，把回复按片发出。
 * hub 已把 assistant 消息落库；这里只用 runTurn 的返回做渠道投递（每片一次 context_token 会话）。
 * @param hub - 对话枢纽。
 * @param push - 出站推送函数。
 * @returns 可作为 `WechatInboundDeps.dispatch` 的分发器。
 */
export function createDirectDispatcher(hub: LittlyHub, push: WechatPushFn): WechatDispatchFn {
  return async ({ bot, sender, text }): Promise<void> => {
    const response = await hub.runTurn({ botId: bot.id, sender, text, channelId: WECHAT_CHANNEL_ID })
    const pieces = (response.pieces ?? []).filter((piece) => piece !== '')
    const replies = pieces.length > 0 ? pieces : [response.reply]
    for (const reply of replies) {
      if (reply === '') continue
      await push(bot, sender, reply)
    }
  }
}

/** 出站投递地址解析结果。 */
export interface WechatDeliveryTarget {
  /** 原始微信外部 id（iLink sendmessage 的 to_user_id / context_token 键）。 */
  toUser: string
  /** 该会话 context_token（可能为空）。 */
  contextToken: string
  /** 24h 窗口是否新鲜。 */
  windowFresh: boolean
}

/**
 * 解析出站投递地址：sender 可能是平台 userId（绑定归一后），也可能是原生合成键。
 * 权威顺序：ChannelIdentity → contacts.external_id → 原值。
 * @param storage - 业务存储。
 * @param botId - bot id。
 * @param sender - 会话主键（userId 或 `<wxid>@im.wechat`）。
 * @returns 投递地址与窗口状态；解析不到返回 null。
 */
export function resolveWechatTarget(storage: LittlyStorage, botId: string, sender: string): WechatDeliveryTarget | null {
  if (sender === '') return null
  let toUser = sender
  if (!sender.includes('@im.wechat')) {
    const identity = storage
      .prepare('SELECT external_id FROM channel_identities WHERE user_id = ? AND channel = ?')
      .get(sender, WECHAT_CHANNEL_ID) as { external_id: string } | undefined
    if (identity !== undefined && identity.external_id !== '') {
      toUser = identity.external_id
    } else {
      const contact = storage
        .prepare('SELECT external_id FROM contacts WHERE bot_id = ? AND sender = ?')
        .get(botId, sender) as { external_id: string } | undefined
      if (contact !== undefined && contact.external_id.includes('@im.wechat')) toUser = contact.external_id
    }
  }
  const state = getContextTokenState(storage, botId, toUser)
  return {
    toUser,
    contextToken: state?.token ?? '',
    windowFresh: hasFreshContextToken(storage, botId, toUser),
  }
}

/**
 * 微信出站推送（兼容旧 webhook 路径的默认实现）：自建客户端 + context_token 直发。
 *
 * 语义与旧项目一致：失败只记日志返回 false，不向调用方抛（webhook 是 200 reply_async）。
 * @param deps - 插件依赖。
 * @param bot - 目标 bot 行。
 * @param toUser - 收件人（可能是归一化后的 userId）。
 * @param text - 文本内容。
 * @returns 是否推送成功。
 */
export async function pushWechatText(
  deps: Pick<WechatInboundDeps, 'storage' | 'log'>,
  bot: BotRow,
  toUser: string,
  text: string,
): Promise<boolean> {
  const credentials = getCredentials(deps.storage, bot.id)
  if (credentials === null) {
    deps.log('[wechat] push 跳过：bot %s 未绑定 iLink 凭据（请先扫码绑定）', bot.name)
    return false
  }
  const target = resolveWechatTarget(deps.storage, bot.id, toUser)
  if (target === null || target.toUser === '') {
    deps.log('[wechat] push 跳过：解析不到微信投递地址（bot=%s, to=%s）', bot.name, toUser)
    return false
  }
  if (target.contextToken === '') {
    deps.log('[wechat] push 跳过：缺少 context_token（bot=%s, to=%s）— 对方需先给 bot 发过消息', bot.name, target.toUser)
    return false
  }
  if (!target.windowFresh) {
    deps.log('[wechat] push 跳过：24 小时窗口已过期（bot=%s, to=%s）', bot.name, target.toUser)
    return false
  }
  try {
    const options: { token: string; baseUrl?: string } = { token: credentials.bot_token }
    if (credentials.baseurl !== '') options.baseUrl = credentials.baseurl
    const client = new ILinkClient(options)
    await client.sendText(target.toUser, text, target.contextToken)
    deps.log('[wechat] push 成功 (bot=%s, to=%s, len=%d)', bot.name, target.toUser, text.length)
    return true
  } catch (err) {
    deps.log('[wechat] push 失败 (bot=%s, to=%s): %s', bot.name, target.toUser, err instanceof Error ? err.message : String(err))
    return false
  }
}

/**
 * 扫码确认后把扫码者的微信身份（ilink_user_id）绑定到当前登录用户。
 *
 * 与 TG 绑定码同一套 ChannelIdentity 模型：
 *  1. 该微信身份已被其他账号占用 → 冲突，绝不静默抢占；
 *  2. 换号：移除该用户原有 wechat 身份（自己的数据，安全自替换）；
 *  3. 晋升：该微信身份在所有角色下未绑定的同名 Contact 认领为登录用户（历史记忆全保留）。
 * @param storage - 业务存储。
 * @param botId - 当前 bot id（用于本 bot 下的即时认领）。
 * @param userId - 平台用户 id（扫码者）。
 * @param wxExternalId - 微信外部 id（iLink user_id）。
 */
export function claimWechatIdentity(storage: LittlyStorage, botId: string, userId: string, wxExternalId: string): void {
  if (userId === '' || wxExternalId === '') return
  const taken = storage
    .prepare('SELECT user_id FROM channel_identities WHERE channel = ? AND external_id = ?')
    .get(WECHAT_CHANNEL_ID, wxExternalId) as { user_id: string } | undefined
  if (taken !== undefined && taken.user_id !== userId) return
  const now = new Date().toISOString()
  storage.db.exec('BEGIN IMMEDIATE')
  try {
    storage.prepare('DELETE FROM channel_identities WHERE user_id = ? AND channel = ?').run(userId, WECHAT_CHANNEL_ID)
    storage
      .prepare('INSERT INTO channel_identities (id, user_id, channel, external_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), userId, WECHAT_CHANNEL_ID, wxExternalId, now)
    storage
      .prepare("UPDATE contacts SET user_id = ? WHERE channel = 'wechat' AND user_id IS NULL AND (sender = ? OR external_id = ?)")
      .run(userId, wxExternalId, wxExternalId)
    storage.db.exec('COMMIT')
  } catch (err) {
    storage.db.exec('ROLLBACK')
    throw err
  }
  storage
    .prepare("UPDATE contacts SET user_id = ? WHERE bot_id = ? AND channel = 'wechat' AND user_id IS NULL AND (sender = ? OR external_id = ?)")
    .run(userId, botId, wxExternalId, wxExternalId)
}

/** 读凭据的便捷 re-export（外部模块不必直接依赖 store 文件）。 */
export type { ILinkCredentials }
