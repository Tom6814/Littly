/**
 * 自然语言时间标签（展示层，随「现在」重算 → 自动老化）。
 *
 * 例：`两个月前（2026-08）`、`3 天前（10-18）`、`昨天 21:30`、`今天 08:05`。
 * 关键时间（生日/纪念日/约定/截止）额外保留绝对日期。
 */
import type { VaultEntry } from './types.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 解析条目时间（带时区 ISO / 纯日期）。 */
export function parseEntryTime(value: string): Date | null {
  const text = String(value ?? '').trim()
  if (text === '') return null
  const ms = Date.parse(text)
  return Number.isNaN(ms) ? null : new Date(ms)
}

function pad(n: number): string { return String(n).padStart(2, '0') }

/** 本地（+08:00）日期/时间片段。 */
function localParts(date: Date): { y: number; m: number; d: number; hh: number; mm: number } {
  const local = new Date(date.getTime() + 8 * HOUR)
  return { y: local.getUTCFullYear(), m: local.getUTCMonth() + 1, d: local.getUTCDate(), hh: local.getUTCHours(), mm: local.getUTCMinutes() }
}

/** 绝对日期（YYYY-MM-DD）。 */
export function absoluteDate(date: Date): string {
  const p = localParts(date)
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`
}

/** 判断是否关键时间（生日/纪念日/约定/截止）→ 保留绝对日期。 */
export function isKeyDate(entry: Pick<VaultEntry, 'title' | 'tags' | 'thread'>): boolean {
  const text = `${entry.title} ${entry.tags.join(' ')} ${entry.thread}`
  return /生日|纪念日|周年|约定|截止|deadline|anniversary|birthday/iu.test(text)
}

/** 生成自然语言标签（过去称「前」，未来称「后」）。 */
export function relativeLabel(eventTime: string, now: Date, options: { keyDate?: boolean; recorded?: boolean } = {}): string {
  const event = parseEntryTime(eventTime)
  if (event === null) return eventTime
  const diff = now.getTime() - event.getTime()
  const suffix = options.keyDate === true ? `（${absoluteDate(event)}）` : ''
  const prefix = options.recorded === true ? '记录于 ' : ''
  if (diff < 0) {
    const ahead = -diff
    if (ahead < HOUR) return `${prefix}${Math.max(1, Math.round(ahead / MINUTE))} 分钟后${suffix}`
    if (ahead < DAY) return `${prefix}${Math.round(ahead / HOUR)} 小时后${suffix}`
    if (ahead < 30 * DAY) return `${prefix}${Math.round(ahead / DAY)} 天后${suffix}`
    const p = localParts(event)
    return `${prefix}${p.y}-${pad(p.m)}-${pad(p.d)}${suffix}`
  }
  if (diff < MINUTE) return `${prefix}刚刚${suffix}`
  if (diff < HOUR) return `${prefix}${Math.max(1, Math.round(diff / MINUTE))} 分钟前${suffix}`
  if (diff < DAY) {
    return `${prefix}${Math.max(1, Math.round(diff / HOUR))} 小时前${suffix}`
  }
  const days = Math.floor(diff / DAY)
  const p = localParts(event)
  if (days === 1) return `${prefix}昨天 ${pad(p.hh)}:${pad(p.mm)}${suffix}`
  if (days < 7) return `${prefix}${days} 天前（${pad(p.m)}-${pad(p.d)}）${suffix}`
  if (days < 30) return `${prefix}${days} 天前（${pad(p.m)}-${pad(p.d)}）${suffix}`
  if (days < 365) {
    const months = Math.max(1, Math.floor(days / 30))
    return `${prefix}${months} 个月前（${p.y}-${pad(p.m)}）${suffix}`
  }
  const years = Math.max(1, Math.floor(days / 365))
  return `${prefix}${years} 年前（${p.y}）${suffix}`
}

/** 条目的「发生/记录」时间标签（读取时按当前时间生成）。 */
export function timeLabelsFor(entry: VaultEntry, now: Date): { eventLabel: string; recordedLabel: string } {
  return {
    eventLabel: relativeLabel(entry.event_time, now, { keyDate: isKeyDate(entry) }),
    recordedLabel: relativeLabel(entry.record_time, now, { recorded: true }),
  }
}

/** 每域最近更新时间的自然语言（domains 端点）。 */
export function relativeSince(iso: string, now: Date): string {
  return relativeLabel(iso, now)
}
