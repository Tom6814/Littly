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
import { assembleSystemPrompt, buildEditableLayers, buildPersonaLayers, getPostHistoryMessage, type PersonaContext, type PersonaLayers } from './layers.ts'

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
  channel?: string
  /** 世界书匹配语料：近期对话 + 当前消息 */
  haystack: string
  /** 最新一条用户消息（追问必达跳过概率骰） */
  focusText?: string
  currentMemories?: MemoryRow[]
  historyDigest?: string
  growthText?: string
  crossChannelHint?: string
}

export class LittlyPersona {
  constructor(private readonly ctx: Context, private readonly storage: LittlyStorage) {}

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
    }
  }

  /** 产出系统提示词 + 收尾槽位（PHI）。bot 不存在返回 null。 */
  buildPrompt(opts: BuildPromptOptions): { system: string; phi: string | null; layers: PersonaLayers } | null {
    const ctx = this.buildContext(opts)
    if (!ctx) return null
    const layers = buildPersonaLayers(ctx)
    return { system: assembleSystemPrompt(layers), phi: getPostHistoryMessage(layers), layers }
  }

  editableLayers(opts: BuildPromptOptions) {
    const ctx = this.buildContext(opts)
    return ctx ? buildEditableLayers(ctx) : []
  }
}

export function apply(ctx: Context, _config: Config): void {
  const storage = ctx.littlyStorage as LittlyStorage
  const persona = new LittlyPersona(ctx, storage)
  ctx.provide('littlyPersona', persona)
  ctx.logger.info('littly persona ready')
}
