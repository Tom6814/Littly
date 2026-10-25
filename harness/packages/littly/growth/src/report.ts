/**
 * §成长档案 — 月度成长日记（D10）。
 *
 * 逐字移植自旧项目 src/internal/growth/report.ts（仅 DB 访问层改为 SQL）。
 * 提案批准后，由「角色本人」（带人格提示词的 bot 模型）以第一人称写一篇
 * 月底「月度成长日记」。纯展示产物：只呈现已批准的变化，永不回馈档案、
 * 不参与后续评审输入（防止叙事污染事实层——hermes 教训）。
 * fail-open：失败返回 null，不影响审批主流程。
 */
import type { LittlyStorage } from '@littly/storage'
import { chatComplete, type ChatMessage } from '@littly/llm'
import { cardDigestText } from './dimensions.ts'
import { parseDimensions, parseChanges } from './types.ts'
import { profileByVersion, setProposalReport, writeAudit, type GrowthProposalRow } from './store.ts'

const REPORT_MAX_TOKENS = 900

interface ReportBotRow {
  id: string
  name: string
  character_id: string | null
  ai_model: string
}

interface ReportCharacterRow {
  id: string
  data: string
}

export async function generateGrowthReport(
  storage: LittlyStorage,
  botId: string,
  proposalId: string,
): Promise<string | null> {
  try {
    const bot = storage.prepare('SELECT * FROM bots WHERE id = ?').get(botId) as ReportBotRow | undefined
    const proposal = storage.prepare('SELECT * FROM growth_proposals WHERE id = ?').get(proposalId) as GrowthProposalRow | undefined
    if (!bot || !proposal) return null
    if (!['approved', 'edited'].includes(proposal.status)) return null

    const newProfile = storage
      .prepare("SELECT * FROM growth_profiles WHERE bot_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1")
      .get(botId) as { dimensions: string } | undefined
    if (!newProfile) return null

    const changes = parseChanges(proposal.changes)
    if (changes.length === 0) return null

    // 变化前后的行为判据对照（按 basedVersion 精确取旧版档案）
    const oldProfile = profileByVersion(storage, botId, proposal.based_version)
    const oldDims = oldProfile ? parseDimensions(oldProfile.dimensions) : []
    const newDims = parseDimensions(newProfile.dimensions)

    let cardText = ''
    if (bot.character_id) {
      const character = storage.prepare('SELECT * FROM characters WHERE id = ?').get(bot.character_id) as ReportCharacterRow | undefined
      if (character) cardText = cardDigestText(character.data)
    }

    const diffLines = changes.map((c) => {
      const before = oldDims.find((d) => d.key === c.dimension)?.desc ?? ''
      const after = newDims.find((d) => d.key === c.dimension)?.desc ?? ''
      return `【${c.dimension}】${c.fromLevel}→${c.toLevel} 级\n变化前：${before}\n变化后：${after}\n你的理解：${c.reasoning}`
    }).join('\n\n')

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `你就是${bot.name}本人。现在到了月底，该写你本月的「月度成长日记」了——像深夜独自坐在窗前，回想这个月，把心里的变化写给未来的自己。

要求：
- 完全用你自己的口吻和性格说话（角色卡是你的性格依据）。
- 这是日记，不是报告、不是总结表——是写给未来的自己看的心里话，可以碎碎念、可以停顿、可以只写当下最在意的事。
- 把下面列出的这些已经确认的变化，融进你这个月真实经历过的事里自然地写出来；只写这些已确认的变化，不要夸大、不要虚构其它改变。
- 自然、真实；可以困惑、可以释然，不必正能量。
- 300 字以内，不要标题，不要客套，不要「本月总结」之类的书面腔。`,
      },
      {
        role: 'user',
        content: `${cardText ? `【关于你】\n${cardText.slice(0, 1500)}\n\n` : ''}【你这段时间的变化】\n${diffLines}\n\n请写下你这个月的成长日记。`,
      },
    ]

    const res = await chatComplete(storage, messages, { model: bot.ai_model || undefined, temperature: 0.8, maxTokens: REPORT_MAX_TOKENS })
    const text = res.content.trim()
    if (!text) return null

    setProposalReport(storage, proposalId, text)
    writeAudit(storage, botId, 'report', `proposal=${proposalId}`)
    return text
  } catch (e) {
    console.warn(`[growth] report failed for ${botId}/${proposalId}:`, e instanceof Error ? e.message : e)
    return null
  }
}
