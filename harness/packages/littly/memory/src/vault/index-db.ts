/**
 * Vault 派生索引（SQLite，与 Markdown 真相分离、可重建）。
 *
 * 表（见 /tmp/memory-system-spec.md §3）：
 * - entries：条目元数据 + path + line_no + sha256
 * - entry_fts：FTS5 trigram（title + 正文）
 * - entry_vec：向量（BLOB float32）+ 模型名 + 该向量对应的条目内容 sha256
 * - time_labels：自然语言时间标签缓存（按「现在」重算）
 * - staging：暂存区镜像（文件仍以 vault/_staging 为准，这里便于统计/控制台）
 * - meta：schema_version / indexer_version / source_digest / build_id
 * - dream_reports：整理报告
 *
 * 检索：FTS(bm25) + 向量(cosine) → RRF(k=60) 融合 → 加权排序（见 rank.ts）；结果可定位 path+line。
 *
 * 一致性要点：向量只在 Dream 里写，所以重建索引时必须按 entry_id + 内容 sha256 保留「内容没变」的向量，
 * 否则一次 memory_write 就会把该 scope 的向量全部清掉，搜索静默退化为纯 FTS。
 */
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { relativeLabel, timeLabelsFor } from './time.ts'
import { importanceWeight, normalizeRelevance, rankScore, recencyWeight } from './rank.ts'
import type { MemoryDomain, VaultEntry } from './types.ts'
import { sha256Hex } from './types.ts'

/** v2：entry_vec 增加 sha256（v1 库在 migrate 里原地补列）。 */
export const INDEX_SCHEMA_VERSION = 2
export const INDEXER_VERSION = 1
export const RRF_K = 60

/** 条目内容指纹（title+body 决定向量内容；importance/时间等元数据变化不影响向量复用）。 */
export function entryContentSha(entry: Pick<VaultEntry, 'id' | 'title' | 'body'>): string {
  return sha256Hex(`${entry.id}\n${entry.title}\n${entry.body}`)
}

export interface IndexRow {
  entryId: string
  botId: string
  contactId: string
  domain: string
  kind: string
  title: string
  eventTime: string
  recordTime: string
  lastVerified: string
  validUntil: string | null
  supersededBy: string | null
  importance: number
  volatility: string
  provenance: string
  path: string
  sha256: string
  lineNo: number
}

/** 排序分项（调试/控制台 explain 用；不入库、不改变 path+line 定位能力）。 */
export interface SearchScoreBreakdown {
  /** 两路 RRF 原始融合分（Σ 1/(k+rank+1)）。 */
  rrf: number
  /** rrf / 本批最大 rrf（0..1）。 */
  relevance: number
  /** importance/5（0.2..1）。 */
  importance: number
  /** 按 event_time 指数衰减的新鲜度（0..1）。 */
  recency: number
  /** 0.55·relevance + 0.25·importance + 0.20·recency。 */
  final: number
}

export interface SearchHit {
  entryId: string
  domain: string
  path: string
  line: number
  title: string
  timeLabel: string
  /** 最终加权分（0..1，与 minScore 同一口径）。 */
  score: number
  /** 分项（便于调试「为什么这条排前面」）。 */
  scoreBreakdown: SearchScoreBreakdown
  matchedLayer: 'fts' | 'vec' | 'both'
  provenance: string
  validUntil: string | null
  supersededBy: string | null
}

export interface SearchOptions {
  domain?: string | undefined
  limit?: number | undefined
  embedding?: number[] | undefined
  model?: string | undefined
  validOnly?: boolean | undefined
  /** 过滤最终加权分（0..1），不是 RRF 原始分。 */
  minScore?: number | undefined
}

export interface DomainStat {
  domain: MemoryDomain
  count: number
  activeCount: number
  latestEventTime: string
  latestLabel: string
  description: string
}

export interface DreamReportRow {
  id: string
  bot_id: string
  contact_id: string
  at: string
  added: number
  merged: number
  superseded: number
  archived: number
  duration_ms: number
  tokens: number
  status: string
  error: string
}

function encodeVec(vec: number[]): Buffer {
  const arr = new Float32Array(vec)
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
}

function decodeVec(blob: Uint8Array): number[] {
  const buffer = Buffer.from(blob)
  return [...new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4))]
}

function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) { const x = a[i] ?? 0; const y = b[i] ?? 0; dot += x * y; na += x * x; nb += y * y }
  if (na === 0 || nb === 0) return 0
  return dot / Math.sqrt(na * nb)
}

/** 派生索引数据库。 */
export class VaultIndex {
  readonly file: string
  private readonly db: DatabaseSync

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true })
    this.file = file
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        entry_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, contact_id TEXT NOT NULL,
        domain TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
        event_time TEXT NOT NULL, record_time TEXT NOT NULL, last_verified TEXT NOT NULL,
        valid_until TEXT, superseded_by TEXT, importance INTEGER NOT NULL DEFAULT 3,
        volatility TEXT NOT NULL, provenance TEXT NOT NULL, path TEXT NOT NULL,
        sha256 TEXT NOT NULL, line_no INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_entries_scope ON entries(bot_id, contact_id, domain);
      CREATE TABLE IF NOT EXISTS entry_vec (entry_id TEXT PRIMARY KEY, model TEXT NOT NULL, vec BLOB NOT NULL, sha256 TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS time_labels (entry_id TEXT PRIMARY KEY, event_label TEXT NOT NULL, recorded_label TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS staging (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, contact_id TEXT NOT NULL, content TEXT NOT NULL, source_ref TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dream_reports (
        id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, contact_id TEXT NOT NULL, at TEXT NOT NULL,
        added INTEGER NOT NULL DEFAULT 0, merged INTEGER NOT NULL DEFAULT 0, superseded INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL, error TEXT NOT NULL DEFAULT ''
      );
    `)
    try {
      this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS entry_fts USING fts5(entry_id UNINDEXED, title, body, tokenize='trigram')")
    } catch {
      this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS entry_fts USING fts5(entry_id UNINDEXED, title, body, tokenize='unicode61')")
    }
    // v1 → v2：旧库的 entry_vec 没有 sha256 列；补列后旧行 sha 为空串，
    // 重建时回退到 entries.sha256 判断（旧代码每次重建都会清空向量，
    // 所以「还活着的向量」必然对应当时那次索引的条目内容）。
    const vecColumns = this.db.prepare('PRAGMA table_info(entry_vec)').all() as Array<{ name: string }>
    if (!vecColumns.some((column) => column.name === 'sha256')) {
      this.db.exec("ALTER TABLE entry_vec ADD COLUMN sha256 TEXT NOT NULL DEFAULT ''")
    }
    this.setMeta('schema_version', String(INDEX_SCHEMA_VERSION))
    this.setMeta('indexer_version', String(INDEXER_VERSION))
  }

  close(): void { this.db.close() }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  getMeta(key: string): string {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? ''
  }

  /** 清空某个 bot×contact 的派生数据（重建前）。 */
  clearScope(botId: string, contactId: string): void {
    const ids = this.db.prepare('SELECT entry_id FROM entries WHERE bot_id = ? AND contact_id = ?').all(botId, contactId) as Array<{ entry_id: string }>
    for (const { entry_id: id } of ids) this.removeEntry(id)
    this.db.prepare('DELETE FROM entries WHERE bot_id = ? AND contact_id = ?').run(botId, contactId)
    this.db.prepare('DELETE FROM staging WHERE bot_id = ? AND contact_id = ?').run(botId, contactId)
  }

  /** 清空全库（索引重建用）。 */
  clearAll(): void {
    this.db.exec('DELETE FROM entries; DELETE FROM entry_vec; DELETE FROM time_labels; DELETE FROM staging')
  }

  removeEntry(entryId: string): void {
    this.db.prepare('DELETE FROM entry_fts WHERE entry_id = ?').run(entryId)
    this.db.prepare('DELETE FROM entry_vec WHERE entry_id = ?').run(entryId)
    this.db.prepare('DELETE FROM time_labels WHERE entry_id = ?').run(entryId)
    this.db.prepare('DELETE FROM entries WHERE entry_id = ?').run(entryId)
  }

  /** 写入/更新一条索引（含 FTS；向量单独 setVector）。 */
  upsertEntry(botId: string, contactId: string, entry: VaultEntry, relPath: string, lineNo: number): void {
    const sha = entryContentSha(entry)
    this.db.prepare(`INSERT INTO entries (entry_id, bot_id, contact_id, domain, kind, title, event_time, record_time, last_verified, valid_until, superseded_by, importance, volatility, provenance, path, sha256, line_no)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(entry_id) DO UPDATE SET domain=excluded.domain, kind=excluded.kind, title=excluded.title,
        event_time=excluded.event_time, record_time=excluded.record_time, last_verified=excluded.last_verified,
        valid_until=excluded.valid_until, superseded_by=excluded.superseded_by, importance=excluded.importance,
        volatility=excluded.volatility, provenance=excluded.provenance, path=excluded.path, sha256=excluded.sha256, line_no=excluded.line_no`)
      .run(entry.id, botId, contactId, entry.domain, entry.kind, entry.title, entry.event_time, entry.record_time,
        entry.last_verified, entry.valid_until, entry.superseded_by, entry.importance, entry.volatility,
        entry.provenance, relPath, sha, lineNo)
    this.db.prepare('DELETE FROM entry_fts WHERE entry_id = ?').run(entry.id)
    this.db.prepare('INSERT INTO entry_fts (entry_id, title, body) VALUES (?,?,?)').run(entry.id, entry.title, entry.body)
  }

  /**
   * 写向量；同时记录该向量对应的条目内容 sha256（重建索引时据此判断能否复用）。
   * 条目不在索引里时 sha 记空串——这种向量不会被 rebuildScope 保留（宁可缺，不混用旧内容的向量）。
   */
  setVector(entryId: string, model: string, vec: number[]): void {
    const row = this.db.prepare('SELECT sha256 FROM entries WHERE entry_id = ?').get(entryId) as { sha256: string } | undefined
    this.db.prepare('INSERT INTO entry_vec (entry_id, model, vec, sha256) VALUES (?,?,?,?) ON CONFLICT(entry_id) DO UPDATE SET model=excluded.model, vec=excluded.vec, sha256=excluded.sha256')
      .run(entryId, model, encodeVec(vec), row?.sha256 ?? '')
  }

  getVector(entryId: string): number[] | null {
    const row = this.db.prepare('SELECT vec FROM entry_vec WHERE entry_id = ?').get(entryId) as { vec: Uint8Array } | undefined
    return row ? decodeVec(row.vec) : null
  }

  /** 向量条数（诊断/测试：验证写路径不会把向量清空）。 */
  vectorCount(scope?: { botId: string; contactId: string }): number {
    const row = scope === undefined
      ? this.db.prepare('SELECT COUNT(*) AS c FROM entry_vec').get()
      : this.db.prepare('SELECT COUNT(*) AS c FROM entry_vec v JOIN entries e ON e.entry_id = v.entry_id WHERE e.bot_id = ? AND e.contact_id = ?').get(scope.botId, scope.contactId)
    return (row as { c: number }).c
  }

  /** 重建前快照该 scope 的向量行（含其对应的内容 sha256），用于复用未变化条目的向量。 */
  private snapshotVectors(botId: string, contactId: string): Map<string, { model: string; vec: Uint8Array; sha256: string }> {
    const rows = this.db.prepare(`
      SELECT e.entry_id AS entry_id, v.model AS model, v.vec AS vec,
             COALESCE(NULLIF(v.sha256, ''), e.sha256) AS sha256
      FROM entries e LEFT JOIN entry_vec v ON v.entry_id = e.entry_id
      WHERE e.bot_id = ? AND e.contact_id = ?
    `).all(botId, contactId) as Array<{ entry_id: string; model: string | null; vec: Uint8Array | null; sha256: string }>
    const snapshot = new Map<string, { model: string; vec: Uint8Array; sha256: string }>()
    for (const row of rows) {
      if (row.vec === null || row.model === null) continue
      snapshot.set(row.entry_id, { model: row.model, vec: row.vec, sha256: row.sha256 })
    }
    return snapshot
  }

  /**
   * 重建 scope：写入全部条目、刷新时间标签、计算 source_digest/build_id。
   *
   * 向量只在 Dream 里写，重建本身不算向量；因此这里先把「内容未变」的向量按
   * entry_id + 内容 sha256 带过去（原 BLOB 原样复用），内容变了的条目向量丢弃等下次
   * Dream 重建。这样 memory_write/update/forget 之后，该 scope 不会整体退化为纯 FTS。
   */
  rebuildScope(botId: string, contactId: string, items: Array<{ entry: VaultEntry; relPath: string; lineNo: number }>, now: Date): { sourceDigest: string; buildId: string; count: number; vectorsKept: number } {
    const preserved = this.snapshotVectors(botId, contactId)
    this.clearScope(botId, contactId)
    const digest = createHash('sha256')
    const sorted = [...items].sort((a, b) => a.relPath.localeCompare(b.relPath))
    let vectorsKept = 0
    for (const item of sorted) {
      this.upsertEntry(botId, contactId, item.entry, item.relPath, item.lineNo)
      const kept = preserved.get(item.entry.id)
      if (kept !== undefined && kept.sha256 !== '' && kept.sha256 === entryContentSha(item.entry)) {
        this.db.prepare('INSERT INTO entry_vec (entry_id, model, vec, sha256) VALUES (?,?,?,?) ON CONFLICT(entry_id) DO UPDATE SET model=excluded.model, vec=excluded.vec, sha256=excluded.sha256')
          .run(item.entry.id, kept.model, kept.vec, kept.sha256)
        vectorsKept++
      }
      digest.update(`${item.relPath}\n${sha256Hex(item.entry.title + item.entry.body)}\n`)
    }
    this.refreshTimeLabels(now)
    const sourceDigest = digest.digest('hex')
    const seq = Number(this.getMeta('build_seq') || '0') + 1
    this.setMeta('build_seq', String(seq))
    const buildId = sha256Hex(`${botId}:${contactId}:${sourceDigest}:${seq}`).slice(0, 16)
    this.setMeta('source_digest', sourceDigest)
    this.setMeta('build_id', buildId)
    this.setMeta('last_index_at', now.toISOString())
    return { sourceDigest, buildId, count: sorted.length, vectorsKept }
  }

  /** 按「现在」重算所有时间标签（自动老化）。 */
  refreshTimeLabels(now: Date): number {
    const rows = this.listIndexRows()
    const stmt = this.db.prepare('INSERT INTO time_labels (entry_id, event_label, recorded_label, updated_at) VALUES (?,?,?,?) ON CONFLICT(entry_id) DO UPDATE SET event_label=excluded.event_label, recorded_label=excluded.recorded_label, updated_at=excluded.updated_at')
    for (const row of rows) {
      const entry = { event_time: row.eventTime, record_time: row.recordTime, title: row.title, tags: [], thread: '' } as unknown as VaultEntry
      const labels = timeLabelsFor(entry, now)
      stmt.run(row.entryId, labels.eventLabel, labels.recordedLabel, now.toISOString())
    }
    return rows.length
  }

  listIndexRows(scope?: { botId: string; contactId: string }): IndexRow[] {
    const rows = (scope !== undefined
      ? this.db.prepare('SELECT * FROM entries WHERE bot_id = ? AND contact_id = ? ORDER BY event_time DESC').all(scope.botId, scope.contactId)
      : this.db.prepare('SELECT * FROM entries ORDER BY event_time DESC').all()) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      entryId: String(row['entry_id']), botId: String(row['bot_id']), contactId: String(row['contact_id']),
      domain: String(row['domain']), kind: String(row['kind']), title: String(row['title']),
      eventTime: String(row['event_time']), recordTime: String(row['record_time']), lastVerified: String(row['last_verified']),
      validUntil: row['valid_until'] === null || row['valid_until'] === undefined ? null : String(row['valid_until']),
      supersededBy: row['superseded_by'] === null || row['superseded_by'] === undefined ? null : String(row['superseded_by']),
      importance: Number(row['importance']), volatility: String(row['volatility']), provenance: String(row['provenance']),
      path: String(row['path']), sha256: String(row['sha256']), lineNo: Number(row['line_no']),
    }))
  }

  /** 带时间标签的条目视图。 */
  entriesWithLabels(scope: { botId: string; contactId: string }, filter: { domain?: string | undefined; limit?: number | undefined; offset?: number | undefined }, now: Date): Array<IndexRow & { eventLabel: string; recordedLabel: string; state: 'active' | 'superseded' | 'expired' | 'archived' }> {
    const rows = this.listIndexRows(scope).filter((r) => filter.domain === undefined || r.domain === filter.domain)
    const labels = new Map<string, { eventLabel: string; recordedLabel: string }>()
    for (const row of this.db.prepare('SELECT entry_id, event_label, recorded_label FROM time_labels').all() as Array<{ entry_id: string; event_label: string; recorded_label: string }>) {
      labels.set(row.entry_id, { eventLabel: row.event_label, recordedLabel: row.recorded_label })
    }
    const limit = Math.min(200, Math.max(1, filter.limit ?? 50))
    const offset = Math.max(0, filter.offset ?? 0)
    return rows.slice(offset, offset + limit).map((row) => {
      const label = labels.get(row.entryId) ?? { eventLabel: relativeLabel(row.eventTime, now), recordedLabel: relativeLabel(row.recordTime, now) }
      const expired = row.validUntil !== null && Date.parse(row.validUntil) <= now.getTime()
      const state = row.supersededBy !== null ? 'superseded' : expired ? 'expired' : row.domain === 'history' ? 'archived' : 'active'
      return { ...row, ...label, state }
    })
  }

  domainStats(scope: { botId: string; contactId: string }, now: Date, descriptions: Record<string, string>): DomainStat[] {
    const rows = this.listIndexRows(scope)
    return Object.entries(descriptions).map(([domain, description]) => {
      const inDomain = rows.filter((r) => r.domain === domain)
      const active = inDomain.filter((r) => r.supersededBy === null && (r.validUntil === null || Date.parse(r.validUntil) > now.getTime()))
      const latest = inDomain.reduce((max, r) => (r.eventTime > max ? r.eventTime : max), '')
      return {
        domain: domain as MemoryDomain,
        count: inDomain.length,
        activeCount: active.length,
        latestEventTime: latest,
        latestLabel: latest === '' ? '' : relativeLabel(latest, now),
        description,
      }
    })
  }

  /** FTS 检索（trigram；短查询回退 LIKE）。 */
  private ftsSearch(scope: { botId: string; contactId: string }, query: string, limit: number, domain?: string): string[] {
    const q = query.trim()
    if (q === '') return []
    const scopedIds = new Set(this.listIndexRows(scope).filter((r) => domain === undefined || r.domain === domain).map((r) => r.entryId))
    let ids: string[] = []
    if ([...q].length >= 3) {
      try {
        const rows = this.db.prepare('SELECT entry_id FROM entry_fts WHERE entry_fts MATCH ? ORDER BY bm25(entry_fts) LIMIT ?').all(`"${q.replace(/"/gu, '')}"`, limit * 3) as Array<{ entry_id: string }>
        ids = rows.map((r) => r.entry_id)
      } catch {
        ids = []
      }
    }
    if (ids.length === 0) {
      try {
        const rows = this.db.prepare('SELECT entry_id FROM entries WHERE title LIKE ? OR entry_id IN (SELECT entry_id FROM entry_fts WHERE body LIKE ?) LIMIT ?').all(`%${q}%`, `%${q}%`, limit * 3) as Array<{ entry_id: string }>
        ids = rows.map((r) => r.entry_id)
      } catch {
        ids = this.listIndexRows(scope).filter((r) => r.title.includes(q) || (domain === undefined || r.domain === domain)).slice(0, limit).map((r) => r.entryId)
      }
    }
    return ids.filter((id) => scopedIds.has(id)).slice(0, limit * 2)
  }

  /**
   * 检索：FTS + 向量 → RRF(k=60) 融合 → 加权排序（相关度/重要度/新鲜度）。
   *
   * - 相关度 = RRF 分 / 本批最大 RRF（0..1，保持「谁被召回」不变，只影响同等相关时的次序）；
   * - 重要度 = importance/5；新鲜度按 event_time 的半衰期指数衰减（domain 定半衰期，
   *   volatility=state 封顶 7 天）——见 rank.ts；
   * - 最终分 = 0.55·相关度 + 0.25·重要度 + 0.20·新鲜度；minScore 过滤的是这个最终分。
   * - 没有向量的条目仍可被 FTS 单独召回（向量层只扫 entry_vec 里已有的条目），
   *   所以新写入、尚未等到 Dream 补向量的条目不会从检索里消失。
   * - 同分按 event_time 倒序（新事在前），保证排序稳定、可解释。
   */
  search(scope: { botId: string; contactId: string }, query: string, options: SearchOptions = {}, now: Date = new Date()): SearchHit[] {
    const limit = Math.min(50, Math.max(1, options.limit ?? 10))
    const rows = new Map(this.listIndexRows(scope).map((r) => [r.entryId, r]))
    const ftsIds = this.ftsSearch(scope, query, limit, options.domain)
    const vecIds: string[] = []
    if (options.embedding !== undefined && options.embedding.length > 0) {
      const scored: Array<{ id: string; score: number }> = []
      for (const row of rows.values()) {
        if (options.domain !== undefined && row.domain !== options.domain) continue
        const vec = this.getVector(row.entryId)
        if (vec === null) continue
        scored.push({ id: row.entryId, score: cosine(options.embedding, vec) })
      }
      scored.sort((a, b) => b.score - a.score)
      vecIds.push(...scored.slice(0, limit * 2).map((s) => s.id))
    }
    const scores = new Map<string, { score: number; fts: boolean; vec: boolean }>()
    ftsIds.forEach((id, index) => scores.set(id, { score: 1 / (RRF_K + index + 1), fts: true, vec: false }))
    vecIds.forEach((id, index) => {
      const cur = scores.get(id) ?? { score: 0, fts: false, vec: false }
      cur.score += 1 / (RRF_K + index + 1)
      cur.vec = true
      if (cur.fts) cur.fts = true
      scores.set(id, cur)
    })
    let maxRrf = 0
    for (const info of scores.values()) if (info.score > maxRrf) maxRrf = info.score
    const hits: Array<{ hit: SearchHit; eventTime: string }> = []
    for (const [id, info] of scores) {
      const row = rows.get(id)
      if (row === undefined) continue
      const expired = row.validUntil !== null && Date.parse(row.validUntil) <= now.getTime()
      if (row.supersededBy !== null || row.domain === 'history') continue
      if (options.validOnly !== false && expired) continue
      const relevance = normalizeRelevance(info.score, maxRrf)
      const importance = importanceWeight(row.importance)
      const recency = recencyWeight(row.eventTime, now, row.domain, row.volatility)
      const final = rankScore({ relevance, importance, recency })
      if (options.minScore !== undefined && final < options.minScore) continue
      const round = (value: number): number => Number(value.toFixed(6))
      hits.push({
        eventTime: row.eventTime,
        hit: {
          entryId: row.entryId,
          domain: row.domain,
          path: row.path,
          line: row.lineNo,
          title: row.title,
          timeLabel: relativeLabel(row.eventTime, now),
          score: round(final),
          scoreBreakdown: {
            rrf: round(info.score),
            relevance: round(relevance),
            importance: round(importance),
            recency: round(recency),
            final: round(final),
          },
          matchedLayer: info.fts && info.vec ? 'both' : info.fts ? 'fts' : 'vec',
          provenance: row.provenance,
          validUntil: row.validUntil,
          supersededBy: row.supersededBy,
        },
      })
    }
    const eventMs = (value: string): number => {
      const ms = Date.parse(value)
      return Number.isNaN(ms) ? 0 : ms
    }
    return hits
      .sort((a, b) => (b.hit.score - a.hit.score) || (eventMs(b.eventTime) - eventMs(a.eventTime)))
      .slice(0, limit)
      .map((entry) => entry.hit)
  }

  /** 暂存镜像同步（文件为准）。 */
  syncStaging(botId: string, contactId: string, records: Array<{ id: string; content: string; source_ref: string; status: string; created_at: string }>): number {
    for (const record of records) {
      this.db.prepare('INSERT INTO staging (id, bot_id, contact_id, content, source_ref, status, created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content, status=excluded.status').run(record.id, botId, contactId, record.content, record.source_ref, record.status, record.created_at)
    }
    const keep = new Set(records.map((r) => r.id))
    const existing = this.db.prepare('SELECT id FROM staging WHERE bot_id = ? AND contact_id = ?').all(botId, contactId) as Array<{ id: string }>
    for (const { id } of existing) if (!keep.has(id)) this.db.prepare('DELETE FROM staging WHERE id = ?').run(id)
    return records.length
  }

  stagingCount(botId: string, contactId: string): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS c FROM staging WHERE bot_id = ? AND contact_id = ? AND status = 'pending'").get(botId, contactId) as { c: number }).c)
  }

  insertDreamReport(report: DreamReportRow): void {
    this.db.prepare('INSERT OR REPLACE INTO dream_reports (id, bot_id, contact_id, at, added, merged, superseded, archived, duration_ms, tokens, status, error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(report.id, report.bot_id, report.contact_id, report.at, report.added, report.merged, report.superseded, report.archived, report.duration_ms, report.tokens, report.status, report.error)
  }

  listDreamReports(botId: string, contactId: string, limit: number = 10): DreamReportRow[] {
    return this.db.prepare('SELECT * FROM dream_reports WHERE bot_id = ? AND contact_id = ? ORDER BY at DESC LIMIT ?').all(botId, contactId, limit) as unknown as DreamReportRow[]
  }

  lastDreamAt(botId: string, contactId: string): string {
    const row = this.db.prepare("SELECT at FROM dream_reports WHERE bot_id = ? AND contact_id = ? AND status = 'ok' ORDER BY at DESC LIMIT 1").get(botId, contactId) as { at: string } | undefined
    return row?.at ?? ''
  }

  counts(): { entries: number; staging: number } {
    return {
      entries: Number((this.db.prepare('SELECT COUNT(*) AS c FROM entries').get() as { c: number }).c),
      staging: Number((this.db.prepare('SELECT COUNT(*) AS c FROM staging').get() as { c: number }).c),
    }
  }
}
