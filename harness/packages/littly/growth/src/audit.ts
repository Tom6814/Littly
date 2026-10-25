/**
 * §成长档案 — 事实审计器（§幻觉治理）。
 *
 * 逐字移植自旧项目 src/internal/growth/audit.ts（仅 DB 访问层改为 SQL）。
 * 背景：Memory / Diary 是 AI 加工的二手产物，可能失真甚至完全虚构；
 * Message（对话原文）是逐字保存的金标准。
 * 流程：从原文检索与每条证据相关的对话片段 → 审计器对照原文逐条核实 →
 * 失真证据返回 rejectEvidenceIds，由调用方在落库前剔除（铁律二仍硬校验）。
 * fail-open：任何失败返回全 keep（pass），不阻断管线；服务端存在性校验仍生效。
 */
import type { LittlyStorage } from '@littly/storage'
import { chatComplete, type ChatMessage } from '@littly/llm'
import { parseAudit, type EvidenceAudit } from './types.ts'

const AUDIT_MAX_TOKENS = 1200
const CONTEXT_PER_EVIDENCE = 6 // 每条证据最多检索的原文消息条数
const QUERY_TERMS = 4 // 每条证据最多取 4 个关键词
const MAX_DIALOGUE_CHARS = 16000 // 喂给审计器的原文总量上限（防爆）

/** 从证据文本里抽出中文关键词（2-6 字），用于原文检索 */
export function extractKeywords(text: string): string[] {
  const words = text.match(/[\u4e00-\u9fa5]{2,8}/g) ?? []
  const uniq = Array.from(new Set(words.filter((w) => w.length >= 2)))
  const stop = new Set(['我们', '自己', '一个', '这个', '那个', '什么', '因为', '但是', '然后', '如果', '所以', '没有', '怎么', '可以', '知道', '觉得', '时候', '事情', '真的', '有点', '还是', '就是', '不是', '一下', '一会', '现在', '今天', '昨天', '明天', '以后', '之前', '东西', '你们', '他们', '她们', '已经', '这样', '那样'])
  return uniq.filter((w) => !stop.has(w)).slice(0, QUERY_TERMS)
}

/** 为一条证据检索对应的对话原文片段（含上下文） */
function retrieveDialogueForEvidence(
  storage: LittlyStorage,
  botId: string,
  evidenceText: string,
  maxCount: number,
): string[] {
  const terms = extractKeywords(evidenceText)
  if (terms.length === 0) return []
  try {
    const rows = storage
      .prepare(
        `SELECT role, content FROM messages WHERE bot_id = ? AND role IN ('user','assistant') AND (${terms.map(() => 'content LIKE ?').join(' OR ')}) ORDER BY created_at DESC LIMIT ?`,
      )
      .all(botId, ...terms.map((t) => `%${t}%`), maxCount) as unknown as Array<{ role: string; content: string }>
    return rows.map((r) => `${r.role === 'user' ? '你' : '她'}: ${r.content.slice(0, 200)}`)
  } catch {
    return []
  }
}

/** 从 "[abc] (category) 内容" 里取证据编号。 */
function evidenceIdOf(text: string): string {
  const head = text.split(']')[0] ?? ''
  return head.replace('[', '').trim()
}

/**
 * 对评审引用的证据逐条核实。
 * @param evidenceTexts 每条证据的原文（编号 + 内容），如 "[abc] (relationship) 她提到..."
 */
export async function auditEvidence(
  storage: LittlyStorage,
  botId: string,
  evidenceTexts: string[],
  model?: string,
): Promise<EvidenceAudit> {
  const fallback: EvidenceAudit = {
    verdict: 'pass',
    rejectEvidenceIds: [],
    keepEvidenceIds: evidenceTexts.map(evidenceIdOf).filter(Boolean),
    issues: ['事实审计不可用，放行（证据存在性硬校验仍生效）'],
  }
  if (evidenceTexts.length === 0) return fallback

  const snippets: string[] = []
  for (const ev of evidenceTexts) {
    const ctx = retrieveDialogueForEvidence(storage, botId, ev, CONTEXT_PER_EVIDENCE)
    if (ctx.length > 0) snippets.push(`[证据: ${ev}]\n[对话原文片段]:\n${ctx.join('\n')}`)
  }

  if (snippets.length === 0) {
    return {
      verdict: 'reject',
      rejectEvidenceIds: evidenceTexts.map(evidenceIdOf).filter(Boolean),
      keepEvidenceIds: [],
      issues: ['无法从对话原文检索到任何相关片段，全部证据无法核实'],
    }
  }

  const joined = snippets.join('\n\n').slice(0, MAX_DIALOGUE_CHARS)
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `你是事实审计器。你的唯一职责：判断下面的「记忆证据」是否能被「对话原文片段」证实。你是独立的怀疑者，倾向严格。
  
规则：
- 只有原文片段明确提到、或高度直接支持记忆中的内容，才算「证实」。
- 原文片段与记忆不符、无关、或原文缺失关键细节 → 判定「无法证实」。
- 如果对话原文完全检索不到相关片段 → 判定「无法证实」。
- 你只依据给出的原文判断，绝不脑补、绝不补全。
  
只回 JSON：
{"verdict":"pass","rejectEvidenceIds":[],"keepEvidenceIds":["所有证实通过的证据编号"],"issues":["整体意见"]}
{"verdict":"reject","rejectEvidenceIds":["无法证实的证据编号"],"keepEvidenceIds":["证实通过的证据编号"],"issues":["每个被否证据一条理由"]}`,
    },
    {
      role: 'user',
      content: `以下是需要核实的记忆证据，以及检索到的对话原文片段。请逐条核实：\n\n${joined}`,
    },
  ]

  try {
    const res = await chatComplete(storage, messages, { model, temperature: 0.1, maxTokens: AUDIT_MAX_TOKENS })
    const match = res.content.match(/\{[\s\S]*\}/)
    if (!match) return fallback
    return parseAudit(match[0]) ?? fallback
  } catch {
    return fallback
  }
}
