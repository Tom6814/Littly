/**
 * 「她」域 API 封装（世界书 / 铁律 / 成长 / 相册 / 日记）。
 *
 * 为什么不放进 `@/api/endpoints.ts`：那是 fe-core 的写域，本目录的页面只
 * 从这里 import；接口契约对齐 console-api 的 routes-content.ts / routes-data.ts /
 * routes-admin.ts（2026-10-31 HEAD）。全部用 `@/api/client` 的 http 助手，
 * 成功后端已解包为 `data`。
 */
import { asBool, asNum, asStr, firstOf, http, isRecord, pickArray, pickRecord } from '@/api/client'

/* ---------------- 世界书 ---------------- */

export interface WorldEntry {
  id: string
  botId: string
  characterId: string
  keys: string[]
  secondKeys: string[]
  /** 后端只有 4 个值：AND_ANY / NOT_ALL / NOT_ANY / AND_ALL。 */
  logic: string
  probability: number
  priority: number
  position: 'before' | 'after' | string
  constant: boolean
  enabled: boolean
  content: string
  comment: string
}

function toWorldEntry(v: unknown): WorldEntry | undefined {
  if (!isRecord(v)) return undefined
  const id = asStr(v.id)
  if (!id) return undefined
  return {
    id,
    botId: asStr(v.botId) ?? '',
    characterId: asStr(v.characterId) ?? '',
    keys: pickArray(v, 'keys').map((k) => String(k) ?? '').filter(Boolean),
    secondKeys: pickArray(v, 'secondKeys').map((k) => String(k) ?? '').filter(Boolean),
    logic: asStr(v.logic) ?? 'AND_ANY',
    probability: asNum(v.probability) ?? 85,
    priority: asNum(v.priority) ?? 100,
    position: asStr(v.position) ?? 'after',
    constant: asBool(v.constant) ?? false,
    enabled: asBool(v.enabled) ?? true,
    content: asStr(v.content) ?? '',
    comment: asStr(v.comment) ?? '',
  }
}

export interface WorldEntryInput {
  botId: string
  keys: string[]
  secondKeys: string[]
  logic: string
  probability: number
  priority: number
  position: 'before' | 'after'
  constant: boolean
  enabled: boolean
  content: string
  comment: string
}

export const worldbookApi = {
  async list(botId: string): Promise<WorldEntry[]> {
    const out = await http.get<unknown>('/api/world-entries', { botId })
    const rec = isRecord(out) ? out : {}
    return pickArray(rec, 'entries')
      .map(toWorldEntry)
      .filter((e): e is WorldEntry => e !== undefined)
  },
  async create(input: WorldEntryInput): Promise<void> {
    await http.post('/api/world-entries', input)
  },
  async update(id: string, input: WorldEntryInput): Promise<void> {
    await http.patch(`/api/world-entries/${encodeURIComponent(id)}`, input)
  },
  async remove(id: string): Promise<void> {
    await http.del(`/api/world-entries/${encodeURIComponent(id)}`)
  },
  /** 命中测试：与正式匹配共用 evaluateWorldEntry（纯函数，不掷概率）。 */
  async test(botId: string, text: string): Promise<string[]> {
    const out = await http.post<unknown>('/api/world-entries/test', { botId, text })
    const rec = isRecord(out) ? out : {}
    return pickArray(rec, 'matchedIds')
      .map((x) => String(x ?? ''))
      .filter(Boolean)
  },
}

/* ---------------- 铁律 ---------------- */

export interface PersonaRules {
  content: string
  enabled: boolean
  updatedAt?: string
}

export const rulesApi = {
  async get(botId: string): Promise<PersonaRules> {
    const out = await http.get<unknown>('/api/persona-rules', { botId })
    const rec = isRecord(out) ? out : {}
    return {
      content: asStr(rec.content) ?? '',
      enabled: asBool(rec.enabled) ?? true,
      updatedAt: asStr(rec.updatedAt),
    }
  },
  async put(botId: string, input: { content: string; enabled: boolean }): Promise<void> {
    await http.put('/api/persona-rules', input, { query: { botId } })
  },
}

/* ---------------- 成长 ---------------- */

export interface GrowthDimension {
  name: string
  level: number
  max?: number
  description?: string
}

export interface GrowthVersion {
  version?: number
  createdAt?: string
  summary?: string
  author?: string
}

export interface GrowthProposal {
  id: string
  status?: string
  summary?: string
  evidence: string[]
  /** 结构化提案变更（批准改后重提时原样回传数组）。 */
  changesParsed: Record<string, unknown>[]
  majorEvents?: string
  lifeStageNext?: string
  trigger?: string
  basedVersion?: number
  report?: string
  createdAt?: string
  expiresAt?: string
}

export interface GrowthData {
  profile: {
    version?: number
    lifeStage?: string
    createdAt?: string
    summary?: string
    report?: string
    dimensions: GrowthDimension[]
  } | null
  dimensions: GrowthDimension[]
  versions: GrowthVersion[]
  proposals: GrowthProposal[]
  window?: { nextAt?: string; lastAt?: string; reason?: string }
  reviewWindowOpen?: boolean
  nextReviewAt?: string
  nextReviewText?: string
}

function toDim(v: unknown): GrowthDimension | undefined {
  if (!isRecord(v)) return undefined
  const name = asStr(v.name)
  if (!name) return undefined
  return {
    name,
    level: asNum(v.level) ?? 0,
    max: asNum(v.max),
    description: asStr(v.description),
  }
}

function toProposal(v: unknown): GrowthProposal | undefined {
  if (!isRecord(v)) return undefined
  const id = asStr(v.id)
  if (!id) return undefined
  return {
    id,
    status: asStr(v.status),
    summary: asStr(v.summary),
    evidence: pickArray(v, 'evidence').map((x) => String(x ?? '')).filter(Boolean),
    changesParsed: pickArray(v, 'changesParsed').filter(isRecord),
    majorEvents: asStr(v.majorEvents),
    lifeStageNext: asStr(v.lifeStageNext),
    trigger: asStr(v.trigger),
    basedVersion: asNum(v.basedVersion),
    report: asStr(v.report),
    createdAt: asStr(v.createdAt),
    expiresAt: asStr(v.expiresAt),
  }
}

export const growthApi = {
  async get(botId: string): Promise<GrowthData> {
    const out = await http.get<unknown>('/api/growth', { botId })
    const rec = isRecord(out) ? out : {}
    const profileRec = pickRecord(rec, 'profile')
    const profile = profileRec
      ? {
          version: asNum(profileRec.version),
          lifeStage: asStr(profileRec.lifeStage),
          createdAt: asStr(profileRec.createdAt),
          summary: asStr(profileRec.summary),
          report: asStr(profileRec.report),
          dimensions: pickArray(profileRec, 'dimensions')
            .map(toDim)
            .filter((d): d is GrowthDimension => d !== undefined),
        }
      : null
    const dims = pickArray(rec, 'dimensions')
      .map(toDim)
      .filter((d): d is GrowthDimension => d !== undefined)
    const versionRecs = pickArray(rec, 'versions').filter(isRecord)
    const proposalRecs = pickArray(rec, 'proposals').filter(isRecord)
    const windowRec = pickRecord(rec, 'window')
    return {
      profile,
      dimensions: dims.length > 0 ? dims : (profile?.dimensions ?? []),
      versions: versionRecs.map((v) => ({
        version: asNum(v.version),
        createdAt: asStr(v.createdAt),
        summary: asStr(v.summary),
        author: asStr(v.author),
      })),
      proposals: proposalRecs
        .map(toProposal)
        .filter((p): p is GrowthProposal => p !== undefined)
        .filter((p) => !p.status || p.status === 'pending' || p.status === 'proposed'),
      window: windowRec
        ? {
            nextAt: asStr(firstOf(windowRec, 'nextAt')) ?? asStr(rec.nextReviewAt),
            lastAt: asStr(windowRec.lastAt),
            reason: asStr(windowRec.reason) ?? asStr(rec.nextReviewText),
          }
        : undefined,
      reviewWindowOpen: asBool(rec.reviewWindowOpen),
      nextReviewAt: asStr(rec.nextReviewAt),
      nextReviewText: asStr(rec.nextReviewText),
    }
  },
  /** action: seed / evaluate / repropose / rollback（后端 action 分发）。 */
  async action(botId: string, action: 'seed' | 'evaluate' | 'repropose' | 'rollback', version?: number): Promise<void> {
    await http.post('/api/growth', { botId, action, ...(version !== undefined ? { version } : {}) })
  },
  async decide(id: string, decision: 'approve' | 'approve_edited' | 'reject' | 'cancel', changes?: unknown[]): Promise<void> {
    await http.post(`/api/growth/proposals/${encodeURIComponent(id)}`, {
      decision,
      ...(changes !== undefined ? { changes } : {}),
    })
  },
}

/* ---------------- 相册 ---------------- */

export type PhotoSemanticStatus = 'none' | 'pending' | 'done' | 'failed'

export interface Photo {
  id: string
  botId: string
  url: string
  caption: string
  tags: string[]
  sha256: string
  mime: string
  category: string
  semanticStatus: PhotoSemanticStatus
  semanticAt: string
  semanticError: string
  meme: string
  createdAt?: string
}

export interface PhotoAnalyzeResult {
  analyzed: number
  failed: number
  skipped: number
  configured: boolean
  error: string
}

function toPhotoStatus(raw: string | undefined): PhotoSemanticStatus {
  return raw === 'pending' || raw === 'done' || raw === 'failed' ? raw : 'none'
}

function toPhoto(v: unknown): Photo | undefined {
  if (!isRecord(v)) return undefined
  const id = asStr(v.id)
  if (!id) return undefined
  return {
    id,
    botId: asStr(v.botId) ?? '',
    url: asStr(v.url) ?? '',
    caption: asStr(v.caption) ?? '',
    tags: pickArray(v, 'tags').map((t) => String(t ?? '')).filter(Boolean),
    sha256: asStr(v.sha256) ?? '',
    mime: asStr(v.mime) ?? '',
    category: asStr(v.category) ?? '',
    semanticStatus: toPhotoStatus(asStr(v.semanticStatus)),
    semanticAt: asStr(v.semanticAt) ?? '',
    semanticError: asStr(v.semanticError) ?? '',
    meme: asStr(v.meme) ?? '',
    createdAt: asStr(v.createdAt),
  }
}

export const albumApi = {
  async list(botId: string): Promise<Photo[]> {
    const out = await http.get<unknown>('/api/photos', { botId })
    const rec = isRecord(out) ? out : {}
    return pickArray(rec, 'photos')
      .map(toPhoto)
      .filter((p): p is Photo => p !== undefined)
  },
  async upload(botId: string, file: File, caption = ''): Promise<void> {
    const fd = new FormData()
    fd.append('file', file)
    if (caption) fd.append('caption', caption)
    await http.upload(`/api/photos?botId=${encodeURIComponent(botId)}`, fd)
  },
  async update(id: string, botId: string, patch: { caption?: string; tags?: string[] }): Promise<void> {
    await http.patch(`/api/photos/${encodeURIComponent(id)}`, patch, { query: { botId } })
  },
  async analyze(botId: string, opts: { ids?: string[]; limit?: number } = {}): Promise<PhotoAnalyzeResult> {
    const out = await http.post<unknown>('/api/photos/analyze', { botId, ...opts })
    const rec = isRecord(out) ? out : {}
    return {
      analyzed: asNum(rec.analyzed) ?? 0,
      failed: asNum(rec.failed) ?? 0,
      skipped: asNum(rec.skipped) ?? 0,
      configured: asBool(rec.configured) ?? true,
      error: asStr(rec.error) ?? '',
    }
  },
  async remove(id: string, botId: string): Promise<void> {
    await http.del(`/api/photos/${encodeURIComponent(id)}`, { query: { botId } })
  },
}

/* ---------------- 日记 ---------------- */

export interface Diary {
  id: string
  botId: string
  date: string
  content: string
  mood: string
  createdAt?: string
}

function toDiary(v: unknown): Diary | undefined {
  if (!isRecord(v)) return undefined
  const id = asStr(v.id)
  if (!id) return undefined
  return {
    id,
    botId: asStr(v.botId) ?? '',
    date: asStr(v.date) ?? '',
    content: asStr(v.content) ?? '',
    mood: asStr(v.mood) ?? '',
    createdAt: asStr(v.createdAt),
  }
}

export const diaryApi = {
  async list(botId: string): Promise<Diary[]> {
    const out = await http.get<unknown>('/api/diaries', { botId })
    const rec = isRecord(out) ? out : {}
    return pickArray(rec, 'diaries')
      .map(toDiary)
      .filter((d): d is Diary => d !== undefined)
      .sort((a, b) => b.date.localeCompare(a.date))
  },
  async get(id: string): Promise<Diary | undefined> {
    const out = await http.get<unknown>(`/api/diaries/${encodeURIComponent(id)}`)
    const rec = isRecord(out) ? out : {}
    return toDiary(rec.diary ?? out)
  },
  async write(botId: string): Promise<{ alreadyWritten: boolean }> {
    const out = await http.post<unknown>('/api/diaries/write', { botId })
    const rec = isRecord(out) ? out : {}
    return { alreadyWritten: asBool(rec.alreadyWritten) ?? false }
  },
  async remove(id: string): Promise<void> {
    await http.del(`/api/diaries/${encodeURIComponent(id)}`)
  },
}
