/**
 * Asia/Shanghai 时区工具（日记时段、当日计数边界、消息时间标注共用）。
 */

/** Shanghai 当天日期串（YYYY-MM-DD）。 */
export function shanghaiDateStr(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

/** Shanghai 当前小时（0-23）。 */
export function shanghaiHour(now: Date): number {
  const s = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(now)
  const n = Number(s)
  return Number.isFinite(n) ? n : 0
}

/** Shanghai 某天 0 点的 UTC ISO 串（+08:00 换算）。 */
export function shanghaiDayStartIso(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00+08:00`).toISOString()
}

/** HH:mm（Shanghai 时区），日记消息时间标注用。 */
export function shanghaiTimeStr(iso: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso))
}
