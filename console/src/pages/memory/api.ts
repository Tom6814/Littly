/**
 * 记忆域 API（console-api routes-data.ts 的 /api/memories*）。
 *
 * 语义提醒：
 * - DELETE = 软删（淡忘池），POST /:id/restore 恢复；永不物理删除。
 * - includeDeleted=true 返回「未淡忘 + 已淡忘」；不传只返回未淡忘。
 * - 记忆检查器台账 explain 返回出处/三层时间/墓碑链/召回理由/硬保护位。
 */
import { asBool, asNum, asStr, http, isRecord, pickArray, pickRecord } from '@/api/client'

export type MemoryCategory = 'profile' | 'relationship' | 'fact' | 'detail' | 'value' | 'thought'

export const MEMORY_CATEGORIES: Array<{ value: MemoryCategory; label: string }> = [
  { value: 'profile', label: '人物档案' },
  { value: 'relationship', label: '关系' },
  { value: 'fact', label: '事实' },
  { value: 'detail', label: '细节' },
  { value: 'value', label: '偏好/价值' },
  { value: 'thought', label: '想法' },
]

export interface Memory {
  id: string
  botId: string
  sender: string
  category: string
  importance: number
  eventTime: string
  eventTimeRaw: string
  recordedAt: string
  provenance: string
  volatility: string
  content: string
  tags: string[]
  supersededBy: string
  validUntil: string
  deleted: boolean
  deletedAt: string
  deletedReason: string
  protected: boolean
}

function toMemory(v: unknown): Memory | undefined {
  if (!isRecord(v)) return undefined
  const id = asStr(v.id)
  if (!id) return undefined
  return {
    id,
    botId: asStr(v.botId) ?? '',
    sender: asStr(v.sender) ?? '',
    category: asStr(v.category) ?? '',
    importance: asNum(v.importance) ?? 0,
    eventTime: asStr(v.eventTime) ?? '',
    eventTimeRaw: asStr(v.eventTimeRaw) ?? '',
    recordedAt: asStr(v.recordedAt) ?? '',
    provenance: asStr(v.provenance) ?? '',
    volatility: asStr(v.volatility) ?? '',
    content: asStr(v.content) ?? '',
    tags: pickArray(v, 'tags').map((t) => String(t ?? '')).filter(Boolean),
    supersededBy: asStr(v.supersededBy) ?? '',
    validUntil: asStr(v.validUntil) ?? '',
    deleted: asBool(v.deleted) ?? (asStr(v.deletedAt) !== undefined),
    deletedAt: asStr(v.deletedAt) ?? '',
    deletedReason: asStr(v.deletedReason) ?? '',
    protected: asBool(v.protected) ?? false,
  }
}

export interface MemoryCreateInput {
  botId: string
  sender: string
  content: string
  category?: string
  importance?: number
  provenance?: string
  validUntil?: string
}

export interface MemoryUpdateInput {
  content?: string
  category?: string
  importance?: number
  tags?: string[]
  validUntil?: string | null
}

export interface MemoryExplain {
  memory: Record<string, unknown>
  timing: {
    eventTime: string
    eventTimeRaw: string
    recordedAt: string
    lastVerified: string
    effectiveTime: string
    volatility: string
    halfLifeDays: number
  }
  provenance: { kind: string; note: string }
  tombstone: {
    deleted: boolean
    deletedAt: string
    deletedReason: string
    supersededBy: string
    supersededByContent: string
    supersededFrom: Array<{ id: string; content: string }>
  }
  retrieval: {
    score: number
    matchedBy: string
    signals: { relevance: number; importance: number; recency: number }
  }
  protected: boolean
}

function toExplain(v: unknown): MemoryExplain | undefined {
  if (!isRecord(v)) return undefined
  const timingRec = pickRecord(v, 'timing') ?? {}
  const provenanceRec = pickRecord(v, 'provenance') ?? {}
  const tombstoneRec = pickRecord(v, 'tombstone') ?? {}
  const retrievalRec = pickRecord(v, 'retrieval') ?? {}
  const signalsRec = pickRecord(retrievalRec, 'signals') ?? {}
  return {
    memory: pickRecord(v, 'memory') ?? {},
    timing: {
      eventTime: asStr(timingRec.eventTime) ?? '',
      eventTimeRaw: asStr(timingRec.eventTimeRaw) ?? '',
      recordedAt: asStr(timingRec.recordedAt) ?? '',
      lastVerified: asStr(timingRec.lastVerified) ?? '',
      effectiveTime: asStr(timingRec.effectiveTime) ?? '',
      volatility: asStr(timingRec.volatility) ?? '',
      halfLifeDays: asNum(timingRec.halfLifeDays) ?? 0,
    },
    provenance: {
      kind: asStr(provenanceRec.kind) ?? '',
      note: asStr(provenanceRec.note) ?? '',
    },
    tombstone: {
      deleted: asBool(tombstoneRec.deleted) ?? false,
      deletedAt: asStr(tombstoneRec.deletedAt) ?? '',
      deletedReason: asStr(tombstoneRec.deletedReason) ?? '',
      supersededBy: asStr(tombstoneRec.supersededBy) ?? '',
      supersededByContent: asStr(tombstoneRec.supersededByContent) ?? '',
      supersededFrom: pickArray(tombstoneRec, 'supersededFrom')
        .filter(isRecord)
        .map((r) => ({ id: asStr(r.id) ?? '', content: asStr(r.content) ?? '' })),
    },
    retrieval: {
      score: asNum(retrievalRec.score) ?? 0,
      matchedBy: asStr(retrievalRec.matchedBy) ?? '',
      signals: {
        relevance: asNum(signalsRec.relevance) ?? 0,
        importance: asNum(signalsRec.importance) ?? 0,
        recency: asNum(signalsRec.recency) ?? 0,
      },
    },
    protected: asBool(v.protected) ?? false,
  }
}

export interface ConsolidatePreview {
  pending: number
  note: string
}

export interface ConsolidateResult {
  before: number
  deleted: number
  compressed: number
  kept: number
  recentProtected: number
}

export const memoriesApi = {
  async list(botId: string, options: { sender?: string; includeDeleted?: boolean } = {}): Promise<Memory[]> {
    const out = await http.get<unknown>('/api/memories', {
      botId,
      sender: options.sender,
      includeDeleted: options.includeDeleted === true ? 'true' : undefined,
    })
    const rec = isRecord(out) ? out : {}
    return pickArray(rec, 'memories')
      .map(toMemory)
      .filter((m): m is Memory => m !== undefined)
  },
  async create(input: MemoryCreateInput): Promise<{ dupSkipped: boolean }> {
    const out = await http.post<unknown>('/api/memories', input)
    const rec = isRecord(out) ? out : {}
    return { dupSkipped: asBool(rec.dupSkipped) ?? false }
  },
  async update(id: string, patch: MemoryUpdateInput): Promise<void> {
    await http.patch(`/api/memories/${encodeURIComponent(id)}`, patch)
  },
  /** 软删 = 淡忘（进淡忘池，可恢复）。 */
  async forget(id: string): Promise<void> {
    await http.del(`/api/memories/${encodeURIComponent(id)}`)
  },
  async restore(id: string): Promise<void> {
    await http.post(`/api/memories/${encodeURIComponent(id)}/restore`)
  },
  async explain(botId: string, id: string): Promise<MemoryExplain | undefined> {
    const out = await http.get<unknown>(`/api/memories/${encodeURIComponent(id)}/explain`, { botId })
    return toExplain(out)
  },
  async consolidate(botId: string, sender: string, dryRun: boolean): Promise<ConsolidatePreview | ConsolidateResult> {
    const out = await http.post<unknown>('/api/memories/consolidate', { botId, sender, dryRun })
    const rec = isRecord(out) ? out : {}
    if (asBool(rec.dryRun) === true) {
      return { pending: asNum(rec.pending) ?? 0, note: asStr(rec.note) ?? '' }
    }
    return {
      before: asNum(rec.before) ?? 0,
      deleted: asNum(rec.deleted) ?? 0,
      compressed: asNum(rec.compressed) ?? 0,
      kept: asNum(rec.kept) ?? 0,
      recentProtected: asNum(rec.recentProtected) ?? 0,
    }
  },
}
