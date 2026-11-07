/** 对话页展示助手：时间/日期/分条。 */

export function parseTime(iso: string | undefined): number {
  if (!iso) return 0
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : 0
}

/** HH:mm（本地时区）。 */
export function formatTime(iso: string | undefined): string {
  const t = parseTime(iso)
  if (t === 0) return ''
  return new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

/** 今天 / 昨天 / M月D日 / YYYY年M月D日。 */
export function formatDayLabel(iso: string | undefined): string {
  const t = parseTime(iso)
  if (t === 0) return '更早'
  const date = new Date(t)
  const now = new Date()
  const startOf = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diffDays = Math.round((startOf(now) - startOf(date)) / 86_400_000)
  if (diffDays === 0) return '今天'
  if (diffDays === 1) return '昨天'
  if (diffDays > 1 && diffDays < 7) return `${diffDays} 天前`
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1} 月 ${date.getDate()} 日`
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`
}

export function dayKey(iso: string | undefined): string {
  const t = parseTime(iso)
  if (t === 0) return 'unknown'
  const d = new Date(t)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/**
 * 一条消息按「单换行 = 分条」拆成多个气泡；空行只作分隔，不产生空气泡。
 * 后端 assistant 文本常把拟人化分片用 \n 拼接，这里逐行 trim 后过滤空行。
 */
export function bubblesOf(text: string | undefined): string[] {
  const lines = String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  return lines
}

export function initialOf(name: string): string {
  const trimmed = name.trim()
  if (trimmed === '') return '她'
  return [...trimmed][0] ?? '她'
}
