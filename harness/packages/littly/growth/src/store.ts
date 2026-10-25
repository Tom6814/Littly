/**
 * §成长档案 — 存储访问层（growth_profiles / growth_proposals / audit_logs）。
 *
 * 与旧项目的差异（schema 已按新仓库约定落库）：
 * - 旧 GrowthProfile.active(boolean) → 新 status('active'|'archived')
 * - 旧 GrowthProfile.values → 新 value_exclusions
 * - 旧 GrowthProposal.baseVersion → 新 based_version
 * - 旧 GrowthProposal.trigger/adversarial/majorEvents/lifeStageNext → 新 evidence(JSON 信封)
 * - 旧 GrowthProposal.reportDraft → 新 report
 */
import { randomUUID } from 'node:crypto'
import type { LittlyStorage } from '@littly/storage'
import { parseAdversarial, type AdversarialVerdict } from './types.ts'

export interface GrowthProfileRow {
  id: string
  bot_id: string
  version: number
  status: 'active' | 'archived'
  dimensions: string
  life_stage: string
  value_exclusions: string
  derived_from: string | null
  created_at: string
}

export interface GrowthProposalRow {
  id: string
  bot_id: string
  based_version: number
  status: 'pending' | 'approved' | 'edited' | 'rejected' | 'expired' | 'cancelled'
  changes: string
  evidence: string
  report: string
  evaluator_model: string
  created_at: string
  decided_at: string | null
  expires_at: string | null
}

/** 提案元数据信封（旧库的 trigger/adversarial/majorEvents/lifeStageNext 合并存放） */
export interface ProposalMeta {
  trigger?: string | undefined
  adversarial?: AdversarialVerdict | null | undefined
  majorEvents?: string | undefined
  lifeStageNext?: string | undefined
  evidenceIds?: string[] | undefined
}

export function parseProposalMeta(raw: string): ProposalMeta {
  if (!raw) return {}
  try {
    const j = JSON.parse(raw) as unknown
    if (!j || typeof j !== 'object') return {}
    const rec = j as Record<string, unknown>
    const adv = rec['adversarial']
    return {
      trigger: typeof rec['trigger'] === 'string' ? rec['trigger'] : undefined,
      adversarial: adv && typeof adv === 'object' ? (adv as AdversarialVerdict) : null,
      majorEvents: typeof rec['majorEvents'] === 'string' ? rec['majorEvents'] : undefined,
      lifeStageNext: typeof rec['lifeStageNext'] === 'string' ? rec['lifeStageNext'] : undefined,
      evidenceIds: Array.isArray(rec['evidenceIds'])
        ? rec['evidenceIds'].filter((x: unknown): x is string => typeof x === 'string')
        : undefined,
    }
  } catch {
    return {}
  }
}

export function serializeProposalMeta(meta: ProposalMeta): string {
  return JSON.stringify(meta)
}

// --- 档案 ---

export function activeProfile(storage: LittlyStorage, botId: string): GrowthProfileRow | undefined {
  return storage
    .prepare("SELECT * FROM growth_profiles WHERE bot_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1")
    .get(botId) as GrowthProfileRow | undefined
}

export function profileByVersion(storage: LittlyStorage, botId: string, version: number): GrowthProfileRow | undefined {
  return storage
    .prepare('SELECT * FROM growth_profiles WHERE bot_id = ? AND version = ?')
    .get(botId, version) as GrowthProfileRow | undefined
}

export function firstProfile(storage: LittlyStorage, botId: string): GrowthProfileRow | undefined {
  return storage
    .prepare('SELECT * FROM growth_profiles WHERE bot_id = ? ORDER BY version ASC LIMIT 1')
    .get(botId) as GrowthProfileRow | undefined
}

export function listProfiles(storage: LittlyStorage, botId: string): GrowthProfileRow[] {
  return storage
    .prepare('SELECT * FROM growth_profiles WHERE bot_id = ? ORDER BY version DESC')
    .all(botId) as unknown as GrowthProfileRow[]
}

export function maxProfileVersion(storage: LittlyStorage, botId: string): number {
  const row = storage
    .prepare('SELECT MAX(version) AS v FROM growth_profiles WHERE bot_id = ?')
    .get(botId) as { v: number | null } | undefined
  return row?.v ?? 0
}

export function createProfile(
  storage: LittlyStorage,
  input: {
    botId: string
    version: number
    dimensions: string
    lifeStage: string
    valueExclusions: string
    derivedFrom: string
    active: boolean
  },
): GrowthProfileRow {
  const id = randomUUID()
  const now = new Date().toISOString()
  storage
    .prepare(
      'INSERT INTO growth_profiles (id, bot_id, version, status, dimensions, life_stage, value_exclusions, derived_from, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    )
    .run(
      id,
      input.botId,
      input.version,
      input.active ? 'active' : 'archived',
      input.dimensions,
      input.lifeStage,
      input.valueExclusions,
      input.derivedFrom,
      now,
    )
  return {
    id,
    bot_id: input.botId,
    version: input.version,
    status: input.active ? 'active' : 'archived',
    dimensions: input.dimensions,
    life_stage: input.lifeStage,
    value_exclusions: input.valueExclusions,
    derived_from: input.derivedFrom,
    created_at: now,
  }
}

/** 归档当前生效版本（批准/回滚时切换版本用）。 */
export function archiveActive(storage: LittlyStorage, botId: string): void {
  storage.prepare("UPDATE growth_profiles SET status = 'archived' WHERE bot_id = ? AND status = 'active'").run(botId)
}

// --- 提案 ---

export function listProposalsByStatus(
  storage: LittlyStorage,
  botId: string,
  status: GrowthProposalRow['status'],
): GrowthProposalRow[] {
  return storage
    .prepare('SELECT * FROM growth_proposals WHERE bot_id = ? AND status = ? ORDER BY created_at DESC')
    .all(botId, status) as unknown as GrowthProposalRow[]
}

export function listAllProposals(storage: LittlyStorage, botId: string): GrowthProposalRow[] {
  return storage
    .prepare('SELECT * FROM growth_proposals WHERE bot_id = ? ORDER BY created_at DESC')
    .all(botId) as unknown as GrowthProposalRow[]
}

export function proposalById(storage: LittlyStorage, id: string): GrowthProposalRow | undefined {
  return storage.prepare('SELECT * FROM growth_proposals WHERE id = ?').get(id) as GrowthProposalRow | undefined
}

export function pendingProposal(storage: LittlyStorage, botId: string): GrowthProposalRow | undefined {
  return storage
    .prepare("SELECT * FROM growth_proposals WHERE bot_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1")
    .get(botId) as GrowthProposalRow | undefined
}

/** 最近一次非 cancelled 提案（成长事件计时用：被取消的提案视为从未发生）。 */
export function lastTouchProposal(storage: LittlyStorage, botId: string, afterIso: string): GrowthProposalRow | undefined {
  return storage
    .prepare("SELECT * FROM growth_proposals WHERE bot_id = ? AND created_at > ? AND status != 'cancelled' ORDER BY created_at DESC LIMIT 1")
    .get(botId, afterIso) as GrowthProposalRow | undefined
}

export function createProposal(
  storage: LittlyStorage,
  input: {
    botId: string
    basedVersion: number
    changes: string
    meta: ProposalMeta
    evaluatorModel: string
    expiresAt: string
  },
): GrowthProposalRow {
  const id = randomUUID()
  const now = new Date().toISOString()
  storage
    .prepare(
      'INSERT INTO growth_proposals (id, bot_id, based_version, status, changes, evidence, report, evaluator_model, created_at, decided_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      id,
      input.botId,
      input.basedVersion,
      'pending',
      input.changes,
      serializeProposalMeta(input.meta),
      '',
      input.evaluatorModel,
      now,
      null,
      input.expiresAt,
    )
  return {
    id,
    bot_id: input.botId,
    based_version: input.basedVersion,
    status: 'pending',
    changes: input.changes,
    evidence: serializeProposalMeta(input.meta),
    report: '',
    evaluator_model: input.evaluatorModel,
    created_at: now,
    decided_at: null,
    expires_at: input.expiresAt,
  }
}

export function setProposalStatus(
  storage: LittlyStorage,
  id: string,
  status: GrowthProposalRow['status'],
  opts: { changes?: string; report?: string } = {},
): void {
  const decided = new Date().toISOString()
  if (opts.changes !== undefined && opts.report !== undefined) {
    storage
      .prepare('UPDATE growth_proposals SET status = ?, changes = ?, report = ?, decided_at = ? WHERE id = ?')
      .run(status, opts.changes, opts.report, decided, id)
    return
  }
  if (opts.changes !== undefined) {
    storage
      .prepare('UPDATE growth_proposals SET status = ?, changes = ?, decided_at = ? WHERE id = ?')
      .run(status, opts.changes, decided, id)
    return
  }
  if (opts.report !== undefined) {
    storage
      .prepare('UPDATE growth_proposals SET status = ?, report = ?, decided_at = ? WHERE id = ?')
      .run(status, opts.report, decided, id)
    return
  }
  storage.prepare('UPDATE growth_proposals SET status = ?, decided_at = ? WHERE id = ?').run(status, decided, id)
}

export function setProposalReport(storage: LittlyStorage, id: string, report: string): void {
  storage.prepare('UPDATE growth_proposals SET report = ? WHERE id = ?').run(report, id)
}

/** 过期扫描：pending 超时 → expired（幂等，随时可调）。 */
export function expireStaleProposals(storage: LittlyStorage, botId?: string): number {
  const now = new Date().toISOString()
  if (botId) {
    const r = storage
      .prepare("UPDATE growth_proposals SET status = 'expired', decided_at = ? WHERE bot_id = ? AND status = 'pending' AND expires_at IS NOT NULL AND expires_at < ?")
      .run(now, botId, now)
    return Number(r.changes ?? 0)
  }
  const r = storage
    .prepare("UPDATE growth_proposals SET status = 'expired', decided_at = ? WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < ?")
    .run(now, now)
  return Number(r.changes ?? 0)
}

// --- 审计日志 ---

export function writeAudit(storage: LittlyStorage, botId: string, action: string, detail: string): void {
  storage
    .prepare('INSERT INTO audit_logs (id, bot_id, category, action, detail, created_at) VALUES (?,?,?,?,?,?)')
    .run(randomUUID(), botId, 'growth', action, detail, new Date().toISOString())
}

export { parseAdversarial }
