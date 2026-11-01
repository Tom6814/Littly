/**
 * 检索排序加权：相关度（RRF 归一）+ 重要度 + 新鲜度。
 *
 * 最终分 = 0.55·相关度 + 0.25·(importance/5) + 0.20·新鲜度。
 *
 * 设计取舍：
 * - 相关度仍是「名次」的产物（FTS/向量两路 RRF 融合分 / 本批最高分），保证召回口径不变；
 *   重要度与新鲜度只做「同等相关时的重排」，不改变谁能被召回。
 * - 新鲜度按 **event_time**（事情发生的时间）算，而不是 record_time / last_verified：
 *   补录旧事不会因为「刚写入」被洗新；这与 legacy score.ts 的口径一致。
 * - domain 决定半衰期（关系/规则最慢，生活/健康最快）；volatility=state 的记忆是「当前状态」
 *   （这周在感冒/最近在赶工），半衰期封顶 7 天，状态过期后自然沉底。
 *
 * 说明：加权思路参考了外部记忆项目（livingmemory, AGPL-3.0）公开论述的 α/β/γ 打分结构；
 * 本文件是按本仓库数据模型独立重写的实现，未复制其代码或提示词。
 */
import { parseEntryTime } from './time.ts'

export const RANK_WEIGHTS = {
  /** 检索相关度（RRF 归一分）。 */
  relevance: 0.55,
  /** 重要度（importance 1-5 归一到 0.2-1）。 */
  importance: 0.25,
  /** 新鲜度（按 event_time 指数衰减）。 */
  recency: 0.20,
} as const

/** 域半衰期（天）：关系/规则 365，生活/健康 30，关于用户/兴趣/项目 180，其余 90。 */
export const DOMAIN_HALF_LIFE_DAYS: Readonly<Record<string, number>> = {
  relationships: 365,
  feedback: 365,
  'about-user': 180,
  interests: 180,
  projects: 180,
  life: 30,
  health: 30,
}

/** 未列入半衰期表的域（notes / history / 未来新增域）默认 90 天。 */
export const DEFAULT_HALF_LIFE_DAYS = 90

/** 状态类（volatility=state）半衰期上限：7 天。 */
export const STATE_HALF_LIFE_DAYS = 7

/** 半衰期（天）：先取 domain 表，再对 state 记忆封顶。 */
export function halfLifeDays(domain: string, volatility: string): number {
  const base = DOMAIN_HALF_LIFE_DAYS[domain] ?? DEFAULT_HALF_LIFE_DAYS
  return volatility === 'state' ? Math.min(base, STATE_HALF_LIFE_DAYS) : base
}

/** 重要度归一：1-5 → 0.2-1（越界钳制，非数字按中位数 3）。 */
export function importanceWeight(importance: number): number {
  const value = Number.isFinite(importance) ? importance : 3
  const clamped = Math.min(5, Math.max(1, Math.round(value)))
  return clamped / 5
}

/** 新鲜度（0-1）：exp(-ln2 · ageDays / halfLife)，age 以 event_time 计；时间不可解析按 0（不奖励脏数据）。 */
export function recencyWeight(eventTime: string, now: Date, domain: string, volatility: string): number {
  const event = parseEntryTime(eventTime)
  if (event === null) return 0
  const ageDays = Math.max(0, (now.getTime() - event.getTime()) / 86_400_000)
  return Math.exp((-Math.LN2 * ageDays) / halfLifeDays(domain, volatility))
}

/** 把 RRF 原始分归一到 0..1（本批最高分 = 1；空集/异常返回 0）。 */
export function normalizeRelevance(score: number, maxScore: number): number {
  if (!Number.isFinite(score) || score <= 0) return 0
  if (!Number.isFinite(maxScore) || maxScore <= 0) return 0
  return Math.min(1, score / maxScore)
}

export interface RankParts {
  relevance: number
  importance: number
  recency: number
}

/** 最终加权分（0..1）；分项各自已归一，便于在结果里解释「为什么排前面」。 */
export function rankScore(parts: RankParts): number {
  return RANK_WEIGHTS.relevance * parts.relevance
    + RANK_WEIGHTS.importance * parts.importance
    + RANK_WEIGHTS.recency * parts.recency
}
