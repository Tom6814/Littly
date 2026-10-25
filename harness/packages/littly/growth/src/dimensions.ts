/**
 * §成长档案 — 维度推导（seed）。
 *
 * 逐字移植自旧项目 src/internal/growth/dimensions.ts。
 * 为没有成长档案的角色建立第一份档案：由「潜意识」实例从角色卡提炼
 * 5-8 个人格核心维度 + 当前等级 + 行为判据。角色卡只读（D1），
 * 潜意识无人格身份，仅以角色卡为参考资料（D3）。
 * fail-open：任何失败返回 null，绝不阻断调用方。
 */
import type { LittlyStorage } from '@littly/storage'
import { chatComplete, getAIConfig, type ChatMessage } from '@littly/llm'
import { parseDimensions, type GrowthDimension } from './types.ts'
import { createProfile, maxProfileVersion, writeAudit } from './store.ts'

const SEED_MAX_TOKENS = 1600

export function cardDigestText(cardJson: string): string {
  try {
    const c = JSON.parse(cardJson) as Record<string, unknown>
    const d = (c['data'] ?? c) as Record<string, unknown>
    return [d['description'], d['personality'], d['scenario']]
      .filter((x: unknown): x is string => typeof x === 'string' && !!x.trim())
      .join('\n')
  } catch {
    return ''
  }
}

/** 潜意识专用模型：全局 growth_model 优先，未配置则回退到传入的聊天模型。 */
async function resolveGrowthModel(storage: LittlyStorage, fallback?: string): Promise<string> {
  const cfg = await getAIConfig(storage)
  return cfg.growthModel || fallback || cfg.chatModel || ''
}

/**
 * 确保该 bot 存在 active 成长档案；缺失时由潜意识推导 v1 并落库。
 * 返回 active 档案（可能为 null —— fail-open）。
 */
export async function ensureGrowthProfile(
  storage: LittlyStorage,
  botId: string,
  model?: string,
): Promise<{ id: string; version: number; dimensions: string; lifeStage: string } | null> {
  try {
    return await ensureGrowthProfileInner(storage, botId, model)
  } catch (e) {
    console.warn(`[growth] ensureGrowthProfile failed for ${botId}:`, e instanceof Error ? e.message : e)
    return null
  }
}

interface SeedBotRow {
  id: string
  character_id: string | null
  ai_model: string
}

interface SeedCharacterRow {
  id: string
  data: string
}

async function ensureGrowthProfileInner(
  storage: LittlyStorage,
  botId: string,
  model?: string,
): Promise<{ id: string; version: number; dimensions: string; lifeStage: string } | null> {
  const existing = storage
    .prepare("SELECT * FROM growth_profiles WHERE bot_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1")
    .get(botId) as { id: string; version: number; dimensions: string; life_stage: string } | undefined
  if (existing) {
    return { id: existing.id, version: existing.version, dimensions: existing.dimensions, lifeStage: existing.life_stage }
  }

  const bot = storage.prepare('SELECT * FROM bots WHERE id = ?').get(botId) as SeedBotRow | undefined
  if (!bot?.character_id) return null
  const character = storage.prepare('SELECT * FROM characters WHERE id = ?').get(bot.character_id) as SeedCharacterRow | undefined
  if (!character) return null

  const cardText = cardDigestText(character.data)
  if (!cardText) return null

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `你是她的潜意识——她内心深处的一部分，她自己意识不到你的存在，你也不等同于她本人。

你不是她，也不是观察她的旁观者。你不带入她的人格、性格、情绪或立场，不用她的口吻思考，不替她做任何决定。你只是感知她，然后如实沉淀：她是谁。她永远不会知道你在运作，也不需要知道。

下面的材料用来让你理解"她是谁"：角色卡是她的人格设定。你读它是为了感知她的底色，不是为了成为她，也不要把这些设定当成你自己的身份。

任务：把"她是谁"沉淀成一份初始成长档案：
提炼 5-8 个最能描述她本性的维度（中文短词，如「外向性」「戒备心」「好奇心」），给出当前强度(1-5)与人生阶段。

强度必须用行为表现来描述，不要用抽象标签。例如 2/5 的戒备心要写成「对陌生人的善意会先怀疑动机，但熟人示好三次后就会放下防备」，而不是「比较警惕」。

只回 JSON，不要任何其他文字：
{"lifeStage":"她目前的人生阶段一句话","dimensions":[{"key":"维度名","level":3,"desc":"这个强度的具体行为表现"}]}`,
    },
    {
      role: 'user',
      content: `【角色卡资料】\n${cardText}\n\n请为她建立成长档案 v1。`,
    },
  ]

  try {
    const growthModel = await resolveGrowthModel(storage, model || bot.ai_model || undefined)
    const res = await chatComplete(storage, messages, { model: growthModel, temperature: 0.4, maxTokens: SEED_MAX_TOKENS })
    const match = res.content.match(/\{[\s\S]*\}/)
    if (!match) return null
    const j = JSON.parse(match[0]) as Record<string, unknown>
    const dims: GrowthDimension[] = parseDimensions(JSON.stringify(j['dimensions'] ?? []))
      .map((d) => ({ ...d, level: Math.min(5, Math.max(1, Math.round(d.level))) }))
      .filter((d) => d.key && d.desc)
    if (dims.length < 3 || dims.length > 8) {
      console.warn(`[growth] seed rejected: ${dims.length} dimensions out of range for bot ${botId}`)
      return null
    }

    const version = maxProfileVersion(storage, botId) + 1
    const created = createProfile(storage, {
      botId,
      version,
      dimensions: JSON.stringify(dims),
      lifeStage: typeof j['lifeStage'] === 'string' ? j['lifeStage'].slice(0, 200) : '',
      valueExclusions: '[]',
      derivedFrom: 'seed',
      active: true,
    })
    writeAudit(storage, botId, 'seed', `v1 created, ${dims.length} dimensions`)
    return { id: created.id, version: created.version, dimensions: created.dimensions, lifeStage: created.life_stage }
  } catch (e) {
    console.warn(`[growth] seed failed for ${botId}:`, e instanceof Error ? e.message : e)
    return null
  }
}
