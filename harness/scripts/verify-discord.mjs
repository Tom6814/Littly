#!/usr/bin/env node
/**
 * Discord 渠道行为验证（移植自旧 monolith 的 src/internal/channel/discord.ts + binding.ts）。
 * 运行：node scripts/verify-discord.mjs（Node 24 原生 type stripping，无需 tsx）
 *
 * 覆盖：
 * - 纯函数：内容提取 / 显示名 / 邀请链接
 * - sender 派生：未绑定 `discord_<userId>`，已绑定 → 绑定用户 id
 * - 投递地址解析：contacts.external_id → channel_identities → Create DM
 * - 绑定码全流程：成功 / 过期 / 冲突 / 限频 / 未命中
 * - 入站处理：DM 收、群聊忽略、bot 消息忽略、联系人 upsert、缓冲入队
 * - 出站发送：stub fetch，断言请求 URL / body / Authorization
 * - 插件契约：name / inject / Config 默认值 / registerChannel('discord')
 *
 * DB 用真实 SQLite（LittlyStorage，临时目录）。
 */
import { register } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LittlyStorage } from '../packages/littly/storage/src/index.ts'
import {
  MSG_CONFLICT,
  MSG_EXPIRED,
  MSG_RATE,
  MSG_SUCCESS_DISCORD,
  promoteContact,
  tryHandleBinding,
} from '../packages/littly/channel-discord/src/binding.ts'
import {
  createDiscordInvite,
  resolveDiscordChannelId,
  sendToDiscordHumanized,
} from '../packages/littly/channel-discord/src/client.ts'
import {
  discordDisplayName,
  extractDiscordContent,
  handleDiscordMessage,
  isDirectMessage,
  resolveDiscordSender,
} from '../packages/littly/channel-discord/src/inbound.ts'

let pass = 0
let fail = 0
const ok = (cond, name) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.error(`  ✗ ${name}`) }
}
const eq = (actual, expected, name) => ok(actual === expected, `${name}（实际 ${JSON.stringify(actual)}）`)

// ---------- schemastery 解析钩子 ----------
// 本包尚未 pnpm install，@deepseek-ai/schemastery 走仓库内的 vendor 产物。
const SCHEMASTERY_URL = pathToFileURL(join(process.cwd(), 'vendor/schemastery/lib/index.mjs')).href
register(
  `data:text/javascript,${encodeURIComponent(`export async function resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/schemastery') {
    return { url: ${JSON.stringify(SCHEMASTERY_URL)}, shortCircuit: true }
  }
  return next(specifier, context)
}`)}`,
  import.meta.url,
)

// ---------- fetch stub（只拦 Discord 域名的出站请求） ----------
const realFetch = globalThis.fetch
const calls = []
let fetchHandler = null
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : String(input)
  calls.push({ url, init })
  if (fetchHandler) return fetchHandler(url, init)
  throw new Error(`unexpected fetch: ${url}`)
}
const stubFetch = (handler) => { fetchHandler = handler }
const jsonRes = (obj, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => obj,
  text: async () => JSON.stringify(obj),
  arrayBuffer: async () => new ArrayBuffer(8),
  headers: { get: () => 'application/json' },
})
const textRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => JSON.parse(body),
  text: async () => body,
  arrayBuffer: async () => new ArrayBuffer(8),
  headers: { get: () => 'text/plain' },
})

// ---------- DB 夹具 ----------
const dir = mkdtempSync(join(tmpdir(), 'littly-discord-'))
const storage = new LittlyStorage({ logger: { info: () => {} } }, { file: join(dir, 'd.db') })
const now = () => new Date().toISOString()

storage.prepare(
  'INSERT INTO bots (id, name, discord_enabled, discord_bot_token, discord_client_id, created_at) VALUES (?,?,?,?,?,?)',
).run('bot1', '小璃', 1, 'tok-abc', 'client-1', now())
const bot = storage.prepare('SELECT * FROM bots WHERE id = ?').get('bot1')

const enqueued = []
const hub = {
  enqueueBufferedMessage: (input) => { enqueued.push(input); return { messageId: 'm1', fireAt: now() } },
}
const deps = {
  storage,
  hub,
  log: () => {},
  onMessage: async () => {},
  photoPublicUrl: (u) => `http://127.0.0.1:3000${u}`,
  reconnectMs: 5000,
}
const addToken = (token, userId, kind, ttlMs = 600000) =>
  storage.prepare(
    'INSERT INTO binding_tokens (id, user_id, bot_id, token, kind, expires_at, used_at, created_at) VALUES (?,?,?,?,?,?,?,?)',
  ).run(`tok-${token}`, userId, 'bot1', token, kind, new Date(Date.now() + ttlMs).toISOString(), null, now())

// ---------- 1. 纯函数 ----------
console.log('== 纯函数：内容提取 / 显示名 / 邀请链接 ==')
{
  const c = extractDiscordContent({
    id: 'm', channel_id: 'dm1', channel_type: 1,
    content: '  你好  ',
    attachments: [
      { content_type: 'image/png', url: 'https://cdn/a.png' },
      { content_type: 'text/plain', url: 'https://cdn/b.txt' },
      { content_type: 'image/jpeg' },
    ],
  })
  eq(c.text, '你好', '正文 trim')
  eq(c.images.length, 1, '只保留 image/* 且有 url 的附件')
  eq(c.images[0], 'https://cdn/a.png', '图片 URL 提取')
  eq(extractDiscordContent({ id: 'm', channel_id: 'c' }).text, '', '无正文 → 空串')
  eq(extractDiscordContent({ id: 'm', channel_id: 'c' }).images.length, 0, '无附件 → 空数组')

  eq(discordDisplayName({ global_name: '阿璃', username: 'gl', id: 'u1' }, 'u1'), '阿璃', '显示名优先 global_name')
  eq(discordDisplayName({ global_name: null, username: 'gl', id: 'u1' }, 'u1'), 'gl', 'global_name 为 null → username')
  eq(discordDisplayName({ id: 'u1' }, 'u1'), 'u1', '兜底 user id')

  eq(
    createDiscordInvite('client-1'),
    'https://discord.com/api/oauth2/authorize?client_id=client-1&permissions=2048&scope=bot',
    '邀请链接（permissions=2048 Send Messages）',
  )
  eq(createDiscordInvite('a b&c'), 'https://discord.com/api/oauth2/authorize?client_id=a%20b%26c&permissions=2048&scope=bot', 'client id 转义')
}

// ---------- 2. sender 派生 ----------
console.log('== sender 派生 ==')
{
  eq(resolveDiscordSender(storage, 'u9'), 'discord_u9', '未绑定 → discord_<userId>')
  storage.prepare('INSERT INTO channel_identities (id, user_id, channel, external_id, created_at) VALUES (?,?,?,?,?)')
    .run('ci-1', 'user-x', 'discord', 'u9', now())
  eq(resolveDiscordSender(storage, 'u9'), 'user-x', '已绑定 → 绑定用户 id（与 Web/TG 同一会话线）')
}

// ---------- 3. 绑定码 ----------
console.log('== 绑定码流程 ==')
{
  addToken('ABC234', 'user-1', 'discord_code')
  const r = await tryHandleBinding(storage, { channel: 'discord', externalId: 'u1', text: '绑定 ABC234' })
  ok(r.handled, '命中绑定码 → handled=true')
  eq(r.reply, MSG_SUCCESS_DISCORD, '成功回复文案逐字一致')
  const ident = storage.prepare('SELECT * FROM channel_identities WHERE channel = ? AND external_id = ?').get('discord', 'u1')
  eq(ident?.user_id, 'user-1', '写入 channel_identities（discord / u1 → user-1）')
  const used = storage.prepare('SELECT used_at FROM binding_tokens WHERE token = ?').get('ABC234')
  ok(Boolean(used?.used_at), '绑定码标记 used_at')

  const again = await tryHandleBinding(storage, { channel: 'discord', externalId: 'u1', text: '绑定 ABC234' })
  ok(again.handled, '重复使用同一码 → handled=true（短路）')
  eq(again.reply, MSG_EXPIRED, '重复使用 → 已失效文案')

  const miss = await tryHandleBinding(storage, { channel: 'discord', externalId: 'u1', text: '今天天气不错' })
  eq(miss.handled, false, '非绑定文本 → handled=false（继续正常流程）')
  eq(miss.reply, undefined, '非绑定文本 → 无回复')

  addToken('EXPIRE', 'user-2', 'discord_code', -1000)
  const expired = await tryHandleBinding(storage, { channel: 'discord', externalId: 'u2', text: '绑定 EXPIRE' })
  eq(expired.reply, MSG_EXPIRED, '过期码 → 已失效文案')

  addToken('TGCODE', 'user-3', 'tg_deeplink')
  const wrongKind = await tryHandleBinding(storage, { channel: 'discord', externalId: 'u3', text: '绑定 TGCODE' })
  eq(wrongKind.reply, MSG_EXPIRED, 'kind 不匹配（tg_deeplink vs discord_code）→ 已失效文案')

  // 冲突：u1 已被 user-1 占用，另一个用户拿自己的码来绑同一 external_id
  addToken('ZZZ999', 'user-9', 'discord_code')
  const conflict = await tryHandleBinding(storage, { channel: 'discord', externalId: 'u1', text: '绑定 ZZZ999' })
  eq(conflict.reply, MSG_CONFLICT, '外部身份已被占用 → 冲突文案（绝不静默抢占）')
  const stillU1 = storage.prepare('SELECT user_id FROM channel_identities WHERE channel = ? AND external_id = ?').get('discord', 'u1')
  eq(stillU1?.user_id, 'user-1', '冲突后原身份不变')

  // 限频：discord:u5 连吃 5 次失败后进入限频
  for (let i = 0; i < 5; i++) {
    await tryHandleBinding(storage, { channel: 'discord', externalId: 'u5', text: '绑定 NOPE12' })
  }
  const limited = await tryHandleBinding(storage, { channel: 'discord', externalId: 'u5', text: '绑定 NOPE12' })
  eq(limited.reply, MSG_RATE, '一小时内失败超过 5 次 → 限频文案')

  // 晋升：身份存在时认领同渠道未绑定联系人（匹配 sender 或 external_id = 外部 id）
  storage.prepare('INSERT INTO contacts (id, bot_id, sender, name, external_id, channel, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('ct-1', 'bot1', 'u1', 'U1', 'dm-1', 'discord', now(), now())
  promoteContact(storage, 'bot1', 'discord', 'u1')
  const promoted = storage.prepare('SELECT user_id FROM contacts WHERE id = ?').get('ct-1')
  eq(promoted?.user_id, 'user-1', 'promoteContact 认领联系人（sender = 外部 id）')

  // 与旧 monolith 一致：Discord 的联系人主键是 `discord_<userId>`，而 promoteContact
  // 按原始外部 id（userId）匹配 —— 该晋升对 Discord 实际不命中（旧代码同此行为）。
  storage.prepare('INSERT INTO contacts (id, bot_id, sender, name, external_id, channel, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('ct-2', 'bot1', 'discord_u1', 'U1前缀', 'dm-1', 'discord', now(), now())
  promoteContact(storage, 'bot1', 'discord', 'u1')
  const prefixed = storage.prepare('SELECT user_id FROM contacts WHERE id = ?').get('ct-2')
  eq(prefixed?.user_id, null, 'discord_<userId> 前缀联系人不被 promoteContact 认领（旧行为一致）')
}

// ---------- 3.5 DM 判据（B6） ----------
console.log('== DM 判据（B6：无 guild_id 即 DM）==')
ok(isDirectMessage({}) === true, '既无 guild_id 也无 channel_type → 判 DM（旧实现这里恒丢）')
ok(isDirectMessage({ channel_type: 1 }) === true, 'channel_type=1 → DM')
ok(isDirectMessage({ guild_id: 'g1' }) === false, '带 guild_id → 群聊')
ok(isDirectMessage({ guild_id: 'g1', channel_type: 0 }) === false, '群消息（guild_id + type 0）→ 群聊')
ok(isDirectMessage({ channel_type: 0 }) === false, '显式 channel_type=0 → 群聊')
ok(isDirectMessage({ channel_type: 1, guild_id: '' }) === true, '空串 guild_id 视为 DM')

// ---------- 4. 入站处理 ----------
console.log('== 入站处理 ==')
{
  enqueued.length = 0
  stubFetch(() => jsonRes({ id: 'sent-1' }))
  await handleDiscordMessage(deps, bot, {
    id: 'm1', channel_id: 'dm-77', channel_type: 1,
    author: { id: 'u42', username: 'u42name', global_name: '小可' },
    content: '在吗',
  })
  eq(enqueued.length, 1, 'DM 消息入队一次')
  eq(enqueued[0]?.channelId, 'discord', '入队 channelId=discord（缓冲窗口由 hub 调度）')
  eq(enqueued[0]?.sender, 'discord_u42', '入队 sender=discord_<userId>')
  eq(enqueued[0]?.text, '在吗', '入队文本')
  const contact = storage.prepare('SELECT * FROM contacts WHERE bot_id = ? AND sender = ?').get('bot1', 'discord_u42')
  eq(contact?.external_id, 'dm-77', '联系人 external_id = DM channel_id（投递地址）')
  eq(contact?.channel, 'discord', '联系人 channel=discord')
  eq(contact?.name, '小可', '联系人名称 = global_name')

  enqueued.length = 0
  await handleDiscordMessage(deps, bot, {
    id: 'm2', channel_id: 'g1', guild_id: 'guild-1',
    author: { id: 'u43', username: 'g43' }, content: '群消息',
  })
  eq(enqueued.length, 0, '群聊消息忽略（只收 DM）')

  // B6 回归：真实 Gateway DM payload 没有 channel_type 字段 —— 旧实现会在这里丢消息
  enqueued.length = 0
  await handleDiscordMessage(deps, bot, {
    id: 'm2b', channel_id: 'dm-77b',
    author: { id: 'u42', username: 'u42name' },
    content: '没有 channel_type 的私聊',
  })
  eq(enqueued.length, 1, '无 channel_type 的 DM 也入队（B6 回归）')

  enqueued.length = 0
  await handleDiscordMessage(deps, bot, {
    id: 'm3', channel_id: 'dm-78', channel_type: 1,
    author: { id: 'bot-x', bot: true, username: 'bot' }, content: 'bot 消息',
  })
  eq(enqueued.length, 0, 'bot 自己的消息忽略')

  enqueued.length = 0
  await handleDiscordMessage(deps, bot, {
    id: 'm4', channel_id: 'dm-79', channel_type: 1, author: { id: 'u44', username: 'u44' }, content: '   ',
  })
  eq(enqueued.length, 0, '空正文且无附件 → 忽略')

  // 已绑定用户 → 归并到绑定用户的会话线
  enqueued.length = 0
  await handleDiscordMessage(deps, bot, {
    id: 'm5', channel_id: 'dm-80', channel_type: 1,
    author: { id: 'u9', username: 'u9' }, content: '绑定后消息',
  })
  eq(enqueued[0]?.sender, 'user-x', '已绑定账号 → sender = 绑定用户 id')

  // 绑定流短路：入站不进入缓冲，且回一条绑定结果
  enqueued.length = 0
  calls.length = 0
  addToken('BIND77', 'user-77', 'discord_code')
  await handleDiscordMessage(deps, bot, {
    id: 'm6', channel_id: 'dm-81', channel_type: 1,
    author: { id: 'u77', username: 'u77' }, content: '绑定 BIND77',
  })
  eq(enqueued.length, 0, '绑定码消息短路（不入缓冲）')
  eq(calls.length, 1, '绑定结果回一条消息')
  eq(calls[0]?.url, 'https://discord.com/api/v10/channels/dm-81/messages', '绑定回复发到当前 DM channel')
  eq(calls[0]?.init?.body, JSON.stringify({ content: MSG_SUCCESS_DISCORD }), '绑定回复正文')
}

// ---------- 5. 出站 ----------
console.log('== 出站投递 ==')
{
  stubFetch(() => jsonRes({ id: 'sent-2' }))
  storage.prepare('INSERT OR REPLACE INTO contacts (id, bot_id, sender, name, external_id, channel, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('ct-out', 'bot1', 'discord_u42', 'U42', 'dm-77', 'discord', now(), now())

  const cid = await resolveDiscordChannelId(deps, bot, 'discord_u42')
  eq(cid, 'dm-77', '投递地址优先取 contacts.external_id')

  // 无 contact 记录但有绑定身份 → 动态 Create DM
  storage.prepare('INSERT INTO channel_identities (id, user_id, channel, external_id, created_at) VALUES (?,?,?,?,?)')
    .run('ci-2', 'user-y', 'discord', 'u99', now())
  calls.length = 0
  stubFetch((url) => (url.includes('/users/u99/channels') ? jsonRes({ id: 'dm-created' }) : jsonRes({ id: 'x' })))
  const created = await resolveDiscordChannelId(deps, bot, 'user-y')
  eq(created, 'dm-created', '缺投递地址 → 用 channel_identities 的 user id 现开 DM')
  eq(calls[0]?.url, 'https://discord.com/api/v10/users/u99/channels', 'Create DM 请求路径')
  eq(calls[0]?.init?.headers?.Authorization, 'Bot tok-abc', 'Create DM 带 Bot token')

  const none = await resolveDiscordChannelId(deps, bot, 'discord_unknown')
  eq(none, '', '既无 contact 又无身份 → 无投递地址')

  // 发送文本
  calls.length = 0
  stubFetch(() => jsonRes({ id: 'sent-3' }))
  const sent = await sendToDiscordHumanized(deps, bot, 'discord_u42', '在的')
  eq(sent.ok, true, '发送成功')
  eq(sent.sent, 1, 'sent=1')
  eq(calls[0]?.url, 'https://discord.com/api/v10/channels/dm-77/messages', '发送请求路径')
  eq(calls[0]?.init?.body, JSON.stringify({ content: '在的' }), '发送正文 {content}')
  eq(calls[0]?.init?.headers?.Authorization, 'Bot tok-abc', '发送带 Bot token')

  const disabled = await sendToDiscordHumanized(deps, { ...bot, discord_enabled: 0 }, 'discord_u42', '在的')
  eq(disabled.ok, false, '未启用 → ok=false')
  eq(disabled.error, 'Discord 未启用', '未启用错误文案')

  const blank = await sendToDiscordHumanized(deps, bot, 'discord_u42', '   ')
  eq(blank.ok, true, '空文本 → ok=true')
  eq(blank.sent, 0, '空文本 → sent=0')

  const noAddr = await sendToDiscordHumanized(deps, bot, 'discord_unknown', '在的')
  eq(noAddr.ok, false, '无投递地址 → ok=false')
  eq(noAddr.error, '没有 Discord DM 投递地址（对方需要先给 bot 发过消息）', '无投递地址错误文案')

  stubFetch(() => textRes('boom', 500))
  const failed = await sendToDiscordHumanized(deps, bot, 'discord_u42', '在的')
  eq(failed.ok, false, 'Discord 返回 5xx → ok=false')
  eq(failed.error, 'Discord 发送失败', '发送失败错误文案')
}

// ---------- 6. 插件契约 ----------
console.log('== 插件契约 ==')
{
  const plugin = await import('../packages/littly/channel-discord/src/index.ts')
  eq(plugin.name, 'littly-channel-discord', '插件名')
  eq(JSON.stringify(plugin.inject), JSON.stringify(['littlyStorage', 'littlyHub']), 'inject 依赖')
  const parsed = plugin.Config({})
  eq(parsed.reconnectMs, 5000, 'Config 默认 reconnectMs=5000')
  eq(parsed.publicBaseUrl, '', 'Config 默认 publicBaseUrl=""')

  // apply()：注册 discord 渠道（用独立的库，bot 全部禁用 → 不触网）
  const dir2 = mkdtempSync(join(tmpdir(), 'littly-discord-apply-'))
  const storage2 = new LittlyStorage({ logger: { info: () => {} } }, { file: join(dir2, 'a.db') })
  storage2.prepare('INSERT INTO bots (id, name, created_at) VALUES (?,?,?)').run('bot2', '禁用机器人', now())
  const registered = []
  const disposers = []
  const ctx = {
    littlyStorage: storage2,
    littlyHub: { registerChannel: (id, sender) => registered.push({ id, sender }) },
    logger: { info: () => {} },
    effect: (fn) => { const d = fn(); disposers.push(d); return d },
  }
  plugin.apply(ctx, { reconnectMs: 5000, publicBaseUrl: '' })
  eq(registered.length, 1, 'apply() 注册一个渠道')
  eq(registered[0]?.id, 'discord', '注册渠道 id = discord')
  ok(typeof registered[0]?.sender?.sendText === 'function', '注册 sendText')
  ok(typeof registered[0]?.sender?.sendPhoto === 'function', '注册 sendPhoto')
  for (const d of disposers) d?.()
  rmSync(dir2, { recursive: true, force: true })
}

globalThis.fetch = realFetch
rmSync(dir, { recursive: true, force: true })

console.log(`\n${fail === 0 ? '全部通过' : '存在失败'}：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
