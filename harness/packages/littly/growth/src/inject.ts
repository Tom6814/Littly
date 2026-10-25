/**
 * §成长档案 — 注入层 [2.4]。
 *
 * 逐字移植自旧项目 src/internal/growth/inject.ts。
 * 把 active 成长档案渲染成「她自己的内在状态」，插在角色卡与场景锚定之间。
 * 关键措辞约束（设计文档 D2/D3）：档案是经历沉淀的结果而非设定，
 * 要求自然体现、绝不主动汇报。v1 采用每请求读取（近似冻结快照），
 * 评审期间人格稳定性由「提案未批准不生效」保证。
 */
import type { LittlyStorage } from '@littly/storage'
import { parseDimensions } from './types.ts'
import { activeProfile } from './store.ts'

function levelBar(level: number): string {
  return '█'.repeat(Math.min(5, Math.max(0, level))) + '░'.repeat(Math.max(0, 5 - level))
}

/** 返回注入文本；无档案 / 出错返回 undefined（fail-open，绝不阻断对话）。 */
export function getActiveGrowthText(storage: LittlyStorage, botId: string): string | undefined {
  try {
    const profile = activeProfile(storage, botId)
    if (!profile) return undefined

    const dims = parseDimensions(profile.dimensions)
    if (dims.length === 0) return undefined

    const lines: string[] = []
    lines.push(`【成长档案 v${profile.version}】你最近悄悄变了一些——这些变化来自你真实的经历，不是你刻意选择的设定，是经历在你身上留下的痕迹。你甚至不一定说得清自己为什么变了，很多变化本来就是这样无声发生的。让它自然地体现在你的言行、喜好和第一反应里就好：绝不要主动提起、复述或解释这些变化，就像人不会时刻念叨自己是什么性格。`)
    if (profile.life_stage) {
      lines.push(`人生阶段：${profile.life_stage}`)
    }
    lines.push('内在状态：')
    for (const d of dims) {
      lines.push(`- ${d.key} ${levelBar(d.level)} ${d.level}/5 —— ${d.desc}`)
    }
    return lines.join('\n')
  } catch {
    return undefined
  }
}
