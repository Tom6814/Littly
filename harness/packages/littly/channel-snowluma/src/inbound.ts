/**
 * SnowLuma 入站事件处理（旧 qq-personal.ts handleQQPMessage 的移植 + 群聊 @提及门）。
 *
 * 渠道 id 决策：QQ 账号流量全部用 'qqp'（沿用旧渠道语义：scene 文案、tools 枚举、
 * sender 前缀 qqp_<uin> 均不变）；SnowLuma 只是其新的传输底座。
 *
 * - 私聊 friend：全处理（绑定拦截 → 身份归一化 → 联系人 → 图片入库 → 缓冲入队）。
 * - 群聊：仅处理 @bot 昵称的消息（昵称来自 get_login_info），external_id 不落库。
 * - 图片：收集 http URL → fire-and-forget 下载进 public/downloads/photos → photos 表。
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BotRow } from '@littly/storage'
import { promoteContact, tryHandleBinding } from './binding.ts'
import { callBotAction, type OneBotEnvelope, type SnowlumaDeps } from './client.ts'

interface MessageSegment {
  type?: unknown
  data?: { text?: unknown; url?: unknown; file?: unknown }
}

/** message 可能是纯文本 string，也可能是 CQ 段数组 → 取 text 段拼接 + image 段提取 URL（契约 §4）。 */
export function extractMedia(msg: unknown): { text: string; images: string[] } {
  if (typeof msg === 'string') return { text: msg, images: [] }
  if (Array.isArray(msg)) {
    let text = ''
    const images: string[] = []
    for (const item of msg) {
      const seg = item as MessageSegment | null
      if (!seg || typeof seg !== 'object') continue // 畸形段跳过，不丢整条（契约 §4）
      if (seg.type === 'text' && typeof seg.data?.text === 'string') text += seg.data.text
      if (seg.type === 'image') {
        const url = seg.data?.url
        const file = seg.data?.file
        const u = typeof url === 'string' && url ? url : typeof file === 'string' ? file : ''
        if (u) images.push(u)
      }
    }
    return { text, images }
  }
  return { text: String(msg ?? ''), images: [] }
}

// --- 联系人/收件人解析 ---

/** sender 归一化为绑定用户 id 时从 channel_identities(qqp) 拿权威 uin；否则 qqp_ 前缀 / contact 兜底。 */
export function resolveQqpUin(deps: SnowlumaDeps, botId: string, sender: string): string {
  if (sender.startsWith('qqp_') && sender.length > 4 && /^\d+$/.test(sender.slice(4))) return sender.slice(4)
  const identity = deps.storage
    .prepare('SELECT external_id FROM channel_identities WHERE user_id = ? AND channel = ?')
    .get(sender, 'qqp') as { external_id: string } | undefined
  if (identity && /^\d+$/.test(identity.external_id)) return identity.external_id
  const contact = deps.storage
    .prepare('SELECT external_id FROM contacts WHERE bot_id = ? AND sender = ?')
    .get(botId, sender) as { external_id: string } | undefined
  if (contact && /^\d+$/.test(contact.external_id)) return contact.external_id
  return ''
}

// --- 图片入库（fire-and-forget，best effort） ---

function extFor(contentType: string | null): string {
  if (contentType && contentType.includes('png')) return '.png'
  if (contentType && contentType.includes('gif')) return '.gif'
  if (contentType && contentType.includes('webp')) return '.webp'
  return '.jpg'
}

async function importPhotos(deps: SnowlumaDeps, bot: BotRow, sender: string, urls: string[]): Promise<void> {
  const dir = join(process.cwd(), 'public', 'downloads', 'photos')
  mkdirSync(dir, { recursive: true })
  for (const url of urls.slice(0, 9)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
      if (!res.ok) continue
      const buf = Buffer.from(await res.arrayBuffer())
      const filename = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${extFor(res.headers.get('content-type'))}`
      writeFileSync(join(dir, filename), buf)
      deps.storage
        .prepare('INSERT INTO photos (id, bot_id, url, caption, tags, created_at) VALUES (?,?,?,?,?,?)')
        .run(randomUUID(), bot.id, `/api/photos/file/photos/${filename}`, `来自 ${sender}`, '[]', new Date().toISOString())
      deps.log('[snowluma] 已收录 1 张图进相册 (bot=%s)', bot.name)
    } catch {
      // 单张失败跳过，绝不阻断对话
    }
  }
}

// --- 出站底层：私聊文本发送（供绑定回复 / hub 投递 / 渠道工具共用） ---

export async function sendPrivateText(deps: SnowlumaDeps, botId: string, uin: string, text: string): Promise<void> {
  const res = await callBotAction(deps.storage, botId, 'send_private_msg', { user_id: Number(uin), message: text })
  if (!res) throw new Error('SnowLuma 连接不可用或响应超时')
  if (!(res.retcode === 0 || res.status === 'ok')) {
    throw new Error(`SnowLuma 发送失败: retcode=${String(res.retcode)} ${String(res.wording ?? '').slice(0, 200)}`)
  }
}

// --- 入站主入口 ---

export async function handleSnowlumaEvent(deps: SnowlumaDeps, bot: BotRow, ev: OneBotEnvelope): Promise<void> {
  if (ev.post_type !== 'message') return
  // 多账号：self_id 过滤（契约 §1——事件 self_id 即 UIN；缺失时宽松放行）
  if (bot.snowluma_account && ev.self_id !== undefined && String(ev.self_id) !== bot.snowluma_account) return

  const isPrivateFriend = ev.message_type === 'private' && ev.sub_type === 'friend'
  const isGroup = ev.message_type === 'group'
  if (!isPrivateFriend && !isGroup) return

  const uin = String(ev.user_id ?? '')
  if (!uin || !/^\d+$/.test(uin)) return

  const { text, images } = extractMedia(ev.message ?? ev.raw_message)
  const clean = text.trim()

  if (isGroup) {
    // 群聊只响应 @机器人（昵称来自 get_login_info；旧项目直接丢群，此处按契约补 @提及门）
    const nick = await deps.getSelfNickname(bot)
    if (!nick || !clean.includes(nick)) return
    // TODO(M2)：改用 at 段（data.qq === self uin）精确匹配，昵称子串只是 v1 的近似
  }

  if (!clean && images.length === 0) return

  // 绑定流只吃纯文本（绑定码不含图片）；私聊与群聊均可（外部 id 统一用 uin，与旧 TG 同款）
  if (clean) {
    const binding = await tryHandleBinding(deps.storage, { channel: 'qqp', externalId: uin, text: clean })
    if (binding.handled) {
      if (binding.reply) {
        try {
          await sendPrivateText(deps, bot.id, uin, binding.reply)
        } catch (err) {
          deps.log('[snowluma] 绑定回复失败 (bot=%s): %s', bot.name, String(err))
        }
      }
      return
    }
  }

  // 身份归一化：已绑定的 QQ 账号归并到绑定用户的会话线
  const identity = deps.storage
    .prepare('SELECT user_id FROM channel_identities WHERE channel = ? AND external_id = ?')
    .get('qqp', uin) as { user_id: string } | undefined
  const sender = identity?.user_id ?? `qqp_${uin}`

  // 联系人 upsert：私聊落 external_id = uin（投递地址）；群聊绝不动 external_id，
  // 且永不覆盖已有 external_id。
  const name = isGroup ? String(ev.sender?.card || ev.sender?.nickname || uin) : uin
  const privateExternal = isPrivateFriend ? uin : ''
  const now = new Date().toISOString()
  const existing = deps.storage
    .prepare('SELECT id, external_id FROM contacts WHERE bot_id = ? AND sender = ?')
    .get(bot.id, sender) as { id: string; external_id: string } | undefined
  if (existing) {
    if (privateExternal && !existing.external_id) {
      deps.storage
        .prepare('UPDATE contacts SET name = ?, external_id = ?, updated_at = ? WHERE id = ?')
        .run(name, privateExternal, now, existing.id)
    } else {
      deps.storage.prepare('UPDATE contacts SET name = ?, updated_at = ? WHERE id = ?').run(name, now, existing.id)
    }
  } else {
    deps.storage
      .prepare('INSERT INTO contacts (id, bot_id, sender, name, external_id, channel, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(randomUUID(), bot.id, sender, name, privateExternal, 'qqp', now, now)
  }
  promoteContact(deps.storage, bot.id, 'qqp', uin)

  // 用户发的图片自动进相册（下载较慢，后台异步，不阻断对话）
  const httpImages = images.filter((u) => /^https?:\/\//.test(u))
  if (httpImages.length > 0) {
    void importPhotos(deps, bot, sender, httpImages).catch((err) =>
      deps.log('[snowluma] 相册入库失败 (bot=%s): %s', bot.name, String(err)),
    )
  }

  if (clean) {
    // §buffer — 落库即入缓冲；hub 自行调度到期合并投递
    deps.hub.enqueueBufferedMessage({ botId: bot.id, sender, text: clean, channelId: 'qqp' })
  }
}
