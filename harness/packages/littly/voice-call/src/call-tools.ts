/**
 * 通话专用的两个工具（recall_context / end_call）—— 旧 monolith
 * src/internal/voice-call/call-server.ts 的 RECALL_CONTEXT_TOOL / END_CALL_TOOL
 * 与 executeRecallContext 的忠实移植。
 *
 * 注意：这两个工具**不进全局注册表**，只在本链路下发给模型；执行器在本文件内
 * （recall_context 需要捞回被精简掉的上下文：RAG 记忆 + 世界书 + 关系树 + 社交生活线）。
 */
import { SOCIAL_LIFE_LINE } from '@littly/persona/src/pack.ts'
import type { ContactRelationRow, LittlyStorage, WorldEntryRow } from '@littly/storage'
import type { LittlyMemory } from '@littly/memory'
import type { ToolDef } from '@littly/tools'

// §recall_context — 通话专用工具（不进全局注册，只在本链路下发）。
// 通话精简 prompt 时删掉了世界书关键词注入/关系树骨架/社交生活线，并且不想常驻
// 注入太多记忆——AI 需要时用这个工具按需捞回：RAG 检索记忆 + 世界书 + 关系树 + 社交生活线。
export const RECALL_CONTEXT_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'recall_context',
    description: `通话中按需检索被精简掉的背景设定与记忆（RAG 语义检索）。需要以下信息时调用：
- 记忆：关于当前这个人的过往记忆（关系进展、喜好、聊过的事）——语义检索，query 填你想了解的话题。
- 世界书：世界观设定（人名/地点/事件/规则），query 填关键词。
- 关系树：你认识的人之间的关系。
- 社交生活线：你的相册、QQ 空间等生活设定。
对方提到你记不清的旧事、陌生名词，或你想确认某段关系/某个设定时调用。query 越具体越好。`,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '想了解的话题 / 关键词，尽量具体' },
      },
      required: ['query'],
    },
  },
}

// §end_call — 通话专用工具：AI 判断对话该结束时主动挂断。
export const END_CALL_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'end_call',
    description: `结束本次语音通话。当对话自然走到尾声时调用：对方明确说再见/晚安/去忙别的、话题已经收尾、或你判断该挂了。调用后通话会结束，系统会自动把这次通话整理成记忆。不要一开场就挂，也别把普通聊天当告别。`,
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '为什么结束通话（简短，内部记录用）' },
      },
      required: ['reason'],
    },
  },
}

/** end_call 的工具名（决策路径判定用）。 */
export const END_CALL_TOOL_NAME = 'end_call'

/** 该工具调用是否意味着「AI 主动结束通话」。 */
export function isEndCallTool(name: string): boolean {
  return name === END_CALL_TOOL_NAME
}

/** 通话链路的执行依赖（存储 + 记忆引擎）。 */
export interface CallToolDeps {
  storage: LittlyStorage
  memory: LittlyMemory
}

/**
 * recall_context 执行器（旧 executeRecallContext 移植）：
 * 1) RAG 语义检索记忆（复用主链路同一套混合检索：向量优先、词法兜底）
 * 2) 世界书：关键词命中（query 为空时返回常驻条目）
 * 3) 关系树（无条件返回，量小且重要）
 * 4) 社交生活线（无条件返回）
 */
export async function executeRecallContext(
  deps: CallToolDeps,
  botId: string,
  sender: string,
  query: string,
): Promise<string> {
  const parts: string[] = []
  const q = (query || '').trim()

  // 1) RAG 语义检索记忆
  if (q) {
    try {
      const mems = await deps.memory.retrieveMemories({ botId, sender, query: q })
      const lines = mems
        .filter((m) => m.content)
        .slice(0, 10)
        .map((m) => `- ${m.content}`)
      if (lines.length) parts.push('【记忆】\n' + lines.join('\n'))
    } catch {
      // RAG 失败降级：跳过记忆部分，不影响其余
    }
  }

  // 2) 世界书：关键词命中（query 为空时返回常驻条目）
  try {
    const entries = deps.storage
      .prepare("SELECT * FROM world_entries WHERE enabled = 1 AND (character_id = '' OR character_id = ?) ORDER BY priority DESC")
      .all(characterIdOf(deps, botId)) as unknown as WorldEntryRow[]
    const kw = q.toLowerCase()
    const hit = entries.filter((e) => {
      if (!q) return e.constant === 1
      return `${e.keys} ${e.content} ${e.second_keys}`.toLowerCase().includes(kw)
    })
    if (hit.length) parts.push('【世界书】\n' + hit.slice(0, 6).map((e) => `- ${e.content}`).join('\n'))
  } catch {
    // 忽略世界书查询失败
  }

  // 3) 关系树（无条件返回，量小且重要）
  try {
    const rels = deps.storage
      .prepare('SELECT * FROM contact_relations WHERE bot_id = ?')
      .all(botId) as unknown as ContactRelationRow[]
    const relLines = rels.filter((r) => r.relation && r.to_sender).map((r) => `${r.from_sender} —${r.relation}→ ${r.to_sender}`)
    if (relLines.length) parts.push('【关系树】\n' + relLines.join('\n'))
  } catch {
    // 忽略
  }

  // 4) 社交生活线（无条件返回）
  parts.push(SOCIAL_LIFE_LINE)

  return parts.join('\n\n---\n\n') || '（没有找到相关背景设定）'
}

/** 该 bot 的角色卡 id（世界书按「全局 + 本角色」取；无角色卡则只取全局）。 */
function characterIdOf(deps: CallToolDeps, botId: string): string {
  const row = deps.storage.prepare('SELECT character_id FROM bots WHERE id = ?').get(botId) as { character_id: string | null } | undefined
  return row?.character_id ?? ''
}
