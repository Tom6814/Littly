/**
 * @littly/growth — 人格成长系统（§12）。
 *
 * 移植自旧项目 src/internal/growth/*（959 行）与两份 API 路由。
 * 行为契约（docs/PRINCIPLES.md §三.5-7，必须原样保留）：
 * - 角色卡永远只读；人格以档案形式按月漂移，需人工审批（提议-审批制，永不静默生效）。
 * - 成长三铁律：证据链 ≥2 条、单维 ≤±1 级、总位移 ≤6 级、价值禁区。服务端硬校验，提示词只是告知。
 * - 事实审计以对话原文为金标准；对抗质询常开，职责是证伪。
 * - 月度评审固定在自然月月底（中国时区），非「距上次 30 天」滚动。
 *
 * 本插件提供：档案 seed / 月度评审 / 提案裁决 / 版本回滚 / [2.4] 注入文本。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { LittlyStorage } from '@littly/storage'
import { ensureGrowthProfile } from './dimensions.ts'
import { runGrowthEvaluation, growthTick, type EvalOutcome, type EvalTrigger } from './evaluator.ts'
import { generateGrowthReport } from './report.ts'
import { getActiveGrowthText } from './inject.ts'
import {
  applyChangesToDims,
  parseChanges,
  parseDimensions,
  parseValueExclusions,
  validateProposalChanges,
  validateValueExclusions,
  type GrowthChange,
} from './types.ts'
import { fmtShanghai, isMonthEndWindow, nextMonthEnd } from './timing.ts'
import {
  activeProfile,
  archiveActive,
  createProfile,
  expireStaleProposals,
  firstProfile,
  listAllProposals,
  listProfiles,
  maxProfileVersion,
  parseProposalMeta,
  proposalById,
  setProposalStatus,
  writeAudit,
  type GrowthProfileRow,
  type GrowthProposalRow,
} from './store.ts'

export const name = 'littly-growth'

export const inject = ['littlyStorage']

declare module '@deepseek-ai/cordis' {
  interface Context {
    littlyGrowth: LittlyGrowth
  }
}

export interface Config {}

export const Config: z<Config> = z.object({})

export type DecideDecision = 'approve' | 'approve_edited' | 'reject' | 'cancel'

export interface DecideResult {
  ok: boolean
  error?: string
  status?: string
  profile?: { version: number; dimensions: string; lifeStage: string }
  report?: string | null
}

/** 控制台用的成长快照（档案 + 提案 + 评审窗口）。 */
export interface GrowthSnapshot {
  profile: GrowthProfileRow | null
  dimensionsParsed: ReturnType<typeof parseDimensions>
  versions: GrowthProfileRow[]
  pendingProposals: GrowthProposalRow[]
  history: GrowthProposalRow[]
  reviewWindowOpen: boolean
  nextReviewAt: string
  nextReviewText: string
}

export class LittlyGrowth {
  private readonly storage: LittlyStorage

  constructor(storage: LittlyStorage) {
    this.storage = storage
  }

  /** [2.4] 注入文本（fail-open：没有档案时返回 undefined）。 */
  getActiveText(botId: string): string | undefined {
    return getActiveGrowthText(this.storage, botId)
  }

  /** 确保存在 active 档案（缺失时由潜意识推导 v1）。 */
  ensureProfile(botId: string, model?: string): Promise<{ id: string; version: number; dimensions: string; lifeStage: string } | null> {
    return ensureGrowthProfile(this.storage, botId, model)
  }

  /** 单次评审（manual 触发豁免月底窗口守卫）。 */
  evaluate(botId: string, trigger: EvalTrigger = 'manual'): Promise<EvalOutcome> {
    return runGrowthEvaluation(this.storage, botId, trigger)
  }

  /** 月度 tick（scheduler 调用）。 */
  tick(now: Date = new Date()): Promise<{ evaluated: number; created: number }> {
    return growthTick(this.storage, now)
  }

  /**
   * B10：设置当前生效档案的「价值禁区」（不可被成长改写的人格边界词）。
   * 存 active 档案的 value_exclusions 列（JSON 字符串数组），随版本冻结继承。
   *
   * @param botId - bot 行 id
   * @param input - 禁区词数组（每个 ≤ 40 字，去重，最多 20 条；空数组 = 清除禁区）
   * @returns 归一化后的禁区列表
   */
  setValueExclusions(botId: string, input: unknown): { ok: true; valueExclusions: string[] } | { ok: false; error: string } {
    if (!Array.isArray(input)) return { ok: false, error: 'exclusions 需为字符串数组' }
    const normalized: string[] = []
    for (const raw of input) {
      if (typeof raw !== 'string') return { ok: false, error: 'exclusions 需为字符串数组' }
      const word = raw.trim()
      if (word === '') continue
      if (word.length > 40) return { ok: false, error: `禁区词过长（≤40 字）：${word.slice(0, 20)}…` }
      if (!normalized.includes(word)) normalized.push(word)
    }
    if (normalized.length > 20) return { ok: false, error: '禁区最多 20 条' }
    const active = activeProfile(this.storage, botId)
    if (!active) return { ok: false, error: '尚无成长档案（先生成初始档案）' }
    this.storage
      .prepare('UPDATE growth_profiles SET value_exclusions = ? WHERE id = ?')
      .run(JSON.stringify(normalized), active.id)
    writeAudit(this.storage, botId, 'value_exclusions', `set ${JSON.stringify(normalized)}`)
    return { ok: true, valueExclusions: normalized }
  }

  /** B10：读取当前生效档案的价值禁区。 */
  getValueExclusions(botId: string): string[] {
    const active = activeProfile(this.storage, botId)
    return active ? parseValueExclusions(active.value_exclusions) : []
  }

  /** 重新评审：取消当前待审提案 + 立即以 manual 触发重新评审。 */
  async repropose(botId: string): Promise<{ outcome: EvalOutcome; discarded: number }> {
    const pendings = this.storage
      .prepare("SELECT * FROM growth_proposals WHERE bot_id = ? AND status = 'pending'")
      .all(botId) as unknown as GrowthProposalRow[]
    for (const p of pendings) {
      setProposalStatus(this.storage, p.id, 'cancelled')
      writeAudit(this.storage, botId, 'cancel', `repropose discard proposal=${p.id} base=v${p.based_version}`)
    }
    const outcome = await this.evaluate(botId, 'manual')
    return { outcome, discarded: pendings.length }
  }

  /** 控制台快照。 */
  snapshot(botId: string): GrowthSnapshot {
    expireStaleProposals(this.storage, botId)
    const profile = activeProfile(this.storage, botId) ?? null
    const all = listAllProposals(this.storage, botId)
    const now = new Date()
    return {
      profile,
      dimensionsParsed: profile ? parseDimensions(profile.dimensions) : [],
      versions: listProfiles(this.storage, botId),
      pendingProposals: all.filter((p) => p.status === 'pending'),
      history: all.filter((p) => p.status !== 'pending').slice(0, 30),
      reviewWindowOpen: isMonthEndWindow(now),
      nextReviewAt: nextMonthEnd(now).toISOString(),
      nextReviewText: fmtShanghai(nextMonthEnd(now)),
    }
  }

  /**
   * 提案裁决：批准 / 编辑后批准 / 驳回 / 取消。
   * 批准时在服务端重放全部铁律硬校验（不信任前端），校验 based_version 并发护栏，
   * 事务内完成版本切换；批准后异步生成人格执笔报告（fail-open，纯展示）。
   */
  async decide(
    proposalId: string,
    decision: DecideDecision,
    editedChanges?: unknown,
  ): Promise<DecideResult> {
    if (!['approve', 'approve_edited', 'reject', 'cancel'].includes(decision)) {
      return { ok: false, error: 'decision 无效' }
    }
    const proposal = proposalById(this.storage, proposalId)
    if (!proposal) return { ok: false, error: '提案不存在' }
    if (proposal.status !== 'pending') return { ok: false, error: `提案已处理（${proposal.status}）` }
    if (proposal.expires_at && proposal.expires_at < new Date().toISOString()) {
      setProposalStatus(this.storage, proposalId, 'expired')
      return { ok: false, error: '提案已过期' }
    }

    const botId = proposal.bot_id

    // --- 取消（软删）：状态化归档，不物理删除。不影响后续评审（lastTouch 排除 cancelled） ---
    if (decision === 'cancel') {
      setProposalStatus(this.storage, proposalId, 'cancelled')
      writeAudit(this.storage, botId, 'cancel', `proposal=${proposalId} base=v${proposal.based_version}`)
      return { ok: true, status: 'cancelled' }
    }

    // --- 驳回 ---
    if (decision === 'reject') {
      setProposalStatus(this.storage, proposalId, 'rejected')
      writeAudit(this.storage, botId, 'reject', `proposal=${proposalId}`)
      return { ok: true, status: 'rejected' }
    }

    // --- 批准 / 编辑后批准：服务端重放硬校验 ---
    const active = activeProfile(this.storage, botId)
    if (!active) return { ok: false, error: '当前没有生效的成长档案' }
    // 并发护栏：评审基于的版本必须仍是生效版本，否则编辑稿可能建立在陈旧状态上
    if (active.version !== proposal.based_version) {
      return {
        ok: false,
        error: `版本冲突：提案基于 v${proposal.based_version}，当前已是 v${active.version}，请驳回后重新评审`,
      }
    }

    let changes: GrowthChange[] =
      decision === 'approve_edited'
        ? (Array.isArray(editedChanges) ? editedChanges : []).filter(
            (c): c is GrowthChange =>
              c !== null &&
              typeof c === 'object' &&
              typeof (c as Record<string, unknown>)['dimension'] === 'string' &&
              Number.isFinite((c as Record<string, unknown>)['fromLevel']) &&
              Number.isFinite((c as Record<string, unknown>)['toLevel']),
          )
        : parseChanges(proposal.changes)
    if (changes.length === 0) return { ok: false, error: '没有任何变更可批准' }

    const baseDims = parseDimensions(active.dimensions)
    const seedRow = firstProfile(this.storage, botId)
    const seedDims = seedRow && seedRow.version !== active.version ? parseDimensions(seedRow.dimensions) : null

    // 证据存在性硬校验（以数据库为准，不信任提案文本）
    const allEvidenceIds = [...new Set(changes.flatMap((c) => (Array.isArray(c.evidenceIds) ? c.evidenceIds : [])))]
    const evidenceSet = new Set<string>()
    if (allEvidenceIds.length > 0) {
      const placeholders = allEvidenceIds.map(() => '?').join(',')
      const existing = this.storage
        .prepare(`SELECT id FROM memories WHERE bot_id = ? AND id IN (${placeholders})`)
        .all(botId, ...allEvidenceIds) as unknown as Array<{ id: string }>
      for (const row of existing) evidenceSet.add(row.id)
    }

    const v = validateProposalChanges(baseDims, seedDims, changes, evidenceSet)
    if (!v.ok) return { ok: false, error: `铁律校验未通过：${v.errors.join('；')}` }
    // B10：审批时重放价值禁区硬校验（编辑稿也不得触碰禁区；空列表 no-op）。
    const vZone = validateValueExclusions(active.value_exclusions, changes)
    if (!vZone.ok) return { ok: false, error: `价值禁区校验未通过：${vZone.errors.join('；')}` }

    const newDims = applyChangesToDims(baseDims, changes)
    const nextVersion = maxProfileVersion(this.storage, botId) + 1
    const meta = parseProposalMeta(proposal.evidence)
    const lifeStageNext = meta.lifeStageNext || active.life_stage

    // 事务内：归档旧版本 → 写新版本 → 提案落终态
    this.storage.db.exec('BEGIN IMMEDIATE')
    try {
      archiveActive(this.storage, botId)
      createProfile(this.storage, {
        botId,
        version: nextVersion,
        dimensions: JSON.stringify(newDims),
        lifeStage: lifeStageNext,
        valueExclusions: active.value_exclusions, // 核心价值禁区随版本冻结继承（D 设计）
        derivedFrom: proposal.id,
        active: true,
      })
      setProposalStatus(this.storage, proposalId, decision === 'approve_edited' ? 'edited' : 'approved',
        // 编辑稿以最终批准内容为准落库，保证审计链完整
        decision === 'approve_edited' ? { changes: JSON.stringify(changes) } : {})
      this.storage.db.exec('COMMIT')
    } catch (err) {
      this.storage.db.exec('ROLLBACK')
      return { ok: false, error: `版本切换失败：${err instanceof Error ? err.message : String(err)}` }
    }

    writeAudit(
      this.storage,
      botId,
      decision,
      `v${active.version}→v${nextVersion} dims=${changes.map((c) => `${c.dimension}:${c.fromLevel}→${c.toLevel}`).join(',')}`,
    )

    // 人格执笔报告（纯展示；失败不影响审批结果）
    const report = await generateGrowthReport(this.storage, botId, proposalId)

    return {
      ok: true,
      status: decision === 'approve_edited' ? 'edited' : 'approved',
      profile: { version: nextVersion, dimensions: JSON.stringify(newDims), lifeStage: lifeStageNext },
      report,
    }
  }

  /**
   * 归档式回滚：不篡改历史，复制目标版本为新的最高版本并激活。
   */
  rollback(botId: string, version: number): { ok: boolean; error?: string; profile?: GrowthProfileRow } {
    if (!Number.isInteger(version) || version < 1) return { ok: false, error: 'version 无效' }
    const source = this.storage
      .prepare('SELECT * FROM growth_profiles WHERE bot_id = ? AND version = ?')
      .get(botId, version) as GrowthProfileRow | undefined
    if (!source) return { ok: false, error: '目标版本不存在' }

    const active = activeProfile(this.storage, botId)
    if (active && active.version === version) return { ok: false, error: '该版本已是当前生效版本' }

    const nextVersion = maxProfileVersion(this.storage, botId) + 1
    this.storage.db.exec('BEGIN IMMEDIATE')
    try {
      archiveActive(this.storage, botId)
      const restored = createProfile(this.storage, {
        botId,
        version: nextVersion,
        dimensions: source.dimensions,
        lifeStage: source.life_stage,
        valueExclusions: source.value_exclusions,
        derivedFrom: `rollback:v${version}`,
        active: true,
      })
      this.storage.db.exec('COMMIT')
      writeAudit(this.storage, botId, 'rollback', `restored v${version} as v${nextVersion}`)
      return { ok: true, profile: restored }
    } catch (err) {
      this.storage.db.exec('ROLLBACK')
      return { ok: false, error: `回滚失败：${err instanceof Error ? err.message : String(err)}` }
    }
  }
}

export function apply(ctx: Context, _config: Config): void {
  const growth = new LittlyGrowth(ctx.littlyStorage as LittlyStorage)
  ctx.provide('littlyGrowth', growth)
  ctx.logger.info('littly growth ready')
}

export { getActiveGrowthText, ensureGrowthProfile, runGrowthEvaluation, growthTick, generateGrowthReport }
export type { EvalOutcome, EvalTrigger }
export { parseDimensions, parseChanges, parseProposalMeta }
// B9：调度器（scheduler）接线成长 tick 时需要判断月底窗口/上海日期键。
export { isMonthEndWindow, shanghaiMonthKey, shanghaiParts, daysInShanghaiMonth, nextMonthEnd, fmtShanghai } from './timing.ts'
