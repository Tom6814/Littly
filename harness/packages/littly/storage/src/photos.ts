/**
 * 相册 meme 短 id / sha256 助手。
 *
 * 协议（借鉴 AstrBot meme_manager，MIT；代码为本项目重写）：
 * - 模型选图必须先 `view_album` 拿到 `meme`，再把 `meme:<hex>` 交给 `send_photo`；
 * - meme 默认取 sha256 前 12 位 hex；老照片没有 sha256 时取 id 前 12 位；
 * - 同一角色内出现前缀碰撞时自动加长前缀，仍碰撞（例如历史重复照片 sha 相同）
 *   则退化为「前缀-id 片段」，保证同一相册内 meme 唯一。
 *
 * 分配只依赖（当前角色的）照片集合，不依赖查询顺序；同一集合重复计算结果一致。
 */
import { createHash } from 'node:crypto'
import type { LittlyStorage } from './index.ts'

/** meme 默认前缀长度（12 hex）。 */
export const MEME_ID_LENGTH = 12

/** 计算 sha256 小写 hex。 */
export function sha256Hex(data: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

export interface PhotoMemeRow {
  id: string
  sha256?: string | null
}

/** 单张照片的 meme 基串：优先 sha256，其次 id。 */
export function photoMemeBase(row: PhotoMemeRow): string {
  const sha = (row.sha256 ?? '').trim().toLowerCase()
  if (/^[0-9a-f]+$/.test(sha) && sha.length >= 8) return sha
  return (row.id ?? '').trim().toLowerCase()
}

/**
 * 给一组照片分配唯一 meme 短 id。
 *
 * 先按 base/id 排序再分配，避免 SQLite 返回顺序变化导致同一张照片的 meme 漂移。
 * 返回 id → meme 的映射（id 重复时后者覆盖，调用方不应传入重复 id）。
 */
export function assignMemeIds(rows: ReadonlyArray<PhotoMemeRow>): Map<string, string> {
  const entries = rows
    .map((row) => ({ id: row.id, base: photoMemeBase(row) }))
    .sort((a, b) => (a.base === b.base ? a.id.localeCompare(b.id) : a.base.localeCompare(b.base)))

  const used = new Set<string>()
  const out = new Map<string, string>()
  for (const entry of entries) {
    const base = entry.base === '' ? entry.id : entry.base
    let length = Math.min(MEME_ID_LENGTH, base.length)
    let candidate = base.slice(0, length)
    // 前缀碰撞：加长前缀直到唯一（或耗尽整个 base）。
    while (used.has(candidate) && length < base.length) {
      length += 1
      candidate = base.slice(0, length)
    }
    if (used.has(candidate)) {
      // base 完全相同（历史重复 sha / 超短 id）或极短 base 撞车：追加 id 片段。
      const idPart = entry.id.replace(/[^0-9a-zA-Z]/g, '') || entry.id
      const head = base.slice(0, Math.min(MEME_ID_LENGTH, base.length))
      candidate = `${head}-${idPart.slice(0, 8)}`
      let suffix = 2
      while (used.has(candidate)) {
        candidate = `${head}-${idPart.slice(0, 8)}-${suffix}`
        suffix += 1
      }
    }
    used.add(candidate)
    out.set(entry.id, candidate)
  }
  return out
}

/** 某个角色整个相册的 meme 映射（调用方按需取用）。 */
export function memeIdsForBot(storage: LittlyStorage, botId: string): Map<string, string> {
  const rows = storage
    .prepare('SELECT id, sha256 FROM photos WHERE bot_id = ?')
    .all(botId) as PhotoMemeRow[]
  return assignMemeIds(rows)
}
