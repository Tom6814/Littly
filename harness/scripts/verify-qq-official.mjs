#!/usr/bin/env node
/**
 * QQ 官方开放平台渠道验证（@littly/channel-qq-official）。
 * 运行：node scripts/verify-qq-official.mjs
 *
 * 覆盖：网关载荷解析、sender / 渠道派生、绑定码路径（含失效/冲突/限频）、
 * 被动回复窗口（event_id）、入站缓冲入队、出站错误语义与请求体、插件入口契约。
 * 用真实 SQLite（@littly/storage）落库断言；HTTP 层用 fetch mock 复刻
 * QQ 官方网关契约（token 端点 + /v2/users/{openid}/messages）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LittlyStorage } from '../packages/littly/storage/src/index.ts'
import { apply, inject, name as pluginName, sendQqText } from '../packages/littly/channel-qq-official/src/index.ts'
import {
  buildQqMessageBody,
  parseC2CMessage,
  verifyQqCredentials,
  QQ_API,
  QQ_TOKEN_URL,
} from '../packages/littly/channel-qq-official/src/client.ts'
import { handleQQMessage, resolveQqOpenid } from '../packages/littly/channel-qq-official/src/inbound.ts'
import {
  MSG_CONFLICT,
  MSG_EXPIRED,
  MSG_RATE,
  MSG_SUCCESS_QQ,
  tryHandleBinding,
} from '../packages/littly/channel-qq-official/src/binding.ts'

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`) } else { fail++; console.error(`  ✗ ${label}`) }
}

// ---------- fetch mock（QQ 官方网关契约） ----------

const fetchCalls = []
let tokenCalls = 0
let sendStatus = 200
let tokenOk = true

globalThis.fetch = async (url, init) => {
  const target = String(url)
  fetchCalls.push({ url: target, init })
  if (target === QQ_TOKEN_URL) {
    tokenCalls++
    if (!tokenOk) return new Response(JSON.stringify({ error: 'invalid' }), { status: 400, statusText: 'Bad Request' })
    return new Response(JSON.stringify({ access_token: 'TOKEN-1', expires_in: 7200 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  if (target.startsWith(`${QQ_API}/v2/users/`)) {
    if (sendStatus !== 200) return new Response('send failed', { status: sendStatus, statusText: 'Server Error' })
    return new Response(JSON.stringify({ id: 'msg-1', timestamp: '2026-01-01T00:00:00+08:00' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return new Response('not found', { status: 404, statusText: 'Not Found' })
}

const lastSendCall = () => [...fetchCalls].reverse().find((c) => c.url.startsWith(`${QQ_API}/v2/users/`))
const lastSendBody = () => {
  const call = lastSendCall()
  return call ? JSON.parse(String(call.init.body)) : null
}

// ---------- 真实 SQLite 库 ----------

const dir = mkdtempSync(join(tmpdir(), 'littly-qq-official-'))
const storage = new LittlyStorage({ logger: { info: () => {} } }, { file: join(dir, 'main.db') })
const nowIso = new Date().toISOString()
storage
  .prepare('INSERT INTO bots (id, name, created_at, qq_enabled, qq_app_id, qq_app_secret) VALUES (?,?,?,?,?,?)')
  .run('bot-qq', '小璃', nowIso, 1, 'app-1', 'secret-1')
storage
  .prepare('INSERT INTO bots (id, name, created_at, qq_enabled, qq_app_id, qq_app_secret) VALUES (?,?,?,?,?,?)')
  .run('bot-off', '关掉的角色', nowIso, 0, 'app-2', 'secret-2')

const botRow = () => storage.prepare('SELECT * FROM bots WHERE id = ?').get('bot-qq')
const bot = botRow()

// ---------- 插件依赖（hub 用假实现，只记录入队与注册） ----------

const enqueued = []
const registered = []
const hub = {
  registerChannel: (channelId, sender) => { registered.push({ channelId, sender }) },
  enqueueBufferedMessage: (input) => {
    enqueued.push(input)
    return { messageId: 'msg-local', fireAt: nowIso }
  },
}
const deps = {
  storage,
  hub,
  log: () => {},
  onMessage: async (target, payload) => { await handleQQMessage(deps, target, payload) },
  reconnectMs: 5000,
}

// ---------- 1. 网关载荷解析 ----------

console.log('== 网关载荷解析 ==')
const parsed = parseC2CMessage({
  id: 'MSG-1',
  author: { user_openid: 'OPENID-1' },
  content: '你好',
  msg_id: 'MID-1',
  event_id: 'EVT-1',
  timestamp: 1767225600,
})
ok(parsed?.author?.user_openid === 'OPENID-1', '解析出 author.user_openid')
ok(parsed?.content === '你好', '解析出 content')
ok(parsed?.event_id === 'EVT-1', '解析出 event_id（被动回复窗口凭据）')
ok(parsed?.msg_id === 'MID-1', '解析出 msg_id')
ok(parsed?.timestamp === 1767225600, '解析出 timestamp')
const noAuthor = parseC2CMessage({ id: 'MSG-2', content: 'hi' })
ok(noAuthor?.author?.user_openid === '', '缺 author 时 openid 为空串')
ok(parseC2CMessage(null) === null, '非对象载荷返回 null')
ok(parseC2CMessage('x') === null, '字符串载荷返回 null')

// ---------- 2. 发送体（被动回复窗口） ----------

console.log('== 发送体 ==')
const plainBody = buildQqMessageBody('在吗')
ok(plainBody.content === '在吗' && plainBody.msg_type === 0, '文本体 = content + msg_type 0')
ok(!('event_id' in plainBody), '主动推送不带 event_id')
const passiveBody = buildQqMessageBody('在吗', 'EVT-9')
ok(passiveBody.event_id === 'EVT-9', '被动回复带上 event_id')
ok(!('event_id' in buildQqMessageBody('在吗', '')), '空 event_id 不写入（与旧实现一致）')

// ---------- 3. sender / 渠道派生 ----------

console.log('== sender / 渠道派生 ==')
ok(resolveQqOpenid(deps, 'bot-qq', 'qq_OPENID-2') === 'OPENID-2', 'qq_ 前缀直接取 openid')
storage
  .prepare('INSERT INTO channel_identities (id, user_id, channel, external_id, created_at) VALUES (?,?,?,?,?)')
  .run('id-1', 'user-1', 'qq', 'OPENID-BOUND', nowIso)
ok(resolveQqOpenid(deps, 'bot-qq', 'user-1') === 'OPENID-BOUND', '已绑定用户取 channel_identities 的权威 openid')
storage
  .prepare('INSERT INTO contacts (id, bot_id, sender, name, external_id, channel, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
  .run('ct-1', 'bot-qq', 'user-2', '访客', 'OPENID-GUEST', 'qq', nowIso, nowIso)
ok(resolveQqOpenid(deps, 'bot-qq', 'user-2') === 'OPENID-GUEST', '无绑定时回落到 contact.external_id')
ok(resolveQqOpenid(deps, 'bot-qq', 'user-unknown') === '', '无法解析时返回空串')

// ---------- 4. 绑定码路径 ----------

console.log('== 绑定码路径 ==')
const insertToken = (id, userId, token, kind, expiresAt) =>
  storage
    .prepare('INSERT INTO binding_tokens (id, user_id, bot_id, token, kind, expires_at, used_at, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, userId, 'bot-qq', token, kind, expiresAt, null, nowIso)

insertToken('bt-1', 'user-1', 'ABC123', 'qq_code', new Date(Date.now() + 10 * 60 * 1000).toISOString())
insertToken('bt-2', 'user-1', 'ZZZ999', 'qqp_code', new Date(Date.now() + 10 * 60 * 1000).toISOString())
insertToken('bt-3', 'user-1', 'OLD111', 'qq_code', new Date(Date.now() - 1000).toISOString())

ok((await tryHandleBinding(storage, { channel: 'qq', externalId: 'OPENID-1', text: '在吗' })).handled === false,
  '未命中绑定码时 handled=false（正常消息继续）')

// 绑定期望：联系人在所有角色下被认领
storage
  .prepare('INSERT INTO contacts (id, bot_id, sender, name, external_id, channel, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
  .run('ct-bind', 'bot-qq', 'OPENID-1', 'OPENID-1', 'OPENID-1', 'qq', nowIso, nowIso)

const bindOk = await tryHandleBinding(storage, { channel: 'qq', externalId: 'OPENID-1', text: '绑定 ABC123' })
ok(bindOk.handled === true, '绑定码命中 → handled=true（调用方短路）')
ok(bindOk.reply === MSG_SUCCESS_QQ, '绑定成功文案与旧项目逐字一致')
const identityRow = storage
  .prepare('SELECT user_id, channel, external_id FROM channel_identities WHERE channel = ? AND external_id = ?')
  .get('qq', 'OPENID-1')
ok(identityRow?.user_id === 'user-1', '写入 channel_identities(qq) 身份')
const usedToken = storage.prepare('SELECT used_at FROM binding_tokens WHERE token = ?').get('ABC123')
ok(!!usedToken?.used_at, '绑定码标记已用（一次性）')
const promoted = storage.prepare('SELECT user_id FROM contacts WHERE id = ?').get('ct-bind')
ok(promoted?.user_id === 'user-1', '同渠道联系人被认领为登录用户')
const reuse = await tryHandleBinding(storage, { channel: 'qq', externalId: 'OPENID-1', text: '绑定 ABC123' })
ok(reuse.reply === MSG_EXPIRED, '已用过的绑定码 → 失效文案')

const wrongKind = await tryHandleBinding(storage, { channel: 'qq', externalId: 'OPENID-KIND', text: '绑定 ZZZ999' })
ok(wrongKind.reply === MSG_EXPIRED, 'kind 不匹配（qqp_code ≠ qq_code）→ 失效文案')
const expired = await tryHandleBinding(storage, { channel: 'qq', externalId: 'OPENID-OLD', text: '绑定 OLD111' })
ok(expired.reply === MSG_EXPIRED, '过期绑定码 → 失效文案')

storage
  .prepare('INSERT INTO channel_identities (id, user_id, channel, external_id, created_at) VALUES (?,?,?,?,?)')
  .run('id-2', 'user-other', 'qq', 'OPENID-TAKEN', nowIso)
insertToken('bt-4', 'user-1', 'DEF456', 'qq_code', new Date(Date.now() + 10 * 60 * 1000).toISOString())
const conflict = await tryHandleBinding(storage, { channel: 'qq', externalId: 'OPENID-TAKEN', text: '绑定 DEF456' })
ok(conflict.reply === MSG_CONFLICT, '该 openid 已被他人绑定 → 冲突文案')

// 限频：同一 sender 连续失败 5 次后返回限频文案
let rateReply = null
for (let i = 0; i < 6; i++) {
  const res = await tryHandleBinding(storage, { channel: 'qq', externalId: 'OPENID-RATE', text: '绑定 NOPE12' })
  rateReply = res.reply
}
ok(rateReply === MSG_RATE, '连续失败 5 次后 → 限频文案')

// ---------- 5. 入站处理 ----------

console.log('== 入站处理 ==')
const beforeEnqueue = enqueued.length
await handleQQMessage(deps, bot, { id: 'M1', author: { user_openid: 'OPENID-2' }, content: '在吗', event_id: 'EVT-1' })
ok(enqueued.length === beforeEnqueue + 1, '普通消息进缓冲窗口')
const enq = enqueued[enqueued.length - 1]
ok(enq.sender === 'qq_OPENID-2', '未绑定用户 sender = qq_<openid>')
ok(enq.channelId === 'qq', '渠道 id = qq')
ok(enq.botId === 'bot-qq' && enq.text === '在吗', '入队内容 = 原始文本（已 trim）')
const contactRow = storage
  .prepare('SELECT name, external_id, channel FROM contacts WHERE bot_id = ? AND sender = ?')
  .get('bot-qq', 'qq_OPENID-2')
ok(contactRow?.external_id === 'OPENID-2', '联系人记下投递地址 external_id = openid')
ok(contactRow?.name === 'OPENID-2' && contactRow?.channel === 'qq', '联系人 name/channel 落库')

const beforeBound = enqueued.length
await handleQQMessage(deps, bot, { id: 'M2', author: { user_openid: 'OPENID-1' }, content: '在吗' })
ok(enqueued[enqueued.length - 1].sender === 'user-1', '已绑定 openid 归并到 user_id 会话线')

const beforeBind = enqueued.length
insertToken('bt-5', 'user-1', 'GHI789', 'qq_code', new Date(Date.now() + 10 * 60 * 1000).toISOString())
await handleQQMessage(deps, bot, { id: 'M3', author: { user_openid: 'OPENID-BIND' }, content: '绑定 GHI789', event_id: 'EVT-BIND' })
ok(enqueued.length === beforeBind, '绑定消息不进 AI 流程（短路）')
const bindReply = lastSendBody()
ok(bindReply?.content === MSG_SUCCESS_QQ, '绑定回复文案正确')
ok(bindReply?.event_id === 'EVT-BIND', '绑定回复带 event_id（命中 60 分钟被动回复窗口）')

const beforeEmpty = enqueued.length
await handleQQMessage(deps, bot, { id: 'M4', author: { user_openid: 'OPENID-3' }, content: '   ' })
ok(enqueued.length === beforeEmpty, '空消息不入队')

// ---------- 6. 出站（hub sendText） ----------

console.log('== 出站 ==')
const disabled = await sendQqText(deps, 'bot-off', 'qq_OPENID-2', '你好')
ok(disabled.ok === false && disabled.error === 'QQ 未启用', '未启用 → QQ 未启用')
ok(disabled.sent === 0, '未启用时 sent = 0')
const blank = await sendQqText(deps, 'bot-qq', 'qq_OPENID-2', '   ')
ok(blank.ok === true && blank.sent === 0, '空文本 → ok 且 sent = 0')
const noOpenid = await sendQqText(deps, 'bot-qq', 'user-unknown', '你好')
ok(noOpenid.ok === false && noOpenid.error === '没有 QQ openid（对方需要先给 bot 发过消息）', '拿不到 openid → 明确错误')
ok(noOpenid.sent === 0, '拿不到 openid 时 sent = 0')

const sent = await sendQqText(deps, 'bot-qq', 'qq_OPENID-2', '你好呀')
ok(sent.ok === true && sent.sent === 1, '正常发送成功')
const sendCall = lastSendCall()
ok(sendCall?.url === `${QQ_API}/v2/users/OPENID-2/messages`, '发送地址 = /v2/users/{openid}/messages')
ok(sendCall?.init?.headers?.Authorization === 'QQBot TOKEN-1', 'Authorization = QQBot <access_token>')
const sendBody = lastSendBody()
ok(sendBody?.content === '你好呀' && sendBody?.msg_type === 0, '发送体 = content + msg_type 0')
// B7：主链路出站现在会自动带最近入站 event_id（OPENID-2 之前发过 EVT-1）——
// 修复前这里恒为主动推送，4 条/月配额用光就发不出去。
ok(sendBody?.event_id === 'EVT-1', 'B7：主链路回复自动带最近入站 event_id（被动回复窗口）')

// B7：TTL 60 分钟 —— 过期后回退为主动推送；不同 (bot,openid) 互不串
{
  const { rememberQqEvent, recallQqEvent, QQ_EVENT_TTL_MS, clearQqEvents } = await import(
    '../packages/littly/channel-qq-official/src/event-context.ts'
  )
  clearQqEvents()
  rememberQqEvent('b1', 'o1', 'E1', 1000)
  ok(recallQqEvent('b1', 'o1', 1000) === 'E1', 'B7：同 (bot,openid) 取回 event_id')
  ok(recallQqEvent('b1', 'o1', 1000 + QQ_EVENT_TTL_MS) === 'E1', 'B7：TTL 边界内仍有效')
  ok(recallQqEvent('b1', 'o1', 1000 + QQ_EVENT_TTL_MS + 1) === undefined, 'B7：超过 60 分钟 → 过期回退主动推送')
  ok(recallQqEvent('b2', 'o1', 1000) === undefined, 'B7：按 botId 隔离')
  ok(recallQqEvent('b1', 'o2', 1000) === undefined, 'B7：按 openid 隔离')
  rememberQqEvent('b1', 'o1', 'E2', 2000)
  ok(recallQqEvent('b1', 'o1', 2000) === 'E2', 'B7：新入站覆盖旧 event_id')
  rememberQqEvent('b1', 'o1', undefined, 3000)
  ok(recallQqEvent('b1', 'o1', 3000) === 'E2', 'B7：无 event_id 的入站不清空已有上下文')
  ok(QQ_EVENT_TTL_MS === 60 * 60 * 1000, 'B7：TTL = 60 分钟（QQ 被动回复窗口）')
  clearQqEvents()
  // 清空后主链路回退为主动推送
  const plain = await sendQqText(deps, 'bot-qq', 'qq_OPENID-2', '清空后')
  ok(plain.ok === true, 'B7：清空上下文后仍可发送')
  const plainBody = lastSendBody()
  ok(!('event_id' in (plainBody ?? {})), 'B7：无上下文时走主动推送（不带 event_id）')
}
ok(tokenCalls === 1, 'access_token 复用缓存（只换一次）')
const cachedToken = storage.prepare('SELECT qq_access_token, qq_token_expires_at FROM bots WHERE id = ?').get('bot-qq')
ok(cachedToken?.qq_access_token === 'TOKEN-1', 'access_token 落库缓存')
ok(Number(cachedToken?.qq_token_expires_at) > Math.floor(Date.now() / 1000), '过期时间落库（Unix 秒）')

sendStatus = 500
const failed = await sendQqText(deps, 'bot-qq', 'qq_OPENID-2', '你好呀')
ok(failed.ok === false && failed.error === 'QQ 发送失败' && failed.sent === 0, 'HTTP 失败 → QQ 发送失败')
sendStatus = 200

// ---------- 7. 凭据校验 ----------

console.log('== 凭据校验 ==')
ok((await verifyQqCredentials('app-1', 'secret-1')) === true, '凭据有效')
tokenOk = false
ok((await verifyQqCredentials('app-1', 'bad')) === false, '凭据无效 → false')
tokenOk = true

// ---------- 8. 插件入口契约 ----------

console.log('== 插件入口 ==')
ok(pluginName === 'littly-channel-qq-official', '插件名')
ok(JSON.stringify(inject) === JSON.stringify(['littlyStorage', 'littlyHub']), 'inject = [littlyStorage, littlyHub]')

const emptyStorage = new LittlyStorage({ logger: { info: () => {} } }, { file: join(dir, 'empty.db') })
const effectDisposers = []
const fakeCtx = {
  logger: { info: () => {} },
  littlyStorage: emptyStorage,
  littlyHub: { registerChannel: (channelId, sender) => { registered.push({ channelId, sender }) } },
  effect: (execute) => {
    const disposer = execute()
    if (typeof disposer === 'function') effectDisposers.push(disposer)
    return disposer
  },
}
apply(fakeCtx, { reconnectMs: 5000 })
const qqChannel = registered.find((r) => r.channelId === 'qq')
ok(!!qqChannel, "hub.registerChannel('qq', …) 已注册")
ok(typeof qqChannel?.sender?.sendText === 'function', '注册了 sendText')
const delegated = await qqChannel.sender.sendText('bot-none', 'qq_X', '你好')
ok(delegated.ok === false && delegated.error === 'QQ 未启用', '注册的 sendText 走本插件实现')
for (const disposer of effectDisposers) disposer()

emptyStorage.close()
storage.close()
rmSync(dir, { recursive: true, force: true })

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
