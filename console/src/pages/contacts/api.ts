/**
 * 联系人 / 关系 / 记忆速览 API（`/api/contacts`、`/api/relations`、`/api/memories`）。
 * 页面只从本文件 import；契约对齐 console-api routes-data.ts。
 */
import { asBool, asNum, asStr, firstOf, http, isRecord, pickArray, pickRecord } from '@/api/client'

export interface Contact {
  /** 前端 id 就是 sender 标识（后端 contactView.id 同值）。 */
  id: string
  rowId: string
  botId: string
  name: string
  brief: string
  profile: Record<string, unknown> | null
  isOwner: boolean
  blocked: boolean
  channel: string
  externalId: string
  lastActiveAt?: string
  createdAt?: string
}

function toContact(v: unknown): Contact | undefined {
  if (!isRecord(v)) return undefined
  const sender = asStr(firstOf(v, 'sender', 'id'))
  if (!sender) return undefined
  const profileRec = pickRecord(v, 'profile')
  return {
    id: sender,
    rowId: asStr(v.id) ?? sender,
    botId: asStr(v.botId) ?? '',
    name: asStr(v.name) ?? sender,
    brief: asStr(v.brief) ?? '',
    profile: profileRec ?? null,
    isOwner: asBool(v.isOwner) ?? false,
    blocked: asBool(v.blocked) ?? false,
    channel: asStr(v.channel) ?? '',
    externalId: asStr(v.externalId) ?? '',
    lastActiveAt: asStr(firstOf(v, 'lastActiveAt', 'last_active_at')),
    createdAt: asStr(v.createdAt),
  }
}

/** profile 可能是 JSON 字符串（后端 profile 列存 TEXT）→ 统一成对象。 */
function parseProfile(raw: string): Record<string, unknown> | null {
  const text = raw.trim()
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as unknown
    if (isRecord(parsed)) return parsed
  } catch {
    // 非 JSON → 当作单段文本展示
  }
  return { 简介: text }
}

export const contactsApi = {
  async list(botId: string): Promise<Contact[]> {
    const out = await http.get<unknown>('/api/contacts', { botId })
    const rec = isRecord(out) ? out : {}
    return pickArray(rec, 'contacts')
      .map(toContact)
      .filter((c): c is Contact => c !== undefined)
  },
  async get(sender: string, botId: string): Promise<Contact | undefined> {
    const out = await http.get<unknown>(`/api/contacts/${encodeURIComponent(sender)}`, { botId })
    const rec = isRecord(out) ? out : {}
    return toContact(rec.contact ?? out)
  },
  async update(sender: string, botId: string, patch: { name?: string; brief?: string; profile?: unknown; blocked?: boolean }): Promise<void> {
    await http.patch(`/api/contacts/${encodeURIComponent(sender)}`, patch, { query: { botId } })
  },
}

export interface Relation {
  id: string
  botId: string
  fromContactId: string
  toContactId: string
  fromName: string
  toName: string
  type: string
  description: string
  createdAt?: string
}

function toRelation(v: unknown): Relation | undefined {
  if (!isRecord(v)) return undefined
  const from = asStr(firstOf(v, 'fromContactId', 'fromSender', 'from')) ?? ''
  const to = asStr(firstOf(v, 'toContactId', 'toSender', 'to')) ?? ''
  const id = asStr(v.id) ?? `${from}->${to}`
  return {
    id,
    botId: asStr(v.botId) ?? '',
    fromContactId: from,
    toContactId: to,
    fromName: asStr(firstOf(v, 'fromName', 'fromSenderName')) ?? from,
    toName: asStr(firstOf(v, 'toName', 'toSenderName')) ?? to,
    type: asStr(firstOf(v, 'type', 'relation')) ?? '',
    description: asStr(firstOf(v, 'description', 'note')) ?? '',
    createdAt: asStr(v.createdAt),
  }
}

export const relationsApi = {
  async list(botId: string): Promise<Relation[]> {
    const out = await http.get<unknown>('/api/relations', { botId })
    const rec = isRecord(out) ? out : {}
    return pickArray(rec, 'relations')
      .map(toRelation)
      .filter((r): r is Relation => r !== undefined)
  },
  /** 后端按 (from,to) upsert；from/to 都用 contact 的 sender 标识。 */
  async create(botId: string, input: { fromContactId: string; toContactId: string; type: string; description: string }): Promise<void> {
    await http.post('/api/relations', { botId, ...input })
  },
}

/** 记忆速览（联系人详情里只看该 sender 最近几条）。 */
export interface MemoryPreview {
  id: string
  sender: string
  category: string
  importance: number
  content: string
  createdAt?: string
  deleted: boolean
}

export const memoryPreviewApi = {
  async list(botId: string, sender?: string): Promise<MemoryPreview[]> {
    const out = await http.get<unknown>('/api/memories', { botId, sender })
    const rec = isRecord(out) ? out : {}
    return pickArray(rec, 'memories')
      .filter(isRecord)
      .map((m) => ({
        id: asStr(m.id) ?? '',
        sender: asStr(m.sender) ?? '',
        category: asStr(m.category) ?? '',
        importance: asNum(m.importance) ?? 0,
        content: asStr(m.content) ?? '',
        createdAt: asStr(m.createdAt),
        deleted: asBool(m.deleted) ?? asStr(m.deletedAt) !== undefined,
      }))
      .filter((m) => m.id !== '')
  },
}

/** 后端 contact.profile 存的是 TEXT；列表接口返回的是解析后的对象或原串。 */
export function contactProfile(contact: Contact): Record<string, unknown> | null {
  if (contact.profile) return contact.profile
  return null
}

export { parseProfile }
