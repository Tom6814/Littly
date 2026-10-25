/**
 * 微信入站处理（旧 internal/channel/wechat.ts 的 processWechatMessage / pushWechatText 移植）。
 *
 * 流程：绑定拦截 → 身份归一化 → 联系人 upsert → 晋升 → 缓冲入队。
 * - 入站绝不直接调模型：一律走 hub.enqueueBufferedMessage（缓冲窗口由 hub 调度，
 *   保证"恰好一次"模型调用契约）。
 * - 渠道 id = 'wechat'（与旧项目一致；hub 的场景文案表里也是 wechat）。
 */
import { randomUUID } from 'node:crypto'
import type { BotRow, LittlyStorage } from '@littly/storage'
import type { LittlyHub } from '@littly/agents'
import { promoteContact, tryHandleBinding } from './binding.ts'
import { pushILinkText } from './ilink.ts'

/** 微信渠道 id（会话线 / 联系人 channel / 缓冲 channel_id 三处一致）。 */
export const WECHAT_CHANNEL_ID = 'wechat'

/** 出站推送函数签名（bot → 微信外部 id → 文本 → 是否成功）。 */
export type WechatPushFn = (bot: BotRow, toUser: string, text: string) => Promise<boolean>

/** 微信渠道入站依赖（存储 / hub / 日志 / 可注入的出站推送）。 */
export interface WechatInboundDeps {
  storage: LittlyStorage
  hub: LittlyHub
  log: (msg: string, ...args: unknown[]) => void
  /** 出站推送（默认走 iLink 直连；测试可注入假实现） */
  push?: WechatPushFn | undefined
}

/**
 * 微信渠道原生合成键（会话主键）：<wxid>@im.wechat。
 *
 * iLink 的 from_user_id 与桥接 webhook 的 event.data.sender.id 原生即此形，
 * 这里做幂等归一化：已带后缀原样返回，裸 wxid 补后缀
 * （旧项目设计文档 §3.2 / §10.6 的会话主键规则）。
 * @param externalId - 渠道原生外部 id。
 * @returns 渠道原生合成键。
 */
export function wechatSenderKey(externalId: string): string {
  return externalId.includes('@im.wechat') ? externalId : `${externalId}@im.wechat`
}

/**
 * 微信入站主入口：绑定短路 → 身份归一化 → 联系人 → 缓冲入队。
 * @param deps - 插件依赖。
 * @param bot - 命中的 bot 行。
 * @param fromUser - 渠道原生外部 id（<wxid>@im.wechat）。
 * @param text - 消息正文。
 */
export async function processWechatMessage(
  deps: WechatInboundDeps,
  bot: BotRow,
  fromUser: string,
  text: string,
): Promise<void> {
  const push: WechatPushFn =
    deps.push ?? ((b: BotRow, to: string, t: string): Promise<boolean> => pushWechatText(deps, b, to, t))

  const binding = await tryHandleBinding(deps.storage, { channel: WECHAT_CHANNEL_ID, externalId: fromUser, text })
  if (binding.handled) {
    if (binding.reply) await push(bot, fromUser, binding.reply)
    return
  }

  // §身份归一化 — 与 Telegram 入站对齐：已绑定平台的微信账号，其消息归并到
  // 绑定用户的会话线（sender=userId），与 Web 端共用历史/记忆，不再当成新联系人。
  const identity = deps.storage
    .prepare('SELECT user_id FROM channel_identities WHERE channel = ? AND external_id = ?')
    .get(WECHAT_CHANNEL_ID, fromUser) as { user_id: string } | undefined
  const sender = identity?.user_id ?? wechatSenderKey(fromUser)

  // contact 按归一化后的 sender 落库；不覆盖已存在的 external_id（可能是 TG 数字
  // 投递地址），投递一律从 ChannelIdentity 权威解析。channel 更新为最近活跃渠道。
  const now = new Date().toISOString()
  const existing = deps.storage
    .prepare('SELECT id FROM contacts WHERE bot_id = ? AND sender = ?')
    .get(bot.id, sender) as { id: string } | undefined
  if (existing) {
    deps.storage
      .prepare('UPDATE contacts SET name = ?, channel = ?, updated_at = ? WHERE id = ?')
      .run(fromUser, WECHAT_CHANNEL_ID, now, existing.id)
  } else {
    deps.storage
      .prepare('INSERT INTO contacts (id, bot_id, sender, name, external_id, channel, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(randomUUID(), bot.id, sender, fromUser, fromUser, WECHAT_CHANNEL_ID, now, now)
  }
  promoteContact(deps.storage, bot.id, WECHAT_CHANNEL_ID, fromUser)

  // §buffer — 落库即入缓冲；hub 自行调度到期合并投递（旧项目的 waiter 由 hub 取代）。
  deps.hub.enqueueBufferedMessage({ botId: bot.id, sender, text, channelId: WECHAT_CHANNEL_ID })
}

/**
 * 微信出站推送。
 *
 * §iLink 直连：有 bot_token 就走 iLink push（扫码即用，不再依赖 openilink-hub 中转）。
 * @param deps - 插件依赖。
 * @param bot - 目标 bot 行。
 * @param toUser - 收件人（可能是归一化后的 userId）。
 * @param text - 文本内容。
 * @returns 是否推送成功（旧项目语义：失败只记日志，不抛异常）。
 */
export async function pushWechatText(
  deps: WechatInboundDeps,
  bot: BotRow,
  toUser: string,
  text: string,
): Promise<boolean> {
  if (bot.wx_push_token) {
    try {
      // §身份归一化后 toUser 可能是 userId，但 iLink push 需要原始微信外部 id
      // （context_token 按原始 from_user_id 存储）。从 ChannelIdentity 权威解析；
      // contact.external_id 可能被其他渠道覆盖（如 TG 数字 id），只作兜底。
      let target = toUser
      if (!target.includes('@im.wechat')) {
        const identity = deps.storage
          .prepare('SELECT external_id FROM channel_identities WHERE user_id = ? AND channel = ?')
          .get(target, WECHAT_CHANNEL_ID) as { external_id: string } | undefined
        if (identity?.external_id) target = identity.external_id
        else {
          const contact = deps.storage
            .prepare('SELECT external_id FROM contacts WHERE bot_id = ? AND sender = ?')
            .get(bot.id, toUser) as { external_id: string } | undefined
          if (contact?.external_id.includes('@im.wechat')) target = contact.external_id
        }
      }
      return await pushILinkText(deps, bot, target, text)
    } catch (err) {
      deps.log('wechat push failed (bot=%s, to=%s): %s', bot.name, toUser, err instanceof Error ? err.message : String(err))
      return false
    }
  }
  deps.log('wechat push skipped: no iLink bot_token configured for bot %s（请先扫码绑定）', bot.name)
  return false
}
