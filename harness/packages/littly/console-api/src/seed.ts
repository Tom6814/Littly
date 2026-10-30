/**
 * 首启播种：默认 bot「小璃」+ 铁律 + 演示角色卡 + 演示世界书。
 *
 * 移植自旧仓 `src/internal/config/seed.ts` 的 `ensureSeed()`。
 * 旧仓把它挂在 /api/bots、/api/chat、/api/chat/buffer、/api/chat/buffer/flush 上 ——
 * 用户第一次打开控制台、或第一次发消息时自动播种，全程感知不到。
 * 新仓原本只留了 admin 手动 `POST /api/seed`，全新 Docker 部署打开就是空库：
 * 聊天页没有对象、角色卡是空的、铁律没落库。移植时把这个行为补回来。
 *
 * 两个必须照旧仓的地方：
 * 1. 铁律写的是 @littly/persona 的 DEFAULT_IRON_RULES（与旧仓逐字一致），
 *    不是概括版 —— 概括版会把「严格反 NTR」这类核心条覆盖掉。
 * 2. 角色卡与三条演示世界书的内容逐字照旧仓，演示世界书里的关系事实
 *    （怕坐飞机 / 加班 / 生日）是她人格的一部分，不能随手改写。
 */
import { randomUUID } from 'node:crypto'
import { DEFAULT_IRON_RULES } from '@littly/persona/src/pack.ts'
import type { Deps } from './deps.ts'

/** 旧仓 demo character「小璃」的角色卡原文。 */
const DEMO_CARD = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  name: '小璃',
  description: '一个温柔、粘人、有点小傲娇的女朋友型角色。喜欢被夸、喜欢被抱，但嘴上不认。会主动惦记你、会撒娇、偶尔闹小脾气。',
  personality: '温柔、粘人、傲娇、细心、有点小占有欲',
  scenario: '你和她是恋人关系，已经在一起一段时间了，彼此很熟悉。',
  first_mes: '回来啦～\n今天怎么样呀',
  mes_example: '<START>\n{{user}}: 我今天加班到好晚\n{{char}}: 又加班啊\n你老板是不是有病\n快点回来嘛\n我给你留了饭',
  system_prompt: '',
  post_history_instructions: '',
  tags: ['girlfriend', 'gentle', 'clingy'],
  creator: 'littly',
  character_version: '1.0',
}

/** 旧仓演示世界书三条：两条挂角色，一条全局。 */
const DEMO_WORLD_ENTRIES = [
  {
    characterScoped: true,
    keys: ['飞机', '出差', '坐飞机'],
    content: 'TA 之前提过怕坐飞机，遇到出差坐飞机要主动关心、安慰。',
    priority: 5,
  },
  {
    characterScoped: true,
    keys: ['加班', '老板'],
    content: 'TA 老板经常让 TA 加班，TA 嘴上不说但心里烦。可以陪着吐槽。',
    priority: 3,
  },
  {
    characterScoped: false,
    keys: ['生日', 'cake', '蛋糕'],
    content: '提到生日时，主动问是不是快到了，记住日期。',
    priority: 4,
  },
]

export interface SeedResult {
  seeded: boolean
  skipped: boolean
  botId?: string
  characterId?: string
}

/**
 * 保证库里至少有一个可用的 bot / 铁律 / 角色卡。
 * 幂等：已有就什么都不做（不覆盖用户改过的内容）。
 */
/** 首个管理员 id（没有用户时返回 ''）；播种 bot 时据此归属，避免非 admin 读不到默认角色。 */
function firstAdminId(d: Deps): string {
  const row = d.storage
    .prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1")
    .get() as { id: string } | undefined
  return row?.id ?? ''
}

export function ensureSeed(d: Deps): SeedResult {
  const now = new Date().toISOString()

  // ---- bot ----
  let bot = d.storage.prepare('SELECT * FROM bots ORDER BY created_at ASC LIMIT 1').get() as
    | { id: string; character_id: string | null; owner_id?: string }
    | undefined
  if (!bot) {
    const botId = randomUUID()
    d.storage.prepare(
      'INSERT INTO bots (id, name, system_prompt, ai_temperature, ai_max_history, memory_scope, ai_humanize_wechat, proactive_enabled, owner_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).run(
      botId,
      '小璃',
      '你是一个有温度的、像真人一样聊天的角色。',
      0.85,
      20,
      'global',
      1,
      1,
      firstAdminId(d),
      now,
    )
    bot = { id: botId, character_id: null }
  }

  // ---- 铁律：没有就写完整的 DEFAULT_IRON_RULES（不是概括版）----
  const rule = d.storage.prepare('SELECT bot_id FROM persona_rules WHERE bot_id = ?').get(bot.id) as
    | { bot_id: string }
    | undefined
  if (!rule) {
    d.storage.prepare('INSERT OR REPLACE INTO persona_rules (bot_id, rules_text, enabled, updated_at) VALUES (?,?,1,?)')
      .run(bot.id, DEFAULT_IRON_RULES, now)
    // 全局 '' 行也放一份兜底（读铁律时 bot 行回落全局）
    d.storage.prepare('INSERT OR REPLACE INTO persona_rules (bot_id, rules_text, enabled, updated_at) VALUES (?,?,1,?)')
      .run('', DEFAULT_IRON_RULES, now)
  }

  // ---- 演示角色卡「小璃」----
  let character = d.storage.prepare("SELECT * FROM characters WHERE name = '小璃' ORDER BY created_at ASC LIMIT 1").get() as
    | { id: string }
    | undefined
  if (!character) {
    const characterId = randomUUID()
    d.storage.prepare(
      'INSERT INTO characters (id, name, spec, data, system_prompt, first_mes, avatar, style_calibration, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(
      characterId,
      '小璃',
      'chara_card_v2',
      JSON.stringify(DEMO_CARD),
      '',
      DEMO_CARD.first_mes,
      '',
      '{}',
      now,
    )
    character = { id: characterId }
    // 演示世界书
    for (const e of DEMO_WORLD_ENTRIES) {
      d.storage.prepare(
        'INSERT INTO world_entries (id, bot_id, character_id, keys, second_keys, logic, constant, probability, priority, position, enabled, content, comment) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
        randomUUID(),
        bot.id,
        e.characterScoped ? characterId : '',
        JSON.stringify(e.keys),
        '[]',
        0,
        0,
        85,
        e.priority,
        1,
        1,
        e.content,
        '',
      )
    }
  }

  // 角色卡挂到 bot 上（不管角色卡是这次新建的还是早就有的）。
  // 旧仓只在「角色卡刚创建」时挂 —— 那是因为旧仓里 bot 和角色卡总是一起出现。
  // 但如果 bot 存在而角色卡后来被删了/别的路径建的，旧逻辑就永远挂不上，
  // 结果是「有角色卡，但 bot 没挂她」—— 提示词里就没有角色卡那一层。
  const attached = d.storage.prepare('SELECT character_id FROM bots WHERE id = ?').get(bot.id) as
    | { character_id: string | null }
    | undefined
  if (attached === undefined || attached.character_id === null || attached.character_id === '') {
    d.storage.prepare('UPDATE bots SET character_id = ? WHERE id = ?').run(character.id, bot.id)
  }

  return { seeded: true, skipped: false, botId: bot.id, characterId: character.id }
}
