/**
 * MemoryVault 服务门面：vault 读写 + 派生索引 + 检索 + 暂存/Dream + 迁移。
 *
 * 真相在 `LITTLY_DATA_DIR/memory/<bot>/<contact>/`（Markdown）；SQLite 只是派生索引（可重建）。
 * console-api 的 routes-memory-vault 与 AI 工具 memory_* 都走这里。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { LittlyStorage } from '@littly/storage'
import { embedTexts } from '@littly/llm'
import { chatComplete } from '@littly/llm'
import {
  defaultVaultRoot, ensureVault, entryFile, listAllEntries, listStaging, readEntryFile,
  readTextFile, rewriteEntryFile, vaultPaths, writeEntryFile, writeStaging, writeTombstone, type VaultPaths,
} from './store.ts'
import { VaultIndex } from './index-db.ts'
import { buildProfileMarkdown, dreamDue, refreshProfileFiles, runDream, type DreamReport } from './dream.ts'
import { timeLabelsFor, relativeLabel } from './time.ts'
import { MEMORY_DOMAINS, VaultError, normalizeWriteInput, type MemoryDomain, type VaultEntry, type VaultWriteInput } from './types.ts'

const DOMAIN_DESC: Record<string, string> = {
  'about-user': '关于 TA 的稳定事实（生日/城市/工作/家庭等）',
  interests: 'TA 的兴趣爱好与偏好',
  projects: 'TA 在做的事/项目/学业（含进展）',
  life: '日常生活、作息、状态与事件',
  relationships: 'TA 与身边人的关系、与你的关系进展',
  feedback: 'TA 明确表达过的相处偏好/雷点（规则域）',
  notes: '你的推断与观察（非事实，读取时需标注推断）',
  health: '健康、情绪与身体状态（敏感）',
  history: '墓碑归档（失效/被取代条目的摘要）',
}

const DOMAIN_LABELS: Record<string, string> = {
  'about-user': '关于 TA', interests: '兴趣', projects: '在做的事', life: '日常',
  relationships: '关系', feedback: '相处规则', notes: '推断', health: '健康', history: '墓碑',
}

export type VaultScope = { botId: string; contactId: string }

export interface MemoryVaultOptions {
  rootDir?: string
  now?: () => Date
  /** 注入 fake embedding（测试用）；缺省用 @littly/llm embedTexts。 */
  embed?: ((texts: string[]) => Promise<number[][] | null>) | null
  /** 注入 fake LLM（测试用）；缺省用 @littly/llm chatComplete（growth 模型）。 */
  complete?: ((prompt: string) => Promise<string>) | null
  log?: (msg: string, ...args: unknown[]) => void
}

export interface EntryView extends VaultEntry {
  eventLabel: string
  recordedLabel: string
  state: 'active' | 'superseded' | 'expired' | 'archived'
  isInference: boolean
}

/** 记忆 vault 门面。 */
export class MemoryVault {
  readonly rootDir: string
  private readonly storage: LittlyStorage
  private readonly options: MemoryVaultOptions
  private readonly now: () => Date
  private readonly indexCache = new Map<string, VaultIndex>()
  private running = false

  constructor(storage: LittlyStorage, options: MemoryVaultOptions = {}) {
    this.storage = storage
    this.options = options
    this.rootDir = (options.rootDir ?? '').trim() || defaultVaultRoot()
    this.now = options.now ?? (() => new Date())
  }

  /** 某个 bot×contact 的路径（含路径安全校验）。 */
  paths(botId: string, contactId: string): VaultPaths {
    if (String(botId ?? '').trim() === '') throw new VaultError('bad_scope', 'botId 不能为空')
    if (String(contactId ?? '').trim() === '') throw new VaultError('bad_scope', 'contactId 不能为空')
    return vaultPaths(this.rootDir, botId, contactId)
  }

  private ensure(botId: string, contactId: string): VaultPaths {
    const paths = this.paths(botId, contactId)
    ensureVault(paths)
    return paths
  }

  /** 全局索引（root/index.sqlite）。 */
  index(): VaultIndex {
    const file = join(this.rootDir, 'index.sqlite')
    let index = this.indexCache.get(file)
    if (index === undefined) {
      index = new VaultIndex(file)
      this.indexCache.set(file, index)
    }
    return index
  }

  /** 确保 scope 已建索引（首次/索引为空时从文件重建）。 */
  ensureIndex(scope: VaultScope): VaultIndex {
    const index = this.index()
    const rows = index.listIndexRows(scope)
    if (rows.length === 0) {
      const items = listAllEntries(this.paths(scope.botId, scope.contactId))
      if (items.length > 0) {
        index.rebuildScope(scope.botId, scope.contactId, items.map(({ entry, relPath }) => ({ entry, relPath, lineNo: 1 })), this.now())
      }
    }
    return index
  }

  /** 重新扫描文件重建该 scope 的索引（返回 source_digest/build_id）。 */
  rebuildIndex(scope: VaultScope): { count: number; sourceDigest: string; buildId: string } {
    const index = this.index()
    const items = listAllEntries(this.paths(scope.botId, scope.contactId))
    const result = index.rebuildScope(scope.botId, scope.contactId, items.map(({ entry, relPath }) => ({ entry, relPath, lineNo: 1 })), this.now())
    return { count: result.count, sourceDigest: result.sourceDigest, buildId: result.buildId }
  }

  /** 读取档案（不存在则生成一版）。 */
  profile(scope: VaultScope, options: { rebuild?: boolean } = {}): { markdown: string; updatedAt: string; truncated: boolean; chars: number; entryCount: number; path: string } {
    const paths = this.ensure(scope.botId, scope.contactId)
    const index = this.ensureIndex(scope)
    if (options.rebuild === true || !existsSync(paths.profileFile)) {
      refreshProfileFiles(paths, index, this.now(), scope)
    }
    const markdown = readTextFile(paths.profileFile)
    const profile = buildProfileMarkdown(paths, index, this.now(), 2000, scope)
    return {
      markdown,
      updatedAt: index.getMeta('last_index_at'),
      truncated: profile.truncated,
      chars: profile.chars,
      entryCount: profile.entryCount,
      path: paths.profileFile,
    }
  }

  /** 相处规则（RULES.md；不存在则生成一版）。 */
  rules(scope: VaultScope): { markdown: string; updatedAt: string; entries: Array<{ entryId: string; title: string; timeLabel: string }> } {
    const paths = this.ensure(scope.botId, scope.contactId)
    const index = this.ensureIndex(scope)
    if (!existsSync(paths.rulesFile)) refreshProfileFiles(paths, index, this.now(), scope)
    const rules = index.entriesWithLabels(scope, { domain: 'feedback', limit: 100 }, this.now()).filter((r) => r.state === 'active')
    return {
      markdown: readTextFile(paths.rulesFile),
      updatedAt: index.getMeta('last_index_at'),
      entries: rules.map((r) => ({ entryId: r.entryId, title: r.title, timeLabel: r.eventLabel })),
    }
  }

  /** 9 域地图（含条目数与最近更新自然语言）。 */
  domains(scope: VaultScope): Array<{ domain: MemoryDomain; label: string; description: string; count: number; activeCount: number; latestEventTime: string; latestLabel: string; readme: string; latest: Array<{ entryId: string; title: string; timeLabel: string }> }> {
    const paths = this.ensure(scope.botId, scope.contactId)
    const index = this.ensureIndex(scope)
    const all = index.entriesWithLabels(scope, { limit: 500 }, this.now())
    return index.domainStats(scope, this.now(), DOMAIN_DESC).map((stat) => {
      const inDomain = all.filter((r) => r.domain === stat.domain && r.state === 'active')
      return {
        ...stat,
        label: DOMAIN_LABELS[stat.domain] ?? stat.domain,
        readme: readTextFile(join(paths.domainsDir, stat.domain, 'README.md')).split('\n').slice(2).join(' ').trim(),
        latest: inDomain.slice(0, 3).map((r) => ({ entryId: r.entryId, title: r.title, timeLabel: r.eventLabel })),
      }
    })
  }

  /** 条目列表（含自然语言时间标签与状态）。 */
  entries(scope: VaultScope, filter: { domain?: string | undefined; limit?: number | undefined; offset?: number | undefined } = {}): Array<ReturnType<VaultIndex['entriesWithLabels']>[number] & { isInference: boolean }> {
    const index = this.ensureIndex(scope)
    if (filter.domain !== undefined && !(MEMORY_DOMAINS as readonly string[]).includes(filter.domain)) {
      throw new VaultError('bad_domain', `domain 不合法：${filter.domain}`)
    }
    const rows = index.entriesWithLabels(scope, filter, this.now())
    return rows.map((row) => ({ ...row, isInference: row.kind === 'agent-note' || row.provenance === 'inferred' }))
  }

  /** 条目详情（正文/时间/取代链/来源/墓碑全文）。 */
  getEntry(scope: VaultScope, entryId: string): EntryView & { supersededChain: string[]; tombstone: string; path: string } {
    const paths = this.ensure(scope.botId, scope.contactId)
    const index = this.ensureIndex(scope)
    const row = index.listIndexRows(scope).find((r) => r.entryId === entryId)
    if (row === undefined) throw new VaultError('entry_not_found', `条目不存在：${entryId}`, 404)
    const found = readEntryFile(paths, row.domain, entryId)
    if (found === null) throw new VaultError('entry_not_found', `条目文件不存在：${entryId}`, 404)
    const labels = timeLabelsFor(found.entry, this.now())
    const chain: string[] = []
    let cursor: string | null = found.entry.superseded_by
    const seen = new Set<string>()
    while (cursor !== null && cursor !== '' && !seen.has(cursor)) {
      seen.add(cursor)
      chain.push(cursor)
      const next = index.listIndexRows(scope).find((r) => r.entryId === cursor)
      cursor = next?.supersededBy ?? null
    }
    const tombFile = join(paths.historyDir, `${entryId}.md`)
    const tombstone = existsSync(tombFile) ? readTextFile(tombFile) : ''
    const expired = found.entry.valid_until !== null && Date.parse(found.entry.valid_until) <= this.now().getTime()
    return {
      ...found.entry,
      eventLabel: labels.eventLabel,
      recordedLabel: labels.recordedLabel,
      state: found.entry.superseded_by !== null ? 'superseded' : expired ? 'expired' : found.entry.domain === 'history' ? 'archived' : 'active',
      isInference: found.entry.kind === 'agent-note' || found.entry.provenance === 'inferred',
      supersededChain: chain,
      tombstone,
      path: entryFile(paths, found.entry.domain, entryId),
    }
  }

  /** 写入条目（id 冲突不同内容 → 409；supersedes → 旧条目失效 + 墓碑）。 */
  write(scope: VaultScope, input: VaultWriteInput): { entry: VaultEntry; created: boolean; duplicate: boolean; path: string; superseded: string[] } {
    const paths = this.ensure(scope.botId, scope.contactId)
    const entry = normalizeWriteInput(input, this.now)
    const written = writeEntryFile(paths, entry)
    const superseded: string[] = []
    for (const oldId of entry.supersedes) {
      const rows = this.index().listIndexRows(scope)
      const oldRow = rows.find((r) => r.entryId === oldId)
      const oldFile = oldRow === undefined ? null : readEntryFile(paths, oldRow.domain, oldId)
      if (oldFile === null || oldFile.entry.superseded_by !== null) continue
      rewriteEntryFile(paths, { ...oldFile.entry, superseded_by: entry.id, valid_until: entry.event_time })
      writeTombstone(paths, oldFile.entry, '被新条目取代', entry.id)
      superseded.push(oldId)
    }
    this.rebuildIndex(scope)
    return { entry: written.entry, created: written.created, duplicate: written.duplicate, path: entryFile(paths, entry.domain, entry.id), superseded }
  }

  /** 人工编辑正文/标签/重要度（生命周期字段不动；写审计条目）。 */
  update(scope: VaultScope, entryId: string, patch: { title?: string; body?: string; tags?: string[]; importance?: number; related?: string[]; thread?: string }): VaultEntry {
    const paths = this.ensure(scope.botId, scope.contactId)
    const rows = this.index().listIndexRows(scope)
    const row = rows.find((r) => r.entryId === entryId)
    if (row === undefined) throw new VaultError('entry_not_found', `条目不存在：${entryId}`, 404)
    const found = readEntryFile(paths, row.domain, entryId)
    if (found === null) throw new VaultError('entry_not_found', `条目文件不存在：${entryId}`, 404)
    const next: VaultEntry = {
      ...found.entry,
      ...(patch.title !== undefined ? { title: String(patch.title).slice(0, 200) } : {}),
      ...(patch.body !== undefined ? { body: String(patch.body).slice(0, 20_000) } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags.slice(0, 20) } : {}),
      ...(patch.importance !== undefined ? { importance: Math.min(5, Math.max(1, Math.round(patch.importance))) } : {}),
      ...(patch.related !== undefined ? { related: patch.related.slice(0, 50) } : {}),
      ...(patch.thread !== undefined ? { thread: String(patch.thread).slice(0, 120) } : {}),
      last_verified: this.now().toISOString().slice(0, 10),
    }
    rewriteEntryFile(paths, next)
    this.rebuildIndex(scope)
    this.storage.prepare("INSERT INTO audit_logs (id, bot_id, category, action, detail, created_at) VALUES (?,?,?,?,?,?)")
      .run(randomUUID(), scope.botId, 'tool_call', 'memory_edit', JSON.stringify({ entryId, fields: Object.keys(patch) }), this.now().toISOString())
    return next
  }

  /** 跨域检索（FTS + 向量 RRF）。 */
  async search(scope: VaultScope, query: string, options: { domain?: string | undefined; limit?: number | undefined; minScore?: number | undefined } = {}): Promise<Array<Record<string, unknown>>> {
    const index = this.ensureIndex(scope)
    const q = String(query ?? '').trim()
    if (q === '') throw new VaultError('bad_request', 'query 不能为空')
    let embedding: number[] | undefined
    try {
      const vectors = await this.embed([q])
      if (vectors !== null && vectors[0] !== undefined) embedding = vectors[0]
    } catch {
      // 向量不可用时退化为纯 FTS
    }
    const hits = index.search(scope, q, {
      ...(options.domain !== undefined ? { domain: options.domain } : {}),
      limit: options.limit ?? 10,
      ...(embedding !== undefined ? { embedding } : {}),
      ...(options.minScore !== undefined ? { minScore: options.minScore } : {}),
    }, this.now())
    return hits as unknown as Array<Record<string, unknown>>
  }

  /** 暂存（聊天中轻量调用）：写 _staging + 镜像索引；达到阈值自动触发后台整理。 */
  stage(scope: VaultScope, content: string, sourceRef: string = ''): { staging: { id: string; created_at: string }; due: boolean; stagingCount: number } {
    const paths = this.ensure(scope.botId, scope.contactId)
    const text = String(content ?? '').trim()
    if (text === '') throw new VaultError('bad_request', '暂存内容不能为空')
    const record = writeStaging(paths, text, sourceRef, this.now)
    const index = this.index()
    const records = listStaging(paths)
    index.syncStaging(scope.botId, scope.contactId, records)
    const lastAt = index.lastDreamAt(scope.botId, scope.contactId)
    const due = dreamDue(records.filter((r) => r.status === 'pending').length, lastAt, this.now())
    if (due && !this.running) {
      // 后台触发（不阻塞聊天）；失败只记录日志，staging 保留
      void this.consolidate(scope, { reason: 'threshold' }).catch((error: unknown) => {
        this.options.log?.('[memory-vault] 自动 Dream 失败: %s', String(error))
      })
    }
    return { staging: { id: record.id, created_at: record.created_at }, due, stagingCount: records.length }
  }

  /** 暂存列表（镜像表，与文件同步）。 */
  staging(scope: VaultScope): Array<{ id: string; content: string; source_ref: string; status: string; created_at: string }> {
    const paths = this.ensure(scope.botId, scope.contactId)
    const records = listStaging(paths)
    this.index().syncStaging(scope.botId, scope.contactId, records)
    return records
  }

  /** 标记失效/遗忘：不物理删除，写墓碑。 */
  forget(scope: VaultScope, entryId: string, reason: string = '用户要求遗忘', validUntil?: string): { ok: boolean; tombstone: string; entry: VaultEntry } {
    const paths = this.ensure(scope.botId, scope.contactId)
    const rows = this.index().listIndexRows(scope)
    const row = rows.find((r) => r.entryId === entryId)
    if (row === undefined) throw new VaultError('entry_not_found', `条目不存在：${entryId}`, 404)
    const found = readEntryFile(paths, row.domain, entryId)
    if (found === null) throw new VaultError('entry_not_found', `条目文件不存在：${entryId}`, 404)
    const nowIso = this.now().toISOString()
    const until = validUntil !== undefined && validUntil.trim() !== '' ? validUntil.trim() : nowIso
    const updated: VaultEntry = { ...found.entry, valid_until: until, superseded_by: found.entry.superseded_by ?? 'forgotten' }
    rewriteEntryFile(paths, updated)
    const tomb = writeTombstone(paths, found.entry, reason)
    this.rebuildIndex(scope)
    return { ok: true, tombstone: tomb, entry: updated }
  }

  /** Dream 状态（上次/下次/进行中/暂存数/最近报告）。 */
  dreamStatus(scope: VaultScope): Record<string, unknown> {
    const paths = this.ensure(scope.botId, scope.contactId)
    const index = this.index()
    const records = listStaging(paths)
    const lastAt = index.lastDreamAt(scope.botId, scope.contactId)
    const due = dreamDue(records.filter((r) => r.status === 'pending').length, lastAt, this.now())
    const reports = index.listDreamReports(scope.botId, scope.contactId, 5)
    const last = reports[0]
    return {
      stagingCount: records.length,
      lastDreamAt: lastAt,
      lastDreamLabel: lastAt === '' ? '' : relativeLabel(lastAt, this.now(), { recorded: true }),
      nextDueAt: due ? this.now().toISOString() : '',
      running: this.running,
      due,
      reports,
      domain: 'dream',
      // fe-core 契约字段
      lastRunAt: lastAt,
      nextRunAt: due ? this.now().toISOString() : '',
      lastReport: last === undefined ? undefined : {
        added: last.added, merged: last.merged, invalidated: last.superseded, archived: last.archived,
        tokens: last.tokens, durationMs: last.duration_ms, status: last.status,
      },
      lastError: last?.status === 'error' ? last.error : undefined,
    }
  }

  /** 手动/定时整理。 */
  async consolidate(scope: VaultScope, options: { reason: 'threshold' | 'daily' | 'manual' } = { reason: 'manual' }): Promise<DreamReport> {
    if (this.running) {
      return {
        id: 'running', botId: scope.botId, contactId: scope.contactId, at: this.now().toISOString(),
        added: 0, merged: 0, superseded: 0, archived: 0, durationMs: 0, tokens: 0,
        status: 'locked', error: '已有整理在进行中', profileChars: 0, profileTruncated: false,
      }
    }
    this.running = true
    try {
      const paths = this.ensure(scope.botId, scope.contactId)
      const index = this.ensureIndex(scope)
      const report = await runDream({
        paths,
        index,
        llm: { complete: (prompt) => this.complete(prompt) },
        embed: async (texts) => (await this.embed(texts)) ?? [],
        now: this.now,
        log: this.options.log ?? (() => {}),
      }, { reason: options.reason })
      return report
    } finally {
      this.running = false
    }
  }

  /** 定时触发：对所有有 staging 的 vault 检查阈值/每日 03:00。 */
  async consolidateDue(kind: 'threshold' | 'daily', now: Date = this.now()): Promise<DreamReport[]> {
    if (kind === 'daily' && now.getHours() !== 3) return []
    const scopes = this.listScopes()
    const reports: DreamReport[] = []
    for (const scope of scopes) {
      const paths = this.ensure(scope.botId, scope.contactId)
      const records = listStaging(paths).filter((r) => r.status === 'pending')
      if (records.length === 0) continue
      const lastAt = this.index().lastDreamAt(scope.botId, scope.contactId)
      if (kind === 'threshold' && !dreamDue(records.length, lastAt, now)) continue
      if (kind === 'daily' && records.length < 3) continue
      reports.push(await this.consolidate(scope, { reason: kind }))
    }
    return reports
  }

  /** 列出磁盘上已有 vault 的 (botId, contactId)。 */
  listScopes(): VaultScope[] {
    const out: VaultScope[] = []
    try {
      for (const bot of readdirSync(this.rootDir, { withFileTypes: true })) {
        if (!bot.isDirectory() || bot.name === 'index.sqlite') continue
        const botDir = join(this.rootDir, bot.name)
        for (const contact of readdirSync(botDir, { withFileTypes: true })) {
          if (contact.isDirectory() && !contact.name.startsWith('.')) out.push({ botId: bot.name, contactId: contact.name })
        }
      }
    } catch {
      return []
    }
    return out
  }

  /** 旧 memories 表 → vault 迁移（幂等；旧表保留只读）。 */
  migrate(options: { botId?: string } = {}): { migrated: number; skipped: number; scopes: number } {
    const rows = (options.botId === undefined || options.botId === ''
      ? this.storage.prepare('SELECT * FROM memories ORDER BY created_at ASC').all()
      : this.storage.prepare('SELECT * FROM memories WHERE bot_id = ? ORDER BY created_at ASC').all(options.botId)) as Array<Record<string, unknown>>
    const domainMap: Record<string, string> = {
      profile: 'about-user', relationship: 'relationships', fact: 'about-user', detail: 'life', value: 'feedback', thought: 'notes',
    }
    let migrated = 0
    let skipped = 0
    const scopes = new Set<string>()
    for (const row of rows) {
      const botId = String(row['bot_id'] ?? '')
      // scope 一律用 contacts.sender（前端/API contactId 契约）；旧 memories.contact_id 是 contacts.id，
      // 只作为旧行元数据保留，绝不参与 vault 目录（否则同一真人会被拆成两个文件夹）。
      const sender = String(row['sender'] ?? '')
      const legacyContactId = String(row['contact_id'] ?? '')
      const contactId = sender
      if (botId === '' || contactId === '') { skipped++; continue }
      const category = String(row['category'] ?? 'fact')
      const domain = domainMap[category] ?? 'notes'
      const id = String(row['id'] ?? '')
      if (id === '') { skipped++; continue }
      const paths = this.ensure(botId, contactId)
      const file = join(paths.domainsDir, domain, `${id}.md`)
      if (existsSync(file)) { skipped++; continue }
      const tags = (() => { try { const parsed = JSON.parse(String(row['tags'] ?? '[]')) as unknown; return Array.isArray(parsed) ? parsed.map(String) : [] } catch { return [] } })()
      // 旧表语义 → 新域语义（notes=推断/feedback=规则；旧 thought 的 user-stated 不可直接沿用为事实）
      const kind = domain === 'notes' ? 'agent-note' : domain === 'feedback' ? 'rule' : 'about-user'
      const provenance = domain === 'notes'
        ? 'inferred'
        : domain === 'feedback'
          ? 'user-stated'
          : ['user-stated', 'observed', 'inferred'].includes(String(row['provenance'] ?? '')) ? String(row['provenance']) : 'observed'
      const input: VaultWriteInput = {
        id,
        domain,
        kind,
        title: String(row['content'] ?? '').slice(0, 60) || `${domain} 记忆`,
        body: String(row['content'] ?? ''),
        ...(String(row['event_time'] ?? '') !== '' ? { event_time: String(row['event_time']) } : {}),
        ...(String(row['event_time_raw'] ?? '') !== '' ? { event_raw: String(row['event_time_raw']) } : {}),
        ...(String(row['recorded_at'] ?? '') !== '' ? { record_time: String(row['recorded_at']) } : {}),
        ...(String(row['valid_until'] ?? '') !== '' ? { valid_until: String(row['valid_until']) } : {}),
        ...(row['importance'] !== undefined ? { importance: Number(row['importance']) || 3 } : {}),
        provenance,
        ...(row['volatility'] !== undefined ? { volatility: String(row['volatility']) } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        source: 'migration',
        source_ref: legacyContactId !== '' && legacyContactId !== sender
          ? `memory:${id};legacy_contact_id:${legacyContactId}`
          : `memory:${id}`,
      }
      try {
        writeEntryFile(paths, normalizeWriteInput(input, this.now))
        migrated++
        scopes.add(`${botId}\u0000${contactId}`)
      } catch (error) {
        this.options.log?.('[memory-vault] 迁移条目失败（跳过）: %s', String(error))
        skipped++
      }
    }
    for (const key of scopes) {
      const [botId, contactId] = key.split('\u0000')
      if (botId === undefined || contactId === undefined) continue
      const scope = { botId, contactId }
      this.rebuildIndex(scope)
      refreshProfileFiles(this.paths(botId, contactId), this.index(), this.now(), scope)
    }
    return { migrated, skipped, scopes: scopes.size }
  }

  /** 默认 embedding：@littly/llm embedTexts（配置缺失时返回 null）。 */
  private async embed(texts: string[]): Promise<number[][] | null> {
    if (this.options.embed !== undefined && this.options.embed !== null) return this.options.embed(texts)
    try {
      const result = await embedTexts(this.storage, texts)
      return Array.isArray(result) ? result : null
    } catch {
      return null
    }
  }

  /** 默认 LLM：growth 模型（缺配置时抛可读错误）。 */
  private async complete(prompt: string): Promise<string> {
    if (this.options.complete !== undefined && this.options.complete !== null) return this.options.complete(prompt)
    const result = await chatComplete(this.storage, [{ role: 'user', content: prompt }], { temperature: 0.2, maxTokens: 4000 })
    return result.content
  }
}
