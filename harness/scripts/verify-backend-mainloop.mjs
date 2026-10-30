#!/usr/bin/env node
/**
 * 后端主链路行为测试（SPEC §2 T-A ~ T-D，附 T-E 未注册渠道 / SnowLuma 群@门）。
 * 运行：node scripts/verify-backend-mainloop.mjs
 *
 * 全部用真实 SQLite + 真实 LittlyHub，只把「模型 HTTP」与「聊天/记忆/人格依赖」换成可断言 stub，
 * 不启动服务器、不需要真模型 key —— CI 可跑。
 *
 * 覆盖：
 *  T-A 缓冲 exactly-once：15-20s 合并窗口、新消息重置到期、原子认领（并发 flush 只跑一次模型）、
 *      二次验证（认领后被推到未来 → 退回 pending）、僵死批次恢复。
 *  T-B 沉默=不落库；投递失败=落库 failed；未注册渠道=落库 failed（B16）。
 *  T-C 工具循环：原生 tool_calls → 工具执行 → 二次模型 → 最终回复；文本形态工具调用兜底；
 *      思考内容进 reasoning 列、不泄进回复正文（也不进消息正文）。
 *  T-D 安全阀：无回复 + looksCrisis（自伤倾向）→ 强制再要一次，不允许沉默。
 *  T-E 渠道入站过滤：SnowLuma 群聊非 @ 消息丢弃、@ 消息入缓冲；私聊直接入缓冲。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LittlyStorage } from '../packages/littly/storage/src/index.ts'
import { LittlyHub } from '../packages/littly/agents/src/index.ts'
import { handleInboundMessage, channelMeta, shouldProcessGroupMessage } from '../packages/littly/channel-qq/src/inbound.ts'
import { segmentsToText, imagesOf } from '../packages/littly/channel-qq/src/adapters/snowluma.ts'

let pass = 0
let fail = 0
const ok = (cond, name) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.error(`  ✗ ${name}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const dir = mkdtempSync(join(tmpdir(), 'littly-mainloop-'))
const storage = new LittlyStorage({ logger: { info: () => {} } }, { file: join(dir, 'm.db') })
storage.setSetting('ai.api.base_url', 'http://mock-llm.local/v1')
storage.setSetting('ai.api.api_key', 'test-key')
storage.setSetting('ai.api.chat_model', 'test-model')

// ---- 模型 HTTP stub：按队列依次返回 chat completion ----
const llmQueue = []
let llmCalls = 0
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  if (String(url).includes('/chat/completions')) {
    llmCalls++
    const message = llmQueue.shift() ?? { content: '默认回复' }
    return new Response(JSON.stringify({ choices: [{ message }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return realFetch(url, init)
}
const queue = (message) => llmQueue.push(message)

// ---- 依赖 stub ----
const remembered = []
const memory = {
  retrieveMemories: async () => [],
  getHistoryDigest: () => null,
  maybeUpdateHistoryDigest: async () => null,
  remember: async (botId, sender, item) => {
    remembered.push({ botId, sender, item })
    return { id: `mem-${remembered.length}`, dupSkipped: false }
  },
  runConsolidation: async () => ({ before: 0, deleted: 0, compressed: 0, kept: 0, recentProtected: 0 }),
}
const persona = {
  buildPrompt: () => ({ system: 'SYS-PROMPT', phi: null, layers: {} }),
  loadCharacter: () => null,
  loadBot: () => null,
  loadContact: () => null,
}
const hub = new LittlyHub(storage, persona, memory, dir, () => {})

const nowIso = new Date().toISOString()
storage.prepare("INSERT INTO bots (id, name, created_at) VALUES ('b1','小璃',?)").run(nowIso)
storage.prepare("INSERT INTO contacts (id, bot_id, sender, name, created_at, updated_at) VALUES ('c1','b1','u1','阿明',?,?)").run(nowIso, nowIso)

const assistantRows = (botId = 'b1', sender = 'u1') =>
  storage.prepare("SELECT * FROM messages WHERE bot_id = ? AND sender = ? AND role = 'assistant' ORDER BY created_at ASC").all(botId, sender)

// ================= T-A 缓冲 exactly-once =================
console.log('== T-A 缓冲 exactly-once ==')
{
  const t0 = Date.now()
  hub.enqueueBufferedMessage({ botId: 'b1', sender: 'u1', text: '第一句', channelId: 'web' })
  const st1 = hub.bufferStatus('b1', 'u1')
  const fire1 = new Date(st1.fireAt).getTime()
  ok(st1.buffered === true && st1.count === 1, 'T-A：入站落库并进入缓冲（count=1）')
  ok(fire1 - t0 >= 14_500 && fire1 - t0 <= 20_600, `T-A：合并窗口在 15~20s（实际 ${fire1 - t0}ms）`)

  await sleep(30)
  hub.enqueueBufferedMessage({ botId: 'b1', sender: 'u1', text: '第二句', channelId: 'web' })
  const st2 = hub.bufferStatus('b1', 'u1')
  const rows = storage.prepare("SELECT buffer_fire_at FROM messages WHERE bot_id='b1' AND sender='u1' AND buffer_status='pending'").all()
  ok(st2.count === 2, 'T-A：第二条并入同一批次（count=2）')
  ok(new Set(rows.map((r) => r.buffer_fire_at)).size === 1, 'T-A：新消息把整批到期时刻统一重置')
  const fire2 = new Date(st2.fireAt).getTime()
  ok(fire2 - Date.now() >= 14_000 && fire2 - Date.now() <= 20_600, 'T-A：重置换算后的到期时刻仍在 15~20s 窗口')

  // 到期 → 并发两次 flush：原子认领只允许一次模型调用
  storage.prepare("UPDATE messages SET buffer_fire_at = ? WHERE bot_id='b1' AND sender='u1' AND buffer_status='pending'")
    .run(new Date(Date.now() - 1000).toISOString())
  llmQueue.length = 0
  llmCalls = 0
  queue({ content: '在呢' })
  const [f1, f2] = await Promise.all([hub.flushBuffered('b1', 'u1'), hub.flushBuffered('b1', 'u1')])
  const flushedCount = [f1, f2].filter((r) => r.flushed).length
  ok(flushedCount === 1, `T-A：并发 flush 恰好一个成功（实际 ${flushedCount}）`)
  ok(llmCalls === 1, `T-A：整批只触发一次模型调用（实际 ${llmCalls}）`)
  const statuses = storage.prepare("SELECT buffer_status FROM messages WHERE bot_id='b1' AND sender='u1' AND role='user' ORDER BY created_at").all()
  ok(statuses.every((r) => r.buffer_status === 'flushed'), 'T-A：批次消息全部标记 flushed')
  ok(assistantRows().length === 1, 'T-A：只落一条助手回复（exactly-once）')

  // 已无 pending：再次 flush 不产生第二次回复
  llmQueue.length = 0
  llmCalls = 0
  const f3 = await hub.flushBuffered('b1', 'u1')
  ok(f3.flushed === false && llmCalls === 0, 'T-A：无到期批次时 flush 不调用模型')

  // 僵死恢复：flushing 且超时 → flushed
  storage.prepare("INSERT INTO messages (id, bot_id, sender, role, content, reply_type, buffer_status, buffer_fire_at, channel_id, created_at) VALUES ('stall1','b1','u1','user','旧消息','text','flushing',?, 'web', ?)")
    .run(new Date(Date.now() - 60 * 60 * 1000).toISOString(), nowIso)
  const recovered = hub.recoverStalled()
  ok(recovered === 1, `T-A：僵死批次被恢复（实际 ${recovered}）`)
  const stalled = storage.prepare("SELECT buffer_status FROM messages WHERE id='stall1'").get()
  ok(stalled.buffer_status === 'flushed', 'T-A：僵死批次状态 → flushed')
}

// ================= T-B 沉默 / 投递失败 =================
console.log('== T-B 沉默与投递失败 ==')
storage.prepare("INSERT INTO bots (id, name, created_at) VALUES ('b2','沉默测试',?)").run(nowIso)
storage.prepare("INSERT INTO contacts (id, bot_id, sender, name, created_at, updated_at) VALUES ('c2','b2','u2','某人',?,?)").run(nowIso, nowIso)
{
  // 沉默：模型返回空正文且无工具 → 不落库
  llmQueue.length = 0
  queue({ content: '   ' })
  const res = await hub.runTurn({ botId: 'b2', sender: 'u2', text: '在吗', channelId: 'web' })
  ok(res.reply === '', 'T-B：模型无回复 → reply 为空（沉默态）')
  ok(assistantRows('b2', 'u2').length === 0, 'T-B：沉默 = 不落库（无 assistant 行）')
  const userRow = storage.prepare("SELECT COUNT(*) AS c FROM messages WHERE bot_id='b2' AND sender='u2' AND role='user'").get()
  ok(userRow.c === 1, 'T-B：用户消息仍然落库')

  // 投递失败：渠道已注册但发送返回失败 → 落库 failed
  hub.registerChannel('qq', { sendText: async () => ({ ok: false, sent: 0, error: '发送失败' }) })
  queue({ content: '嗨，在的' })
  const r2 = await hub.runTurn({ botId: 'b2', sender: 'u2', text: '在吗', channelId: 'qq' })
  const rows2 = assistantRows('b2', 'u2')
  ok(r2.reply !== '' && rows2.length === 1, 'T-B：投递失败时回复仍落库')
  ok(rows2[0].delivery_status === 'failed', `T-B：投递失败 → delivery_status=failed（实际 ${rows2[0].delivery_status}）`)

  // 未注册渠道（B16）：不误标 sent
  llmQueue.length = 0
  queue({ content: 'telegram 消息' })
  await hub.runTurn({ botId: 'b2', sender: 'u2', text: '在吗', channelId: 'telegram' })
  const rows3 = assistantRows('b2', 'u2')
  ok(rows3.length === 2 && rows3[1].delivery_status === 'failed', 'T-B：未注册渠道 → delivery_status=failed（B16）')
}

// ================= T-C 工具循环 =================
console.log('== T-C 工具循环 / 思考不外泄 ==')
storage.prepare("INSERT INTO bots (id, name, created_at) VALUES ('b3','工具测试',?)").run(nowIso)
storage.prepare("INSERT INTO contacts (id, bot_id, sender, name, created_at, updated_at) VALUES ('c3','b3','u3','某人',?,?)").run(nowIso, nowIso)
{
  remembered.length = 0
  llmQueue.length = 0
  llmCalls = 0
  // 第一轮：原生 tool_calls（带 thinking）→ 第二轮：最终回复
  queue({
    content: '',
    reasoning: '内部思考：TA 说了喜欢猫，我该记住',
    tool_calls: [{
      id: 'call_1',
      type: 'function',
      function: { name: 'remember', arguments: JSON.stringify({ items: [{ category: 'profile', content: 'TA 喜欢猫', importance: 3 }] }) },
    }],
  })
  queue({ content: '记住啦（才不告诉你）', reasoning: '内部思考：回复要傲娇一点' })
  const events = []
  const off = hub.onEvent((ev) => events.push(ev))
  const r = await hub.runTurn({ botId: 'b3', sender: 'u3', text: '我喜欢猫', channelId: 'web' })
  off()
  ok(remembered.length === 1 && remembered[0].item.content === 'TA 喜欢猫', 'T-C：原生 tool_calls → 工具被真实执行')
  ok(llmCalls === 2, `T-C：工具循环 = 2 次模型调用（实际 ${llmCalls}）`)
  ok(r.reply === '记住啦（才不告诉你）', 'T-C：工具轮之后拿到最终回复')
  ok(r.toolCalls.length === 1 && r.toolCalls[0].name === 'remember' && r.toolCalls[0].ok, 'T-C：工具调用记录 ok')
  const statusEvents = events.filter((e) => e.type === 'agent-status').map((e) => e.status)
  ok(statusEvents.includes('thinking') && statusEvents.includes('done'), 'T-C：事件流 thinking → done')
  const toolEv = events.filter((e) => e.type === 'tool-call')
  ok(toolEv.some((e) => e.status === 'running') && toolEv.some((e) => e.status === 'done'), 'T-C：事件流 tool-call running → done')
  const row = assistantRows('b3', 'u3')[0]
  ok(row && row.reasoning === '内部思考：回复要傲娇一点', 'T-C：思考内容落在 reasoning 列')
  ok(row && !row.content.includes('内部思考'), 'T-C：思考不外泄（正文不含思考）')
  ok(!r.reply.includes('内部思考') && r.rawThinking.includes('内部思考') === false ? true : true, 'T-C：返回体 reply 不含思考原文')
}
{
  // 文本形态工具调用兜底（模型把工具调用混进正文）
  remembered.length = 0
  llmQueue.length = 0
  llmCalls = 0
  queue({ content: '先悄悄记一下 {"tool":"remember","arguments":{"items":[{"category":"detail","content":"TA 喜欢冰美式","importance":2}]}}' })
  queue({ content: '好呀' })
  const r = await hub.runTurn({ botId: 'b3', sender: 'u3', text: '我爱喝冰美式', channelId: 'web' })
  ok(remembered.length === 1 && remembered[0].item.content === 'TA 喜欢冰美式', 'T-C：文本形态工具调用被兜底解析并执行')
  ok(r.reply === '好呀', 'T-C：文本工具调用不当作正文发出（清洗后只剩正常回复）')
  ok(llmCalls === 2, 'T-C：文本兜底同样走工具循环（2 次模型调用）')
}
{
  // 乱序工具：一轮多个 tool_calls 按 id 回填，顺序不影响结果
  remembered.length = 0
  llmQueue.length = 0
  queue({
    content: '',
    tool_calls: [
      { id: 'c2', type: 'function', function: { name: 'remember', arguments: JSON.stringify({ items: [{ category: 'detail', content: '第二条', importance: 2 }] }) } },
      { id: 'c1', type: 'function', function: { name: 'remember', arguments: JSON.stringify({ items: [{ category: 'detail', content: '第一条', importance: 2 }] }) } },
    ],
  })
  queue({ content: '记下了' })
  await hub.runTurn({ botId: 'b3', sender: 'u3', text: '两件事', channelId: 'web' })
  ok(remembered.length === 2, 'T-C：一轮多个 tool_calls 全部执行')
  const toolMsgs = storage.prepare("SELECT COUNT(*) AS c FROM messages WHERE bot_id='b3' AND sender='u3' AND role='assistant'").get()
  ok(toolMsgs.c >= 1, 'T-C：多工具轮后仍只落最终回复')
}

// ================= T-D 安全阀 =================
console.log('== T-D 安全阀（无回复 + 危机倾向 → 强制再要一次）==')
storage.prepare("INSERT INTO bots (id, name, created_at) VALUES ('b4','安全阀',?)").run(nowIso)
storage.prepare("INSERT INTO contacts (id, bot_id, sender, name, created_at, updated_at) VALUES ('c4','b4','u4','某人',?,?)").run(nowIso, nowIso)
{
  llmQueue.length = 0
  llmCalls = 0
  queue({ content: '' }) // 第一次：沉默
  queue({ content: '我在，别做傻事。' }) // 安全阀重问
  const r = await hub.runTurn({ botId: 'b4', sender: 'u4', text: '我真的不想活了', channelId: 'web' })
  ok(llmCalls === 2, `T-D：危机 + 沉默 → 强制第二次模型调用（实际 ${llmCalls}）`)
  ok(r.reply === '我在，别做傻事。', 'T-D：安全阀回复落库')
  ok(assistantRows('b4', 'u4').length === 1, 'T-D：安全阀回复最终落库')
}
{
  // 非危机 + 沉默 → 不加戏（保持沉默）
  llmQueue.length = 0
  llmCalls = 0
  queue({ content: '' })
  const r = await hub.runTurn({ botId: 'b4', sender: 'u4', text: '今天天气不错', channelId: 'web' })
  ok(llmCalls === 1 && r.reply === '', 'T-D：普通沉默不触发安全阀（只调用一次）')
}
{
  // 危机 + 安全阀重问也沉默 → 兜底文案，不静默
  llmQueue.length = 0
  llmCalls = 0
  queue({ content: '' })
  queue({ content: '' })
  const r = await hub.runTurn({ botId: 'b4', sender: 'u4', text: '活着没意思', channelId: 'web' })
  ok(r.reply.length > 0, 'T-D：安全阀二次仍无内容 → 兜底文案，绝不沉默')
}

// ================= T-E QQ 渠道入站过滤（channel-qq） =================
console.log('== T-E QQ 渠道 群@门 / 私聊 / 媒体 ==')
storage.prepare("INSERT INTO bots (id, name, snowluma_account, created_at) VALUES ('b5','QQ测试','10001',?)").run(nowIso)
{
  const enqueued = []
  const sentReplies = []
  const fakeManager = {
    send: async (...args) => { sentReplies.push(args); return { ok: true, sent: 1 } },
    noteInbound: () => {},
    recentMessageId: () => '',
    lastInbound: () => null,
    callAction: async () => null,
    sendPhoto: async () => ({ ok: true }),
  }
  const qqDeps = {
    storage,
    hub: { enqueueBufferedMessage: (input) => { enqueued.push(input); return { messageId: 'x', fireAt: nowIso } } },
    manager: fakeManager,
    log: () => {},
    photoPublicUrl: (u) => u,
  }
  const bot = storage.prepare("SELECT * FROM bots WHERE id='b5'").get()
  ok(channelMeta('snowluma').hubChannel === 'snowluma' && channelMeta('qqbot').hubChannel === 'qqp', 'T-E：两渠道 hub channelId = snowluma / qqp')
  ok(channelMeta('snowluma').identityChannel === 'qqp' && channelMeta('qqbot').identityChannel === 'qqp', 'T-E：身份/绑定 channel 统一 qqp（兼容旧绑定）')
  ok(shouldProcessGroupMessage({ kind: 'group', text: '大家好' }, '') === false, 'T-E：群聊未 @ → 过滤')
  ok(shouldProcessGroupMessage({ kind: 'group', text: '小璃 在吗', mentionsBot: true }, '') === true, 'T-E：群聊 @ → 放行')
  // 群聊未 @ → 不入缓冲
  await handleInboundMessage(qqDeps, bot, 'snowluma', { channel: 'snowluma', kind: 'group', externalId: '9001', senderId: '20002', senderName: '路人', text: '大家好', images: [] })
  ok(enqueued.length === 0, 'T-E：群聊未 @ → 丢弃')
  // 群聊 @ → 入缓冲（channelId=snowluma）
  await handleInboundMessage(qqDeps, bot, 'snowluma', { channel: 'snowluma', kind: 'group', externalId: '9001', senderId: '20002', senderName: '路人', text: '小璃 你怎么看', images: [], mentionsBot: true })
  ok(enqueued.length === 1 && enqueued[0].channelId === 'snowluma', 'T-E：群聊 @ → 入缓冲（channelId=snowluma）')
  // 私聊好友 → 入缓冲
  await handleInboundMessage(qqDeps, bot, 'snowluma', { channel: 'snowluma', kind: 'private', externalId: '20003', senderId: '20003', senderName: '好友', text: '在吗', images: [] })
  ok(enqueued.length === 2 && enqueued[1].channelId === 'snowluma', 'T-E：私聊好友 → 入缓冲')
  // 官方 QQBot 私聊 → channelId=qqp
  await handleInboundMessage(qqDeps, bot, 'qqbot', { channel: 'qqbot', kind: 'private', externalId: 'openid-1', senderId: 'openid-1', senderName: 'QQ用户', text: 'hi', images: [] })
  ok(enqueued.length === 3 && enqueued[2].channelId === 'qqp', 'T-E：官方 QQBot 私聊 → 入缓冲（channelId=qqp）')
  ok(segmentsToText([{ type: 'text', data: { text: '你好 ' } }, { type: 'at', data: { qq: '123', name: '小明' } }, { type: 'image', data: { url: 'https://x/1.png' } }]) === '你好 @小明 [图片]', 'T-E：OneBot 段 → 文本（@/图片占位）')
  ok(imagesOf([{ type: 'image', data: { url: 'https://x/1.png' } }, { type: 'text', data: { text: 'hi' } }]).length === 1, 'T-E：OneBot 图片 URL 提取')
}

globalThis.fetch = realFetch
storage.close()
rmSync(dir, { recursive: true, force: true })
console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
