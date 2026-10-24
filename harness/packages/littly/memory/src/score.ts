/**
 * 记忆打分（旧 ai/memory-score.ts:1-104 逐字移植，v2 衰减改按 event_time）。
 * 纯函数：score = 0.55×相关度 + 0.25×(重要度/5) + 0.20×新鲜度；14 天半衰期。
 */
export const W_REL = 0.55
export const W_IMPORTANCE = 0.25
export const W_RECENCY = 0.2
export const HALF_LIFE_DAYS = 14

/** CJK 假设：字符 bigram，免分词 */
export function tokenize(text: string): string[] {
  const t = text.toLowerCase().replace(/\s+/g, ' ').trim()
  if (t.length <= 1) return t ? [t] : []
  const grams: string[] = []
  for (let i = 0; i < t.length - 1; i++) grams.push(t.slice(i, i + 2))
  return grams
}

/** 多重集 Dice 系数 */
export function diceCoefficient(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const count = new Map<string, number>()
  for (const g of a) count.set(g, (count.get(g) ?? 0) + 1)
  let hits = 0
  for (const g of b) {
    const c = count.get(g) ?? 0
    if (c > 0) {
      hits++
      count.set(g, c - 1)
    }
  }
  return (2 * hits) / (a.length + b.length)
}

const ASCII_WORD_RE = /[a-z0-9_@.]{2,}/g

export function asciiBoost(query: string, content: string): number {
  const words = query.toLowerCase().match(ASCII_WORD_RE)
  if (!words) return 0
  const lower = content.toLowerCase()
  return words.some((w) => lower.includes(w)) ? 0.15 : 0
}

export function lexicalRelevance(query: string, content: string): number {
  return Math.min(1, diceCoefficient(tokenize(query), tokenize(content)) + asciiBoost(query, content))
}

/**
 * 新鲜度：exp(-ln2 × 天数 / 半衰期)。
 * v2 语义：decay 按传入的 effectiveTime（=event_time）计算——补录三月的事按三月算，
 * 不被补录时间洗成新信息（tori-memex 借鉴 #1）。
 */
export function recencyScore(effectiveTime: string | Date, now = new Date()): number {
  const t = typeof effectiveTime === 'string' ? new Date(effectiveTime) : effectiveTime
  if (Number.isNaN(t.getTime())) return 0
  const ageDays = Math.max(0, (now.getTime() - t.getTime()) / 86_400_000)
  return Math.exp((-Math.LN2 * ageDays) / HALF_LIFE_DAYS)
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export interface EmbeddingEnvelope {
  m: string
  v: number[]
}

/** 信封解析：裸数组（legacy）→ null 触发懒回填；模型戳不符 → null。 */
export function parseEmbedding(raw: string | null | undefined, expectModel?: string): EmbeddingEnvelope | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const env = parsed as { m?: unknown; v?: unknown }
  if (typeof env.m !== 'string' || !Array.isArray(env.v)) return null
  if (expectModel && env.m !== expectModel) return null
  if (!env.v.every((x) => typeof x === 'number')) return null
  return { m: env.m, v: env.v as number[] }
}

export function encodeEmbedding(model: string, vector: number[]): string {
  return JSON.stringify({ m: model, v: vector })
}

/** v2：按类别半衰期（tori-memex 借鉴 #2）+ state 封顶。 */
export const CATEGORY_HALF_LIFE_DAYS: Record<string, number> = {
  relationship: 365,
  value: 365,
  profile: 180,
  fact: 30,
  detail: 30,
  thought: 14,
}
export const STATE_HALF_LIFE_CAP_DAYS = 7

export function halfLifeFor(category: string, volatility: string): number {
  if (volatility === 'state') return Math.min(STATE_HALF_LIFE_CAP_DAYS, CATEGORY_HALF_LIFE_DAYS[category] ?? 14)
  return CATEGORY_HALF_LIFE_DAYS[category] ?? HALF_LIFE_DAYS
}

/** v2 打分：同权重混合，新鲜度按 event_time + 类别半衰期。 */
export function scoreMemory(
  relevance: number,
  importance: number,
  eventTime: string,
  category: string,
  volatility: string,
  now = new Date(),
): number {
  const half = halfLifeFor(category, volatility)
  const t = new Date(eventTime)
  const ageDays = Number.isNaN(t.getTime()) ? 9999 : Math.max(0, (now.getTime() - t.getTime()) / 86_400_000)
  const recency = Math.exp((-Math.LN2 * ageDays) / half)
  return W_REL * relevance + W_IMPORTANCE * (Math.min(5, Math.max(0, importance)) / 5) + W_RECENCY * recency
}
