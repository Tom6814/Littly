/**
 * 世界书引擎（SillyTavern World Info 范式，逐字移植旧 chat.ts:306-428）。
 * 测试面板与正式匹配共用同一套判定（纯函数）。
 */
import type { WorldEntryRow } from '@littly/storage'

export const WI_LOGIC = {
  AND_ANY: 0,
  NOT_ALL: 1,
  NOT_ANY: 2,
  AND_ALL: 3,
} as const

export const WORLDBOOK_CHAR_BUDGET = 3000
export const WORLDBOOK_MAX_ENTRIES = 16

function parseKeywordList(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) return parsed.map((k) => String(k).trim()).filter(Boolean)
  } catch {
    // 非法 JSON → 按分隔符拆（兼容手填格式）
  }
  return raw.split(/[,，\s]+/).filter(Boolean)
}

function compileKeyPattern(key: string): RegExp | null {
  const m = /^\/(.+)\/([gimsuy]*)$/.exec(key)
  if (!m) return null
  try {
    return new RegExp(m[1], m[2].replace(/[gy]/g, ''))
  } catch {
    return null
  }
}

export interface WorldEntryEvaluation {
  active: boolean
  hitKeys: string[]
}

export function evaluateWorldEntry(entry: WorldEntryRow, haystack: string): WorldEntryEvaluation {
  const lowerText = haystack.toLowerCase()
  const primaries = parseKeywordList(entry.keys)
  const secondaries = parseKeywordList(entry.second_keys || '[]')
  const logic = entry.logic

  const hitKey = (k: string): boolean => {
    const p = compileKeyPattern(k)
    if (p) return p.test(haystack)
    return k !== '' && lowerText.includes(k.toLowerCase())
  }

  if (entry.constant) return { active: true, hitKeys: [] }
  if (primaries.length === 0 && secondaries.length === 0) return { active: false, hitKeys: [] }

  const primHits = primaries.filter(hitKey)
  const secHits = secondaries.filter(hitKey)

  if (primaries.length === 0) {
    const active =
      logic === WI_LOGIC.AND_ALL || logic === WI_LOGIC.NOT_ALL
        ? secHits.length === secondaries.length
        : secHits.length > 0
    return { active, hitKeys: secHits }
  }

  const primaryOk =
    logic === WI_LOGIC.AND_ALL ? primHits.length === primaries.length : primHits.length > 0
  if (!primaryOk) return { active: false, hitKeys: primHits }

  let secondaryOk: boolean
  switch (logic) {
    case WI_LOGIC.AND_ANY:
      secondaryOk = secondaries.length === 0 || secHits.length > 0
      break
    case WI_LOGIC.NOT_ALL:
      secondaryOk = !(secondaries.length > 0 && secHits.length === secondaries.length)
      break
    case WI_LOGIC.NOT_ANY:
      secondaryOk = secHits.length === 0
      break
    case WI_LOGIC.AND_ALL:
      secondaryOk = secondaries.length === 0 || secHits.length === secondaries.length
      break
    default:
      secondaryOk = true
  }
  return { active: secondaryOk, hitKeys: [...primHits, ...secHits] }
}

export function matchWorldbook(
  entries: WorldEntryRow[],
  haystack: string,
  focusText?: string,
): { beforeChar: string[]; afterChar: string[] } {
  const activated: Array<{ content: string; priority: number; position: number }> = []
  for (const entry of entries) {
    if (!entry.enabled) continue
    const { active } = evaluateWorldEntry(entry, haystack)
    if (!active) continue
    // 骰子只管「要不要顺带主动提起」；正面命中最新消息（追问必达）时跳过掷骰
    const explicitlyProbed = !!focusText && evaluateWorldEntry(entry, focusText).active
    if (!explicitlyProbed && entry.probability < 100 && Math.random() * 100 >= entry.probability) continue
    activated.push({ content: entry.content, priority: entry.priority, position: entry.position })
  }
  activated.sort((a, b) => b.priority - a.priority)

  const beforeChar: string[] = []
  const afterChar: string[] = []
  let usedChars = 0
  for (const e of activated) {
    if (beforeChar.length + afterChar.length >= WORLDBOOK_MAX_ENTRIES) break
    if (usedChars + e.content.length > WORLDBOOK_CHAR_BUDGET) continue
    usedChars += e.content.length
    ;(e.position === 0 ? beforeChar : afterChar).push(e.content)
  }
  return { beforeChar, afterChar }
}
