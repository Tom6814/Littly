/**
 * QQ 官方入站处理（旧 src/internal/channel/qq.ts handleQQMessage 的移植）。
 *
 * - 渠道 id 固定为 'qq'（QQ 官方开放平台，与 QQ 个人号 qqp 区分）。
 * - sender 键：已绑定用户的 openid 归并到绑定用户的 user_id，否则 `qq_<openid>`。
 * - 投递地址（openid）落 contacts.external_id，出站优先从 channel_identities(qq) 取权威值。
 * - 入站一律走 hub 缓冲窗口（enqueueBufferedMessage），不直接调模型。
 */
import { randomUUID } from 'node:crypto'
import type { BotRow } from '@littly/storage'
import { promoteContact, tryHandleBinding } from './binding.ts'
import { sendQQText, type QqC2CMessage, type QqDeps } from './client.ts'
import { rememberQqEvent } from './event-context.ts'

/**
 * 出站投递地址解析：sender 归一化为 userId 时从 channel_identities(qq) 拿权威 openid；
 * 否则 qq_ 前缀 / contact 兜底。
 * @param deps - 插件依赖
 * @param botId - bot 行 id
 * @param sender - 会话发送方键
 * @returns 接收方 openid；无法解析返回空串
 */
export function resolveQqOpenid(deps: QqDeps, botId: string, sender: string): string {
  if (sender.startsWith('qq_') && sender.length > 3) return sender.slice(3)
  const identity = deps.storage
    .prepare('SELECT external_id FROM channel_identities WHERE user_id = ? AND channel = ?')
    .get(sender, 'qq') as { external_id: string } | undefined
  if (identity?.external_id) return identity.external_id
  const contact = deps.storage
    .prepare('SELECT external_id FROM contacts WHERE bot_id = ? AND sender = ?')
    .get(botId, sender) as { external_id: string } | undefined
  return contact?.external_id ?? ''
}

/**
 * 入站主入口：绑定拦截 → 身份归一化 → 联系人 → 缓冲入队。
 * @param deps - 插件依赖
 * @param bot - 收到消息的 bot 行
 * @param d - C2C_MSG_RECEIVE 载荷
 */
export async function handleQQMessage(deps: QqDeps, bot: BotRow, d: QqC2CMessage): Promise<void> {
  const openid = d.author?.user_openid ?? ''
  const text = (d.content ?? '').trim()
  if (!openid || !text) return

  // §B7：记住本次入站的 event_id —— 主链路出站时带上它命中 60 分钟被动回复窗口
  rememberQqEvent(bot.id, openid, d.event_id)

  const binding = await tryHandleBinding(deps.storage, { channel: 'qq', externalId: openid, text })
  if (binding.handled) {
    if (binding.reply) {
      try {
        // 带上前置事件 id：命中 60 分钟被动回复窗口
        await sendQQText(deps, bot, openid, binding.reply, { eventId: d.event_id })
      } catch (err) {
        deps.log('[qq] bind reply failed (bot=%s): %s', bot.name, err instanceof Error ? err.message : String(err))
      }
    }
    return
  }

  // §身份归一化 — 与微信/TG 对齐：已绑定平台的 QQ 账号消息归并到绑定用户的会话线
  const identity = deps.storage
    .prepare('SELECT user_id FROM channel_identities WHERE channel = ? AND external_id = ?')
    .get('qq', openid) as { user_id: string } | undefined
  const sender = identity?.user_id ?? `qq_${openid}`

  // 联系人 upsert：name/external_id 都记 openid；已存在时只更新 name 与 channel
  const now = new Date().toISOString()
  const existing = deps.storage
    .prepare('SELECT id FROM contacts WHERE bot_id = ? AND sender = ?')
    .get(bot.id, sender) as { id: string } | undefined
  if (existing) {
    deps.storage
      .prepare('UPDATE contacts SET name = ?, channel = ?, updated_at = ? WHERE id = ?')
      .run(openid, 'qq', now, existing.id)
  } else {
    deps.storage
      .prepare('INSERT INTO contacts (id, bot_id, sender, name, external_id, channel, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(randomUUID(), bot.id, sender, openid, openid, 'qq', now, now)
  }
  promoteContact(deps.storage, bot.id, 'qq', openid)

  // §buffer — 落库即入缓冲；hub 自行调度到期合并投递（恰好一次模型调用）
  deps.hub.enqueueBufferedMessage({ botId: bot.id, sender, text, channelId: 'qq' })
}
