/**
 * Discord 入站处理（旧 internal/channel/discord.ts handleDiscordMessage 的移植）。
 *
 * 流程：bot 守卫 → 只收 DM → 内容提取 → 绑定拦截 → 身份归一化 → 联系人 upsert
 *       → 图片进相册（异步） → 缓冲入队。
 *
 * 身份归一化（与微信/TG 对齐）：已绑定平台的 Discord 账号消息归并到绑定用户的会话线，
 * sender = channel_identities(discord, external_id=userId).user_id ?? `discord_${userId}`。
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { downloadsDir, type BotRow, type LittlyStorage } from '@littly/storage'
import { promoteContact, tryHandleBinding } from './binding.ts'
import { sendDiscordText, type DiscordAuthor, type DiscordDeps, type DiscordMessage } from './client.ts'

/** 单条消息最多收录进相册的图片数（旧 importImages 的 slice(0, 5)）。 */
const MAX_IMPORT_IMAGES = 5

/**
 * 内容提取：正文 trim + 图片附件（content_type 以 image/ 开头）。
 * @param msg - MESSAGE_CREATE 事件体。
 * @returns 文本正文与图片 URL 列表。
 */
export function extractDiscordContent(msg: DiscordMessage): { text: string; images: string[] } {
  const text = (msg.content ?? '').trim()
  const images = (msg.attachments ?? [])
    .filter((a) => (a.content_type ?? '').startsWith('image/'))
    .map((a) => a.url ?? '')
    .filter(Boolean)
  return { text, images }
}

/**
 * 显示名：global_name → username → user id（旧 displayName 规则）。
 * @param author - 消息作者。
 * @param userId - 作者 id（兜底显示名）。
 * @returns 联系人显示名。
 */
export function discordDisplayName(author: DiscordAuthor, userId: string): string {
  return author.global_name || author.username || userId
}

/**
 * sender 归一化：已绑定 → 绑定用户 id；未绑定 → `discord_&lt;userId&gt;`。
 * @param storage - 业务存储（channel_identities）。
 * @param userId - Discord 平台用户 id。
 * @returns 会话标识（sender）。
 */
export function resolveDiscordSender(storage: LittlyStorage, userId: string): string {
  const identity = storage
    .prepare('SELECT user_id FROM channel_identities WHERE channel = ? AND external_id = ?')
    .get('discord', userId) as { user_id: string } | undefined
  return identity?.user_id ?? `discord_${userId}`
}

/**
 * 联系人 upsert：external_id 存 DM channel_id（投递地址）；
 * channel_identities 的 external_id 存 user id。
 * @param deps - 插件依赖（存储）。
 * @param bot - bot 行。
 * @param sender - 会话标识。
 * @param displayName - 联系人显示名。
 * @param dmChannelId - 入站消息所在的 DM channel id（投递地址）。
 */
export function upsertDiscordContact(
  deps: DiscordDeps,
  bot: BotRow,
  sender: string,
  displayName: string,
  dmChannelId: string,
): void {
  const now = new Date().toISOString()
  const existing = deps.storage
    .prepare('SELECT id, external_id FROM contacts WHERE bot_id = ? AND sender = ?')
    .get(bot.id, sender) as { id: string; external_id: string } | undefined
  if (existing) {
    // 已有投递地址不覆盖（Discord DM channel 对同一对用户是稳定的）；空则补上。
    const externalId = existing.external_id ? existing.external_id : dmChannelId
    deps.storage
      .prepare('UPDATE contacts SET name = ?, channel = ?, external_id = ?, updated_at = ? WHERE id = ?')
      .run(displayName, 'discord', externalId, now, existing.id)
    return
  }
  deps.storage
    .prepare('INSERT INTO contacts (id, bot_id, sender, name, external_id, channel, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(randomUUID(), bot.id, sender, displayName, dmChannelId, 'discord', now, now)
}

// --- 图片入库（fire-and-forget，best effort） ---

function extFor(contentType: string | null): string {
  if (contentType && contentType.includes('png')) return '.png'
  if (contentType && contentType.includes('gif')) return '.gif'
  if (contentType && contentType.includes('webp')) return '.webp'
  return '.jpg'
}

async function importPhotos(deps: DiscordDeps, bot: BotRow, sender: string, urls: string[]): Promise<void> {
  // B11：落持久卷（LITTLY_DATA_DIR/downloads/photos），URL 不变。
  const dir = join(downloadsDir(), 'photos')
  mkdirSync(dir, { recursive: true })
  for (const url of urls.slice(0, MAX_IMPORT_IMAGES)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
      if (!res.ok) continue
      const buf = Buffer.from(await res.arrayBuffer())
      const filename = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${extFor(res.headers.get('content-type'))}`
      writeFileSync(join(dir, filename), buf)
      deps.storage
        .prepare('INSERT INTO photos (id, bot_id, url, caption, tags, created_at) VALUES (?,?,?,?,?,?)')
        .run(randomUUID(), bot.id, `/api/photos/file/photos/${filename}`, `来自 ${sender}`, '[]', new Date().toISOString())
      deps.log('[discord] 已收录 1 张图进相册 (bot=%s)', bot.name)
    } catch {
      // 单张失败跳过，绝不阻断对话
    }
  }
}

/**
 * B6：Discord 语义判 DM。
 *
 * 旧实现用 `msg.channel_type !== 1` 判私聊 —— 但 Gateway 的 MESSAGE_CREATE
 * payload 里 `channel_type` 并不保证存在（只有 REST 的 Channel 对象有），
 * 于是 `undefined !== 1` 恒成立 → 所有私聊消息被当群聊丢掉。
 * 正确语义：**没有 guild_id 就是私聊**（Discord 文档：DM 消息不带 guild_id）。
 * 若事件显式带了 channel_type，则以它为准（1 = DM），兼容 REST 形状的 fixture。
 */
export function isDirectMessage(msg: Pick<DiscordMessage, 'guild_id' | 'channel_type'>): boolean {
  if (typeof msg.guild_id === 'string' && msg.guild_id !== '') return false
  if (typeof msg.channel_type === 'number') return msg.channel_type === 1
  return true
}

/**
 * 入站主入口：MESSAGE_CREATE → 绑定拦截 → 联系人 → 缓冲入队。
 * @param deps - 插件依赖（存储 / hub / 日志）。
 * @param bot - bot 行。
 * @param msg - MESSAGE_CREATE 事件体。
 */
export async function handleDiscordMessage(deps: DiscordDeps, bot: BotRow, msg: DiscordMessage): Promise<void> {
  const author = msg.author
  if (!author?.id || author.bot) return
  // 只处理私聊（DM）；群聊忽略（拟真陪伴以单聊为主）。B6：无 guild_id 即 DM。
  if (!isDirectMessage(msg)) return
  const { text, images } = extractDiscordContent(msg)
  if (!text && images.length === 0) return
  const userId = author.id

  // 绑定流只吃纯文本
  if (text) {
    const binding = await tryHandleBinding(deps.storage, { channel: 'discord', externalId: userId, text })
    if (binding.handled) {
      if (binding.reply) {
        try {
          await sendDiscordText(deps, bot, msg.channel_id, binding.reply)
        } catch (err) {
          deps.log('[discord] bind reply failed (bot=%s): %s', bot.name, err instanceof Error ? err.message : String(err))
        }
      }
      return
    }
  }

  // §身份归一化 — 与微信/TG 对齐：已绑定平台的 Discord 账号消息归并到绑定用户的会话线
  const sender = resolveDiscordSender(deps.storage, userId)
  const displayName = discordDisplayName(author, userId)

  // externalId 存 DM channel_id（投递地址）；channelIdentity 的 externalId 存 user id
  upsertDiscordContact(deps, bot, sender, displayName, msg.channel_id)
  promoteContact(deps.storage, bot.id, 'discord', userId)

  // 用户发的图片自动进相册（异步，不阻断对话）
  if (images.length > 0) {
    void importPhotos(deps, bot, sender, images).catch((err) =>
      deps.log('[discord] 相册入库失败 (bot=%s): %s', bot.name, String(err)),
    )
  }

  if (text) {
    // §buffer — 落库即入缓冲；hub 自行调度到期合并投递（旧 deliverBufferedForChannel 由 hub 取代）
    deps.hub.enqueueBufferedMessage({ botId: bot.id, sender, text, channelId: 'discord' })
  }
}
