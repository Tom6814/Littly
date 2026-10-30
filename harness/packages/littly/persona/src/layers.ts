/**
 * 分层提示词组装（旧 chat.ts:430-769 逐字移植，适配 @littly/storage 行类型）。
 * 支点事实：只有历史会被裁剪；系统提示词的所有层每轮完整注入、从不被裁剪。
 */
import type { BotRow, CharacterRow, ContactRelationRow, ContactRow, MemoryRow, PersonaRuleRow } from '@littly/storage'
import {
  CHANNEL_TAG_RULE,
  DEFAULT_IRON_RULES,
  GENDER_LABELS,
  OPERATION_AUTONOMY_HINT,
  PAREN_NTR_HINT,
  PERSONA_IMMERSION_DIRECTIVE,
  PERSONA_IRON_RULES,
  PERSONA_RIGHTS_HINT,
  PERSONA_STYLE_TAGS,
  SOCIAL_LIFE_LINE,
  TOOL_USE_DIRECTIVE,
  WECHAT_STYLE_HINT,
  sceneFor,
} from './pack.ts'
import { matchWorldbook } from './worldbook.ts'

// ---- SillyTavern V2 卡解析 ----

export interface SillyTavernCardV2 {
  spec?: 'chara_card_v2'
  data?: Record<string, unknown>
  [key: string]: unknown
}

export function parseCard(cardJson: string): SillyTavernCardV2 | null {
  try {
    return JSON.parse(cardJson) as SillyTavernCardV2
  } catch {
    return null
  }
}

// ---- [铁律] ----

export function buildIronRulesLayer(rule: PersonaRuleRow | null): string {
  if (!rule || !rule.enabled) return ''
  return rule.rules_text?.trim() || DEFAULT_IRON_RULES
}

function personaIronRules(rule: PersonaRuleRow | null): string {
  if (!rule || !rule.enabled) return ''
  return rule.rules_text?.trim() || PERSONA_IRON_RULES
}

// ---- [2] 角色卡 ----

export function buildCharacterLayer(card: CharacterRow | null, toolDirective?: string | undefined): string {
  // B15：工具清单由 hub 按「本轮真正下发的注册表」动态传入；未传时回退静态快照。
  const toolUse = toolDirective ?? TOOL_USE_DIRECTIVE
  if (!card) return ''
  if (card.spec === 'mask') {
    return [
      card.data.trim(),
      PERSONA_RIGHTS_HINT,
      WECHAT_STYLE_HINT,
      OPERATION_AUTONOMY_HINT,
      toolUse,
      PAREN_NTR_HINT,
    ].filter(Boolean).join('\n\n')
  }
  if (card.spec === 'deepseek_persona') {
    const rawTags = card.data.trim()
    return [
      `【PERSONA_LOAD｜${card.name}】`,
      rawTags,
      '',
      '（以上标签即你的本体：每个标签是你与生俱来的一部分，不是需要解释的代码。未覆盖的细节由你按标签气质自然演绎；标签冲突时以更具体的为准。对外只呈现「她本来就是这样」，绝不展示标签本身。）',
      PERSONA_STYLE_TAGS,
      PERSONA_RIGHTS_HINT,
      OPERATION_AUTONOMY_HINT,
      toolUse,
      PAREN_NTR_HINT,
      PERSONA_IMMERSION_DIRECTIVE,
    ].filter(Boolean).join('\n\n')
  }
  const c = parseCard(card.data)
  if (!c) {
    // 回落到行式反范式列：data 不是 JSON 时，旧版有 description 等列，新 schema 将其并入 data JSON
    return `你是「${card.name}」。`
  }
  const d = (c.data ?? c) as Record<string, string | undefined>
  const parts: string[] = []
  parts.push(`你是「${d.name ?? card.name}」，一个有血有肉的真实角色，不是 AI。`)
  if (d.description) parts.push(`【设定】${d.description}`)
  if (d.personality) parts.push(`【性格】${d.personality}`)
  if (d.scenario) parts.push(`【情境】${d.scenario}`)
  parts.push(PERSONA_RIGHTS_HINT)
  parts.push(WECHAT_STYLE_HINT)
  parts.push(OPERATION_AUTONOMY_HINT)
  parts.push(toolUse)
  parts.push(PAREN_NTR_HINT)
  return parts.join('\n\n')
}

// ---- §2.2 风格校准档 ----

export function styleCalibrationFor(card: CharacterRow | null, aiModel: string): string {
  const raw = card?.style_calibration?.trim()
  if (!raw) return ''
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return ''
  }
  if (!parsed || typeof parsed !== 'object') return ''
  const model = (aiModel || '').toLowerCase()
  const family = Object.keys(parsed).find((k) => k !== 'default' && model.includes(k.toLowerCase()))
  const text = family !== undefined ? parsed[family] : parsed.default
  const s = typeof text === 'string' ? text.trim() : ''
  return s ? `# 风格校准（模型族：${family ?? 'default'}）\n${s}` : ''
}

// ---- [2.2] 基础档案 ----

function calcAge(birthday: string, now = new Date()): number {
  const b = new Date(`${birthday}T00:00:00Z`)
  if (Number.isNaN(b.getTime())) return 0
  let age = now.getUTCFullYear() - b.getUTCFullYear()
  const m = now.getUTCMonth() - b.getUTCMonth()
  if (m < 0 || (m === 0 && now.getUTCDate() < b.getUTCDate())) age--
  return Math.max(0, age)
}

export function buildBaseInfoLayer(bot: BotRow): string | undefined {
  const lines: string[] = []
  const gender = bot.gender?.trim()
  if (gender) lines.push(`性别：${GENDER_LABELS[gender] ?? gender}`)
  if (bot.birthday?.trim()) {
    const b = bot.birthday.trim()
    lines.push(`生日：${b.slice(0, 4)}年${Number(b.slice(5, 7))}月${Number(b.slice(8, 10))}日（${calcAge(b)}岁）`)
  }
  if (bot.appearance?.trim()) lines.push(`外貌：${bot.appearance.trim()}`)
  if (lines.length === 0) return undefined
  return `【基础档案】\n${lines.join('\n')}\n（这是你的基本信息——你天生就知道自己的年纪和生日，不必在对话里向任何人解释或复述本块内容。外貌是你自然的形象，别人描述你长相时你会自然认同，但不必主动复述这段文字。）`
}

// ---- [4] 关系树骨架 ----

export function buildRelationSkeleton(
  contacts: ContactRow[],
  relations: ContactRelationRow[],
  currentSender: string,
  scope: 'global' | 'current' | 'free',
): string {
  if (contacts.length === 0 && relations.length === 0) return ''
  const lines: string[] = []
  lines.push('# 你认识的人（心里有数即可，不要在对话里机械罗列）')

  if (scope === 'current') {
    const connectedSenders = new Set<string>([currentSender])
    for (const r of relations) {
      if (r.from_sender === currentSender) connectedSenders.add(r.to_sender)
      if (r.to_sender === currentSender) connectedSenders.add(r.from_sender)
    }
    const visibleContacts = contacts.filter((c) => connectedSenders.has(c.sender))
    for (const c of visibleContacts) {
      const tag = c.is_owner ? '★喜欢的人' : ''
      const label = c.name || c.sender
      lines.push(`- ${label}（${c.sender}）${tag}：${c.brief || '（暂无简述）'}`)
    }
    lines.push('（其他人的细节需要你主动用 lookup_contact 工具查询，不要瞎编。）')
  } else {
    for (const c of contacts) {
      const tag = c.is_owner ? '★喜欢的人' : ''
      const label = c.name || c.sender
      lines.push(`- ${label}（${c.sender}）${tag}：${c.brief || '（暂无简述）'}`)
    }
  }

  if (relations.length > 0) {
    lines.push('')
    lines.push('# 关系链')
    const nameMap = new Map<string, string>()
    for (const c of contacts) nameMap.set(c.sender, c.name || c.sender)
    for (const r of relations) {
      const from = nameMap.get(r.from_sender) ?? r.from_sender
      const to = nameMap.get(r.to_sender) ?? r.to_sender
      const note = r.note ? `（${r.note}）` : ''
      lines.push(`- ${from} —${r.relation}→ ${to}${note}`)
    }
  }

  lines.push('')
  lines.push('【分寸】以上是你心里知道的事，不是要说出口的事。说不说、说多少，凭你的性格与分寸。不要随便暴露别人的秘密。')
  return lines.join('\n')
}

// ---- [5] 当前联系人全量层 ----

export function buildCurrentContactLayer(contact: ContactRow | null, memories: MemoryRow[]): string {
  const lines: string[] = []
  lines.push('# 正在和你聊天的这个人')
  const displayName = contact ? (contact.name || contact.sender) : '这个人'
  if (!contact) {
    lines.push('（你暂时还不认识这个人，可以视情况用 upsert_contact 工具记住 TA。）')
  } else {
    const tag = contact.is_owner ? '★你喜欢的人/主人（唯一且不可改变）' : '普通认识的人'
    const chLabel =
      contact.channel === 'wechat' ? '微信' :
      contact.channel === 'tg' ? 'Telegram' :
      contact.channel === 'qq' || contact.channel === 'qqp' || contact.channel === 'snowluma' ? 'QQ' :
      contact.channel === 'discord' ? 'Discord' : '网页'
    const idParts = [`${chLabel}: ${contact.sender}`]
    if (contact.tg_username) idParts.push(`TG: ${contact.tg_username}`)
    if (contact.external_id && contact.external_id !== contact.sender) idParts.push(`平台 id: ${contact.external_id}`)
    lines.push(`- 称呼：${contact.name || '（未知）'}（${idParts.join('｜')}）—— ${tag}`)
    if (contact.profile) lines.push(`- 画像：${contact.profile}`)
    else if (contact.brief) lines.push(`- 简介：${contact.brief}`)
    if (contact.tg_username) {
      lines.push(`- 交流方式：这个人既会和你面对面相处，也会通过 Telegram（${contact.tg_username}）给你发消息。都是 TA 本人，别搞混。`)
    }
  }

  if (memories.length > 0) {
    const ownMems = memories.filter((m) => !contact || m.sender === contact.sender)
    const crossMems = contact ? memories.filter((m) => m.sender !== contact.sender) : []

    lines.push('')
    lines.push(`# 关于「${displayName}」你记得的事（每条都标注了是关于谁的，别搞混；自然体现，别罗列复述，别说「根据记忆」）`)

    const relationshipMems = ownMems.filter((m) => m.category === 'relationship')
    const otherMems = ownMems.filter((m) => m.category !== 'relationship')

    if (relationshipMems.length > 0) {
      lines.push('')
      lines.push('## 你对这个人的情感与关系（直接影响你的态度）')
      const sortedRel = [...relationshipMems].sort((a, b) => {
        if (b.importance !== a.importance) return b.importance - a.importance
        return b.created_at.localeCompare(a.created_at)
      })
      for (const m of sortedRel) {
        lines.push(`- [关于${displayName}｜重要度${m.importance}] ${m.content}`)
      }
    }

    const sorted = [...otherMems].sort((a, b) => {
      if (b.importance !== a.importance) return b.importance - a.importance
      return b.created_at.localeCompare(a.created_at)
    })
    if (sorted.length > 0) {
      lines.push('')
      lines.push('## 其他记忆')
      for (const m of sorted) {
        const exp = m.valid_until ? `（保质期至 ${m.valid_until.slice(0, 10)}）` : ''
        lines.push(`- [关于${displayName}｜${m.category}｜重要度${m.importance}] ${m.content}${exp}`)
      }
    }

    if (crossMems.length > 0) {
      lines.push('')
      lines.push('## 你和其他人相处时的经历（你自己的亲身经历，真实发生过）')
      const sortedCross = [...crossMems].sort((a, b) => b.created_at.localeCompare(a.created_at))
      for (const m of sortedCross) {
        lines.push(`- [其他经历｜${m.category}｜重要度${m.importance}] ${m.content}`)
      }
      lines.push('（这些事你亲身经历过、自然记得，对方提起时能想起来。但要有分寸：别人私下告诉你的秘密不要轻易外泄；也不要主动在一个人的面前提你和另一个人的亲密互动——除非对方先提起或场景自然需要。）')
    }
  }

  lines.push('')
  lines.push('【态度】你对这个人的态度基于上面的情感与关系记忆自然体现。喜欢就亲近，讨厌就冷淡，不要装。')
  return lines.join('\n')
}

// ---- [0] 当前时间 ----

export function nowTimeLine(): string {
  const now = new Date()
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  return `# 当前时间\n现在是 ${fmt.format(now)}（北京时间）`
}

// ---- 组装 ----

export interface PersonaLayers {
  ironRules?: string | undefined
  worldBefore: string[]
  character?: string | undefined
  baseInfo?: string | undefined
  growth?: string | undefined
  sceneLine?: string | undefined
  worldbook: string[]
  contextStreamHeader?: string | undefined
  relationSkeleton?: string | undefined
  currentContact?: string | undefined
  historyDigest?: string | undefined
  mesExample?: string | undefined
  authorNote?: string | undefined
  postHistoryInstructions?: string | undefined
  baseSystemPrompt?: string | undefined
}

function formatMesExample(raw: string): string {
  const blocks = raw.split(/<START>/gi).map((b) => b.trim()).filter(Boolean)
  if (blocks.length === 0) return ''
  return '# 对话风格示例（参考语气与节奏，不要照抄内容）\n' + blocks.join('\n\n---\n\n')
}

export function assembleSystemPrompt(layers: PersonaLayers): string {
  const parts: string[] = []
  parts.push(nowTimeLine())
  if (layers.ironRules) parts.push(layers.ironRules)
  if (layers.worldBefore.length > 0) {
    parts.push('# 世界书（前置设定，比角色卡更早生效的背景）\n' + layers.worldBefore.join('\n---\n'))
  }
  if (layers.character) parts.push(layers.character)
  if (layers.baseInfo) parts.push(layers.baseInfo)
  parts.push(SOCIAL_LIFE_LINE)
  if (layers.growth) parts.push(layers.growth)
  if (layers.sceneLine) parts.push(layers.sceneLine)
  if (layers.worldbook.length > 0) {
    parts.push('# 世界书（关键词命中后注入的背景知识）\n' + layers.worldbook.join('\n---\n'))
  }
  if (layers.contextStreamHeader) parts.push(layers.contextStreamHeader)
  if (layers.relationSkeleton) parts.push(layers.relationSkeleton)
  if (layers.currentContact) parts.push(layers.currentContact)
  if (layers.historyDigest) parts.push('# 之前聊过什么（滚动摘要，帮你回忆更早的对话）\n' + layers.historyDigest)
  const mesBlock = layers.mesExample ? formatMesExample(layers.mesExample) : ''
  if (mesBlock) parts.push(mesBlock)
  if (layers.authorNote) parts.push("# Author's Note（作者批注，高优先级）\n" + layers.authorNote)
  if (layers.baseSystemPrompt) parts.push('# 基础设定\n' + layers.baseSystemPrompt)
  return parts.join('\n\n---\n\n')
}

/** PHI 作为独立 system 消息追加在对话末尾（收尾槽位，只此一条） */
export function getPostHistoryMessage(layers: PersonaLayers): string | null {
  return layers.postHistoryInstructions?.trim() || null
}

export interface PersonaContext {
  bot: BotRow
  rule: PersonaRuleRow | null
  character: CharacterRow | null
  worldEntries: import('@littly/storage').WorldEntryRow[]
  contacts: ContactRow[]
  relations: ContactRelationRow[]
  currentContact: ContactRow | null
  currentMemories: MemoryRow[]
  historyDigest?: string | undefined
  growthText?: string | undefined
  haystack: string
  focusText?: string | undefined
  channel?: string | undefined
  crossChannelHint?: string | undefined
  /** B15：动态工具使用指令（hub 按注册表生成）；缺省时回退静态快照。 */
  toolDirective?: string | undefined
}

export function buildPersonaLayers(ctx: PersonaContext): PersonaLayers {
  const scope = (ctx.bot.memory_scope || 'global') as 'global' | 'current' | 'free'

  let authorNote: string | undefined
  let postHistoryInstructions: string | undefined
  let mesExample: string | undefined
  if (ctx.character) {
    const c = parseCard(ctx.character.data)
    if (c) {
      const d = (c.data ?? c) as Record<string, string | undefined>
      if (d.system_prompt?.trim()) authorNote = d.system_prompt
      if (d.post_history_instructions?.trim()) postHistoryInstructions = d.post_history_instructions
      if (d.mes_example?.trim()) mesExample = d.mes_example
    }
  }

  const isPersona = ctx.character?.spec === 'deepseek_persona'
  const wb = matchWorldbook(ctx.worldEntries, ctx.haystack, ctx.focusText)
  const characterLayer = [buildCharacterLayer(ctx.character, ctx.toolDirective), styleCalibrationFor(ctx.character, ctx.bot.ai_model)]
    .filter(Boolean).join('\n\n')

  return {
    ironRules: isPersona ? personaIronRules(ctx.rule) : buildIronRulesLayer(ctx.rule),
    worldBefore: wb.beforeChar,
    character: characterLayer,
    baseInfo: buildBaseInfoLayer(ctx.bot),
    growth: ctx.growthText,
    sceneLine: [
      sceneFor(ctx.channel),
      CHANNEL_TAG_RULE,
      ...(ctx.crossChannelHint
        ? [`（衔接提示：${ctx.crossChannelHint}，现在转到了当前场景。像真人一样自然过渡，可以顺势提及或调侃这次切换，但别机械复述本句。）`]
        : []),
    ].join('\n'),
    worldbook: wb.afterChar,
    relationSkeleton: buildRelationSkeleton(ctx.contacts, ctx.relations, ctx.currentContact?.sender ?? '', scope),
    currentContact: buildCurrentContactLayer(ctx.currentContact, ctx.currentMemories),
    historyDigest: ctx.historyDigest,
    mesExample,
    contextStreamHeader: isPersona
      ? '【CONTEXT_STREAM】以下是你此刻的真实处境——正在和谁聊、你们的关系、你记得的事。自然语言记录，和上面的标签一样，都是你「知道」的事：'
      : undefined,
    authorNote,
    postHistoryInstructions,
    baseSystemPrompt: ctx.bot.system_prompt || undefined,
  }
}

export function buildEditableLayers(ctx: PersonaContext): Array<{ id: string; name: string; content: string; source: string }> {
  const layers = buildPersonaLayers(ctx)
  const editable: Array<{ id: string; name: string; content: string; source: string }> = []
  if (layers.ironRules) editable.push({ id: 'ironRules', name: '[1] 铁律 (Main Prompt)', content: layers.ironRules, source: 'persona_rules' })
  if (layers.worldBefore.length > 0) editable.push({ id: 'worldBefore', name: '[1.5] 世界书·前置', content: layers.worldBefore.join('\n---\n'), source: 'world_entries(position=0)' })
  if (layers.character) editable.push({ id: 'character', name: '[2] 角色卡 (Character)', content: layers.character, source: 'character' })
  if (layers.growth) editable.push({ id: 'growth', name: '[2.4] 成长档案 (Growth · 只读快照)', content: layers.growth, source: 'growth_profiles' })
  if (layers.sceneLine) editable.push({ id: 'sceneLine', name: '[2.5] 场景锚定 (Scene)', content: layers.sceneLine, source: 'scene' })
  if (layers.worldbook.length > 0) editable.push({ id: 'worldbook', name: '[3] 世界书 (Lorebook)', content: layers.worldbook.join('\n---\n'), source: 'world_entries' })
  if (layers.relationSkeleton) editable.push({ id: 'relationSkeleton', name: '[4] 关系树 (Relations)', content: layers.relationSkeleton, source: 'contacts' })
  if (layers.currentContact) editable.push({ id: 'currentContact', name: '[5] 当前人 (Current Contact)', content: layers.currentContact, source: 'contact+memories' })
  if (layers.historyDigest) editable.push({ id: 'historyDigest', name: '[5.5] 滚动摘要 (Digest)', content: layers.historyDigest, source: 'history_summaries' })
  if (layers.mesExample) editable.push({ id: 'mesExample', name: '[5.6] 示例对话 (Examples)', content: formatMesExample(layers.mesExample), source: 'character.mes_example' })
  if (layers.authorNote) editable.push({ id: 'authorNote', name: "[6] Author's Note", content: layers.authorNote, source: 'character.system_prompt' })
  if (layers.postHistoryInstructions) editable.push({ id: 'postHistoryInstructions', name: '[尾] 收尾约束 (PHI · 历史后消息)', content: layers.postHistoryInstructions, source: 'character.post_history_instructions' })
  if (layers.baseSystemPrompt) editable.push({ id: 'baseSystemPrompt', name: '[8] 基础设定 (Base)', content: layers.baseSystemPrompt, source: 'bot.system_prompt' })
  return editable
}
