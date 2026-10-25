/**
 * §成长档案 — 人格成长系统共享类型与常量。
 *
 * 逐字移植自旧项目 src/internal/growth/types.ts（行为规格见旧仓库 docs/PROJECT-DESIGN.md §12）。
 * 角色卡只读；人格以 GrowthProfile 版本化漂移；一切变化走「提议-审批制」，
 * 服务端硬校验铁律，永不静默生效。
 */

export interface GrowthDimension {
  key: string      // 中文短词，如「外向性」「戒备心」
  level: number    // 1-5 离散等级
  desc: string     // 行为判据（当前等级的具体表现，非抽象标签）
}

export interface GrowthChange {
  dimension: string
  fromLevel: number
  toLevel: number
  toDesc?: string      // 变化后等级的行为判据（批准时写入新档案；空=沿用原判据）
  evidenceIds: string[] // 必须指向本次评审输入的证据材料（服务端存在性硬校验）
  reasoning: string
}

export interface AdversarialVerdict {
  verdict: 'pass' | 'reject'
  rejectDimensions: string[] // 被裁定不成立的维度（从提案中剔除）
  issues: string[]
}

// --- 事实审计（§幻觉治理） ---
// 记忆/日记是 AI 加工产物，可能失真；对话原文是金标准。
// 事实审计器对照对话原文逐条核实证据，失真证据在落库前被剔除。

export interface EvidenceAudit {
  verdict: 'pass' | 'reject'
  rejectEvidenceIds: string[] // 被判定为「无法被对话原文证实」的证据编号
  keepEvidenceIds: string[]   // 通过核实、可继续使用的证据编号
  issues: string[]
}

export function parseAudit(raw: string): EvidenceAudit | null {
  if (!raw) return null
  try {
    const j = JSON.parse(raw)
    if (!j || typeof j !== 'object') return null
    return {
      verdict: j.verdict === 'reject' ? 'reject' : 'pass',
      rejectEvidenceIds: Array.isArray(j.rejectEvidenceIds) ? j.rejectEvidenceIds.filter((x: unknown) => typeof x === 'string') : [],
      keepEvidenceIds: Array.isArray(j.keepEvidenceIds) ? j.keepEvidenceIds.filter((x: unknown) => typeof x === 'string') : [],
      issues: Array.isArray(j.issues) ? j.issues.filter((x: unknown) => typeof x === 'string') : [],
    }
  } catch {
    return null
  }
}

// --- 铁律常量（服务端硬校验，提示词只是告知） ---

/** 单维单月最大等级步长 */
export const MAX_LEVEL_STEP = 1
/** 相对出厂基线（v1 档案）的维度总位移上限 */
export const MAX_TOTAL_DISPLACEMENT = 6
/** 每条变化至少需要的证据条数 */
export const MIN_EVIDENCE_PER_CHANGE = 2
/** pending 提案过期天数 */
export const PROPOSAL_EXPIRY_DAYS = 14
/** 冷启动免评期（首份档案生成后 N 天内不再评审） */
export const COLD_START_DAYS = 30
/** 月度评审间隔 */
export const MONTHLY_INTERVAL_DAYS = 30

export const PROPOSAL_EXPIRY_MS = PROPOSAL_EXPIRY_DAYS * 24 * 60 * 60 * 1000
export const COLD_START_MS = COLD_START_DAYS * 24 * 60 * 60 * 1000
export const MONTHLY_INTERVAL_MS = MONTHLY_INTERVAL_DAYS * 24 * 60 * 60 * 1000

// --- 解析工具（JSON-in-String 列的读写） ---

export function parseDimensions(raw: string): GrowthDimension[] {
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.filter(
      (d): d is GrowthDimension =>
        d && typeof d.key === 'string' && typeof d.level === 'number',
    )
  } catch {
    return []
  }
}

export function parseChanges(raw: string): GrowthChange[] {
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.filter(
      (c): c is GrowthChange =>
        c && typeof c.dimension === 'string' &&
        typeof c.fromLevel === 'number' && typeof c.toLevel === 'number',
    )
  } catch {
    return []
  }
}

export function parseAdversarial(raw: string): AdversarialVerdict | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as AdversarialVerdict
  } catch {
    return null
  }
}

// --- 三铁律服务端硬校验 ---
// 任何路径（评估器创建提案 / 审批时重放编辑稿）都必须经过这里。

export interface ValidationResult {
  ok: boolean
  errors: string[]
}

export function validateProposalChanges(
  baseDims: GrowthDimension[],
  seedDims: GrowthDimension[] | null,
  changes: GrowthChange[],
  validEvidenceIds: Set<string>,
): ValidationResult {
  const errors: string[] = []
  const seen = new Set<string>()

  for (const ch of changes) {
    if (seen.has(ch.dimension)) {
      errors.push(`维度 ${ch.dimension} 出现重复变更`)
      continue
    }
    seen.add(ch.dimension)

    const base = baseDims.find((d) => d.key === ch.dimension)
    if (!base) {
      errors.push(`维度 ${ch.dimension} 不在当前档案中`)
      continue
    }
    // fromLevel 必须与当前档案一致（防陈旧数据）
    if (ch.fromLevel !== base.level) {
      errors.push(`维度 ${ch.dimension} 的起点等级(${ch.fromLevel})与当前档案(${base.level})不符`)
    }
    // 铁律一：单维单月 ≤ 1 级
    if (Math.abs(ch.toLevel - base.level) > MAX_LEVEL_STEP) {
      errors.push(`维度 ${ch.dimension} 变化幅度超过 ${MAX_LEVEL_STEP} 级上限`)
    }
    if (ch.toLevel < 1 || ch.toLevel > 5) {
      errors.push(`维度 ${ch.dimension} 目标等级越界(1-5)`)
    }
    // 铁律二：证据链存在性硬校验
    if (ch.evidenceIds.length < MIN_EVIDENCE_PER_CHANGE) {
      errors.push(`维度 ${ch.dimension} 证据不足（至少 ${MIN_EVIDENCE_PER_CHANGE} 条）`)
    }
    for (const id of ch.evidenceIds) {
      if (!validEvidenceIds.has(id)) {
        errors.push(`维度 ${ch.dimension} 引用了不存在的证据 ${id}`)
        break
      }
    }
  }

  if (changes.length === 0) {
    errors.push('提案没有任何变更')
  }

  // 铁律三：相对出厂基线的总位移上限
  if (seedDims && seedDims.length > 0) {
    let total = 0
    for (const d of baseDims) {
      const seed = seedDims.find((s) => s.key === d.key)
      const from = seed ? seed.level : d.level
      const to = changes.find((c) => c.dimension === d.key)?.toLevel ?? d.level
      total += Math.abs(to - from)
    }
    if (total > MAX_TOTAL_DISPLACEMENT) {
      errors.push(`总位移 ${total} 超过上限 ${MAX_TOTAL_DISPLACEMENT}（防棘轮漂移）`)
    }
  }

  return { ok: errors.length === 0, errors }
}

/** 批准时把变更套到当前维度上，生成新版本的维度快照 */
export function applyChangesToDims(
  baseDims: GrowthDimension[],
  changes: GrowthChange[],
): GrowthDimension[] {
  return baseDims.map((d) => {
    const ch = changes.find((c) => c.dimension === d.key)
    if (!ch) return d
    return { ...d, level: ch.toLevel, desc: ch.toDesc?.trim() || d.desc }
  })
}
