/**
 * Telegram Bot API 客户端（旧 internal/channel/telegram.ts 的低层移植）。
 *
 * ★ 关键认知（旧 telegram.ts 注释原样保留）：sendMessage 给私聊对象必须用数字
 *   chat_id，@username 只对公开频道生效。所以入站时把 from.id 存进
 *   contacts.external_id，出站时优先取 externalId；没聊过天的用户收不到主动
 *   消息（Telegram 的硬限制）。
 */
import type { LittlyStorage } from '@littly/storage'

const TG_API = 'https://api.telegram.org'

// --- Telegram API 类型（只取用到的字段） ---

export interface TgUser {
  id: number
  is_bot?: boolean
  first_name?: string
  last_name?: string
  username?: string
}

export interface TgChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
  title?: string
  username?: string
  first_name?: string
  last_name?: string
}

export interface TgPhotoSize {
  file_id: string
  file_unique_id?: string
  width?: number
  height?: number
  file_size?: number
}

export interface TgMessage {
  message_id: number
  from?: TgUser
  chat: TgChat
  date?: number
  text?: string
  caption?: string
  /** 图片消息（多分辨率，取最大者）；v1 暂不转译，仅保留 caption */
  photo?: TgPhotoSize[]
}

export interface TgUpdate {
  update_id: number
  message?: TgMessage
}

export interface TgMe {
  id: number
  username?: string
}

// --- 低层 API 调用 ---

export async function tgCall<T>(token: string, method: string, payload: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`${TG_API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  })
  let json: { ok?: boolean; result?: T; description?: string }
  try {
    json = (await res.json()) as { ok?: boolean; result?: T; description?: string }
  } catch {
    json = {}
  }
  if (!json.ok) throw new Error(`telegram ${method} 失败: ${json.description ?? String(res.status)}`)
  return json.result as T
}

export async function tgGetMe(token: string): Promise<TgMe> {
  return tgCall<TgMe>(token, 'getMe')
}

export async function tgSendMessage(token: string, chatId: number, text: string): Promise<TgMessage> {
  return tgCall<TgMessage>(token, 'sendMessage', {
    chat_id: chatId,
    text,
    // 拟人风格：关掉预览、不发链接预览卡片，纯文本更像真人（旧 telegram.ts 同款）
    link_preview_options: { is_disabled: true },
  })
}

// --- 身份映射 ---

// @username 优先，没有 username 的用户退回 tg_<数字id>
export function senderFromTgUser(u: TgUser): string {
  return u.username ? `@${u.username}` : `tg_${u.id}`
}

export function tgDisplayName(u: TgUser): string {
  const name = [u.first_name, u.last_name].filter((s) => !!s && s.length > 0).join(' ').trim()
  return name || (u.username ? `@${u.username}` : `tg_${u.id}`)
}

// --- 出站收件人解析（旧 sendToTelegramHumanized 的 chatId 解析） ---

/**
 * sender 已归一化为绑定用户 id 时，从 channel_identities(tg, userId) 拿权威数字 id
 * （contact.external_id 可能被其他渠道覆盖）；否则走 tg_<id> 前缀或 contact 兜底。
 */
export function resolveTgChatId(storage: LittlyStorage, botId: string, sender: string): number | null {
  if (sender.startsWith('tg_') && /^\d+$/.test(sender.slice(3))) return Number(sender.slice(3))
  const identity = storage
    .prepare('SELECT external_id FROM channel_identities WHERE user_id = ? AND channel = ?')
    .get(sender, 'tg') as { external_id: string } | undefined
  if (identity && /^\d+$/.test(identity.external_id)) return Number(identity.external_id)
  const contact = storage
    .prepare('SELECT external_id FROM contacts WHERE bot_id = ? AND sender = ?')
    .get(botId, sender) as { external_id: string } | undefined
  if (contact && /^\d+$/.test(contact.external_id)) return Number(contact.external_id)
  return null
}
