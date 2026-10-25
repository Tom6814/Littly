#!/usr/bin/env node
/**
 * 首启播种验证（ensureSeed）。
 * 运行：node scripts/verify-seed.mjs
 *
 * 为什么单独验：全新 Docker 部署打开就是空库 —— 聊天页没有对象、角色卡是空的、
 * 铁律没落库。旧仓把 ensureSeed() 挂在 /api/bots 与聊天路由上，第一次访问就自动播种；
 * 移植到新仓时这条行为掉了，只剩 admin 手动 POST /api/seed。
 *
 * 另外要盯住一条：铁律必须是**完整的** DEFAULT_IRON_RULES，
 * 不能是概括版 —— 概括版会把「严格反 NTR」这类核心条覆盖掉，人格就变了。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LittlyStorage } from '../packages/littly/storage/src/index.ts'
import { ensureSeed } from '../packages/littly/console-api/src/seed.ts'
import { DEFAULT_IRON_RULES } from '../packages/littly/persona/src/pack.ts'

let pass = 0
let fail = 0
const ok = (cond, name) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.error(`  ✗ ${name}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'littly-seed-'))
const storage = new LittlyStorage({ logger: { info: () => {} } }, { file: join(dir, 'seed.db') })
const deps = { storage }

console.log('== 空库首次播种 ==')
ok((storage.prepare('SELECT COUNT(*) AS c FROM bots').get()).c === 0, '起始：库里没有 bot')
const r1 = ensureSeed(deps)
ok(typeof r1.botId === 'string' && r1.botId !== '', '返回 botId')

const bots = storage.prepare('SELECT * FROM bots').all()
ok(bots.length === 1, `有且只有一个 bot（实际 ${bots.length}）`)
const bot = bots[0]
ok(bot.name === '小璃', 'bot 叫小璃')
ok(bot.system_prompt === '你是一个有温度的、像真人一样聊天的角色。', 'bot 的系统提示词照旧仓')
ok(bot.ai_temperature === 0.85, 'temperature 0.85（照旧仓，不是表默认 0.8）')
ok(bot.ai_max_history === 20, 'maxHistory 20')
ok(bot.memory_scope === 'global', 'memoryScope global')
ok(bot.ai_humanize_wechat === 1, '微信口语体开')
ok(bot.proactive_enabled === 1, '主动性开')

console.log('== 铁律必须是完整版 ==')
const rule = storage.prepare('SELECT rules_text FROM persona_rules WHERE bot_id = ?').get(bot.id)
ok(rule !== undefined, 'bot 级铁律落库了')
ok(rule.rules_text === DEFAULT_IRON_RULES, '铁律正文 = 完整 DEFAULT_IRON_RULES（逐字一致）')
ok(rule.rules_text.includes('严格反 NTR'), '含「严格反 NTR」核心条')
ok(rule.rules_text.includes('喜欢的人唯一且永久不可改变'), '含「唯一且永久不可改变」核心条')
ok(rule.rules_text.includes('记忆静默铁律'), '含「记忆静默铁律」核心条')
ok(!rule.rules_text.includes('用户的隐私与边界优先于一切讨好行为'), '不是概括版（概括版那行不该出现）')
const globalRule = storage.prepare('SELECT rules_text FROM persona_rules WHERE bot_id = ?').get('')
ok(globalRule !== undefined && globalRule.rules_text === DEFAULT_IRON_RULES, '全局兜底铁律也在')

console.log('== 演示角色卡 ==')
const chars = storage.prepare('SELECT * FROM characters').all()
ok(chars.length === 1, `有且只有一个角色卡（实际 ${chars.length}）`)
const ch = chars[0]
ok(ch.name === '小璃', '角色卡叫小璃')
ok(ch.spec === 'chara_card_v2', 'spec 是 chara_card_v2')
ok(bot.character_id === ch.id, 'bot 挂着这张角色卡')
const card = JSON.parse(ch.data)
ok(card.description.includes('温柔、粘人、有点小傲娇'), '角色卡描述照旧仓原文')
ok(card.first_mes === '回来啦～\n今天怎么样呀', '开场白照旧仓原文')
ok(typeof card.mes_example === 'string' && card.mes_example.includes('<START>'), '带 mes_example（旧仓有）')
ok(Array.isArray(card.tags) && card.tags.includes('girlfriend'), '带 tags（旧仓有）')
ok(card.creator === 'littly', '带 creator（旧仓有）')

console.log('== 演示世界书三条 ==')
const world = storage.prepare('SELECT * FROM world_entries ORDER BY priority DESC').all()
ok(world.length === 3, `三条（实际 ${world.length}）`)
const byKey = world.map((w) => JSON.parse(w.keys).join(','))
ok(byKey.includes('飞机,出差,坐飞机'), '飞机那条在')
ok(byKey.includes('加班,老板'), '加班那条在')
ok(byKey.includes('生日,cake,蛋糕'), '生日那条在')
const plane = world.find((w) => JSON.parse(w.keys).includes('飞机'))
ok(plane.character_id === ch.id, '飞机那条挂角色卡上')
ok(plane.content.includes('怕坐飞机'), '飞机那条内容照旧仓原文')
const cake = world.find((w) => JSON.parse(w.keys).includes('生日'))
ok(cake.character_id === '', '生日那条是全局（character_id 为空）')
ok(world.every((w) => w.bot_id === bot.id), '三条都挂在 bot 上')

console.log('== 幂等：再播一次什么都不改 ==')
const before = {
  bots: storage.prepare('SELECT COUNT(*) AS c FROM bots').get().c,
  chars: storage.prepare('SELECT COUNT(*) AS c FROM characters').get().c,
  world: storage.prepare('SELECT COUNT(*) AS c FROM world_entries').get().c,
  rules: storage.prepare('SELECT COUNT(*) AS c FROM persona_rules').get().c,
}
ensureSeed(deps)
ensureSeed(deps)
const after = {
  bots: storage.prepare('SELECT COUNT(*) AS c FROM bots').get().c,
  chars: storage.prepare('SELECT COUNT(*) AS c FROM characters').get().c,
  world: storage.prepare('SELECT COUNT(*) AS c FROM world_entries').get().c,
  rules: storage.prepare('SELECT COUNT(*) AS c FROM persona_rules').get().c,
}
ok(before.bots === after.bots && before.bots === 1, '没有多出 bot')
ok(before.chars === after.chars && before.chars === 1, '没有多出角色卡')
ok(before.world === after.world && before.world === 3, '没有多出世界书')
ok(before.rules === after.rules, '没有多出铁律行')

console.log('== 不覆盖用户改过的东西 ==')
storage.prepare('UPDATE persona_rules SET rules_text = ? WHERE bot_id = ?').run('我自己写的铁律', bot.id)
storage.prepare('UPDATE bots SET name = ? WHERE id = ?').run('我改的名字', bot.id)
ensureSeed(deps)
const after2 = storage.prepare('SELECT rules_text FROM persona_rules WHERE bot_id = ?').get(bot.id)
ok(after2.rules_text === '我自己写的铁律', '用户改过的铁律不被覆盖')
ok(storage.prepare('SELECT name FROM bots WHERE id = ?').get(bot.id).name === '我改的名字', '用户改过的 bot 名不被覆盖')

rmSync(dir, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
