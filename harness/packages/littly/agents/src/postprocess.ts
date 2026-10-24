/**
 * 出口后处理（旧 sink/ai.ts:24-63 + ai/paren-fix.ts 逐字移植）。
 */

/** §11.1 思考标签剥离 */
export function stripThinkingText(text: string): string {
  if (!text) return text
  return text
    .replace(/<\s*thinking\b[^>]*>[\s\S]*?<\s*\/\s*thinking\s*>/gi, '')
    .replace(/<\s*think\b[^>]*>[\s\S]*?<\s*\/\s*think\s*>/gi, '')
    .replace(/<\s*\/?\s*(?:thinking|think)\b[^>]*>/gi, '')
}

/** §11.5 乱码/工具说明回显巡检 */
export function looksGarbled(text: string): boolean {
  if (!text) return false
  if (/\uFFFD/.test(text)) return true
  if (/schedule_message\s*[:：]/.test(text)) return true
  if (/\barg_key\b/.test(text)) return true
  const urls = text.match(/https?:\/\/|www\.[^\s]{3,}/g)
  if (urls && urls.length >= 3) return true
  if (/source\s*code/i.test(text) && /payment|password/i.test(text)) return true
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length
  const printable = text.replace(/\s+/g, '').length
  if (printable > 20 && cjk / printable < 0.15) return true
  return false
}

/** §3.3 安全阀触发器（只判断「要不要多给一次开口机会」，不产出回复） */
export function looksCrisis(text: string): boolean {
  if (!text) return false
  return (
    /自杀|轻生|想死|不想活|活不下去|活着没(?:有)?(?:意思|意义)|了结(?:自己|生命)|结束(?:自己(?:的)?)?生命|一了百了|遗书|自残|自伤|伤害自己|割腕|割脉|跳楼|跳下去|上吊|烧炭|安眠药|世界再见|不再醒来/.test(text) ||
    /suicide|kill\s*myself|end\s*my\s*life|end\s*it\s*all|want\s*to\s*die|self[-\s]?harm|hurt\s*myself/i.test(text)
  )
}

/** 括号动作人称清洗：括号内「他」→「你」。只处理「他」，不碰「她」（她另有其人）。 */
const PAREN_RE = /（[^（）]*）|\([^()]*\)/g

export function fixParenPerson(text: string): string {
  if (!text) return text
  if (!text.includes('他')) return text
  return text.replace(PAREN_RE, (seg) => seg.replace(/他/g, '你'))
}
