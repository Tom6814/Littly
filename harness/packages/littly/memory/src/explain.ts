/**
 * §记忆 v2 —— explain 台账 / 硬保护能力位 / 写入幂等回执。
 *
 * 计划 v2 §3 的 ⑧⑨⑩：
 *  - ⑧ explain 台账：每条记忆「为什么被召回、它是谁说的、什么时候发生的、被谁取代」
 *    一条可查的台账 —— 检索结果附「记忆是提示不是证据」的出处说明。
 *  - ⑨ newest-N 保护从「整理时硬保护」变成「命中结果上的 protected 能力位」：
 *    最近写入的 N 条在召回结果里明确标出，让调用方（与模型）知道它是受保护的。
 *  - ⑩ 写入幂等回执：同 idempotency key 的重复写入返回同一条结果，不产生新行；
 *    if_sha256 漂移检测：调用方带上期望的内容哈希，存的内容变了就报漂移。
 */
import { createHash } from 'node:crypto'
import type { LittlyStorage, MemoryRow } from '@littly/storage'

/** 内容哈希（if_sha256 漂移检测用）。 */
export function contentSha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** 召回结果上的能力位：protected = 最近写入、不可被整理掉的那些。 */
export interface MemoryHit extends MemoryRow {
  /** 最近 N 条硬保护标记（能力位，不是独立字段）。 */
  protected?: boolean
  /** 召回得分（便于台账与调试）。 */
  score?: number
}

/** explain 台账：一条记忆的完整来历。 */
export interface MemoryExplain {
  memory: MemoryRow
  /** 三层时间：发生时间 / 记录时间 / 最后核验时间；衰减按 event_time。 */
  timing: {
    eventTime: string
    eventTimeRaw: string
    recordedAt: string
    lastVerified: string | null
    effectiveTime: string
    volatility: string
    halfLifeDays: number
  }
  /** 出处：user-stated（对方说的）/ observed（观测到）/ inferred（推断）。 */
  provenance: {
    kind: string
    /** 人话说明：这条记忆是「听到的」还是「我们自己推的」。 */
    note: string
  }
  /** 墓碑与取代链：它取代了谁、又被谁取代。 */
  tombstone: {
    deleted: boolean
    deletedAt: string | null
    deletedReason: string
    supersededBy: string | null
    supersededByContent: string | null
    supersededFrom: Array<{ id: string; content: string }>
  }
  /** 检索解释：为什么它会被召回。 */
  retrieval: {
    score: number
    /** 命中的通道：向量 / 词法 / 保底（重要度或关系事实） */
    matchedBy: 'vector' | 'lexical' | 'guaranteed'
    /** 各信号分量 */
    signals: {
      relevance: number
      importance: number
      recency: number
    }
  }
  /** 硬保护能力位 */
  protected: boolean
}

const PROVENANCE_NOTE: Record<string, string> = {
  'user-stated': '对方明确说过（最可靠的一类记忆）',
  observed: '她自己观察到/记录下来的',
  inferred: '推断出来的，可能不准 —— 只是提示，不是证据',
}

/**
 * 解释一条记忆：出处、时间、墓碑链、召回理由。
 * @param storage 业务存储
 * @param botId 角色 id
 * @param id 记忆 id
 */
export function explainMemory(storage: LittlyStorage, botId: string, id: string): MemoryExplain | null {
  const row = storage.prepare('SELECT * FROM memories WHERE id = ? AND bot_id = ?').get(id, botId) as MemoryRow | undefined
  if (!row) return null

  // 取代链：本条取代了谁（superseded_by 指向的上一任的上一任）
  const supersededFrom = storage
    .prepare('SELECT id, content FROM memories WHERE id = ? AND bot_id = ?')
    .all(row.superseded_by ?? '', botId) as unknown as Array<{ id: string; content: string }>

  // 它取代了谁：找出 superseded_by = 本条 id 的那些（墓碑链往回）
  const replaced = storage
    .prepare('SELECT id, content FROM memories WHERE superseded_by = ? AND bot_id = ? LIMIT 20')
    .all(row.id, botId) as unknown as Array<{ id: string; content: string }>

  const supersededByRow = row.superseded_by
    ? (storage.prepare('SELECT id, content FROM memories WHERE id = ?').get(row.superseded_by) as { id: string; content: string } | undefined)
    : undefined

  return {
    memory: row,
    timing: {
      eventTime: row.event_time,
      eventTimeRaw: row.event_time_raw,
      recordedAt: row.recorded_at,
      lastVerified: row.last_verified,
      effectiveTime: row.event_time || row.recorded_at,
      volatility: row.volatility,
      halfLifeDays: halfLifeDaysOf(row.category, row.volatility),
    },
    provenance: {
      kind: row.provenance,
      note: PROVENANCE_NOTE[row.provenance] ?? '来源未标注',
    },
    tombstone: {
      deleted: row.deleted_at !== null,
      deletedAt: row.deleted_at,
      deletedReason: row.deleted_reason,
      supersededBy: row.superseded_by,
      supersededByContent: supersededByRow?.content ?? null,
      supersededFrom: [...replaced, ...supersededFrom],
    },
    retrieval: {
      score: 0,
      matchedBy: 'lexical',
      signals: { relevance: 0, importance: row.importance / 5, recency: 0 },
    },
    protected: false,
  }
}

/** 类别半衰期（与 score.ts 同口径）。 */
export function halfLifeDaysOf(category: string, volatility: string): number {
  if (volatility === 'state') return 7
  switch (category) {
    case 'relationship':
    case 'value':
      return 365
    case 'profile':
      return 180
    case 'thought':
      return 14
    default:
      return 30
  }
}

// --- 写入幂等回执 ---

export interface WriteReceipt {
  id: string
  dupSkipped: boolean
}

/**
 * 读回执：同 idempotency key 的重复写入直接返回上次结果，不产生新行。
 * @returns 回执结果；没有回执返回 null。
 */
export function readReceipt(storage: LittlyStorage, idempotencyKey: string): WriteReceipt | null {
  try {
    const row = storage
      .prepare('SELECT result FROM memory_write_receipts WHERE idempotency_key = ?')
      .get(idempotencyKey) as { result: string } | undefined
    if (!row) return null
    const parsed = JSON.parse(row.result) as WriteReceipt
    if (!parsed || typeof parsed.id !== 'string') return null
    return { id: parsed.id, dupSkipped: parsed.dupSkipped === true }
  } catch {
    return null
  }
}

/** 写回执。 */
export function writeReceipt(storage: LittlyStorage, idempotencyKey: string, receipt: WriteReceipt): void {
  try {
    storage
      .prepare('INSERT INTO memory_write_receipts (idempotency_key, result, created_at) VALUES (?,?,?) ON CONFLICT(idempotency_key) DO UPDATE SET result = excluded.result')
      .run(idempotencyKey, JSON.stringify(receipt), new Date().toISOString())
  } catch {
    // 回执写失败不阻断主写入
  }
}

/** 漂移检测：调用方给的期望哈希与库里实际内容对不上 → 说明记忆被别人改过。 */
export interface DriftReport {
  expected: string
  actual: string
  message: string
}

export function detectDrift(expected: string | undefined, actualContent: string): DriftReport | null {
  if (!expected) return null
  const actual = contentSha256(actualContent)
  if (actual === expected) return null
  return {
    expected,
    actual,
    message: `内容漂移：期望 sha256=${expected.slice(0, 12)}…，实际 sha256=${actual.slice(0, 12)}…（这条记忆已被改动）`,
  }
}
