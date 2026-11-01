/**
 * persona 插件：从业务库加载行数据，产出分层系统提示词。
 * 服务键 'littlyPersona'；hub / console-api（调试层查看器）共同消费。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { LittlyStorage } from '@littly/storage'
import type {
  BotRow, CharacterRow, ContactRelationRow, ContactRow, MemoryRow, PersonaRuleRow, WorldEntryRow,
} from '@littly/storage'
import { assembleSystemPrompt, buildEditableLayers, buildInnerStateLayer, buildPersonaLayers, getPostHistoryMessage, type PersonaContext, type PersonaLayers } from './layers.ts'
import { loadInnerState, narrate, recordInnerEvent } from './inner-state.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    littlyStorage: LittlyStorage
    littlyPersona: LittlyPersona
  }
}

export const name = 'littly-persona'

export const inject = ['littlyStorage']

export interface Config {}

export const Config: z<Config> = z.object({})

export interface BuildPromptOptions {
  botId: string
  sender: string
  channel?: string | undefined
  /** 世界书匹配语料：近期对话 + 当前消息 */
  haystack: string
  /** 最新一条用户消息（追问必达跳过概率骰） */
  focusText?: string | undefined
  currentMemories?: MemoryRow[] | undefined
  historyDigest?: string | undefined
  growthText?: string | undefined
  crossChannelHint?: string | undefined
  /** B15：动态工具使用指令（由 hub 按实际下发的工具注册表生成）。 */
  toolDirective?: string | undefined
}

export class LittlyPersona {
  private readonly storage: LittlyStorage

  constructor(storage: LittlyStorage) {
    this.storage = storage
  }

  private all<T>(sql: string, ...params: unknown[]): T[] {
    return this.storage.prepare(sql).all(...params) as T[]
  }

  private get<T>(sql: string, ...params: unknown[]): T | null {
    return (this.storage.prepare(sql).get(...params) as T | undefined) ?? null
  }

  loadBot(botId: string): BotRow | null {
    return this.get<BotRow>('SELECT * FROM bots WHERE id = ?', botId)
  }

  loadRule(botId: string): PersonaRuleRow | null {
    // 解析顺序：角色级 → 全局默认（bot_id=''）
    return (
      this.get<PersonaRuleRow>('SELECT * FROM persona_rules WHERE bot_id = ?', botId) ??
      this.get<PersonaRuleRow>("SELECT * FROM persona_rules WHERE bot_id = ''")
    )
  }

  loadCharacter(botId: string): CharacterRow | null {
    const bot = this.loadBot(botId)
    if (!bot?.character_id) return null
    return this.get<CharacterRow>('SELECT * FROM characters WHERE id = ?', bot.character_id)
  }

  loadWorldEntries(botId: string): WorldEntryRow[] {
    const bot = this.loadBot(botId)
    const cid = bot?.character_id ?? ''
    return this.all<WorldEntryRow>(
      'SELECT * FROM world_entries WHERE enabled = 1 AND (character_id = \'\' OR character_id = ?)',
      cid,
    )
  }

  loadContacts(botId: string): ContactRow[] {
    return this.all<ContactRow>('SELECT * FROM contacts WHERE bot_id = ? ORDER BY created_at DESC', botId)
  }

  loadRelations(botId: string): ContactRelationRow[] {
    return this.all<ContactRelationRow>('SELECT * FROM contact_relations WHERE bot_id = ?', botId)
  }

  loadContact(botId: string, sender: string): ContactRow | null {
    return this.get<ContactRow>('SELECT * FROM contacts WHERE bot_id = ? AND sender = ?', botId, sender)
  }

  buildContext(opts: BuildPromptOptions): PersonaContext | null {
    const bot = this.loadBot(opts.botId)
    if (!bot) return null
    return {
      bot,
      rule: this.loadRule(opts.botId),
      character: this.loadCharacter(opts.botId),
      worldEntries: this.loadWorldEntries(opts.botId),
      contacts: this.loadContacts(opts.botId),
      relations: this.loadRelations(opts.botId),
      currentContact: this.loadContact(opts.botId, opts.sender),
      currentMemories: opts.currentMemories ?? [],
      historyDigest: opts.historyDigest,
      growthText: opts.growthText,
      haystack: opts.haystack,
      focusText: opts.focusText,
      channel: opts.channel,
      crossChannelHint: opts.crossChannelHint,
      toolDirective: opts.toolDirective,
    }
  }

  /** 产出系统提示词 + 收尾槽位（PHI）。bot 不存在返回 null。 */
  buildPrompt(opts: BuildPromptOptions): { system: string; phi: string | null; layers: PersonaLayers } | null {
    const ctx = this.buildContext(opts)
    if (!ctx) return null
    // §内心状态 — 每轮推进到当前时刻，并记录一次 user_message（心情/活力/社交需求）。
    // 状态是软状态：读写失败不阻断主对话，最多丢掉这一轮的旁白。
    try {
      const state = recordInnerEvent(this.storage, opts.botId, 'user_message', new Date())
      ctx.innerStateText = buildInnerStateLayer(narrate(state))
    } catch {
      ctx.innerStateText = undefined
    }
    const layers = buildPersonaLayers(ctx)
    return { system: assembleSystemPrompt(layers), phi: getPostHistoryMessage(layers), layers }
  }

  editableLayers(opts: BuildPromptOptions): Array<{ id: string; name: string; content: string; source: string }> {
    const ctx = this.buildContext(opts)
    if (!ctx) return []
    // 调试层查看器只读展示当前时刻的状态；不叠加 user_message 事件，避免预览改变真实状态。
    try {
      ctx.innerStateText = buildInnerStateLayer(narrate(loadInnerState(this.storage, opts.botId)))
    } catch {
      ctx.innerStateText = undefined
    }
    return buildEditableLayers(ctx)
  }
}

export function apply(ctx: Context, _config: Config): void {
  const persona = new LittlyPersona(ctx.littlyStorage as LittlyStorage)
  ctx.provide('littlyPersona', persona)
  ctx.logger.info('littly persona ready')
}

// B15：工具使用指令按注册表动态生成（hub 建 prompt 时调用）。
export { buildToolUseDirective, TOOL_USE_DIRECTIVE, type ToolDirectiveEntry } from './pack.ts'

// §内心状态 — 供 scheduler 的决策 prompt 复用同一份 narrate/事件记录。
export {
  advance,
  applyEvent,
  createInitialInnerState,
  INNER_STATE_INITIAL,
  innerStateKey,
  loadInnerState,
  narrate,
  recordInnerEvent,
  saveInnerState,
  type InnerEvent,
  type InnerState,
  type InnerStateStore,
  type InnerStateValues,
} from './inner-state.ts'
