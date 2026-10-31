/**
 * 记忆引擎：双池混合检索 / 写入去重 / 滚动摘要 / AI 整理。
 * 旧 ai/memory-retrieval.ts + history-summary.ts + consolidate.ts 的移植基线，
 * v2 增量：event_time 衰减（score.ts）、supersede 语义、explain 台账、幂等回执。
 */
import { randomUUID } from 'node:crypto'
import { contentSha256, detectDrift, explainMemory, readReceipt, writeReceipt, type DriftReport, type MemoryExplain, type MemoryHit } from './explain.ts'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { LittlyStorage, MemoryRow } from '@littly/storage'
import { chatComplete, embedTexts, encodeEmbedding, getAIConfig } from '@littly/llm'
import { lexicalRelevance, parseEmbedding, scoreMemory, cosineSimilarity } from './score.ts'
import { MemoryVault } from './vault/service.ts'
import { registerMemoryTools, type MemoryToolRegistryLike } from './vault/tools.ts'

export const name = 'littly-memory'

export const inject = ['littlyStorage']

declare module '@deepseek-ai/cordis' {
  interface Context {
    littlyMemory: LittlyMemory
    littlyMemoryVault: MemoryVault
  }
}

export interface Config {
  /** vault 根目录；默认 LITTLY_DATA_DIR/memory。 */
  vaultRoot?: string
}

export const Config: z<Config> = z.object({ vaultRoot: z.string() })

export const RETRIEVAL_POOL = 300
export const DEFAULT_LIMIT = 30
export const DUPLICATE_THRESHOLD = 0.6
export const DUP_SCAN_RECENT = 60
export const SUMMARIZE_THRESHOLD = 12
export const MAX_CHUNK_PER_TURN = 30
export const SUMMARY_MAX_CHARS = 1500
export const HARD_PROTECT_COUNT = 5
export const MAX_AI_INPUT = 100

/** ⑨ newest-N 硬保护：最近写入的 N 条打上 protected 能力位。 */
function markProtected(rows: MemoryRow[]): MemoryHit[] {
  const byNewest = [...rows].sort((a, b) => (b.recorded_at || b.created_at).localeCompare(a.recorded_at || a.created_at))
  const protectedIds = new Set(byNewest.slice(0, HARD_PROTECT_COUNT).map((r) => r.id))
  return rows.map((r) => (protectedIds.has(r.id) ? { ...r, protected: true } : { ...r }))
}

/** B14：把 remember 的 expiresAt 归一化为 valid_until（非法/空 → null）。 */
export function normalizeValidUntil(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw.trim() === '') return null
  const ms = Date.parse(raw)
  if (Number.isNaN(ms)) return null
  return new Date(ms).toISOString()
}

export class LittlyMemory {
  private readonly ctx: Context
  private readonly storage: LittlyStorage

  constructor(ctx: Context, storage: LittlyStorage) {
    this.ctx = ctx
    this.storage = storage
  }

  private all<T>(sql: string, ...params: unknown[]): T[] {
    return this.storage.prepare(sql).all(...params) as T[]
  }

  // ---- 懒回填 ----

  private async ensureEmbeddings(rows: MemoryRow[]): Promise<void> {
    const cfg = await getAIConfig(this.storage).catch(() => null)
    if (!cfg?.embeddingModel || !cfg.embeddingApiKey) return
    const pending: MemoryRow[] = []
    for (const r of rows) {
      if (parseEmbedding(r.embedding, cfg.embeddingModel)) continue
      pending.push(r)
    }
    if (pending.length === 0) return
    try {
      const vectors = await embedTexts(this.storage, pending.map((r) => r.content))
      const stmt = this.storage.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
      for (let i = 0; i < pending.length; i++) {
        const row = pending[i]
        const vec = vectors[i]
        if (!row || !vec) continue
        try {
          stmt.run(encodeEmbedding(cfg.embeddingModel, vec), row.id)
        } catch {
          // 单行失败吞掉，检索侧该行回退词法
        }
      }
    } catch {
      // 懒回填失败静默：下次检索再试
    }
  }

  // ---- 检索（铁律：绝不抛异常）----

  async retrieveMemories(opts: { botId: string; sender: string; query: string; limit?: number }): Promise<MemoryHit[]> {
    const limit = opts.limit ?? DEFAULT_LIMIT
    try {
      const pool = this.all<MemoryRow>(
        'SELECT * FROM memories WHERE bot_id = ? AND sender = ? AND deleted_at IS NULL AND valid_until IS NULL ORDER BY recorded_at DESC LIMIT ?',
        opts.botId, opts.sender, RETRIEVAL_POOL,
      )
      const crossPool = this.all<MemoryRow>(
        "SELECT * FROM memories WHERE bot_id = ? AND sender != ? AND deleted_at IS NULL AND valid_until IS NULL AND category IN ('relationship','value') ORDER BY recorded_at DESC LIMIT ?",
        opts.botId, opts.sender, RETRIEVAL_POOL,
      )
      if (pool.length === 0 && crossPool.length === 0) return []

      // 向量模式（可用时）：余弦；失败逐行回退词法
      const cfg = await getAIConfig(this.storage).catch(() => null)
      const vectorMode = !!cfg?.embeddingModel && !!cfg.embeddingApiKey && opts.query.trim().length > 0
      let queryVec: number[] | null = null
      if (vectorMode && cfg) {
        try {
          await this.ensureEmbeddings([...pool.slice(0, 64), ...crossPool.slice(0, 32)])
          const q = await embedTexts(this.storage, [opts.query.slice(0, 2000)])
          queryVec = q[0] ?? null
        } catch {
          queryVec = null
        }
      }

      const score = (m: MemoryRow): number => {
        let relevance = lexicalRelevance(opts.query, m.content)
        if (queryVec) {
          const env = parseEmbedding(m.embedding, cfg!.embeddingModel)
          if (env) {
            relevance = (Math.max(-1, Math.min(1, cosineSimilarity(queryVec, env.v))) + 1) / 2
          }
        }
        return scoreMemory(relevance, m.importance, m.event_time || m.recorded_at, m.category, m.volatility)
      }

      // 主池：relationship / value / importance=5 保底；其余按分竞争
      const guaranteed = pool.filter((m) => m.category === 'relationship' || m.category === 'value' || m.importance >= 5)
      const rest = pool
        .filter((m) => !guaranteed.includes(m))
        .map((m) => ({ m, s: score(m) }))
        .sort((a, b) => b.s - a.s)
      const remaining = Math.max(0, limit - guaranteed.length)
      const main = [...guaranteed, ...rest.slice(0, remaining).map((x) => x.m)]

      // 副池：关系事实优先（6 + 4），防 thought 刷屏挤掉关键关系（08-28 事故教训）
      const crossRel = crossPool.filter((m) => m.category === 'relationship' || m.category === 'value').slice(0, 6)
      const crossOther = crossPool.filter((m) => !crossRel.includes(m)).slice(0, 4)
      const picked = [...main, ...crossRel, ...crossOther].slice(0, limit + 10)
      // ⑨ newest-N 硬保护：变成命中结果上的 protected 能力位（最近写入的 N 条）
      return markProtected(picked)
    } catch (err) {
      this.ctx.logger.warn('retrieveMemories failed: %s', err)
      try {
        // 兜底：重要度↓时间↓
        return markProtected(this.all<MemoryRow>(
          'SELECT * FROM memories WHERE bot_id = ? AND sender = ? AND deleted_at IS NULL ORDER BY importance DESC, created_at DESC LIMIT ?',
          opts.botId, opts.sender, limit,
        ))
      } catch {
        return []
      }
    }
  }

  /** 写入前去重：最近 60 条活跃记忆词法 ≥0.6 视为重复；新重要度更高则提升原记忆。 */
  async findDuplicateMemory(botId: string, sender: string, content: string): Promise<MemoryRow | null> {
    try {
      const recent = this.all<MemoryRow>(
        'SELECT * FROM memories WHERE bot_id = ? AND sender = ? AND deleted_at IS NULL AND consolidated = 0 ORDER BY recorded_at DESC LIMIT ?',
        botId, sender, DUP_SCAN_RECENT,
      )
      let best: MemoryRow | null = null
      let bestScore = 0
      for (const m of recent) {
        const s = lexicalRelevance(content, m.content)
        if (s >= DUPLICATE_THRESHOLD && s > bestScore) {
          best = m
          bestScore = s
        }
      }
      return best
    } catch {
      return null
    }
  }

  /** 记忆写入（remember 工具的底层）：去重 → 创建 → 异步预嵌入 → 整理检查。返回 {id, dupSkipped}。 */
  async remember(
    botId: string,
    sender: string,
    item: {
      category?: string
      content: string
      importance?: number
      expiresAt?: string | null
      provenance?: string
      /** 幂等键：同键重复写入返回同一条结果，不产生新行 */
      idempotencyKey?: string
      /** 期望的内容哈希：与库里实际内容不符时报告漂移 */
      ifSha256?: string
    },
  ): Promise<{ id: string; dupSkipped: boolean; idempotentReplay?: boolean; drift?: DriftReport }> {
    const now = new Date().toISOString()
    // ⑩ 幂等回执：同键直接回放上次结果
    if (item.idempotencyKey) {
      const receipt = readReceipt(this.storage, item.idempotencyKey)
      if (receipt) return { ...receipt, idempotentReplay: true }
    }
    const dup = await this.findDuplicateMemory(botId, sender, item.content)
    if (dup) {
      // ⑩ if_sha256 漂移检测：同一话题的内容已被改动 → 报告漂移（不静默覆盖）
      const drift = detectDrift(item.ifSha256, dup.content)
      const importance = Math.min(5, Math.max(1, item.importance ?? 1))
      if (importance > dup.importance) {
        this.storage.prepare('UPDATE memories SET importance = ? WHERE id = ?').run(importance, dup.id)
      }
      const receipt = { id: dup.id, dupSkipped: true }
      if (item.idempotencyKey) writeReceipt(this.storage, item.idempotencyKey, receipt)
      return drift ? { ...receipt, drift } : receipt
    }
    const id = randomUUID()
    // B14：expiresAt → valid_until（有时效的事实到期后不再进上下文，但永不物理删除）。
    const validUntil = normalizeValidUntil(item.expiresAt)
    this.storage.prepare(
      'INSERT INTO memories (id, bot_id, contact_id, sender, category, content, importance, event_time, event_time_raw, recorded_at, provenance, volatility, tags, derived_from, created_at, valid_until) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      id, botId, null, sender,
      item.category ?? 'fact',
      item.content,
      Math.min(5, Math.max(1, item.importance ?? 1)),
      now, '', now,
      item.provenance ?? 'observed',
      item.category === 'thought' ? 'state' : 'stable',
      '[]', '[]', now,
      validUntil,
    )
    // 预嵌入 fire-and-forget；失败由检索懒回填兜底
    void (async () => {
      try {
        const row = this.storage.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined
        if (row) await this.ensureEmbeddings([row])
      } catch { /* ignore */ }
    })()
    // 整理阈值检查（fire-and-forget）
    void this.maybeAutoConsolidate(botId, sender).catch(() => {})
    const receipt = { id, dupSkipped: false }
    if (item.idempotencyKey) writeReceipt(this.storage, item.idempotencyKey, receipt)
    return receipt
  }

  /** ⑧ explain 台账：一条记忆的完整来历（出处/时间/墓碑链/召回理由）。 */
  explain(botId: string, id: string): MemoryExplain | null {
    return explainMemory(this.storage, botId, id)
  }

  /** 内容哈希（if_sha256 漂移检测的期望值来源）。 */
  static hashContent(content: string): string {
    return contentSha256(content)
  }

  /** 翻旧账：淡忘池（时间窗）+ 历史原文（无窗）。 */
  recall(botId: string, sender: string, query: string, daysBack: number = 90): {
    faded: MemoryRow[]
    messages: Array<{ id: string; role: string; content: string; createdAt: string }>
  } {
    const since = new Date(Date.now() - Math.min(365, Math.max(1, daysBack)) * 86_400_000).toISOString()
    const faded = this.all<MemoryRow>(
      'SELECT * FROM memories WHERE bot_id = ? AND sender = ? AND deleted_at IS NOT NULL AND deleted_at >= ? ORDER BY deleted_at DESC LIMIT 200',
      botId, sender, since,
    )
      .map((m) => ({ m, s: lexicalRelevance(query, m.content) }))
      .filter((x) => x.s > 0.05)
      .sort((a, b) => b.s - a.s)
      .slice(0, 8)
      .map((x) => x.m)
    const raw = this.all<{ id: string; role: string; content: string; created_at: string }>(
      'SELECT id, role, content, created_at FROM messages WHERE bot_id = ? AND sender = ? AND role IN (\'user\',\'assistant\') ORDER BY created_at DESC LIMIT 1000',
      botId, sender,
    )
      .map((r) => ({ r, s: lexicalRelevance(query, r.content) }))
      .filter((x) => x.s > 0.05)
      .sort((a, b) => b.s - a.s)
      .slice(0, 5)
      .map((x) => ({ id: x.r.id, role: x.r.role, content: x.r.content.slice(0, 160), createdAt: x.r.created_at }))
    return { faded, messages: raw }
  }

  restoreMemory(id: string, botId: string): 'ok' | 'not_found' | 'already_active' {
    const row = this.storage.prepare('SELECT * FROM memories WHERE id = ? AND bot_id = ?').get(id, botId) as MemoryRow | undefined
    if (!row) return 'not_found'
    if (!row.deleted_at) return 'already_active'
    this.storage.prepare("UPDATE memories SET deleted_at = NULL, deleted_reason = '', consolidated = 0 WHERE id = ?").run(id)
    return 'ok'
  }

  /** 整理（软删 = supersede 语义 v2）。最近 5 条硬保护（结构化能力位见 explain）。 */
  async runConsolidation(botId: string, sender: string): Promise<{ before: number; deleted: number; compressed: number; kept: number; recentProtected: number }> {
    const all = this.all<MemoryRow>(
      'SELECT * FROM memories WHERE bot_id = ? AND sender = ? AND deleted_at IS NULL AND consolidated = 0 ORDER BY recorded_at DESC',
      botId, sender,
    )
    const before = all.length
    if (all.length < 10) return { before, deleted: 0, compressed: 0, kept: before, recentProtected: Math.min(HARD_PROTECT_COUNT, before) }
    const input = all.slice(0, MAX_AI_INPUT)
    const hardIds = new Set(input.slice(0, HARD_PROTECT_COUNT).map((m) => m.id))
    let ops: Array<{ op: string; id?: string; ids?: string[]; reason?: string; mergedContent?: string; mergedImportance?: number }> = []
    try {
      const listing = input.map((m, i) => `${i + 1}. [${m.id}] (${m.category}, 重要度${m.importance}, ${m.recorded_at.slice(0, 10)}) ${m.content}`).join('\n')
      const res = await chatComplete(this.storage, [
        { role: 'system', content: '你是记忆整理器。只输出 JSON：{"operations":[{"op":"DELETE","id":"...","reason":"..."},{"op":"COMPRESS","ids":["..."],"mergedContent":"...","mergedImportance":2},{"op":"KEEP","id":"..."}]}。规则：删除过时/重复/琐屑；合并同类；最近的重要关系记忆保留。禁止 DELETE 最近 5 条。' },
        { role: 'user', content: listing },
      ], { temperature: 0.2, enableThinking: false, retries: 0 })
      const m = /\{[\s\S]*\}/.exec(res.content)
      if (m) ops = (JSON.parse(m[0]) as { operations?: typeof ops }).operations ?? []
    } catch {
      ops = []
    }
    let deleted = 0
    let compressed = 0
    let kept = 0
    const now = new Date().toISOString()
    // B14：归属硬校验 —— 只允许操作本次 (bot_id, sender) 范围内的记忆行，
    // 模型幻觉出的 id（包括其他 bot / 其他联系人的记忆）一律忽略，绝不按裸 id 改库。
    const ownedIds = new Set(input.map((m) => m.id))
    for (const op of ops) {
      if (op.op === 'DELETE' && op.id && !hardIds.has(op.id)) {
        if (!ownedIds.has(op.id)) {
          kept++
          continue
        }
        this.storage.prepare('UPDATE memories SET deleted_at = ?, deleted_reason = ? WHERE id = ? AND bot_id = ? AND sender = ? AND deleted_at IS NULL')
          .run(now, op.reason ?? '整理淡忘', op.id, botId, sender)
        deleted++
      } else if (op.op === 'COMPRESS' && op.ids?.length && op.mergedContent && !op.ids.some((x) => hardIds.has(x))) {
        if (!op.ids.every((x) => ownedIds.has(x))) {
          kept++
          continue
        }
        const sources = this.all<MemoryRow>(`SELECT * FROM memories WHERE id IN (${op.ids.map(() => '?').join(',')})`, ...op.ids)
        if (sources.length >= 2) {
          const id = randomUUID()
          this.storage.prepare(
            'INSERT INTO memories (id, bot_id, contact_id, sender, category, content, importance, event_time, event_time_raw, recorded_at, provenance, volatility, tags, derived_from, consolidated, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)',
          ).run(id, botId, null, sender, 'profile', op.mergedContent, Math.min(5, Math.max(1, op.mergedImportance ?? 2)), now, '', now, 'inferred', 'stable', '[]', JSON.stringify(op.ids), now)
          for (const s of sources) {
            // v2：被合并者进入取代链（supersede），淡忘原因记录取代目标
            this.storage.prepare('UPDATE memories SET deleted_at = ?, deleted_reason = ?, superseded_by = ?, consolidated = 1 WHERE id = ? AND bot_id = ? AND sender = ?')
              .run(now, '已合并', id, s.id, botId, sender)
          }
          compressed++
        }
      } else {
        kept++
      }
    }
    this.storage.prepare('INSERT INTO audit_logs (id, bot_id, category, action, detail, created_at) VALUES (?,?,?,?,?,?)').run(
      randomUUID(), botId, 'consolidation', 'run', JSON.stringify({ before, deleted, compressed, kept, sender }), now,
    )
    return { before, deleted, compressed, kept: before - deleted - compressed * Math.max(0, 1), recentProtected: hardIds.size }
  }

  async maybeAutoConsolidate(botId: string, sender: string): Promise<void> {
    try {
      const bot = this.storage.prepare('SELECT ai_memory_consolidate_threshold FROM bots WHERE id = ?').get(botId) as { ai_memory_consolidate_threshold: number } | undefined
      const threshold = bot?.ai_memory_consolidate_threshold ?? 40
      if (threshold <= 0) return
      const count = (this.storage.prepare('SELECT COUNT(*) AS c FROM memories WHERE bot_id = ? AND sender = ? AND deleted_at IS NULL AND consolidated = 0').get(botId, sender) as { c: number }).c
      if (count > threshold) await this.runConsolidation(botId, sender)
    } catch {
      // fail-open
    }
  }

  // ---- 滚动摘要 ----

  getHistoryDigest(botId: string, sender: string): { summary: string; lastMsgId: string | null; msgCount: number } | null {
    const row = this.storage.prepare('SELECT * FROM history_summaries WHERE bot_id = ? AND sender = ?').get(botId, sender) as { summary: string; last_msg_id: string | null; msg_count: number } | undefined
    return row ? { summary: row.summary, lastMsgId: row.last_msg_id, msgCount: row.msg_count } : null
  }

  /** 增量压缩：仅统计已滚出可见窗口的消息；任何失败静默，边界不推进。 */
  async maybeUpdateHistoryDigest(botId: string, sender: string, visibleWindow: number): Promise<{ summary: string } | null> {
    try {
      const existing = this.getHistoryDigest(botId, sender)
      const candidates = this.all<{ id: string; role: string; content: string; created_at: string }>(
        'SELECT id, role, content, created_at FROM messages WHERE bot_id = ? AND sender = ? AND role IN (\'user\',\'assistant\') ORDER BY created_at ASC',
        botId, sender,
      )
      // 可见窗口起点：倒数 visibleWindow 条的第一条
      const boundaryIdx = Math.max(0, candidates.length - visibleWindow)
      const boundaryTime = candidates[boundaryIdx]?.created_at
      const newOnes = candidates.filter((c) => {
        if (existing?.lastMsgId) {
          const lastIdx = candidates.findIndex((x) => x.id === existing.lastMsgId)
          return lastIdx >= 0 ? candidates.indexOf(c) > lastIdx : true
        }
        return true
      }).filter((c) => boundaryTime && c.created_at < boundaryTime).slice(0, MAX_CHUNK_PER_TURN)
      if (newOnes.length < SUMMARIZE_THRESHOLD) return existing ? { summary: existing.summary } : null
      const last = newOnes[newOnes.length - 1]
      if (!last) return existing ? { summary: existing.summary } : null
      const chunk = newOnes.map((c) => `[${c.role === 'user' ? '对方' : '我'}] ${c.content}`).join('\n')
      let summary: string | null = null
      try {
        const res = await chatComplete(this.storage, [
          { role: 'system', content: '把对话片段合并进既有摘要。第三人称客观叙述（「对方提到…」「两人讨论了…」），保留关键事实、情感变化、约定、重要事件，丢弃寒暄重复。800 字以内，只输出摘要正文。' },
          { role: 'user', content: (existing?.summary ? `现有摘要：\n${existing.summary}\n\n新片段：\n${chunk}` : chunk) },
        ], { temperature: 0.3, enableThinking: false, retries: 0 })
        summary = res.content.trim().slice(0, SUMMARY_MAX_CHARS) || null
      } catch {
        summary = null
      }
      if (!summary) return existing ? { summary: existing.summary } : null
      this.storage.prepare(
        'INSERT INTO history_summaries (id, bot_id, sender, summary, last_msg_id, last_msg_at, msg_count, updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(bot_id, sender) DO UPDATE SET summary=excluded.summary, last_msg_id=excluded.last_msg_id, last_msg_at=excluded.last_msg_at, msg_count=excluded.msg_count, updated_at=excluded.updated_at',
      ).run(randomUUID(), botId, sender, summary, last.id, last.created_at, newOnes.length, new Date().toISOString())
      return { summary }
    } catch {
      return null
    }
  }
}

function cosine(a: number[], b: number[]): number {
  return cosineSimilarity(a, b)
}
void cosine

export function apply(ctx: Context, config: Config = {}): void {
  const storage = ctx.littlyStorage as LittlyStorage
  const memory = new LittlyMemory(ctx, storage)
  ctx.provide('littlyMemory', memory)
  // 记忆 vault：Markdown 真相 + 派生索引（独立于旧 memories 表，旧表保留只读）
  const vault = new MemoryVault(storage, {
    ...(config.vaultRoot !== undefined && config.vaultRoot.trim() !== '' ? { rootDir: config.vaultRoot.trim() } : {}),
    log: (msg, ...args) => ctx.logger.info(msg, ...args),
  })
  ctx.provide('littlyMemoryVault', vault)
  // hub 稍后装配：工具注册不写进 inject（避免与 agents←memory 形成环）
  ctx.inject(['littlyHub'], (child) => {
    const hub = (child as unknown as { littlyHub?: MemoryToolRegistryLike }).littlyHub
    if (hub === undefined) return
    registerMemoryTools(hub, vault)
    child.logger.info('littly memory vault tools registered')
  })
  ctx.logger.info('littly memory vault ready (root=%s)', vault.rootDir)
}

export * from './explain.ts'
export { MemoryVault } from './vault/service.ts'
export { runDream, refreshProfileFiles, buildProfileMarkdown, dreamDue } from './vault/dream.ts'
export { VaultIndex } from './vault/index-db.ts'
export { registerMemoryTools, MEMORY_TOOLS } from './vault/tools.ts'
export { MEMORY_DOMAINS, WRITABLE_DOMAINS, VaultError } from './vault/types.ts'
export { defaultVaultRoot, vaultPaths } from './vault/store.ts'
