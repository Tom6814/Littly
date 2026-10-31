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
  botSettingsView,
  findMaskPollutedSecrets,
  hasMaskPlaceholder,
  isMaskedInput,
  maskSecret,
  BOT_CHANNEL_GROUPS,
  BOT_SETTING_GROUPS,
} from '../packages/littly/console-api/src/mapping.ts'
import { registerBotRoutes } from '../packages/littly/console-api/src/routes-bots.ts'

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
ok(isMaskedInput('••') === false, '只有点号（不足 4 个）→ 不算完整掩码（严格掩码判定）')
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

console.log('== 打码占位符 + 新密钥混合（污染输入）==')
ok(hasMaskPlaceholder('••••abcdsk-new') === true, '占位符+新内容 → hasMaskPlaceholder=true')
ok(hasMaskPlaceholder('••••abcd') === false, '纯打码串 → hasMaskPlaceholder=false')
ok(hasMaskPlaceholder('sk-new') === false, '普通新密钥 → false')
ok(isMaskedInput('••••abcdsk-new') === false, '混合串不算纯掩码（旧实现会误判为掩码）')
const pollutedSettings = findMaskPollutedSecrets(BOT_SETTING_GROUPS, { ai: { visionApiKey: '••••abcdsk-new', model: 'm' }, voice: { apiKey: '••••0000newvoice' } })
ok(pollutedSettings.includes('visionApiKey') && pollutedSettings.includes('apiKey'), '设置区污染检测：visionApiKey + voice.apiKey')
const pollutedChannels = findMaskPollutedSecrets(BOT_CHANNEL_GROUPS, { telegram: { botToken: '••••1234newtoken' }, snowluma: { token: 'clean-token' } })
ok(pollutedChannels.length === 1 && pollutedChannels[0] === 'botToken', '渠道区污染检测：只报 botToken（纯新值不误报）')
// 兜底：即使绕过路由，apply* 也不会把混合串落库
const row0 = load()
const p1 = applyBotSettingsPatch(row0, { ai: { visionApiKey: '••••abcdsk-new' } })
ok(p1.columns.length === 0, 'applyBotSettingsPatch 对混合串不产生写列（防御）')
const p2 = applyBotChannelsPatch(row0, { telegram: { botToken: '••••1234newtoken' } })
ok(p2.columns.length === 0, 'applyBotChannelsPatch 对混合串不产生写列（防御）')

console.log('== 路由层：混合=400 / 纯掩码=保持 / 干净新密钥落库 ==')
{
  class FakeRouter {
    routes = []
    add(method, path, auth, handler) { this.routes.push({ method, path, auth, handler }) }
    get(p, a, h) { this.add('GET', p, a, h) }
    post(p, a, h) { this.add('POST', p, a, h) }
    patch(p, a, h) { this.add('PATCH', p, a, h) }
    put(p, a, h) { this.add('PUT', p, a, h) }
    del(p, a, h) { this.add('DELETE', p, a, h) }
  }
  const matchPath = (pattern, actual) => {
    const a = pattern.split('/').filter(Boolean)
    const b = actual.split('/').filter(Boolean)
    if (a.length !== b.length) return null
    const params = {}
    for (let i = 0; i < a.length; i++) {
      if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i])
      else if (a[i] !== b[i]) return null
    }
    return params
  }
  const fakeRes = () => ({ statusCode: 0, body: '', writeHead(c) { this.statusCode = c }, end(b) { this.body = String(b ?? '') } })
  const router = new FakeRouter()
  const deps = { storage, log: () => {}, persona: { loadBot: () => null } }
  registerBotRoutes(router, deps)
  const call = async (method, path, body) => {
    const route = router.routes.find((rt) => rt.method === method && matchPath(rt.path, path) !== null)
    if (route === undefined) return { status: 404, json: null }
    const req = fakeRes()
    await route.handler({ req: {}, res: req, url: new URL(`http://x${path}`), method, params: matchPath(route.path, path) ?? {}, query: new URLSearchParams(), body, fields: {}, files: [], user: { id: 'admin-1', username: 'admin', role: 'admin' } })
    let json = null
    try { json = req.body ? JSON.parse(req.body) : null } catch { json = null }
    return { status: req.statusCode, json }
  }
  // 初始干净
  storage.prepare("UPDATE bots SET ai_vision_api_key = '', tg_bot_token = '' WHERE id = 'b1'").run()
  const mixed = await call('PATCH', '/api/bots/b1', { settings: { ai: { visionApiKey: '••••abcdsk-new' } } })
  ok(mixed.status === 400 && mixed.json?.error?.code === 'mask_placeholder_mixed', 'PATCH settings 混合输入 → 400 mask_placeholder_mixed')
  ok((storage.prepare("SELECT ai_vision_api_key FROM bots WHERE id='b1'").get().ai_vision_api_key) === '', '400 时未落库')
  const masked = await call('PATCH', '/api/bots/b1', { settings: { ai: { visionApiKey: '••••1234' } } })
  ok(masked.status === 200 && (storage.prepare("SELECT ai_vision_api_key FROM bots WHERE id='b1'").get().ai_vision_api_key) === '', '纯掩码 → 200 且保持原值（不动库）')
  const clean = await call('PATCH', '/api/bots/b1', { settings: { ai: { visionApiKey: 'sk-first-abcd' } } })
  ok(clean.status === 200 && (storage.prepare("SELECT ai_vision_api_key FROM bots WHERE id='b1'").get().ai_vision_api_key) === 'sk-first-abcd', '干净新密钥 → 落库')
  const view1 = botSettingsView(load())
  ok(view1.ai?.visionApiKey === '••••abcd', 'GET 视图掩码显示新密钥尾号 abcd')
  const clean2 = await call('PATCH', '/api/bots/b1', { settings: { ai: { visionApiKey: 'sk-second-wxyz' } } })
  const view2 = botSettingsView(load())
  ok(clean2.status === 200 && view2.ai?.visionApiKey === '••••wxyz' && view2.ai?.visionApiKey !== view1.ai?.visionApiKey, '再次保存后 GET 掩码尾号变化（abcd → wxyz）')
  // 渠道 token 混合/纯掩码/新值
  const mixedChannel = await call('PUT', '/api/bots/b1/channels', { channels: { telegram: { botToken: '••••1234newtoken' } } })
  ok(mixedChannel.status === 400 && mixedChannel.json?.error?.code === 'mask_placeholder_mixed', 'PUT channels 混合输入 → 400')
  const maskedChannel = await call('PUT', '/api/bots/b1/channels', { channels: { telegram: { botToken: '••••1234' } } })
  ok(maskedChannel.status === 200 && (storage.prepare("SELECT tg_bot_token FROM bots WHERE id='b1'").get().tg_bot_token) === '', '渠道纯掩码 → 200 保持原值')
  const cleanChannel = await call('PUT', '/api/bots/b1/channels', { channels: { telegram: { botToken: 'bot-token-new' } } })
  ok(cleanChannel.status === 200 && (storage.prepare("SELECT tg_bot_token FROM bots WHERE id='b1'").get().tg_bot_token) === 'bot-token-new', '渠道干净新 token → 落库')
}

rmSync(dir, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
