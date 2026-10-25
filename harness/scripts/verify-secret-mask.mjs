#!/usr/bin/env node
/**
 * 密钥三态验证：掩码串 = 保持原值 / 空串 = 显式清空 / 其它 = 写入新值。
 * 运行：node scripts/verify-secret-mask.mjs
 *
 * 为什么单独验这个：控制台回显的是掩码串，前端原样回传。
 * 若把掩码串当新值写回，密钥会被自己的打码串覆盖 —— 那就是「改一下别的字段，密钥没了」。
 * 反过来，如果把空串也当成「保持不变」，用户就永远清不掉一个已经废弃的 token。
 * 所以必须是三态，不能是两态。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LittlyStorage } from '../packages/littly/storage/src/index.ts'
import {
  applyBotChannelsPatch,
  applyBotSettingsPatch,
  botChannelsView,
  isMaskedInput,
  maskSecret,
} from '../packages/littly/console-api/src/mapping.ts'

let pass = 0
let fail = 0
const ok = (cond, name) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.error(`  ✗ ${name}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'littly-secret-'))
const storage = new LittlyStorage({ logger: { info: () => {} } }, { file: join(dir, 's.db') })
const now = new Date().toISOString()
storage.prepare("INSERT INTO bots (id, name, created_at) VALUES ('b1','小璃',?)").run(now)

const load = () => storage.prepare('SELECT * FROM bots WHERE id = ?').get('b1')

console.log('== 掩码判定 ==')
ok(isMaskedInput('••••1234') === true, '打码串 → 判为掩码')
ok(isMaskedInput('••') === true, '只有点号 → 判为掩码')
ok(isMaskedInput('') === false, '空串 → 不判为掩码（空串是显式清空）')
ok(isMaskedInput('plain-token') === false, '普通串 → 不判为掩码')
ok(maskSecret('') === '', '空值掩码后仍是空')
ok(maskSecret('abcdefgh') === '••••efgh', '掩码保留末 4 位')
ok(!maskSecret('abcdefgh').includes('abcd'), '掩码不泄露前缀')

console.log('== 渠道密钥三态 ==')
storage.prepare("UPDATE bots SET snowluma_token = 'orig-token', tg_bot_token = 'tg-token' WHERE id = 'b1'").run()
let row = load()

const view = botChannelsView(row)
ok(view.snowluma.token === '••••oken', '回显是掩码串')
ok(view.snowluma.hasToken === true, 'hasToken 为真')
ok(view.telegram.botToken === '••••oken', 'Telegram token 也回显掩码')

// ① 掩码串 → 保持原值
let patch = applyBotChannelsPatch(row, { snowluma: { token: view.snowluma.token } })
ok(patch.columns.length === 0 && patch.values.length === 0, '掩码串 → 不写库（保持原值）')

// ② 空串 → 显式清空
patch = applyBotChannelsPatch(row, { snowluma: { token: '' } })
ok(patch.columns.length === 1 && patch.columns[0] === 'snowluma_token' && patch.values[0] === '', '空串 → 写入空值（显式清空）')
storage.prepare('UPDATE bots SET snowluma_token = ? WHERE id = ?').run(patch.values[0], 'b1')
row = load()
ok(row.snowluma_token === '', '清空真的落库了')

// ③ 普通串 → 写入新值
patch = applyBotChannelsPatch(row, { snowluma: { token: 'new-token' } })
ok(patch.columns[0] === 'snowluma_token' && patch.values[0] === 'new-token', '普通串 → 写入新值')
storage.prepare('UPDATE bots SET snowluma_token = ? WHERE id = ?').run(patch.values[0], 'b1')
row = load()
ok(row.snowluma_token === 'new-token', '新值落库')

// ④ 未出现在请求里的字段不受影响
patch = applyBotChannelsPatch(row, { snowluma: { token: 'x' } })
ok(!patch.columns.includes('tg_bot_token'), '只写请求里出现的字段，其它渠道密钥不动')
ok(!patch.columns.includes('snowluma_ws_url'), '同渠道里没提的字段也不动')

// ⑤ 非密钥字段照常写
patch = applyBotChannelsPatch(row, { snowluma: { enabled: true, account: 'acc-1' } })
ok(patch.columns.includes('snowluma_enabled'), 'enabled 会写')
ok(patch.columns.includes('snowluma_account'), 'account 会写')

console.log('== 设置区密钥三态 ==')
storage.prepare("UPDATE bots SET ai_vision_api_key = 'vkey' WHERE id = 'b1'").run()
row = load()
patch = applyBotSettingsPatch(row, { ai: { visionApiKey: '••••vkey' } })
ok(patch.columns.length === 0, '设置区：掩码串 → 不写库')
patch = applyBotSettingsPatch(row, { ai: { visionApiKey: '' } })
ok(patch.columns[0] === 'ai_vision_api_key' && patch.values[0] === '', '设置区：空串 → 显式清空')
patch = applyBotSettingsPatch(row, { ai: { visionApiKey: 'fresh' } })
ok(patch.values[0] === 'fresh', '设置区：普通串 → 写入新值')

console.log('== 幽灵渠道键 ==')
const groups = Object.keys(botChannelsView(load()))
ok(!groups.includes('qqp'), '没有已废弃的 qqp 分组')
ok(groups.includes('snowluma'), '有 snowluma 分组（QQ 个人号）')
ok(groups.includes('telegram') && groups.includes('discord') && groups.includes('wechat'), '四个渠道分组齐全')

rmSync(dir, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
