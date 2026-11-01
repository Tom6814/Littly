/**
 * 主动消息策略（随机排期 / 未回硬停 / 心跳唤醒尝试统计）。
 *
 * 三条约束：
 * 1) 纯函数优先：随机源可注入（rng），排期时刻只从「区间 + rng」推导，不读系统时钟以外的状态；
 * 2) 不新增表/列：唤醒尝试复用 audit_logs(category='heartbeat', action='decision')，
 *    下一次排期复用 scheduled_messages.fire_at —— 旧库升级不需要数据迁移；
 * 3) 阈值语义：`max_unanswered` 只数「最后一条用户消息之后 status='sent' 的主动消息」，
 *    用户一开口这一窗口自然清空（不需要额外的清零任务）。
 *
 * 合规：随机区间、未回上限这类参数属于通用工程思想；本文件为独立实现。
 */
import type { LittlyStorage } from '@littly/storage'

/** bot.proactive_min_interval 缺失 / ≤0 / 非法时的兜底：2 小时。 */
export const DEFAULT_PROACTIVE_MIN_INTERVAL_SEC = 2 * 60 * 60
/** 随机排期上限硬顶：12 小时（min 再大也不让「下一次」拖过这个量级）。 */
export const PROACTIVE_MAX_INTERVAL_CAP_SEC = 12 * 60 * 60
/**
 * 未回硬停阈值（私聊）。
 * 连续 N 条主动消息都没得到回复 → 停止主动排期，直到用户下一次发言。
 * 群聊暂无独立会话概念（渠道按 1v1 语义接入），因此只实现私聊这一档（群聊若接入则用 2）。
 */
export const PROACTIVE_MAX_UNANSWERED = 4
/**
 * 同一联系人两次心跳决策之间的短冷却。
 * 退避阈值本身至少 10 分钟，这里只防 60s tick 在边界抖动时连续唤醒（如用户刚发言后
 * 多个 tick 同时满足条件）；不会削弱正常说话能力——正常间隔由 backoff 阈值决定。
 */
export const HEARTBEAT_WAKE_COOLDOWN_SEC = 5 * 60

/** 可注入随机源：返回 [0,1)（与 Math.random 同签名）。 */
export type Rng = () => number

/** 归一化随机值：防御注入源的越界/NaN，保证结果始终落在 [0,1]。 */
function unit(rng: Rng): number {
  const v = rng()
  if (!Number.isFinite(v)) return 0
  return v <= 0 ? 0 : v >= 1 ? 0.999999999 : v
}

/** 生效的最小主动间隔（秒）：bot 配置 ≤0 / 非法 → 2 小时。 */
export function effectiveProactiveMinIntervalSec(value: number | null | undefined): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PROACTIVE_MIN_INTERVAL_SEC
}

export interface ProactiveJitterRange {
  minSec: number
  maxSec: number
}

/**
 * 随机排期区间：`min = proactive_min_interval`，`max = min(3×min, 12h)`。
 * max 永远 ≥ min（min 本身超过 12h 时以 min 为准，避免区间反转）。
 */
export function proactiveJitterRange(minIntervalSec: number | null | undefined): ProactiveJitterRange {
  const minSec = effectiveProactiveMinIntervalSec(minIntervalSec)
  const maxSec = Math.max(minSec, Math.min(minSec * 3, PROACTIVE_MAX_INTERVAL_CAP_SEC))
  return { minSec, maxSec }
}

export interface ProactiveDelay {
  delaySec: number
  minSec: number
  maxSec: number
}

/** 在 [min, max] 内均匀取一个延迟（秒），区间端点均可取到。 */
export function computeProactiveDelaySec(
  minIntervalSec: number | null | undefined,
  rng: Rng = Math.random,
): ProactiveDelay {
  const { minSec, maxSec } = proactiveJitterRange(minIntervalSec)
  const delaySec = Math.round(minSec + unit(rng) * (maxSec - minSec))
  return { delaySec, minSec, maxSec }
}

export interface ProactiveFirePlan extends ProactiveDelay {
  fireAt: Date
}

/** `next = now + random[min,max]`：主动排期的唯一时刻来源（调用方落库 fire_at）。 */
export function nextProactiveFireAt(
  now: Date,
  minIntervalSec: number | null | undefined,
  rng: Rng = Math.random,
): ProactiveFirePlan {
  const delay = computeProactiveDelaySec(minIntervalSec, rng)
  return { ...delay, fireAt: new Date(now.getTime() + delay.delaySec * 1000) }
}

// --- 唤醒尝试（退避）统计 ---

/** 心跳决策审计的 action：每次真正调 LLM 前写一条，silent / speak / gate-cancelled 都计入。 */
export const HEARTBEAT_DECISION_ACTION = 'decision'

const EPOCH_ISO = '1970-01-01T00:00:00.000Z'

/**
 * 审计 detail 里 sender 的精确定位串。
 * detail 由 JSON.stringify 生成且 sender 是第一项，因此 `"sender":"<json>"` 不会与
 * `u1` / `u10` 这类前缀冲突；instr() 精确子串匹配，避免 LIKE 的通配符注入。
 */
export function senderDetailNeedle(sender: string): string {
  return `"sender":${JSON.stringify(sender)}`
}

/** 生成心跳决策/跳过的审计 detail（sender 必须为第一项，供 senderDetailNeedle 匹配）。 */
export function heartbeatDetail(sender: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ sender, ...extra })
}

export interface WakeAttemptStats {
  /** 自 sinceIso 以来真正发生过的心跳决策次数（含 silent、gate-cancelled、speak）。 */
  attempts: number
  /** 最近一次决策时间（ISO）；从未决策 → null。 */
  lastAt: string | null
}

/**
 * 统计「自最后一条用户消息以来」的唤醒/决策尝试次数。
 * 旧实现只数 status='sent' 的 proactive：silent 不涨退避、gate-cancelled 也不涨，
 * 静默超过最小间隔后每个 60s tick 都会重新唤醒决策 LLM（P0 空转）。
 * 现在每次决策（不论最终动作）都会留一条 action='decision' 的审计，退避按它计算。
 */
export function readWakeAttempts(
  storage: LittlyStorage,
  botId: string,
  sender: string,
  sinceIso: string | null | undefined,
): WakeAttemptStats {
  const since = sinceIso && sinceIso.length > 0 ? sinceIso : EPOCH_ISO
  const row = storage
    .prepare(
      `SELECT COUNT(*) AS c, MAX(created_at) AS last_at
         FROM audit_logs
        WHERE bot_id = ? AND category = 'heartbeat' AND action = ?
          AND created_at >= ? AND instr(detail, ?) > 0`,
    )
    .get(botId, HEARTBEAT_DECISION_ACTION, since, senderDetailNeedle(sender)) as
    | { c: number; last_at: string | null }
    | undefined
  return { attempts: row?.c ?? 0, lastAt: row?.last_at ?? null }
}

/**
 * 未回硬停计数：最后一条用户消息之后 `status='sent'` 的主动消息条数。
 * 没有用户消息（理论上不会发生，因为主动消息总要发生在对话之后）时按全部已发主动消息计。
 */
export function countUnansweredProactive(
  storage: LittlyStorage,
  botId: string,
  sender: string,
  lastUserAt: string | null | undefined,
): number {
  const since = lastUserAt && lastUserAt.length > 0 ? lastUserAt : ''
  const row = storage
    .prepare(
      `SELECT COUNT(*) AS c
         FROM scheduled_messages
        WHERE bot_id = ? AND sender = ? AND origin = 'proactive'
          AND status = 'sent' AND fired_at IS NOT NULL AND fired_at >= ?`,
    )
    .get(botId, sender, since) as { c: number } | undefined
  return row?.c ?? 0
}
