/**
 * 旧 ai/history-budget.ts:1-51 忠实移植：历史条数 + 字符预算双保险。
 * 关键语义：aiMaxHistory=0 表示「不带历史」（绝不 || 20 吞 0）。
 */
export const HISTORY_CHAR_BUDGET = 6000
export const DEFAULT_AI_MAX_HISTORY = 20
export const HISTORY_CHAR_PER_MESSAGE = 300
export const HISTORY_CHAR_MIN = 2000
export const HISTORY_CHAR_MAX = 12000

export function resolveHistoryTake(maxHistory: number | null | undefined): number {
  if (maxHistory === 0) return 0
  if (maxHistory === null || maxHistory === undefined || !Number.isFinite(maxHistory) || maxHistory < 0) {
    return DEFAULT_AI_MAX_HISTORY
  }
  return maxHistory
}

export function historyCharBudget(maxHistory: number | null | undefined): number {
  const take = resolveHistoryTake(maxHistory)
  const budget = take * HISTORY_CHAR_PER_MESSAGE
  return Math.min(Math.max(budget, HISTORY_CHAR_MIN), HISTORY_CHAR_MAX)
}

export function trimHistoryByBudget<T extends { content: string }>(messages: T[], maxChars = HISTORY_CHAR_BUDGET): T[] {
  const kept: T[] = []
  let used = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m) continue
    if (kept.length > 0 && used + m.content.length > maxChars) break
    kept.unshift(m)
    used += m.content.length
  }
  return kept
}
