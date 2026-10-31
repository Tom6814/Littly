/**
 * Memory Vault 共享类型与校验（Markdown 真相 + 派生索引）。
 *
 * 9 域固定：about-user / interests / projects / life / relationships / feedback / notes / health / history。
 * history 是墓碑归档域（失效/被取代条目的摘要）；notes 是推断（kind=agent-note）。
 */
export const MEMORY_DOMAINS = [
  'about-user', 'interests', 'projects', 'life', 'relationships', 'feedback', 'notes', 'health', 'history',
] as const
export type MemoryDomain = typeof MEMORY_DOMAINS[number]

/** 可写入的 8 个业务域（history 仅由墓碑流程/迁移写）。 */
export const WRITABLE_DOMAINS = MEMORY_DOMAINS.filter((d) => d !== 'history') as Exclude<MemoryDomain, 'history'>[]

export const ENTRY_KINDS = ['about-user', 'agent-note', 'rule'] as const
export type EntryKind = typeof ENTRY_KINDS[number]

export const PROVENANCES = ['user-stated', 'observed', 'inferred'] as const
export type Provenance = typeof PROVENANCES[number]

export const VOLATILITIES = ['stable', 'state'] as const
export type Volatility = typeof VOLATILITIES[number]

export const PRIVACY_LEVELS = ['none', 'no_export'] as const
export type Privacy = typeof PRIVACY_LEVELS[number]

/** Vault 错误（路由层映射 HTTP 状态码）。 */
export class VaultError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'VaultError'
    this.code = code
    this.status = status
  }
}

/** frontmatter + 正文的一条记忆。 */
export interface VaultEntry {
  id: string
  domain: MemoryDomain
  kind: EntryKind
  title: string
  event_time: string
  event_raw: string
  record_time: string
  last_verified: string
  valid_until: string | null
  superseded_by: string | null
  supersedes: string[]
  source: 'chat' | 'manual' | 'migration'
  source_ref: string
  provenance: Provenance
  volatility: Volatility
  importance: number
  tags: string[]
  related: string[]
  thread: string
  privacy: Privacy
  /** 正文（Markdown，不含时间戳）。 */
  body: string
}

/** 写入入参（id 可选，缺省生成 stable id）。 */
export interface VaultWriteInput {
  id?: string
  domain: string
  kind?: string
  title: string
  body: string
  event_time?: string
  event_raw?: string
  record_time?: string
  last_verified?: string
  valid_until?: string | null
  supersedes?: string[]
  titleAlready?: boolean
  source?: 'chat' | 'manual' | 'migration'
  source_ref?: string
  provenance?: string
  volatility?: string
  importance?: number
  tags?: string[]
  related?: string[]
  thread?: string
  privacy?: string
}

/** 校验并补全一条写入。 */
export function normalizeWriteInput(input: VaultWriteInput, now: () => Date = () => new Date()): VaultEntry {
  const domain = String(input.domain ?? '').trim() as MemoryDomain
  if (!(WRITABLE_DOMAINS as string[]).includes(domain)) {
    throw new VaultError('bad_domain', `domain 不合法：${domain || '(空)'}；可选 ${WRITABLE_DOMAINS.join(' / ')}`)
  }
  const title = String(input.title ?? '').trim()
  if (title === '') throw new VaultError('bad_entry', 'title 不能为空')
  if (title.length > 200) throw new VaultError('bad_entry', 'title 过长（>200 字）')
  const body = String(input.body ?? '').trim()
  if (body === '') throw new VaultError('bad_entry', '正文不能为空')
  if (body.length > 20_000) throw new VaultError('bad_entry', '正文过长（>20KB）')
  const kind = String(input.kind ?? (domain === 'feedback' ? 'rule' : domain === 'notes' ? 'agent-note' : 'about-user')) as EntryKind
  if (!ENTRY_KINDS.includes(kind)) throw new VaultError('bad_entry', `kind 不合法：${kind}`)
  // notes 是推断域：只允许 agent-note（避免把推断当事实）
  if (domain === 'notes' && kind !== 'agent-note') throw new VaultError('bad_entry', 'notes 域的 kind 必须是 agent-note（推断）')
  // feedback 是规则域：只允许 rule（用户明确表达）
  if (domain === 'feedback' && kind !== 'rule') throw new VaultError('bad_entry', 'feedback 域的 kind 必须是 rule（相处规则）')
  const provenance = String(
    input.provenance ?? (kind === 'agent-note' ? 'inferred' : kind === 'rule' ? 'user-stated' : 'observed'),
  ) as Provenance
  if (!PROVENANCES.includes(provenance)) throw new VaultError('bad_entry', `provenance 不合法：${provenance}`)
  if (kind === 'agent-note' && provenance === 'user-stated') throw new VaultError('bad_entry', '推断条目不能标 user-stated')
  if (kind === 'rule' && provenance === 'observed') throw new VaultError('bad_entry', 'feedback 规则应为 user-stated（用户明确表达）')
  const volatility = String(input.volatility ?? 'stable') as Volatility
  if (!VOLATILITIES.includes(volatility)) throw new VaultError('bad_entry', `volatility 不合法：${volatility}`)
  const importanceRaw = Number(input.importance ?? 3)
  if (!Number.isInteger(importanceRaw) || importanceRaw < 1 || importanceRaw > 5) {
    throw new VaultError('bad_entry', 'importance 必须是 1-5 的整数')
  }
  const date = now()
  const eventTime = normalizeTime(input.event_time, date)
  const recordTime = normalizeTime(input.record_time, date)
  const lastVerified = String(input.last_verified ?? recordTime.slice(0, 10))
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(lastVerified)) throw new VaultError('bad_entry', 'last_verified 需为 YYYY-MM-DD')
  const validUntil = input.valid_until === null || input.valid_until === undefined || String(input.valid_until).trim() === ''
    ? null
    : normalizeTime(String(input.valid_until), date)
  const privacy = String(input.privacy ?? 'none') as Privacy
  if (!PRIVACY_LEVELS.includes(privacy)) throw new VaultError('bad_entry', `privacy 不合法：${privacy}`)
  const tags = normalizeStringList(input.tags).slice(0, 20)
  const related = normalizeStringList(input.related).slice(0, 50)
  const supersedes = normalizeStringList(input.supersedes).slice(0, 50)
  const id = String(input.id ?? '').trim() || makeEntryId(domain, title, date)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)) throw new VaultError('bad_entry', `id 不合法：${id}`)
  const source = input.source ?? 'chat'
  if (!['chat', 'manual', 'migration'].includes(source)) throw new VaultError('bad_entry', `source 不合法：${source}`)
  return {
    id,
    domain,
    kind,
    title,
    event_time: eventTime,
    event_raw: String(input.event_raw ?? '').trim().slice(0, 500),
    record_time: recordTime,
    last_verified: lastVerified,
    valid_until: validUntil,
    superseded_by: null,
    supersedes,
    source,
    source_ref: String(input.source_ref ?? '').trim().slice(0, 300),
    provenance,
    volatility,
    importance: importanceRaw,
    tags,
    related,
    thread: String(input.thread ?? '').trim().slice(0, 120),
    privacy,
    body,
  }
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((v) => String(v).trim()).filter((v) => v !== ''))]
}

/** 时间统一成带时区的 ISO（缺时区按本地 +08:00 解释；无法解析则报错）。 */
export function normalizeTime(raw: string | undefined, fallback: Date): string {
  const text = String(raw ?? '').trim()
  if (text === '') return toZonedIso(fallback)
  // 纯日期 → 当天 00:00 +08:00
  if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) return `${text}T00:00:00+08:00`
  const ms = Date.parse(text)
  if (Number.isNaN(ms)) throw new VaultError('bad_entry', `时间不合法：${text}（ISO 8601，建议带时区）`)
  const date = new Date(ms)
  if (/[+-]\d{2}:\d{2}$|Z$/u.test(text)) return date.toISOString().replace('Z', '+00:00')
  return toZonedIso(date)
}

/** 本地时区 ISO（Asia/Shanghai 固定 +08:00，与本仓库其它日期逻辑一致）。 */
export function toZonedIso(date: Date): string {
  const offsetMinutes = 8 * 60
  const local = new Date(date.getTime() + offsetMinutes * 60_000)
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0')
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}+08:00`
}

/** 生成可读且稳定的 entry id：<domain>-<slug>-<hash6>。 */
export function makeEntryId(domain: string, title: string, date: Date): string {
  const slug = title.toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40)
  const hash = sha256Hex(`${domain}\n${title}\n${date.toISOString()}`).slice(0, 6)
  return `${domain}-${slug === '' ? 'entry' : slug}-${hash}`
}

import { createHash } from 'node:crypto'
export function sha256Hex(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex')
}
