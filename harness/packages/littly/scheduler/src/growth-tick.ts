/**
 * B9：成长系统「月度评审」接线。
 *
 * 修复前 `growthTick()`（growth/src/evaluator.ts）只在控制台手动评审路径里被调用，
 * scheduler 的 60s tick 从未接上它 —— 于是「每月月底自动成长」这条设计链路根本不存在，
 * 用户的成长档案永远停在初始版本。
 *
 * 接线策略（每日一次 + 窗口内才真跑）：
 * - 每天最多调用一次 growthTick（global_settings `growth.tick.lastDay` 记上海日期）；
 * - 只有处于月底评审窗口（本月最后一天 22:00 ~ 次月 3 日补跑）才真正调用，
 *   避免平时每 tick 都触发 ensureGrowthProfile 的 LLM 推导；
 * - 具体某个 bot 本月是否已评审、是否有材料等守卫仍由 growth 包内部把关。
 */
import type { LittlyStorage } from '@littly/storage'
import { isMonthEndWindow, shanghaiParts } from '@littly/growth/src/timing.ts'
import type { SchedulerDeps } from './types.ts'

/** 记录「上次尝试的上海日期」，保证每日至多一次。 */
export const GROWTH_TICK_DAY_KEY = 'growth.tick.lastDay'

/** 成长服务的最小结构面（避免 scheduler 硬依赖 growth 的实现细节）。 */
export interface GrowthTickLike {
  tick(now?: Date): Promise<{ evaluated: number; created: number }>
}

/** 上海时区日期键 yyyy-mm-dd。 */
export function shanghaiDayKey(now: Date): string {
  const p = shanghaiParts(now)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

/**
 * 每日一次的成长 tick（scheduler 主循环调用）。
 * @param deps - 调度器依赖（growth 可选：profile 未装配时静默跳过）
 * @param now - 当前时间
 * @returns ran=本次是否真的调用了 growthTick；以及其 evaluated/created 计数
 */
export async function runGrowthDailyTick(
  deps: SchedulerDeps,
  now: Date = new Date(),
): Promise<{ ran: boolean; evaluated: number; created: number }> {
  const growth = deps.growth
  if (growth === undefined || typeof growth.tick !== 'function') {
    return { ran: false, evaluated: 0, created: 0 }
  }
  if (!isMonthEndWindow(now)) return { ran: false, evaluated: 0, created: 0 }
  const day = shanghaiDayKey(now)
  if (deps.storage.getSetting(GROWTH_TICK_DAY_KEY) === day) return { ran: false, evaluated: 0, created: 0 }
  // 先认领当天再跑：tick 间不重叠，失败也不在当天反复重试（下个窗口日会再来）。
  deps.storage.setSetting(GROWTH_TICK_DAY_KEY, day)
  try {
    const result = await growth.tick(now)
    deps.log('[scheduler] 成长月度评审：evaluated=%d created=%d', result.evaluated, result.created)
    return { ran: true, evaluated: result.evaluated, created: result.created }
  } catch (error) {
    deps.log('[scheduler] 成长月度评审失败: %s', error instanceof Error ? error.message : String(error))
    return { ran: true, evaluated: 0, created: 0 }
  }
}

/** 便捷读取：当前是否处于月度评审窗口（控制台/测试展示用）。 */
export function inGrowthWindow(now: Date = new Date()): boolean {
  return isMonthEndWindow(now)
}

/** 仅用于类型标注的存储面（避免未使用告警时保留语义）。 */
export type GrowthTickStorage = LittlyStorage
