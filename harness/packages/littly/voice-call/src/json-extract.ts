// §AI JSON 提取 — 从模型输出中稳健地取出第一个完整 JSON 对象。
// 模型偶尔会：重复输出 JSON、在 JSON 前后/中间夹带多余文字、用 ```json 包裹。
// 贪婪正则 `\{[\s\S]*\}` 会吞到最后一个 } 导致 JSON.parse 失败，
// 进而把整段原文当消息发出去（乱码）。这里逐字符扫描：
//   字符串内跳过 { }（含转义感知），{ 计深、} 减深，深度归零即为一个完整对象。
//
// 旧 monolith src/internal/ai/json-extract.ts（与 @littly/scheduler 的同名实现逐字一致）移植。

export function extractFirstJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let escaped = false
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]
    if (inStr) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        const slice = raw.slice(start, i + 1)
        try {
          return JSON.parse(slice) as Record<string, unknown>
        } catch {
          return null
        }
      }
    }
  }
  return null
}
