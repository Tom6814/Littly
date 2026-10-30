#!/usr/bin/env node
/**
 * QQ 渠道（@littly/channel-qq）行为验证。
 * 运行：node scripts/verify-channel-qq.mjs
 *
 * 全程用**依赖注入**的假传输层，不联网、不需要真实 QQ/SnowLuma/开放平台：
 *  - OneBot：替换 globalThis.WebSocket（同 lane-bridge 测试的 FakeSocket 做法）；
 *  - QQBot：注入 FakeBot SDK（loadQqbotModule）；
 *  - 入站/管理器：临时 SQLite + 假 hub，验证缓冲入队、绑定短路、@ 门、被动回复窗口。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { LittlyStorage } from '../packages/littly/storage/src/index.ts'
import { OneBotWsClient } from '../packages/littly/channel-qq/src/adapters/onebot-ws.ts'
import { SnowLumaAdapter, segmentsToText, mentionsOf, imagesOf } from '../packages/littly/channel-qq/src/adapters/snowluma.ts'
import { discoverSnowLumaEndpoint } from '../packages/littly/channel-qq/src/adapters/snowluma-discovery.ts'
import { QqbotAdapter } from '../packages/littly/channel-qq/src/adapters/qqbot.ts'
import { QqChannelManager } from '../packages/littly/channel-qq/src/manager.ts'
import { handleInboundMessage, channelMeta, shouldProcessGroupMessage } from '../packages/littly/channel-qq/src/inbound.ts'
import { maskQqLog } from '../packages/littly/console-api/src/routes-qq.ts'

let pass = 0
let fail = 0
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? `（${detail}）` : ''}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? `（${detail}）` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const dir = mkdtempSync(join(tmpdir(), 'littly-qq-'))
const storage = new LittlyStorage({ logger: { info: () => {} } }, { file: join(dir, 'qq.db') })
const nowIso = new Date().toISOString()
storage.prepare("INSERT INTO bots (id, name, created_at) VALUES ('b1','小璃',?)").run(nowIso)
storage.setSetting('platform.secret', 'qq-test-secret')

/** 模拟 OneBot 服务端的 WebSocket。 */
class FakeSocket {
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.listeners = new Map()
    this.sent = []
    this.failActions = new Set()
    setTimeout(() => { this.readyState = 1; this.fire('open', {}) }, 0)
  }
  addEventListener(name, handler) {
    if (!this.listeners.has(name)) this.listeners.set(name, [])
    this.listeners.get(name).push(handler)
  }
  fire(name, event) { for (const handler of [...(this.listeners.get(name) ?? [])]) handler(event) }
  send(raw) {
    const frame = JSON.parse(raw)
    this.sent.push(frame)
    if (this.failActions.has(frame.action)) {
      setTimeout(() => this.fire('message', { data: JSON.stringify({ status: 'failed', retcode: 1400, wording: 'bad token', echo: frame.echo }) }), 0)
      return
    }
    const data = frame.action === 'get_login_info'
      ? { user_id: 10001, nickname: '小璃' }
      : { message_id: 777, echo: frame.echo }
    setTimeout(() => this.fire('message', { data: JSON.stringify({ status: 'ok', retcode: 0, data, echo: frame.echo }) }), 0)
  }
  pushEvent(event) { this.fire('message', { data: JSON.stringify(event) }) }
  close() { this.readyState = 3; this.fire('close', { code: 1000, reason: 'test-close' }) }
}
let latestSocket = null
const makeSocket = (url) => { latestSocket = new FakeSocket(url); return latestSocket }

console.log('== OneBot v11 WS 客户端 ==')
{
  latestSocket = null
  const client = new OneBotWsClient({ url: 'ws://127.0.0.1:3001', accessToken: 'tok-1', webSocketFactory: makeSocket })
  const events = []
  client.on('event', (event) => events.push(event))
  await client.connect()
  ok(client.opened === true, 'connect() 打开连接')
  ok(latestSocket.url.includes('access_token=tok-1'), 'URL 追加 access_token')
  const info = await client.request('get_login_info', {}, { timeoutMs: 2000 })
  ok(info?.user_id === 10001, 'echo 关联：get_login_info 返回 data')
  ok(latestSocket.sent[0].action === 'get_login_info', '请求帧含 action/params/echo')
  ok(typeof latestSocket.sent[0].echo === 'string', 'echo 字符串')
  latestSocket.pushEvent({ post_type: 'message', message_type: 'private', user_id: 2, raw_message: 'hi' })
  ok(events.length === 1 && events[0].user_id === 2, '事件帧 → event 回调')
  latestSocket.failActions.add('fail')
  let rejected = ''
  try { await client.request('fail', {}, { timeoutMs: 2000 }) } catch (error) { rejected = String(error.message) }
  ok(rejected.includes('bad token'), '失败信封 → reject 带 wording')
  client.close()
  ok(client.opened === false, 'close() 置 opened=false')
}

console.log('== OneBot 段解析（SnowLuma 适配器纯函数）==')
{
  ok(segmentsToText([{ type: 'text', data: { text: '你好 ' } }, { type: 'at', data: { qq: '123', name: '小明' } }, { type: 'image', data: { url: 'http://x' } }, { type: 'face', data: { id: 1 } }]) === '你好 @小明 [图片][表情]', '段 → 文本（@/图片/表情占位）')
  ok(segmentsToText(undefined, 'raw text') === 'raw text', '无段时回退 raw_message')
  ok(segmentsToText([{ type: 'at', data: { qq: 'all' } }]) === '@全体成员', '@全体成员')
  ok(mentionsOf([{ type: 'at', data: { qq: '10001' } }], '10001').mentionsBot === true, 'at 段命中 self_id → mentionsBot')
  ok(mentionsOf([{ type: 'at', data: { qq: '999' } }], '10001').mentionsBot === false, 'at 别人 → 不算 @bot')
  ok(mentionsOf([{ type: 'reply', data: { id: 1 } }], '10001').replyToBot === true, 'reply 段 → replyToBot')
  const imgs = imagesOf([{ type: 'image', data: { url: 'https://x/1.png' } }, { type: 'image', data: { file: 'https://x/2.png' } }, { type: 'image', data: {} }])
  ok(imgs.length === 2 && imgs[0].url === 'https://x/1.png', '图片 URL 提取（url/file 两种、空丢弃）')
}

console.log('== SnowLuma 适配器（假 WS）==')
{
  const adapter = new SnowLumaAdapter({ config: { wsUrl: 'ws://127.0.0.1:3001', accessToken: 'tok' }, webSocketFactory: makeSocket })
  const messages = []
  adapter.on('message', (m) => messages.push(m))
  await adapter.start()
  await sleep(20)
  ok(adapter.status().connected === true, '适配器连接成功')
  ok(adapter.status().selfId === '10001' && adapter.status().nickname === '小璃', '连接后拉取 selfId/nickname')
  // 私聊消息
  adapter.client.socket.pushEvent({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 10001, user_id: 20002, sender: { nickname: '好友' }, raw_message: '在吗', message_id: 11 })
  await sleep(20)
  ok(messages.length === 1 && messages[0].kind === 'private' && messages[0].externalId === '20002', '私聊消息归一化')
  // 群聊 @ 消息
  adapter.client.socket.pushEvent({ post_type: 'message', message_type: 'group', self_id: 10001, group_id: 9001, user_id: 20002, sender: { card: '群友' }, message: [{ type: 'text', data: { text: '小璃 你怎么看' } }, { type: 'at', data: { qq: '10001' } }, { type: 'image', data: { url: 'https://x/a.png' } }], message_id: 12 })
  await sleep(20)
  const group = messages[1]
  ok(group?.kind === 'group' && group.externalId === '9001', '群聊消息归一化')
  ok(group?.mentionsBot === true && group.images.length === 1, '群聊 @ 判定 + 图片提取')
  // 自己发的消息忽略
  adapter.client.socket.pushEvent({ post_type: 'message', message_type: 'private', self_id: 10001, user_id: 10001, raw_message: '自己' })
  await sleep(20)
  ok(messages.length === 2, 'self_id === sender 的消息忽略')
  // 出站：私聊 & 群聊
  const sentPrivate = await adapter.send({ channel: 'snowluma', kind: 'private', externalId: '20002' }, ['甲', '乙'])
  const privateFrames = adapter.client.socket.sent.filter((f) => f.action === 'send_private_msg')
  ok(sentPrivate.length === 2 && privateFrames.length === 2 && privateFrames[0].params.user_id === 20002, '出站私聊 send_private_msg（分条）')
  await adapter.send({ channel: 'snowluma', kind: 'group', externalId: '9001' }, ['群回复'])
  ok(adapter.client.socket.sent.some((f) => f.action === 'send_group_msg' && f.params.group_id === 9001), '出站群聊 send_group_msg')
  // callAction 透传
  const action = await adapter.callAction('get_login_info', {})
  ok(action?.retcode === 0 && action.data?.user_id === 10001, 'callAction 返回 OneBot 信封')
  // 发送图片
  await adapter.sendImage({ channel: 'snowluma', kind: 'private', externalId: '20002' }, 'https://x/p.png', '看图')
  const imgFrame = adapter.client.socket.sent.filter((f) => f.action === 'send_private_msg').at(-1)
  ok(Array.isArray(imgFrame.params.message) && imgFrame.params.message[0].type === 'image', 'sendImage → image 段 + 文本段')
  await adapter.stop()
  ok(adapter.status().connected === false, 'stop() 后 disconnected')
}

console.log('== SnowLuma 自动发现 ==')
{
  const home = join(dir, 'snowluma-home')
  mkdirSync(join(home, 'config'), { recursive: true })
  writeFileSync(join(home, 'config', 'onebot_12345.json'), JSON.stringify({ networks: { wsServers: [{ host: '127.0.0.1', port: 3999, accessToken: 'discovered-token' }] } }))
  const found = discoverSnowLumaEndpoint({ homeDir: home })
  ok(found?.wsUrl === 'ws://127.0.0.1:3999' && found.accessToken === 'discovered-token' && found.uin === '12345', '从 onebot_<uin>.json 发现 wsUrl/token/uin')
  ok(discoverSnowLumaEndpoint({ homeDir: join(dir, 'nope') }) === null, '目录不存在 → null')
  const empty = join(dir, 'empty-home')
  mkdirSync(join(empty, 'config'), { recursive: true })
  ok(discoverSnowLumaEndpoint({ homeDir: empty }) === null, '无 onebot_*.json → null')
  ok(discoverSnowLumaEndpoint({ wsUrl: 'ws://127.0.0.1:3001', accessToken: 'x', homeDir: '' })?.wsUrl === 'ws://127.0.0.1:3001', '显式 wsUrl 优先')
}

console.log('== 官方 QQBot 适配器（Fake SDK）==')
{
  class FakeBot extends EventEmitter {
    constructor(options) { super(); this.options = options; this.sent = []; this.stopped = false }
    start() { return new Promise(() => {}) }
    stop() { this.stopped = true }
    async sendText(target, content) { this.sent.push({ target, content }); return { id: `sent-${this.sent.length}` } }
  }
  const makeAdapter = async (config = { appId: 'app', appSecret: 'secret' }) => {
    const adapter = new QqbotAdapter({ config, loadQqbotModule: async () => ({ QQBot: FakeBot }) })
    await adapter.start()
    await sleep(5)
    adapter.bot.emit('ready', { user: { id: 'bot-openid', username: 'bot' } })
    return adapter
  }
  const adapter = await makeAdapter()
  ok(adapter.status().connected === true && adapter.status().selfId === 'bot-openid', 'ready 事件 → connected/selfId')
  const messages = []
  adapter.on('message', (m) => messages.push(m))
  adapter.bot.emit('message', {}, { kind: 'c2c', senderId: 'u-1', senderName: 'Alice', content: '你好', messageId: 'm-1', replyTarget: { targetId: 'u-1' } })
  adapter.bot.emit('message', {}, { kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE', senderId: 'u-2', content: '<@bot-openid> 存档在哪', messageId: 'm-2', replyTarget: { targetId: 'g-1' } })
  adapter.bot.emit('message', {}, { kind: 'group', rawEventType: 'GROUP_MESSAGE_CREATE', senderId: 'u-3', content: '普通群消息', messageId: 'm-3', replyTarget: { targetId: 'g-1' } })
  adapter.bot.emit('message', {}, { kind: 'c2c', senderIsBot: true, senderId: 'bot-2', content: '机器人互发', replyTarget: { targetId: 'u-9' } })
  ok(messages.length === 3, '机器人消息/自身过滤（3 条有效）')
  ok(messages[0].kind === 'private' && messages[0].externalId === 'u-1', 'c2c 消息 → private/会话 id')
  ok(messages[1].kind === 'group' && messages[1].mentionsBot === true && messages[1].text === '存档在哪', '@ 群消息：mentionsBot + 去掉 <@id>')
  ok(messages[2].mentionsBot === false, '普通群消息不算 @bot')
  // 附件图片
  adapter.bot.emit('message', {}, { kind: 'c2c', senderId: 'u-4', content: '', messageId: 'm-4', replyTarget: { targetId: 'u-4' }, attachments: [{ url: 'https://x/1.png', content_type: 'image/png' }] })
  ok(messages[3].images.length === 1 && messages[3].text === '[图片]', '附件图片 → images + [图片] 占位')
  // 被动回复
  const passive = await adapter.send({ channel: 'qqp', kind: 'private', externalId: 'u-1', reply: true, replyToId: 'm-1' }, ['回复'])
  ok(passive.length === 1 && adapter.bot.sent[0].target.msgId === 'm-1', '被动回复带 msg_id')
  // 主动消息未允许 → 可读错误
  let activeError = ''
  try { await adapter.send({ channel: 'qqp', kind: 'private', externalId: 'u-1', reply: false }, ['主动']) } catch (error) { activeError = String(error.message) }
  ok(activeError.includes('主动消息'), '未允许主动消息 → 可读错误')
  // 被动回复最多 5 条
  const many = await adapter.send({ channel: 'qqp', kind: 'private', externalId: 'u-1', reply: true, replyToId: 'm-1' }, ['1', '2', '3', '4', '5', '6', '7'])
  ok(many.length === 5, '被动回复每条最多 5 条（超出丢弃）')
  // allowActive：主动消息放行
  const activeAdapter = await makeAdapter({ appId: 'app', appSecret: 'secret', allowActive: true })
  const active = await activeAdapter.send({ channel: 'qqp', kind: 'group', externalId: 'g-1', reply: false }, ['推送'])
  ok(active.length === 1 && activeAdapter.bot.sent[0].target.scope === 'group', 'allowActive → 主动消息放行（scope=group）')
  // 被动回复过期 → 降级主动
  activeAdapter.bot.sendText = async (target, content) => {
    if (target.msgId !== undefined) throw new Error('40034005 回复消息msg_id已过期')
    return { id: 'fallback' }
  }
  const degraded = await activeAdapter.send({ channel: 'qqp', kind: 'private', externalId: 'u-1', reply: true, replyToId: 'old' }, ['迟到回复'])
  ok(degraded.length === 1, '被动回复过期且 allowActive → 降级主动消息')
  // 未配置 appId/secret → 可读错误
  const noCfg = new QqbotAdapter({ config: {}, loadQqbotModule: async () => ({ QQBot: FakeBot }) })
  await noCfg.start()
  ok(noCfg.status().connected === false && noCfg.status().lastError.includes('appId'), '未配置 AppID/Secret → lastError 可读')
  const liveBot = adapter.bot
  await adapter.stop()
  ok(liveBot.stopped === true && adapter.bot === null, 'stop() 调用 SDK stop 并清空连接')
}

console.log('== 管理器的入站/出站/被动窗口（假 hub + 假 WS）==')
{
  storage.prepare("UPDATE bots SET snowluma_enabled=1, snowluma_ws_url='ws://127.0.0.1:3001', snowluma_token='tok', snowluma_account='10001' WHERE id='b1'").run()
  const enqueued = []
  const hub = { enqueueBufferedMessage: (input) => { enqueued.push(input); return { messageId: 'x', fireAt: nowIso } } }
  const manager = new QqChannelManager({ storage, log: () => {}, onMessage: () => {}, webSocketFactory: makeSocket })
  await manager.sync()
  await sleep(30)
  const status = manager.status()
  ok(status.snowluma.enabled === true && status.snowluma.configured === true, 'manager.status：已启用/已配置')
  ok(status.snowluma.connected === true && status.snowluma.selfId === '10001', 'manager：连接后聚合 selfId')
  ok(manager.adapterStatuses().length === 1, 'adapterStatuses：1 个适配器')
  // 入站：群聊未 @ 丢弃；@ 入缓冲
  const deps = { storage, hub, manager, log: () => {}, photoPublicUrl: (u) => u }
  const bot = storage.prepare("SELECT * FROM bots WHERE id='b1'").get()
  ok(channelMeta('snowluma').hubChannel === 'snowluma' && channelMeta('qqbot').hubChannel === 'qqp', 'channelMeta：hub channelId')
  ok(shouldProcessGroupMessage({ kind: 'group', text: '大家好' }, '') === false, '群聊未 @ → 过滤')
  await handleInboundMessage(deps, bot, 'snowluma', { channel: 'snowluma', kind: 'group', externalId: '9001', senderId: '20002', senderName: '群友', text: '大家好', images: [] })
  ok(enqueued.length === 0, '群聊未 @ → 不入缓冲')
  await handleInboundMessage(deps, bot, 'snowluma', { channel: 'snowluma', kind: 'group', externalId: '9001', senderId: '20002', senderName: '群友', text: '小璃 在吗', images: [], mentionsBot: true })
  ok(enqueued.length === 1 && enqueued[0].channelId === 'snowluma', '群聊 @ → 入缓冲（channelId=snowluma）')
  await handleInboundMessage(deps, bot, 'qqbot', { channel: 'qqbot', kind: 'private', externalId: 'openid-1', senderId: 'openid-1', senderName: 'QQ', text: 'hi', images: [] })
  ok(enqueued.length === 2 && enqueued[1].channelId === 'qqp', '官方 QQBot → 入缓冲（channelId=qqp）')
  ok(enqueued[0].sender.startsWith('qqp_'), 'sender 归一化 qqp_<uin>')
  // 联系人落库
  const privateContact = storage.prepare("SELECT external_id, channel FROM contacts WHERE bot_id='b1' AND sender=?").get(enqueued[1].sender)
  ok(privateContact?.external_id === 'openid-1' && privateContact.channel === 'qqp', '私聊联系人 upsert（external_id=openid，channel=qqp）')
  const groupContact = storage.prepare("SELECT external_id FROM contacts WHERE bot_id='b1' AND sender=?").get(enqueued[0].sender)
  ok(groupContact?.external_id === '', '群聊联系人不动 external_id（投递地址只由私聊落库）')
  // 被动回复窗口
  manager.noteInbound('b1', 'u-1', { kind: 'group', externalId: 'g-1', hubChannel: 'qqp' })
  ok(manager.lastInbound('b1', 'u-1')?.kind === 'group', 'lastInbound：回到来的地方（群）')
  ok(manager.lastInbound('b1', 'nobody') === null, 'lastInbound：未知会话 null')
  manager.recentMessageId('b1', 'qqbot', 'g-1')
  const recent = manager.recentMessageId('b1', 'snowluma', '9001')
  ok(typeof recent === 'string', 'recentMessageId 返回字符串（无则空）')
  // 出站 send（snowluma 适配器）
  const out = await manager.send('b1', 'snowluma', { channel: 'snowluma', kind: 'private', externalId: '20002' }, ['你好'])
  ok(out.ok === true && out.sent === 1, 'manager.send → SnowLuma 出站成功')
  // callAction + probe
  ok((await manager.callAction('b1', 'get_login_info', {}))?.retcode === 0, 'callAction 走 SnowLuma 适配器')
  const probe = await manager.probe('snowluma', 'b1')
  ok(probe.ok === true && probe.selfId === '10001', 'probe snowluma → get_login_info 成功')
  const probeUnknown = await manager.probe('qqbot', 'b1')
  ok(probeUnknown.ok === false && probeUnknown.error !== '', 'probe 未启用渠道 → 可读错误')
  // 日志环形缓冲
  ok(manager.logs(10).length > 0 && typeof manager.logs(10)[0].text === 'string', 'logs 环形缓冲非空')
  await manager.stopAll()
  ok(manager.adapterStatuses().length === 0, 'stopAll 清空适配器')
}

console.log('== 日志脱敏（路由层）==')
{
  const raw = 'token=abc123 access_token=xyz password: hunter2 正常日志'
  const masked = maskQqLog(raw)
  ok(!masked.includes('abc123') && !masked.includes('xyz') && !masked.includes('hunter2'), '日志中 token/secret/password 值被遮罩')
  ok(masked.includes('正常日志'), '正常日志保留')
  ok(maskQqLog('ws://127.0.0.1:3001/?access_token=secret-token').includes('access_token=***'), 'URL query 里的 access_token 遮罩')
}

storage.close()
rmSync(dir, { recursive: true, force: true })
console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
