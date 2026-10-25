#!/usr/bin/env node
/**
 * 微信渠道（iLink 直连 + 桥接 Webhook）行为验证。
 * 运行：node scripts/verify-wechat-ilink.mjs
 *
 * 覆盖：HMAC 验签（有效/无效/过期）、challenge 回显、幂等（同 id 两次 → 一次效果）、
 * 消息解析、sender 派生、绑定码路径、iLink 会话状态存储、出站投递地址解析。
 * 用真实 SQLite（packages/littly/storage 的 LittlyStorage）落库，不依赖任何外部服务。
 */
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LittlyStorage } from '../packages/littly/storage/src/index.ts'
import {
  clearSeenEvents,
  handleWechatWebhook,
  seenEvent,
  verifyWechatSignature,
} from '../packages/littly/channel-wechat-ilink/src/webhook.ts'
import {
  MSG_CONFLICT,
  MSG_EXPIRED,
  MSG_RATE,
  MSG_SUCCESS_WECHAT,
  createWechatCode,
  genWechatCode,
  tryHandleBinding,
} from '../packages/littly/channel-wechat-ilink/src/binding.ts'
import {
  processWechatMessage,
  pushWechatText,
  wechatSenderKey,
} from '../packages/littly/channel-wechat-ilink/src/inbound.ts'
import {
  extractText,
  createSdkILinkClientFactory,
  getILinkClientFactory,
  setILinkClientFactory,
} from '../packages/littly/channel-wechat-ilink/src/ilink.ts'
import {
  deleteBindSession,
  getBindSession,
  getContextToken,
  getSyncBuf,
  setBindSession,
  setContextToken,
  setSyncBuf,
} from '../packages/littly/channel-wechat-ilink/src/ilink-store.ts'

let pass = 0
let fail = 0
const ok = (cond, name) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.error(`  ✗ ${name}`) }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nowIso = () => new Date().toISOString()

// ---------- 真实 SQLite 库 ----------

const dir = mkdtempSync(join(tmpdir(), 'littly-wx-'))
const storage = new LittlyStorage({ logger: { info: () => {} } }, { file: join(dir, 'verify.db') })

const SECRET = 'verify-secret'
const HUB_BOT_ID = 'hub-bot-1'
const BOT_ID = 'bot-1'
const USER_ID = 'user-1'
const OTHER_USER_ID = 'user-2'
const WXID = 'wxid_alpha@im.wechat'
const BIND_WXID = 'wxid_bind@im.wechat'

storage
  .prepare('INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?,?,?,?,?)')
  .run(USER_ID, 'verifier', 'x', 'user', nowIso())
storage
  .prepare('INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?,?,?,?,?)')
  .run(OTHER_USER_ID, 'verifier2', 'x', 'user', nowIso())
storage.prepare('INSERT INTO bots (id, name, created_at) VALUES (?,?,?)').run(BOT_ID, '验证角色', nowIso())
storage
  .prepare('UPDATE bots SET wx_enabled = 1, wx_hub_bot_id = ?, wx_push_token = ?, wx_verify_secret = ? WHERE id = ?')
  .run(HUB_BOT_ID, 'push-token-1', SECRET, BOT_ID)

const botRow = () => storage.prepare('SELECT * FROM bots WHERE id = ?').get(BOT_ID)

// ---------- 假 hub / 假 push ----------

const enqueued = []
const hub = {
  enqueueBufferedMessage: (input) => {
    enqueued.push(input)
    return { messageId: `msg-${enqueued.length}`, fireAt: nowIso() }
  },
}
const pushes = []
const deps = {
  storage,
  hub,
  log: () => {},
  push: async (bot, to, text) => {
    pushes.push({ bot: bot.id, to, text })
    return true
  },
}

const sign = (secret, ts, body) =>
  `sha256=${createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex')}`

const post = async (bodyObj, { secret = SECRET, timestamp = String(Math.floor(Date.now() / 1000)), signature } = {}) => {
  const raw = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj)
  const sig = signature === undefined ? sign(secret, timestamp, raw) : signature
  return handleWechatWebhook(raw, { timestamp, signature: sig }, deps)
}

// ---------- 1. HMAC 验签 ----------

console.log('== HMAC 验签 ==')
const body = JSON.stringify({ type: 'event', event: { id: 'sig-1' } })
const ts = String(Math.floor(Date.now() / 1000))
ok(verifyWechatSignature(SECRET, ts, body, sign(SECRET, ts, body)) === true, '正确签名通过')
ok(verifyWechatSignature(SECRET, ts, body, sign('wrong-secret', ts, body)) === false, '签名与密钥不匹配拒绝')
ok(verifyWechatSignature(SECRET, ts, body, sign(SECRET, ts, `${body}x`)) === false, '请求体被篡改拒绝')
ok(verifyWechatSignature(SECRET, ts, body, sign(SECRET, ts, body).replace(/^sha256=/, '')) === false, '缺 sha256= 前缀拒绝')
ok(verifyWechatSignature(SECRET, ts, body, 'sha256=zz') === false, '非法 hex 拒绝')
ok(verifyWechatSignature(SECRET, null, body, sign(SECRET, ts, body)) === false, '缺时间戳拒绝')
ok(verifyWechatSignature(SECRET, ts, body, null) === false, '缺签名拒绝')
ok(verifyWechatSignature('', ts, body, sign(SECRET, ts, body)) === false, '空密钥拒绝')
{
  const expired = String(Math.floor(Date.now() / 1000) - 10 * 60)
  ok(verifyWechatSignature(SECRET, expired, body, sign(SECRET, expired, body)) === false, '过期时间戳拒绝')
  const stale = String(Math.floor(Date.now() / 1000) - 5 * 60 - 1)
  ok(verifyWechatSignature(SECRET, stale, body, sign(SECRET, stale, body)) === false, '超过 5 分钟新鲜度窗口拒绝')
}
ok(
  verifyWechatSignature(SECRET, ts, body, `sha256=${sign(SECRET, ts, body).slice(7).toUpperCase()}`) === true,
  '大写 hex 仍通过（比较前转小写）',
)
{
  // 时钟偏差容忍：未来 1 分钟内仍通过
  const future = String(Math.floor(Date.now() / 1000) + 60)
  ok(verifyWechatSignature(SECRET, future, body, sign(SECRET, future, body)) === true, '小幅时钟偏差容忍')
}

// ---------- 2. challenge 回显 ----------

console.log('== challenge 回显 ==')
{
  const r = await post({ type: 'url_verification', challenge: 'chal-123' })
  ok(r.status === 200 && r.body.challenge === 'chal-123', 'url_verification 回显 challenge')
  const r2 = await post({ type: 'url_verification', challenge: 'chal-456' }, { signature: 'sha256=deadbeef' })
  ok(r2.status === 200 && r2.body.challenge === 'chal-456', 'challenge 先于验签（签名无效也回显）')
  const r3 = await post({ type: 'url_verification' }, { secret: 'nope' })
  ok(r3.status === 200 && r3.body.challenge === '', '缺 challenge 回显空串')
}

// ---------- 3. 幂等 ----------

console.log('== 幂等 ==')
{
  clearSeenEvents()
  const evt = {
    bot: { id: HUB_BOT_ID },
    event: { id: 'evt-dup', data: { sender: { id: WXID }, content: '你好' } },
  }
  const before = enqueued.length
  const r1 = await post(evt)
  await sleep(40)
  const r2 = await post(evt)
  await sleep(40)
  ok(r1.status === 200 && r1.body.reply_async === true, '首次事件返回 reply_async')
  ok(r2.status === 200 && r2.body.reply_async === true, '重复事件仍返回 reply_async')
  ok(enqueued.length - before === 1, '同一 event.id 两次 → 只产生一次入站效果')
  ok(seenEvent('evt-dup') === true, 'seenEvent 命中已见 id')
  ok(seenEvent('evt-unknown') === false, 'seenEvent 未见 id 返回 false')
  ok(seenEvent(undefined) === false, 'seenEvent 无 id 返回 false')
}

// ---------- 4. 消息解析 ----------

console.log('== 消息解析 ==')
{
  const r = await post({ bot: { id: HUB_BOT_ID }, event: { id: 'p-1', data: { sender: { id: WXID }, content: '今天天气' } } })
  await sleep(40)
  const last = enqueued[enqueued.length - 1]
  ok(r.status === 200, 'sender.id + data.content 正常受理')
  ok(last?.text === '今天天气', '正文取自 event.data.content')
  ok(last?.sender === WXID, 'sender 取自 event.data.sender.id')
  ok(last?.channelId === 'wechat', 'channelId = wechat')

  await post({ bot: { id: HUB_BOT_ID }, event: { id: 'p-2', from_user: WXID, text: '旧格式' } })
  await sleep(40)
  ok(enqueued[enqueued.length - 1]?.text === '旧格式', '兼容旧自定义格式 from_user/text')

  await post({ bot: { id: HUB_BOT_ID }, event: { id: 'p-3', data: { sender: { id: WXID }, command: 'ping', text: 'pong' } } })
  await sleep(40)
  ok(enqueued[enqueued.length - 1]?.text === 'ping pong', 'command 事件拼成 "<command> <text>"')

  const noSender = await post({ bot: { id: HUB_BOT_ID }, event: { id: 'p-4', data: { content: '无 sender' } } })
  ok(noSender.status === 400 && noSender.body.error === 'sender and content required', '缺 sender → 400')
  const noText = await post({ bot: { id: HUB_BOT_ID }, event: { id: 'p-5', data: { sender: { id: WXID } } } })
  ok(noText.status === 400 && noText.body.error === 'sender and content required', '缺正文 → 400')
  const badJson = await post('{ not json', { signature: 'sha256=deadbeef' })
  ok(badJson.status === 400 && badJson.body.error === 'invalid json', '非法 JSON → 400')
  const unknownBot = await post({ bot: { id: 'no-such-bot' }, event: { id: 'p-6', data: { sender: { id: WXID }, content: 'x' } } })
  ok(unknownBot.status === 404 && unknownBot.body.error === 'unknown bot', '未知 bot → 404')
  const badSig = await post({ bot: { id: HUB_BOT_ID }, event: { id: 'p-7', data: { sender: { id: WXID }, content: 'x' } } }, { signature: 'sha256=' + '0'.repeat(64) })
  ok(badSig.status === 401 && badSig.body.error === 'invalid signature', '签名错误 → 401')
}

// ---------- 5. sender 派生 ----------

console.log('== sender 派生 ==')
{
  ok(wechatSenderKey('wxid_alpha@im.wechat') === 'wxid_alpha@im.wechat', '已是 <wxid>@im.wechat 的 id 原样返回')
  ok(wechatSenderKey('wxid_alpha') === 'wxid_alpha@im.wechat', '裸 wxid 补 @im.wechat 后缀')
  ok(wechatSenderKey('') === '@im.wechat', '空 id 也走同一归一化')

  const before = enqueued.length
  await post({ bot: { id: HUB_BOT_ID }, event: { id: 's-1', data: { sender: { id: WXID }, content: '未绑定' } } })
  await sleep(40)
  ok(enqueued.length - before === 1, '未绑定消息入队一次')
  ok(enqueued[enqueued.length - 1]?.sender === WXID, '未绑定 → sender = 渠道原生合成键 <wxid>@im.wechat')

  const contact = storage
    .prepare('SELECT sender, external_id, channel FROM contacts WHERE bot_id = ? AND sender = ?')
    .get(BOT_ID, WXID)
  ok(contact?.external_id === WXID, '联系人 external_id = 原始微信外部 id（投递地址）')
  ok(contact?.channel === 'wechat', '联系人 channel = wechat')

  // 绑定身份 → sender 归一化为平台 user id
  storage
    .prepare('INSERT INTO channel_identities (id, user_id, channel, external_id, created_at) VALUES (?,?,?,?,?)')
    .run('ci-1', USER_ID, 'wechat', WXID, nowIso())
  const before2 = enqueued.length
  await post({ bot: { id: HUB_BOT_ID }, event: { id: 's-2', data: { sender: { id: WXID }, content: '已绑定' } } })
  await sleep(40)
  ok(enqueued.length - before2 === 1, '已绑定消息入队一次')
  ok(enqueued[enqueued.length - 1]?.sender === USER_ID, '已绑定 → sender = 平台 User.id（与网页端同一条会话线）')
}

// ---------- 6. 绑定码路径 ----------

console.log('== 绑定码路径 ==')
{
  const code = genWechatCode()
  ok(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(code), '生成 6 位绑定码（剔除 I/O/0/1）')

  const issued = createWechatCode(storage, USER_ID)
  ok(/^[A-Z0-9]{6}$/.test(issued.code), 'createWechatCode 落库并返回码')
  ok(issued.expiresAt.getTime() > Date.now(), '绑定码带 10 分钟有效期')

  const before = enqueued.length
  const pushBefore = pushes.length
  await post({ bot: { id: HUB_BOT_ID }, event: { id: 'b-1', data: { sender: { id: BIND_WXID }, content: `绑定 ${issued.code}` } } })
  await sleep(40)
  ok(enqueued.length === before, '命中绑定码 → 短路，不入队')
  ok(pushes.length === pushBefore + 1, '命中绑定码 → 推送一条回复')
  ok(pushes[pushes.length - 1]?.text === MSG_SUCCESS_WECHAT, '绑定成功文案逐字一致')
  ok(pushes[pushes.length - 1]?.to === BIND_WXID, '绑定回复推给原始微信外部 id')
  const identity = storage
    .prepare('SELECT user_id FROM channel_identities WHERE channel = ? AND external_id = ?')
    .get('wechat', BIND_WXID)
  ok(identity?.user_id === USER_ID, '绑定后身份归 USER_ID（换号：移除本人在该渠道的旧身份）')

  // 同一码二次使用 → 过期
  const before2 = enqueued.length
  await post({ bot: { id: HUB_BOT_ID }, event: { id: 'b-2', data: { sender: { id: BIND_WXID }, content: `绑定 ${issued.code}` } } })
  await sleep(40)
  ok(enqueued.length === before2, '重复使用绑定码 → 短路')
  ok(pushes[pushes.length - 1]?.text === MSG_EXPIRED, '重复使用绑定码 → 过期文案')

  // 身份冲突：该微信外部 id 已被别的平台账号占用
  const TAKEN_WXID = 'wxid_taken@im.wechat'
  storage
    .prepare('INSERT INTO channel_identities (id, user_id, channel, external_id, created_at) VALUES (?,?,?,?,?)')
    .run('ci-taken', OTHER_USER_ID, 'wechat', TAKEN_WXID, nowIso())
  const conflictCode = createWechatCode(storage, USER_ID).code
  await post({ bot: { id: HUB_BOT_ID }, event: { id: 'b-3', data: { sender: { id: TAKEN_WXID }, content: `绑定 ${conflictCode}` } } })
  await sleep(40)
  ok(pushes[pushes.length - 1]?.text === MSG_CONFLICT, '身份已被他人占用 → 冲突文案')

  // 限频：连续失败 5 次后进入限频
  const limiter = tryHandleBinding
  let limited = false
  for (let i = 0; i < 6; i++) {
    const r = await limiter(storage, { channel: 'wechat', externalId: 'wxid_flood@im.wechat', text: '绑定 ZZZZZZ' })
    if (r.reply === MSG_RATE) { limited = true; break }
  }
  ok(limited, '连续失败达到上限 → 限频文案')

  // 非绑定文本不短路
  const miss = await tryHandleBinding(storage, { channel: 'wechat', externalId: WXID, text: '今天天气不错' })
  ok(miss.handled === false, '非绑定文本 → handled=false（继续正常 AI 流程）')
}

// ---------- 7. iLink 会话状态存储 ----------

console.log('== iLink 会话状态存储 ==')
{
  ok(getSyncBuf(storage, BOT_ID) === '', '初始 sync_buf 为空')
  setSyncBuf(storage, BOT_ID, 'buf-1')
  ok(getSyncBuf(storage, BOT_ID) === 'buf-1', 'sync_buf 往返一致')
  setSyncBuf(storage, BOT_ID, '')
  ok(getSyncBuf(storage, BOT_ID) === 'buf-1', '空 sync_buf 不覆盖（旧语义）')

  setContextToken(storage, BOT_ID, WXID, 'ctx-1')
  ok(getContextToken(storage, BOT_ID, WXID) === 'ctx-1', 'context_token 往返一致')
  ok(getContextToken(storage, BOT_ID, '') === '', '空 sender 不返回 token')

  const state = { status: 'wait', qrImg: 'qr-1', expiresAt: Date.now() + 60_000 }
  setBindSession(storage, 'sess-1', state)
  ok(getBindSession(storage, 'sess-1')?.qrImg === 'qr-1', '绑定会话往返一致')
  setBindSession(storage, 'sess-expired', { status: 'wait', qrImg: 'q', expiresAt: Date.now() - 1 })
  ok(getBindSession(storage, 'sess-expired') === null, '过期绑定会话视为失效')
  deleteBindSession(storage, 'sess-1')
  ok(getBindSession(storage, 'sess-1') === null, '绑定会话可删除')
}

// ---------- 8. iLink 消息解析（extractText） ----------

console.log('== iLink 消息解析 ==')
{
  ok(extractText({ item_list: [{ type: 1, text_item: { text: '你好' } }] }) === '你好', '取 text_item 正文')
  ok(
    extractText({
      item_list: [
        {
          type: 1,
          text_item: { text: '回复' },
          ref_msg: { title: '标题', message_item: { type: 1, text_item: { text: '被引用' } } },
        },
      ],
    }) === '[引用: 标题 | 被引用]\n回复',
    '引用消息带前缀',
  )
  ok(extractText({ item_list: [{ type: 3, voice_item: { text: '语音转写' } }] }) === '语音转写', '语音转写兜底')
  ok(extractText({ item_list: [{ type: 2 }] }) === '', '纯图片消息无正文')
  ok(extractText({}) === '', '空消息无正文')
}

// ---------- 9. 出站投递地址解析 ----------

console.log('== 出站投递地址解析 ==')
{
  const pushed = []
  setILinkClientFactory((token, options) => ({
    loginWithQr: async () => ({ connected: false, message: 'unused' }),
    monitor: async () => {},
    push: async (to, text) => {
      pushed.push({ to, text, token, baseUrl: options.baseUrl })
      return 'client-id'
    },
    getContextToken: () => 'ctx-token',
    setContextToken: () => {},
  }))
  ok(getILinkClientFactory() !== undefined, '客户端工厂可读取（SDK 接缝）')

  const bot = botRow()
  const r1 = await pushWechatText(deps, bot, USER_ID, '回你一句')
  const authoritative = storage
    .prepare('SELECT external_id FROM channel_identities WHERE user_id = ? AND channel = ?')
    .get(USER_ID, 'wechat')
  ok(authoritative?.external_id === BIND_WXID, '换号语义：同一用户在 wechat 渠道只有一个身份')
  ok(r1 === true, '绑定用户 → 推送成功')
  ok(pushed[0]?.to === authoritative?.external_id, '绑定用户 → 解析出原始微信外部 id（ChannelIdentity 权威）')
  ok(pushed[0]?.text === '回你一句', '推送正文透传')

  const r2 = await pushWechatText(deps, bot, WXID, '直接推')
  ok(r2 === true && pushed[1]?.to === WXID, '原生合成键 → 直接作为投递地址')

  const noTokenBot = { ...bot, wx_push_token: '' }
  const r3 = await pushWechatText(deps, noTokenBot, WXID, '没 token')
  ok(r3 === false, '无 bot_token → 推送失败（旧语义：只记日志不抛异常）')

  setILinkClientFactory(null)
  const sdkFactory = createSdkILinkClientFactory({
    Client: class {
      loginWithQr() { return Promise.resolve({ connected: false, message: '' }) }
      monitor() { return Promise.resolve() }
      push() { return Promise.resolve('cid') }
      getContextToken() { return undefined }
      setContextToken() {}
    },
  })
  ok(typeof sdkFactory === 'function', '官方 SDK 模块可适配为客户端工厂')
  let sdkThrow = false
  try { createSdkILinkClientFactory({}) } catch { sdkThrow = true }
  ok(sdkThrow, '缺 Client 导出的 SDK 模块 → 明确报错')
}

// ---------- 10. 入站链路（直接调用） ----------

console.log('== 入站链路 ==')
{
  const bot = botRow()
  const before = enqueued.length
  await processWechatMessage(deps, bot, WXID, '直接调用')
  ok(enqueued.length === before + 1, 'processWechatMessage 入队一次')
  ok(enqueued[enqueued.length - 1]?.text === '直接调用', '正文透传')
}

storage.close()
rmSync(dir, { recursive: true, force: true })

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
