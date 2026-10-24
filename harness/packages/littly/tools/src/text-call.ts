/**
 * 文本形态工具调用兜底（旧 ai/tool-text.ts 的移植基线）：
 * 解析模型把工具调用以 XML/JSON 混进正文的情况，返回剥离后的剩余文本。
 * 这是「工具调用原文被当消息发给用户」这类严重事故的防线。
 */
import { ALL_TOOLS } from './defs.ts'

export interface TextToolCall {
  name: string
  arguments: Record<string, unknown>
}

export interface TextToolParseResult {
  calls: TextToolCall[]
  cleaned: string
}

const TOOL_NAMES = new Set(ALL_TOOLS.map((t) => t.function.name))

const ANY_TAG_RE = /<(\/?)([a-zA-Z_][a-zA-Z0-9_]*)(?=[>\s<]|$)/g

interface Pending {
  name: string
  start: number
  key: string | null
  kv: Record<string, string>
  /** 本工具块最后一个已知收束位置 */
  end: number
}

function tryParseJsonAt(text: string, i: number): { obj: Record<string, unknown>; end: number } | null {
  // 从 i 开始匹配平衡 JSON（字符串感知）
  let depth = 0
  let inStr = false
  for (let j = i; j < text.length; j++) {
    const ch = text[j]
    if (inStr) {
      if (ch === '\\') j++
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          return { obj: JSON.parse(text.slice(i, j + 1)) as Record<string, unknown>, end: j + 1 }
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/** 解析正文里的文本形态工具调用；无调用返回 null。 */
export function extractTextToolCall(text: string): TextToolParseResult | null {
  if (!text) return null

  // ---- 形态 1：平衡 JSON 对象，带已知工具名（tool/name/function.name）----
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue
    const parsed = tryParseJsonAt(text, i)
    if (!parsed) continue
    const obj = parsed.obj
    const fn = obj.function as Record<string, unknown> | undefined
    const name = String(obj.tool ?? obj.name ?? fn?.name ?? '')
    if (name && TOOL_NAMES.has(name)) {
      let args = obj.arguments ?? obj.parameters ?? fn?.arguments
      if (typeof args === 'string') {
        try { args = JSON.parse(args) } catch { args = { _raw: args } }
      }
      if (!args || typeof args !== 'object') args = {}
      return {
        calls: [{ name, arguments: args as Record<string, unknown> }],
        cleaned: (text.slice(0, i) + text.slice(parsed.end)).trim(),
      }
    }
  }

  // ---- 形态 2：XML 标签（容忍 <remember<arg_key>… 这类未闭合畸形）----
  const calls: TextToolCall[] = []
  const ranges: Array<[number, number]> = []
  let cur: Pending | null = null
  ANY_TAG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ANY_TAG_RE.exec(text)) !== null) {
    const [full, closing, tag] = m
    const tagStart = m.index
    const gt = text.indexOf('>', tagStart)
    const tagEnd = gt < 0 ? text.length : gt + 1
    if (closing) {
      if (cur && tag === cur.name) {
        // 工具块收束
        emit(cur, tagEnd)
        cur = null
      }
      continue
    }
    if (TOOL_NAMES.has(tag)) {
      if (cur) emit(cur, tagStart)
      cur = { name: tag, start: tagStart, key: null, kv: {}, end: tagEnd }
      continue
    }
    if (cur && tag === 'arg_key') {
      const close = text.indexOf('</arg_key>', tagEnd)
      cur.key = (close < 0 ? text.slice(tagEnd) : text.slice(tagEnd, close)).trim()
      if (close >= 0) ANY_TAG_RE.lastIndex = close + '</arg_key>'.length
      cur.end = Math.max(cur.end, ANY_TAG_RE.lastIndex)
      continue
    }
    if (cur && tag === 'arg_value' && cur.key) {
      const close = text.indexOf('</arg_value>', tagEnd)
      const value = close < 0 ? text.slice(tagEnd) : text.slice(tagEnd, close)
      cur.kv[cur.key] = value.trim()
      cur.key = null
      if (close >= 0) ANY_TAG_RE.lastIndex = close + '</arg_value>'.length
      cur.end = Math.max(cur.end, ANY_TAG_RE.lastIndex)
      continue
    }
  }
  if (cur) emit(cur, text.length)

  if (calls.length === 0) return null
  let cleaned = text
  for (const [start, end] of ranges.reverse()) cleaned = cleaned.slice(0, start) + cleaned.slice(end)
  return { calls, cleaned: cleaned.trim() }

  function emit(p: Pending, end: number): void {
    if (Object.keys(p.kv).length === 0) return
    const args: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(p.kv)) {
      try { args[k] = JSON.parse(v) } catch { args[k] = v }
    }
    calls.push({ name: p.name, arguments: args })
    ranges.push([p.start, end])
  }
}
