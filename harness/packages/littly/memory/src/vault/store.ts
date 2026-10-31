/**
 * Vault 文件层：目录布局 / 路径安全 / frontmatter / 原子写 / 条目读写 / 暂存区 / 墓碑。
 *
 * 真相在 Markdown；本模块只做文件 I/O（索引在 index-db.ts，整理在 dream.ts）。
 * 约束：
 * - 同一 entryId 永远落同一路径；重复写入幂等；同 id 不同内容 → 拒绝（VaultError entry_conflict）。
 * - 路径穿越防护：botId/contactId/domain/id 逐段校验，最终路径必须落在该联系人目录内。
 * - 原子写：同目录 tmp 文件 + rename；永不原地截断。
 * - PROFILE.md / RULES.md 的自动区用 <!-- memory:auto:begin/end --> 包住，区间外人工内容保留。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { VaultError, MEMORY_DOMAINS, WRITABLE_DOMAINS, type MemoryDomain, type VaultEntry } from './types.ts'

export const AUTO_BEGIN = '<!-- memory:auto:begin -->'
export const AUTO_END = '<!-- memory:auto:end -->'
export const RULES_BEGIN = '<!-- memory:rules:auto:begin -->'
export const RULES_END = '<!-- memory:rules:auto:end -->'

export interface VaultPaths {
  root: string
  botDir: string
  contactDir: string
  domainsDir: string
  threadsDir: string
  stagingDir: string
  historyDir: string
  metaDir: string
  profileFile: string
  rulesFile: string
}

/** Vault 根目录：默认 LITTLY_DATA_DIR/memory。 */
export function defaultVaultRoot(): string {
  const root = (process.env['LITTLY_DATA_DIR'] ?? '').trim() || join(process.cwd(), 'data')
  return join(root, 'memory')
}

/** 安全目录段：只允许字母数字 . _ -（含 unicode 字母数字）；其它字符编码成 _ + hash 后缀（稳定）。 */
export function safeSegment(value: string, label: string): string {
  const raw = String(value ?? '').trim()
  if (raw === '' || raw === '.' || raw === '..') throw new VaultError('bad_path', `${label} 不能为空、. 或 ..`)
  // 任何路径分量/穿越意图直接拒绝（编码只用于邮箱等「合法但含特殊字符」的 id）
  if (raw.includes('..') || raw.includes('/') || raw.includes('\\') || raw.includes('\u0000')) {
    throw new VaultError('bad_path', `${label} 不允许路径分隔符或 ..：${raw.slice(0, 80)}`)
  }
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(raw)) return raw
  // 邮箱/渠道 id 等：保留可读前缀 + 稳定 hash，保证同一 id 永远同目录
  const prefix = raw.replace(/[^A-Za-z0-9._-]+/gu, '_').replace(/^[._-]+/u, '').slice(0, 64) || 'id'
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 10)
  return `${prefix}-${hash}`
}

/** 计算某个 bot × contact 的 vault 路径。 */
export function vaultPaths(root: string, botId: string, contactId: string): VaultPaths {
  const bot = safeSegment(botId, 'botId')
  const contact = safeSegment(contactId, 'contactId')
  const botDir = join(root, bot)
  const contactDir = join(botDir, contact)
  return {
    root,
    botDir,
    contactDir,
    domainsDir: join(contactDir, 'domains'),
    threadsDir: join(contactDir, 'threads'),
    stagingDir: join(contactDir, '_staging'),
    historyDir: join(contactDir, '_history'),
    metaDir: join(contactDir, '_meta'),
    profileFile: join(contactDir, 'PROFILE.md'),
    rulesFile: join(contactDir, 'RULES.md'),
  }
}

/** 校验路径在 base 内（防穿越）。 */
export function assertInside(base: string, target: string): void {
  const rel = relative(resolve(base), resolve(target))
  if (rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`) || resolve(base) === resolve(target)) {
    throw new VaultError('bad_path', '路径越界：只允许操作联系人目录内的文件', 400)
  }
}

/** 建目录 + 域 README（不覆盖人工内容）。 */
export function ensureVault(paths: VaultPaths): void {
  for (const dir of [paths.botDir, paths.contactDir, paths.domainsDir, paths.threadsDir, paths.stagingDir, paths.historyDir, paths.metaDir]) {
    mkdirSync(dir, { recursive: true })
  }
  const readme: Record<string, string> = {
    'about-user': '关于 TA 的稳定事实（生日/城市/工作/家庭等）。',
    interests: 'TA 的兴趣爱好与偏好。',
    projects: 'TA 在做的事/项目/学业（含进展）。',
    life: '日常生活、作息、状态与事件。',
    relationships: 'TA 与身边人的关系、与你的关系进展。',
    feedback: 'TA 明确表达过的相处偏好/雷点（规则域）。',
    notes: '你的推断与观察（非事实，读取时需标注推断）。',
    health: '健康、情绪与身体状态（敏感，谨慎使用）。',
  }
  for (const domain of WRITABLE_DOMAINS) {
    const dir = join(paths.domainsDir, domain)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'README.md')
    if (!existsSync(file)) writeFileSync(file, `# ${domain}\n\n${readme[domain] ?? ''}\n`)
  }
  const historyDir = join(paths.domainsDir, 'history')
  mkdirSync(historyDir, { recursive: true })
  const historyReadme = join(historyDir, 'README.md')
  if (!existsSync(historyReadme)) writeFileSync(historyReadme, '# history\n\n墓碑归档：失效/被取代条目的摘要（保留「曾经是真的」）。\n')
}

// ---- frontmatter ----

const FRONTMATTER_KEYS = [
  'id', 'domain', 'kind', 'title', 'event_time', 'event_raw', 'record_time', 'last_verified',
  'valid_until', 'superseded_by', 'supersedes', 'source', 'source_ref', 'provenance',
  'volatility', 'importance', 'tags', 'related', 'thread', 'privacy',
] as const

function yamlValue(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return JSON.stringify(value)
  if (typeof value === 'number') return String(value)
  return JSON.stringify(String(value))
}

/** 序列化条目（frontmatter + 空行 + 正文）。 */
export function serializeEntry(entry: VaultEntry): string {
  const lines: string[] = ['---']
  for (const key of FRONTMATTER_KEYS) lines.push(`${key}: ${yamlValue((entry as unknown as Record<string, unknown>)[key])}`)
  lines.push('---', '', entry.body.trim(), '')
  return lines.join('\n')
}

function parseYamlValue(raw: string): unknown {
  const text = raw.trim()
  if (text === 'null' || text === '') return null
  if (text.startsWith('[') || text.startsWith('{') || text.startsWith('"')) {
    try { return JSON.parse(text) } catch { return text }
  }
  if (/^-?\d+$/u.test(text)) return Number(text)
  return text
}

/** 解析条目文件；返回 entry + 正文起始行号（1-based）。 */
export function parseEntry(text: string): { entry: VaultEntry; bodyLine: number } {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') throw new VaultError('bad_entry_file', '条目缺少 frontmatter（应为 --- 开头）', 500)
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') { end = i; break }
  }
  if (end < 0) throw new VaultError('bad_entry_file', '条目 frontmatter 未闭合', 500)
  const meta: Record<string, unknown> = {}
  for (const line of lines.slice(1, end)) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    meta[key] = parseYamlValue(line.slice(idx + 1))
  }
  const body = lines.slice(end + 1).join('\n').replace(/^\n+/u, '').trim()
  const entry: VaultEntry = {
    id: String(meta['id'] ?? ''),
    domain: String(meta['domain'] ?? '') as MemoryDomain,
    kind: String(meta['kind'] ?? 'about-user') as VaultEntry['kind'],
    title: String(meta['title'] ?? ''),
    event_time: String(meta['event_time'] ?? ''),
    event_raw: String(meta['event_raw'] ?? ''),
    record_time: String(meta['record_time'] ?? ''),
    last_verified: String(meta['last_verified'] ?? ''),
    valid_until: meta['valid_until'] === null || meta['valid_until'] === undefined ? null : String(meta['valid_until']),
    superseded_by: meta['superseded_by'] === null || meta['superseded_by'] === undefined ? null : String(meta['superseded_by']),
    supersedes: Array.isArray(meta['supersedes']) ? (meta['supersedes'] as unknown[]).map(String) : [],
    source: String(meta['source'] ?? 'chat') as VaultEntry['source'],
    source_ref: String(meta['source_ref'] ?? ''),
    provenance: String(meta['provenance'] ?? 'observed') as VaultEntry['provenance'],
    volatility: String(meta['volatility'] ?? 'stable') as VaultEntry['volatility'],
    importance: Number(meta['importance'] ?? 3),
    tags: Array.isArray(meta['tags']) ? (meta['tags'] as unknown[]).map(String) : [],
    related: Array.isArray(meta['related']) ? (meta['related'] as unknown[]).map(String) : [],
    thread: String(meta['thread'] ?? ''),
    privacy: String(meta['privacy'] ?? 'none') as VaultEntry['privacy'],
    body,
  }
  if (entry.id === '' || !(MEMORY_DOMAINS as readonly string[]).includes(entry.domain)) {
    throw new VaultError('bad_entry_file', '条目 frontmatter 缺少 id/domain', 500)
  }
  return { entry, bodyLine: end + 3 }
}

/** 原子写：同目录 tmp + rename。 */
export function atomicWrite(file: string, content: string): void {
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  writeFileSync(tmp, content)
  renameSync(tmp, file)
}

/** 条目文件路径（domain/id.md）。 */
export function entryFile(paths: VaultPaths, domain: string, id: string): string {
  const safeDomain = safeSegment(domain, 'domain')
  const safeId = safeSegment(id, 'entryId')
  const dir = join(paths.domainsDir, safeDomain)
  const file = join(dir, `${safeId}.md`)
  assertInside(paths.domainsDir, file)
  return file
}

export interface WriteEntryResult {
  created: boolean
  duplicate: boolean
  file: string
  entry: VaultEntry
}

/** 写条目：同 id 同内容幂等；同 id 不同内容拒绝（走 supersede）。 */
export function writeEntryFile(paths: VaultPaths, entry: VaultEntry): WriteEntryResult {
  ensureVault(paths)
  const file = entryFile(paths, entry.domain, entry.id)
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf8')
    const parsed = parseEntry(existing)
    if (normalizeContent(parsed.entry) === normalizeContent(entry)) {
      return { created: false, duplicate: true, file, entry: parsed.entry }
    }
    throw new VaultError(
      'entry_conflict',
      `条目 ${entry.id} 已存在且内容不同：append-only 不允许覆盖（用 supersede 标记旧条目）`,
      409,
    )
  }
  atomicWrite(file, serializeEntry(entry))
  return { created: true, duplicate: false, file, entry }
}

function normalizeContent(entry: VaultEntry): string {
  const { record_time: _r, last_verified: _v, ...rest } = entry
  return JSON.stringify(rest)
}

/** 读条目。 */
export function readEntryFile(paths: VaultPaths, domain: string, id: string): { entry: VaultEntry; bodyLine: number } | null {
  const file = entryFile(paths, domain, id)
  if (!existsSync(file)) return null
  return parseEntry(readFileSync(file, 'utf8'))
}

/** 列某域条目（按 record_time 倒序）。 */
export function listDomainEntries(paths: VaultPaths, domain: string): VaultEntry[] {
  const dir = join(paths.domainsDir, safeSegment(domain, 'domain'))
  if (!existsSync(dir)) return []
  const out: VaultEntry[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md') || name === 'README.md') continue
    try {
      out.push(parseEntry(readFileSync(join(dir, name), 'utf8')).entry)
    } catch {
      // 损坏文件跳过（不阻塞列表）
    }
  }
  return out.sort((a, b) => b.record_time.localeCompare(a.record_time))
}

/** 列全部条目（含 relPath）。 */
export function listAllEntries(paths: VaultPaths): Array<{ entry: VaultEntry; relPath: string }> {
  const out: Array<{ entry: VaultEntry; relPath: string }> = []
  for (const domain of MEMORY_DOMAINS) {
    const dir = join(paths.domainsDir, domain)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.md') || name === 'README.md') continue
      try {
        const entry = parseEntry(readFileSync(join(dir, name), 'utf8')).entry
        out.push({ entry, relPath: relative(paths.contactDir, join(dir, name)) })
      } catch {
        // ignore
      }
    }
  }
  return out
}

/** 更新条目的生命周期字段（supersede / 失效 / 人工编辑）——只允许字段级变更，不改 id/domain。 */
export function rewriteEntryFile(paths: VaultPaths, entry: VaultEntry): void {
  const file = entryFile(paths, entry.domain, entry.id)
  atomicWrite(file, serializeEntry(entry))
}

/** 写墓碑：_history/<id>.md（保留曾经是真的摘要）。 */
export function writeTombstone(paths: VaultPaths, entry: VaultEntry, reason: string, supersededBy?: string): string {
  ensureVault(paths)
  const file = join(paths.historyDir, `${safeSegment(entry.id, 'entryId')}.md`)
  assertInside(paths.historyDir, file)
  const content = [
    `# 墓碑：${entry.title}`,
    '',
    `- 原条目：${entry.domain}/${entry.id}.md`,
    `- 发生时间：${entry.event_time}`,
    `- 记录时间：${entry.record_time}`,
    `- 归档原因：${reason}`,
    ...(supersededBy !== undefined && supersededBy !== '' ? [`- 被取代为：${supersededBy}`] : []),
    '',
    '## 原正文（摘要保留）',
    '',
    entry.body.trim().slice(0, 2000),
    '',
  ].join('\n')
  atomicWrite(file, content)
  return file
}

// ---- 暂存区 ----

export interface StagingRecord {
  id: string
  content: string
  source_ref: string
  status: string
  created_at: string
}

/** 写一条暂存（聊天中轻量调用）。 */
export function writeStaging(paths: VaultPaths, content: string, sourceRef: string, now: () => Date = () => new Date()): StagingRecord {
  ensureVault(paths)
  const id = `stg-${now().getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const record: StagingRecord = { id, content: content.trim().slice(0, 8000), source_ref: sourceRef.slice(0, 300), status: 'pending', created_at: now().toISOString() }
  const file = join(paths.stagingDir, `${safeSegment(id, 'stagingId')}.json`)
  assertInside(paths.stagingDir, file)
  atomicWrite(file, `${JSON.stringify(record, null, 2)}\n`)
  return record
}

/** 列暂存。 */
export function listStaging(paths: VaultPaths): StagingRecord[] {
  if (!existsSync(paths.stagingDir)) return []
  const out: StagingRecord[] = []
  for (const name of readdirSync(paths.stagingDir)) {
    if (!name.endsWith('.json')) continue
    try {
      out.push(JSON.parse(readFileSync(join(paths.stagingDir, name), 'utf8')) as StagingRecord)
    } catch {
      // ignore
    }
  }
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at))
}

/** 删除已处理暂存（整理成功后）。 */
export function clearStaging(paths: VaultPaths, ids: string[]): void {
  for (const id of ids) {
    const file = join(paths.stagingDir, `${safeSegment(id, 'stagingId')}.json`)
    try {
      assertInside(paths.stagingDir, file)
      rmSync(file, { force: true })
    } catch {
      // ignore
    }
  }
}

// ---- PROFILE / RULES（自动区 + 人工区保护）----

/** 读取文件文本（不存在返回 ''）。 */
export function readTextFile(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

/** 用自动区内容替换文件中的自动区，保留区间外人工内容。 */
export function replaceAutoRegion(existing: string, auto: string, beginMarker: string, endMarker: string): string {
  const begin = existing.indexOf(beginMarker)
  const end = existing.indexOf(endMarker)
  if (begin >= 0 && end > begin) {
    return `${existing.slice(0, begin)}${beginMarker}\n${auto.trim()}\n${endMarker}${existing.slice(end + endMarker.length)}`
  }
  const head = existing.trim() === '' ? '' : `${existing.trimEnd()}\n\n`
  return `${head}${beginMarker}\n${auto.trim()}\n${endMarker}\n`
}

/** 写 PROFILE.md（自动区替换；区间外保留）。 */
export function writeProfile(paths: VaultPaths, autoContent: string): void {
  const existing = readTextFile(paths.profileFile)
  atomicWrite(paths.profileFile, replaceAutoRegion(existing, autoContent, AUTO_BEGIN, AUTO_END))
}

/** 写 RULES.md（自动区替换；区间外保留）。 */
export function writeRules(paths: VaultPaths, autoContent: string): void {
  const existing = readTextFile(paths.rulesFile)
  atomicWrite(paths.rulesFile, replaceAutoRegion(existing, autoContent, RULES_BEGIN, RULES_END))
}

/** 追加 jsonl（dream-log）。 */
export function appendJsonl(file: string, value: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true })
  appendFileSync(file, `${JSON.stringify(value)}\n`)
}

/** 文件大小（不存在 0）。 */
export function fileSize(file: string): number {
  try { return statSync(file).size } catch { return 0 }
}

/** 追加文件行数（用于测试）。 */
export function countStagingFiles(paths: VaultPaths): number {
  try { return readdirSync(paths.stagingDir).filter((n) => n.endsWith('.json')).length } catch { return 0 }
}
