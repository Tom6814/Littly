/**
 * Telegram 入站处理（旧 handleTelegramMessage 的移植，webhook / polling 共用此入口）。
 * 流程：bot 守卫 → 群聊 @提及门 → 绑定拦截 → 身份归一化 → 联系人 upsert → 缓冲入队。
 */
import { randomUUID } from 'node:crypto'
import type { LittlyStorage, BotRow } from '@littly/storage'
import type { LittlyHub } from '@littly/agents'
import { promoteContact, tryHandleBinding } from './binding.ts'
import { senderFromTgUser, tgDisplayName, tgSendMessage, type TgMessage } from './telegram.ts'

export interface TgChannelDeps {
  storage: LittlyStorage
  hub: LittlyHub
  log: (msg: string, ...args: unknown[]) => void
  /** bot username 懒取（getMe，带缓存；群聊 @提及门需要） */
  getBotUsername: (bot: BotRow) => Promise<string>
}

export async function handleTelegramMessage(deps: TgChannelDeps, bot: BotRow, msg: TgMessage): Promise<void> {
  const from = msg.from
  if (!from || from.is_bot) return // 守卫：跳过 bot 自己的消息
  const rawText = (msg.text || msg.caption || '').trim()
  const isPrivate = msg.chat.type === 'private'

  // 群聊里只响应 @机器人 的消息；私聊全响应
  if (!isPrivate) {
    const username = await deps.getBotUsername(bot)
    const at = username ? `@${username}` : ''
    if (!at || !rawText.includes(at)) return
  }

  // TODO(vision)：图片消息暂不转译（text only）。msg.photo 存在时仅用 caption 文本，
  // 后续接 @littly/vision（getFile → base64 → 转译）再补齐旧行为。
  const text = rawText
  if (!text) return

  // 绑定流：命中即短路（外部 id 统一用 from.id，群聊同样可绑定）
  const binding = await tryHandleBinding(deps.storage, { channel: 'tg', externalId: String(from.id), text })
  if (binding.handled) {
    if (binding.reply) {
      try {
        await tgSendMessage(bot.tg_bot_token, msg.chat.id, binding.reply)
      } catch (err) {
        deps.log('[telegram] 绑定回复失败 (bot=%s): %s', bot.name, String(err))
      }
    }
    return
  }

  // 身份归一化：已绑定的 TG 账号归并到绑定用户的会话线（与 Web 端共用历史/记忆）
  const identity = deps.storage
    .prepare('SELECT user_id FROM channel_identities WHERE channel = ? AND external_id = ?')
    .get('tg', String(from.id)) as { user_id: string } | undefined
  const sender = identity?.user_id ?? senderFromTgUser(from)

  // 联系人 upsert：私聊时 chat.id === from.id 存 external_id；群聊绝不动 external_id
  //（避免污染该用户的私聊投递地址），且永不覆盖已有 external_id。
  const name = tgDisplayName(from)
  const tgHandle = from.username ? `@${from.username}` : ''
  const privateExternal = isPrivate ? String(msg.chat.id) : ''
  const now = new Date().toISOString()
  const existing = deps.storage
    .prepare('SELECT id, external_id FROM contacts WHERE bot_id = ? AND sender = ?')
    .get(bot.id, sender) as { id: string; external_id: string } | undefined
  if (existing) {
    if (privateExternal && !existing.external_id) {
      deps.storage
        .prepare('UPDATE contacts SET name = ?, tg_username = ?, external_id = ?, updated_at = ? WHERE id = ?')
        .run(name, tgHandle, privateExternal, now, existing.id)
    } else {
      deps.storage
        .prepare('UPDATE contacts SET name = ?, tg_username = ?, updated_at = ? WHERE id = ?')
        .run(name, tgHandle, now, existing.id)
    }
  } else {
    deps.storage
      .prepare('INSERT INTO contacts (id, bot_id, sender, name, external_id, channel, tg_username, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(), bot.id, sender, name, privateExternal, 'tg', tgHandle, now, now)
  }
  promoteContact(deps.storage, bot.id, 'tg', String(from.id))

  // §buffer — 落库即入缓冲；hub 自行调度到期合并投递（旧项目的手动 waiter 由 hub 取代）
  deps.hub.enqueueBufferedMessage({ botId: bot.id, sender, text, channelId: 'tg' })
}
