/**
 * 联系人身份解析（跨平台同一真人 = 同一联系人；联系人按 bot 隔离）。
 *
 * 背景 bug：web 首聊时 hub 兜底建联系人把 `name` 写成 sender（用户 UUID/邮箱），且
 * `user_id/is_owner` 为空 → 界面显示成「跟我没关联」的新联系人；各渠道 inbound 建联系人
 * 只写 sender/external_id/channel，没写 user_id；promoteContact 只按 sender=external_id 匹配，
 * web 场景永远补不上。存量库还有 user_id 为空的行。
 *
 * 本模块是唯一权威实现：
 * - resolveContact()：按 users.id / channel_identities 解析并 upsert 一行联系人；
 * - promoteContact()：绑定后把该 bot 下相关联系人晋升（兼容 sender 与 external_id 两种匹配）；
 * - repairContacts()：幂等修复存量（补 user_id/name/is_owner，不删行、不改消息）。
 */
import { randomUUID } from 'node:crypto'
import type { LittlyStorage } from '@littly/storage'

/** 联系人行（只取用到的列）。 */
export interface ContactRowLite {
  id: string
  bot_id: string
  sender: string
  name: string
  external_id: string
  channel: string
  user_id: string | null
  is_owner: number
}

export interface ResolveContactHints {
  /** 渠道 id（web/qqp/wechat/discord/tg…），用于 identity 反查与落 channel。 */
  channel?: string
  /** 渠道外部 id（uin/openid/discord id/tg id），用于 identity 反查。 */
  externalId?: string
  /** 可读昵称（渠道昵称等）；缺省时落空串，绝不落裸 id。 */
  name?: string
  /** 是否把 externalId 落成投递地址（群聊传 false：external_id 只由私聊落库）。默认 true。 */
  persistExternal?: boolean
}

export interface ResolvedContact {
  contactId: string
  sender: string
  userId: string | null
  name: string
  isOwner: boolean
  created: boolean
}

/** 形如用户 UUID / 邮箱 / 纯数字 uin / 长 hex openid 的「裸 id」不适合当展示名。 */
export function looksLikeRawId(value: string, sender = ''): boolean {
  const text = value.trim()
  if (text === '') return true
  if (sender !== '' && text === sender) return true
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(text)) return true
  if (/^[^@\s]+@[^@\s]+$/u.test(text)) return true
  if (/^\d{5,}$/u.test(text)) return true
  if (/^[0-9a-f]{16,}$/iu.test(text)) return true
  return false
}

function isUsableName(value: string | undefined): boolean {
  if (value === undefined) return false
  const text = value.trim()
  return text !== '' && !looksLikeRawId(text)
}

/** 取 users 行（id 或 username 展示名）。 */
function userById(storage: LittlyStorage, userId: string): { id: string; username: string } | null {
  try {
    return (storage.prepare('SELECT id, username FROM users WHERE id = ?').get(userId) as { id: string; username: string } | undefined) ?? null
  } catch {
    return null
  }
}

/** 渠道身份反查：优先 (channel, external_id)，退化到 external_id 唯一命中。 */
function userIdFromIdentity(storage: LittlyStorage, channel: string, externalId: string): string | null {
  if (externalId === '') return null
  try {
    if (channel !== '') {
      const direct = storage.prepare('SELECT user_id FROM channel_identities WHERE channel = ? AND external_id = ?').get(channel, externalId) as { user_id: string } | undefined
      if (direct !== undefined) return direct.user_id
    }
    const rows = storage.prepare('SELECT user_id FROM channel_identities WHERE external_id = ?').all(externalId) as unknown as Array<{ user_id: string }>
    const unique = [...new Set(rows.map((r) => r.user_id))]
    return unique.length === 1 ? unique[0] ?? null : null
  } catch {
    return null
  }
}

function botOwnerId(storage: LittlyStorage, botId: string): string {
  try {
    const bot = storage.prepare('SELECT owner_id FROM bots WHERE id = ?').get(botId) as { owner_id?: string | null } | undefined
    return (bot?.owner_id ?? '') || ''
  } catch {
    return ''
  }
}

/** 用解析结果更新/插入一行联系人（幂等；is_owner 只置 1 不清除）。 */
function applyResolved(storage: LittlyStorage, botId: string, sender: string, hints: ResolveContactHints, existing: ContactRowLite | undefined): ResolvedContact {
  const userId = userById(storage, sender)?.id ?? userIdFromIdentity(storage, hints.channel ?? existing?.channel ?? '', hints.externalId ?? existing?.external_id ?? '')
  const user = userId !== null ? userById(storage, userId) : null
  const ownerId = botOwnerId(storage, botId)
  const shouldOwn = userId !== null && ownerId !== '' && userId === ownerId
  const now = new Date().toISOString()
  const hintName = isUsableName(hints.name) ? (hints.name ?? '').trim() : ''
  // 展示名：已绑定用户优先 username；否则优先可读昵称；裸 id 不作为名字。
  let desiredName = user?.username ?? hintName
  if (existing !== undefined) {
    const current = existing.name.trim()
    const currentUsable = current !== '' && !looksLikeRawId(current, sender)
    desiredName = user !== null
      ? user.username
      : currentUsable ? current : hintName
    const nextUserId = userId ?? (existing.user_id !== null && existing.user_id !== '' ? existing.user_id : null)
    const nextIsOwner = shouldOwn ? 1 : existing.is_owner
    const nextChannel = existing.channel !== '' ? existing.channel : (hints.channel ?? '')
    const persistExternal = hints.persistExternal !== false
    const nextExternal = existing.external_id !== '' ? existing.external_id : (persistExternal ? (hints.externalId ?? '') : '')
    const nameChanged = desiredName !== existing.name
    const userIdChanged = nextUserId !== existing.user_id
    const ownerChanged = nextIsOwner !== existing.is_owner
    const channelChanged = nextChannel !== existing.channel
    const externalChanged = nextExternal !== existing.external_id
    if (nameChanged || userIdChanged || ownerChanged || channelChanged || externalChanged) {
      storage
        .prepare('UPDATE contacts SET name = ?, user_id = ?, is_owner = ?, channel = ?, external_id = ?, updated_at = ? WHERE id = ?')
        .run(desiredName, nextUserId, nextIsOwner, nextChannel, nextExternal, now, existing.id)
    }
    return { contactId: existing.id, sender, userId: nextUserId, name: desiredName, isOwner: nextIsOwner === 1, created: false }
  }
  const id = randomUUID()
  storage
    .prepare('INSERT INTO contacts (id, bot_id, sender, name, external_id, channel, user_id, is_owner, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, botId, sender, desiredName, hints.persistExternal === false ? '' : (hints.externalId ?? ''), hints.channel ?? '', userId, shouldOwn ? 1 : 0, now, now)
  return { contactId: id, sender, userId, name: desiredName, isOwner: shouldOwn, created: true }
}

/**
 * 解析并确保联系人存在/已关联。
 * - sender 命中 users.id → user_id=sender、name=username、is_owner=(bots.owner_id===sender)；
 * - 否则用 hints.channel + hints.externalId 查 channel_identities 反查 user_id；
 * - 只补空/不一致的 user_id，name 不用裸 id，is_owner 只置 1 不清除。
 */
export function resolveContact(storage: LittlyStorage, botId: string, sender: string, hints: ResolveContactHints = {}): ResolvedContact {
  const existing = storage
    .prepare('SELECT id, bot_id, sender, name, external_id, channel, user_id, is_owner FROM contacts WHERE bot_id = ? AND sender = ?')
    .get(botId, sender) as ContactRowLite | undefined
  return applyResolved(storage, botId, sender, hints, existing)
}

/**
 * 正常消息路径的晋升：渠道身份已存在 → 把该 bot 下相关联系人补成同一用户。
 * 兼容两种匹配：sender = 用户 id / sender = 渠道外部 id / external_id = 渠道外部 id。
 */
export function promoteContact(storage: LittlyStorage, botId: string, channel: string, externalId: string): void {
  const identity = storage
    .prepare('SELECT user_id FROM channel_identities WHERE channel = ? AND external_id = ?')
    .get(channel, externalId) as { user_id: string } | undefined
  if (identity === undefined) return
  const userId = identity.user_id
  const rows = storage
    .prepare('SELECT id, bot_id, sender, name, external_id, channel, user_id, is_owner FROM contacts WHERE bot_id = ? AND (sender = ? OR sender = ? OR external_id = ?)')
    .all(botId, userId, externalId, externalId) as unknown as ContactRowLite[]
  for (const row of rows) applyResolved(storage, botId, row.sender, { channel, externalId }, row)
}

/**
 * 幂等修复存量联系人（启动时执行一次）：
 * - sender 命中 users.id → 补 user_id / name（username，若原 name 为空或裸 id）/ is_owner；
 * - 渠道联系人 → 用 channel_identities 反查 user_id；
 * - 不删行、不改消息、不重复产生变更（第二次执行 repaired=0）。
 */
export function repairContacts(storage: LittlyStorage): { scanned: number; repaired: number } {
  const rows = storage.prepare('SELECT id, bot_id, sender, name, external_id, channel, user_id, is_owner FROM contacts').all() as unknown as ContactRowLite[]
  let repaired = 0
  for (const row of rows) {
    const before = JSON.stringify([row.name, row.user_id, row.is_owner])
    applyResolved(storage, row.bot_id, row.sender, { channel: row.channel, externalId: row.external_id }, row)
    const after = storage
      .prepare('SELECT name, user_id, is_owner FROM contacts WHERE id = ?')
      .get(row.id) as { name: string; user_id: string | null; is_owner: number } | undefined
    if (after !== undefined && JSON.stringify([after.name, after.user_id, after.is_owner]) !== before) repaired++
  }
  return { scanned: rows.length, repaired }
}
