/**
 * 共享格式化/错误文案小工具（fe-pages 写域内）。
 * 不引第三方日期库：console-new 依赖只有 vue/router/felinic/lucide，
 * 用原生 Intl 足够，也不用为 9 个页面新增依赖。
 */

const dtFmt = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

const dtYearFmt = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

const dateFmt = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
const timeFmt = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

/** 「—」而不是假 0：后端没给值时不要伪造。 */
export const DASH = '—'

/** 月-日 时:分；跨年时带年份。 */
export function fmtDateTime(iso: string | null | undefined): string {
  const d = parse(iso)
  if (!d) return DASH
  return (d.getFullYear() === new Date().getFullYear() ? dtFmt : dtYearFmt).format(d)
}

export function fmtDate(iso: string | null | undefined): string {
  const d = parse(iso)
  return d ? dateFmt.format(d) : DASH
}

export function fmtTime(iso: string | null | undefined): string {
  const d = parse(iso)
  return d ? timeFmt.format(d) : DASH
}

/** 相对时间：「刚刚 / N 分钟前 / N 小时前 / N 天前」，更久用日期。 */
export function fmtAgo(iso: string | null | undefined): string {
  const d = parse(iso)
  if (!d) return DASH
  const diff = Date.now() - d.getTime()
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return fmtDate(iso)
}

/** `datetime-local` 输入控件要 `YYYY-MM-DDTHH:mm`（本地时区，不做 UTC 换算）。 */
export function toLocalInput(iso: string | null | undefined): string {
  const d = parse(iso)
  if (!d) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 把 `datetime-local` 的值转 ISO；非法返回 undefined（调用处 gate 掉）。 */
export function fromLocalInput(value: string): string | undefined {
  if (!value) return undefined
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

/** 秒 → 「N 分钟 / N 小时」人话（心跳最小间隔展示用，读取仍是秒）。 */
export function fmtSeconds(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return DASH
  if (seconds < 60) return `${seconds} 秒`
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`
  return `${Math.round((seconds / 3600) * 10) / 10} 小时`
}

/** 统一取错误文案（ApiError 的 message 已是后端中文信封）。 */
export function errText(e: unknown): string {
  if (e instanceof Error && e.message) return e.message
  if (typeof e === 'string' && e !== '') return e
  return '操作失败，请稍后再试'
}
