/**
 * §成长档案 — 月度评审计时（中国时区 Asia/Shanghai，每月月底触发）。
 *
 * 逐字移植自旧项目 src/internal/growth/timing.ts。
 * 评审固定在每个自然月的月底结算，而不是「距上次 30 天」的简单滚动：
 * - 窗口期：本月最后一天 22:00 → 次月 3 日 23:59（补跑，防止调度错过）
 * - 面板可通过 GET /api/growth 的 nextReviewAt / reviewWindowOpen 查看具体时间。
 */

const TZ = 'Asia/Shanghai'

export interface ShanghaiParts {
  year: number
  month: number // 1-12
  day: number
  hour: number
}

function num(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number {
  return Number(parts.find((p) => p.type === type)?.value ?? NaN)
}

/** 把 Date 拆成上海时区的年/月/日/时 */
export function shanghaiParts(d: Date): ShanghaiParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(d)
  return { year: num(parts, 'year'), month: num(parts, 'month'), day: num(parts, 'day'), hour: num(parts, 'hour') }
}

/** 上海时区某年某月的天数（month 1-12） */
export function daysInShanghaiMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** 是否处于月底评审窗口（本月最后一天 22:00 起，含次月前 3 天补跑） */
export function isMonthEndWindow(now: Date): boolean {
  const p = shanghaiParts(now)
  const lastDay = daysInShanghaiMonth(p.year, p.month)
  if (p.day === lastDay && p.hour >= 22) return true
  if (p.day <= 3) return true // 次月 1-3 日补跑
  return false
}

/** 上海时区"yyyy-MM" 标识，用于判断本月是否已评审 */
export function shanghaiMonthKey(d: Date): string {
  const p = shanghaiParts(d)
  return `${p.year}-${String(p.month).padStart(2, '0')}`
}

/** 下一个月底评审时间点（上海时区本月最后一天 22:00；已过则下个月），返回 UTC Date */
export function nextMonthEnd(now: Date): Date {
  const p = shanghaiParts(now)
  const lastDay = daysInShanghaiMonth(p.year, p.month)
  // 上海 22:00 = UTC 14:00
  const candidate = new Date(Date.UTC(p.year, p.month - 1, lastDay, 14, 0, 0))
  if (candidate.getTime() > now.getTime()) return candidate
  const ny = p.month === 12 ? p.year + 1 : p.year
  const nm = p.month === 12 ? 1 : p.month + 1
  const nlast = daysInShanghaiMonth(ny, nm)
  return new Date(Date.UTC(ny, nm - 1, nlast, 14, 0, 0))
}

/** 上海时区友好展示：如 "6月30日 22:00" */
export function fmtShanghai(d: Date): string {
  const p = shanghaiParts(d)
  return `${p.month}月${p.day}日 ${String(p.hour).padStart(2, '0')}:00`
}
