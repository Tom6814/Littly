/**
 * 通话专用的精简 system prompt —— 旧 monolith src/internal/voice-call/call-server.ts
 * 里那段「只留人格与当前关系」的层选择，逐层逐序照搬。
 *
 * 旧实现（call-server.ts:438-451）：
 *   const sysParts = [
 *     layers.ironRules, layers.character, layers.baseInfo, layers.growth,
 *     layers.sceneLine, layers.contextStreamHeader, layers.currentContact,
 *     layers.historyDigest, layers.mesExample, layers.authorNote,
 *     layers.baseSystemPrompt,
 *   ].filter((x): x is string => !!x && x.trim().length > 0)
 *   const systemPrompt = sysParts.join('\n\n---\n\n')
 *
 * 语义（必须保持）：通话走独立精简链路，**跳过**世界书关键词注入（worldBefore /
 * worldbook）、关系树骨架（relationSkeleton）、社交生活线（social life line），
 * 以及收尾槽位（postHistoryInstructions）——语音指令 CALL_VOICE_STYLE 放在对话
 * 最末（jailbreak 槽位）权重最高。
 */
import type { PersonaLayers } from '@littly/persona/src/layers.ts'

/** 参与通话 system prompt 的层（顺序即拼接顺序）。 */
export const CALL_SYSTEM_LAYERS = [
  'ironRules',
  'character',
  'baseInfo',
  'growth',
  'sceneLine',
  'contextStreamHeader',
  'currentContact',
  'historyDigest',
  'mesExample',
  'authorNote',
  'baseSystemPrompt',
] as const satisfies readonly (keyof PersonaLayers)[]

/** 被通话链路显式排除的层（世界书 / 关系树 / 收尾槽位）。 */
export const CALL_EXCLUDED_LAYERS = [
  'worldBefore',
  'worldbook',
  'relationSkeleton',
  'postHistoryInstructions',
] as const satisfies readonly (keyof PersonaLayers)[]

/** 取参与通话的层文本（空串/纯空白剔除）。 */
export function selectCallSystemParts(layers: PersonaLayers): string[] {
  const parts: string[] = []
  for (const key of CALL_SYSTEM_LAYERS) {
    const value = layers[key]
    if (typeof value === 'string' && value.trim().length > 0) parts.push(value)
  }
  return parts
}

/** 拼装通话 system prompt（层间分隔符与旧实现一致）。 */
export function buildCallSystemPrompt(layers: PersonaLayers): string {
  return selectCallSystemParts(layers).join('\n\n---\n\n')
}
