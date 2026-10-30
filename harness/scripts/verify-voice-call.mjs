#!/usr/bin/env node
/**
 * 实时语音通话（voice-call）行为验证。
 * 运行：node scripts/verify-voice-call.mjs
 *
 * 覆盖：来电暂存（增/列/消费/TTL 过期）/ JSON 稳健提取 / 通话 system prompt 层选择
 *      （排除世界书·关系树·社交生活线，包含铁律·角色卡·当前联系人）/
 *      end_call 决策路径 / recall_context 捞回被精简的上下文 /
 *      回响总结落库（记忆 + 待办 + 审计）与 fireAt 钳制 /
 *      /call 升级路由与 WS 协议握手（ready → stop → call_end → 通话卡片落库）。
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LittlyStorage } from '../packages/littly/storage/src/index.ts'
// 记忆包的源码用了 TS 参数属性（Node 的 strip-only 模式拒绝），故这里取编译产物。
import { LittlyMemory } from '../packages/littly/memory/lib/index.js'
import {
  addPendingCall,
  consumePendingCall,
  listPendingCalls,
  PENDING_TTL_MS,
} from '../packages/littly/voice-call/src/pending.ts'
import { extractFirstJsonObject } from '../packages/littly/voice-call/src/json-extract.ts'
import {
  buildCallSystemPrompt,
  selectCallSystemParts,
  CALL_SYSTEM_LAYERS,
  CALL_EXCLUDED_LAYERS,
} from '../packages/littly/voice-call/src/call-prompt.ts'
import {
  END_CALL_TOOL,
  RECALL_CONTEXT_TOOL,
  executeRecallContext,
  isEndCallTool,
} from '../packages/littly/voice-call/src/call-tools.ts'
import { summarizeCall, clampFireAt, parseFireAt } from '../packages/littly/voice-call/src/summary.ts'
import { createVoiceCallService, CALL_PATH } from '../packages/littly/voice-call/src/call-server.ts'
import { signCallToken, verifyCallToken, CALL_TOKEN_TTL_MS } from '../packages/littly/voice-call/src/call-token.ts'
// 仓库根没有 ws 依赖；语音通话包声明了 ws@8.21.3，pnpm 会给它建这个软链。
import WebSocket from '../packages/littly/voice-call/node_modules/ws/index.js'

let pass = 0
let fail = 0
const ok = (cond, name) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.error(`  ✗ ${name}`) }
}

console.log('== 来电暂存（pending）==')
const T0 = 1_700_000_000_000
const call = addPendingCall('bot-1', 'user-1', '想你了', '最近怎么样', T0)
ok(call.botId === 'bot-1' && call.sender === 'user-1', 'addPendingCall 登记 botId/sender')
ok(call.reason === '想你了' && call.topic === '最近怎么样', 'addPendingCall 登记 reason/topic')
ok(call.createdAt === T0 && typeof call.id === 'string' && call.id.length > 0, 'addPendingCall 生成 id 与 createdAt')
ok(listPendingCalls('bot-1', T0 + 1000).length === 1, 'listPendingCalls 列出待接来电')
ok(listPendingCalls('bot-2', T0 + 1000).length === 0, 'listPendingCalls 按 botId 隔离')
const consumed = consumePendingCall(call.id)
ok(consumed?.id === call.id && consumed?.reason === '想你了', 'consumePendingCall 返回来电信息')
ok(consumePendingCall(call.id) === null, 'consumePendingCall 二次消费 → null')
addPendingCall('bot-ttl', 'u', 'r', 't', T0)
ok(listPendingCalls('bot-ttl', T0 + PENDING_TTL_MS).length === 1, 'TTL 边界内（90s）仍可领取')
ok(listPendingCalls('bot-ttl', T0 + PENDING_TTL_MS + 1).length === 0, '超过 90s TTL → 过期清理')
ok(listPendingCalls('bot-ttl', T0 + PENDING_TTL_MS + 2).length === 0, '过期项已从存储中移除')
ok(PENDING_TTL_MS === 90 * 1000, 'TTL = 90s（与旧实现一致）')

console.log('== JSON 稳健提取（extractFirstJsonObject）==')
ok(extractFirstJsonObject('{"action":"speak"}')?.['action'] === 'speak', '纯 JSON')
ok(extractFirstJsonObject('好的：{"memories":[]} 完毕')?.['memories'] !== undefined, '前后夹带文字')
ok(extractFirstJsonObject('{"a":{"b":1},"x":2}')?.['x'] === 2, '嵌套对象不被贪婪正则吞掉')
ok(extractFirstJsonObject('{"text":"含 } 的字符串","x":1}')?.['x'] === 1, '字符串里的花括号不计入深度')
ok(extractFirstJsonObject('没有 JSON') === null, '无 JSON → null')
ok(extractFirstJsonObject('{坏的 json}') === null, '坏 JSON → null')

console.log('== 通话 system prompt 层选择 ==')
const layers = {
  ironRules: '铁律正文',
  worldBefore: ['世界书前置正文'],
  character: '角色卡正文',
  baseInfo: '基础档案正文',
  growth: '成长档案正文',
  sceneLine: '场景锚定正文',
  worldbook: ['世界书命中正文'],
  contextStreamHeader: 'CONTEXT_STREAM 头正文',
  relationSkeleton: '关系树骨架正文',
  currentContact: '当前联系人正文',
  historyDigest: '最近聊到正文',
  mesExample: '示例对话正文',
  authorNote: "Author's Note 正文",
  postHistoryInstructions: '收尾约束正文',
  baseSystemPrompt: '基础设定正文',
}
const prompt = buildCallSystemPrompt(layers)
ok(prompt.includes('铁律正文'), '包含铁律层（ironRules）')
ok(prompt.includes('角色卡正文'), '包含角色卡层（character）')
ok(prompt.includes('当前联系人正文'), '包含当前联系人层（currentContact）')
ok(prompt.includes('最近聊到正文'), '包含滚动摘要层（historyDigest）')
ok(prompt.includes('CONTEXT_STREAM 头正文'), '包含 CONTEXT_STREAM 头（contextStreamHeader）')
ok(!prompt.includes('世界书前置正文'), '排除世界书·前置（worldBefore）')
ok(!prompt.includes('世界书命中正文'), '排除世界书·命中（worldbook）')
ok(!prompt.includes('关系树骨架正文'), '排除关系树骨架（relationSkeleton）')
ok(!prompt.includes('收尾约束正文'), '排除收尾槽位（postHistoryInstructions）')
ok(!prompt.includes('你的生活（自然融入，不必主动炫耀）'), '排除社交生活线（social life line）')
ok(prompt.indexOf('铁律正文') < prompt.indexOf('角色卡正文'), '层顺序：铁律 → 角色卡')
ok(prompt.indexOf('角色卡正文') < prompt.indexOf('当前联系人正文'), '层顺序：角色卡 → 当前联系人')
ok(prompt.split('\n\n---\n\n').length === 11, '11 层参与拼接（分隔符 \\n\\n---\\n\\n）')
ok(selectCallSystemParts(layers).length === 11, 'selectCallSystemParts 返回 11 层')
ok(CALL_SYSTEM_LAYERS.length === 11, 'CALL_SYSTEM_LAYERS = 11 层')
ok(CALL_EXCLUDED_LAYERS.includes('worldBefore') && CALL_EXCLUDED_LAYERS.includes('worldbook'), '排除清单含世界书两层')
ok(CALL_EXCLUDED_LAYERS.includes('relationSkeleton') && CALL_EXCLUDED_LAYERS.includes('postHistoryInstructions'), '排除清单含关系树 / 收尾槽位')
ok(!buildCallSystemPrompt({ ...layers, growth: '   ', baseInfo: undefined }).includes('成长档案正文'), '空白层被剔除')

console.log('== end_call 决策路径 ==')
ok(isEndCallTool('end_call') === true, 'end_call → 结束通话')
ok(isEndCallTool('recall_context') === false, 'recall_context → 不结束通话')
ok(isEndCallTool('recall') === false, 'recall → 不结束通话')
ok(isEndCallTool('') === false, '空工具名 → 不结束通话')
ok(END_CALL_TOOL.function.name === 'end_call', 'end_call 工具名')
ok(END_CALL_TOOL.function.parameters.required.includes('reason'), 'end_call 参数含 reason')
ok(RECALL_CONTEXT_TOOL.function.name === 'recall_context', 'recall_context 工具名')
ok(RECALL_CONTEXT_TOOL.function.parameters.required.includes('query'), 'recall_context 参数含 query')

const dir = mkdtempSync(join(tmpdir(), 'littly-voice-call-'))
const storage = new LittlyStorage({ logger: { info: () => {} } }, { file: join(dir, 'v.db') })
const nowIso = new Date().toISOString()
storage.prepare("INSERT INTO bots (id, name, created_at, ai_call_api_key) VALUES ('b1','小璃',?,'dummy-key')").run(nowIso)
storage.prepare("INSERT INTO bots (id, name, created_at) VALUES ('b2','没有通话配置',?)").run(nowIso)
storage.prepare("INSERT INTO world_entries (id, bot_id, character_id, keys, second_keys, constant, priority, enabled, content) VALUES ('w1','b1','','猫','',0,100,1,'世界上有猫')").run()
storage.prepare("INSERT INTO contact_relations (id, bot_id, from_sender, to_sender, relation, created_at) VALUES ('r1','b1','u1','u2','朋友',?)").run(nowIso)

console.log('== recall_context（捞回被精简的上下文）==')
const stubMemory = {
  retrieveMemories: async () => [{ id: 'm1', content: '他喜欢猫' }],
  findDuplicateMemory: async () => null,
  remember: async () => ({ id: 'm1', dupSkipped: false }),
}
const recallOut = await executeRecallContext({ storage, memory: stubMemory }, 'b1', 'u1', '猫')
ok(recallOut.includes('【记忆】') && recallOut.includes('他喜欢猫'), 'RAG 记忆被捞回')
ok(recallOut.includes('【世界书】') && recallOut.includes('世界上有猫'), '世界书关键词命中被捞回')
ok(recallOut.includes('【关系树】') && recallOut.includes('u1 —朋友→ u2'), '关系树被捞回')
ok(recallOut.includes('你的生活（自然融入，不必主动炫耀）'), '社交生活线被捞回')
const recallEmpty = await executeRecallContext({ storage, memory: { ...stubMemory, retrieveMemories: async () => [] } }, 'b1', 'u1', '毫不相干的词')
ok(!recallEmpty.includes('【世界书】'), '世界书未命中 → 不返回世界书块')

console.log('== 回响总结（记忆 + 待办 + 审计）==')
const llm = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            memories: [{ content: '她记得我喜欢猫', importance: 4 }, { content: '  ' }],
            todos: [{ what: '买猫粮', fireAt: '' }, { what: '下周约饭', fireAt: '2099-01-01T10:00:00+08:00' }],
          }),
        },
      }],
    }))
  })
})
await new Promise((resolve) => llm.listen(0, '127.0.0.1', resolve))
const llmPort = llm.address().port
storage.setSetting('ai.api.base_url', `http://127.0.0.1:${llmPort}/v1`)
storage.setSetting('ai.api.api_key', 'test-key')
storage.setSetting('ai.api.chat_model', 'test-model')

const memory = new LittlyMemory({ logger: { warn: () => {}, info: () => {} } }, storage)
const botRow = storage.prepare("SELECT * FROM bots WHERE id='b1'").get()
await summarizeCall({ storage, memory, log: () => {} }, botRow, 'u1', '对方: 在吗\n我: 在')
const memRows = storage.prepare("SELECT * FROM memories WHERE bot_id='b1'").all()
ok(memRows.length === 1, '回响总结 → 写入 1 条记忆（空内容被跳过）')
ok(memRows[0]?.content === '她记得我喜欢猫' && memRows[0]?.category === 'fact', '记忆内容/类别正确')
ok(memRows[0]?.importance === 4, '记忆重要度 = 4（模型给的 1-5 之间原样保留）')
const todoRows = storage.prepare("SELECT * FROM scheduled_messages WHERE bot_id='b1' ORDER BY fire_at ASC").all()
ok(todoRows.length === 2, '回响总结 → 写入 2 条待办')
ok(todoRows[0]?.prompt === '买猫粮' && todoRows[0]?.origin === 'promise' && todoRows[0]?.status === 'pending', '待办内容/来源/状态正确')
ok(todoRows[0]?.strictness === 2, '待办履约等级 = 2（中等）')
const nowMs = Date.now()
const fireAt1 = new Date(todoRows[0].fire_at).getTime()
ok(fireAt1 >= nowMs + 29 * 60 * 1000 && fireAt1 <= nowMs + 31 * 60 * 1000, '无明确时间 → 兜底 30 分钟后')
const fireAt2 = new Date(todoRows[1].fire_at).getTime()
ok(fireAt2 <= nowMs + 7 * 24 * 3600 * 1000 + 5000, '超期时间 → 钳制到 7 天内')
const auditRows = storage.prepare("SELECT * FROM audit_logs WHERE bot_id='b1'").all()
ok(auditRows.length === 1 && auditRows[0]?.category === 'heartbeat', '审计 category=heartbeat（CHECK 约束内）')
ok(auditRows[0]?.action === 'call_summary' && auditRows[0]?.detail === 'memories=1 todos=2', '审计 action=call_summary 且计数正确')

console.log('== fireAt 钳制（纯函数）==')
const base = Date.now()
ok(clampFireAt(undefined, base) === base + 30 * 60 * 1000, '缺失 fireAt → now+30min')
ok(clampFireAt('  ', base) === base + 30 * 60 * 1000, '空白 fireAt → now+30min')
ok(clampFireAt('not-a-date', base) === base + 30 * 60 * 1000, '非法 fireAt → now+30min')
ok(clampFireAt(new Date(base - 60_000).toISOString(), base) === base + 30 * 60 * 1000, '过期 fireAt → now+30min')
const soon = clampFireAt(new Date(base + 60_000).toISOString(), base)
ok(soon === base + 10 * 60 * 1000, '太近的 fireAt → 夹到 now+10min')
const far = clampFireAt(new Date(base + 30 * 24 * 3600 * 1000).toISOString(), base)
ok(far === base + 7 * 24 * 3600 * 1000, '太远的 fireAt → 夹到 now+7d')
ok(parseFireAt('2026-10-25T20:00:00') === Date.parse('2026-10-25T20:00:00+08:00'), '裸时间按 Asia/Shanghai 解释')
ok(parseFireAt('2026-10-25T20:00:00Z') === Date.parse('2026-10-25T20:00:00Z'), '带时区时间按绝对时刻解释')
ok(parseFireAt(undefined) === null, '无 fireAt → null')

console.log('== /call 升级路由与 WS 协议 ==')
const persona = {
  loadContact: () => null,
  loadRelations: () => [],
  buildPrompt: () => ({ system: '', phi: null, layers: {} }),
}
const hub = { tools: { dispatch: async () => ({ ok: true, result: '{}' }) } }
// B2：/call 握手必须先拿服务端签名的短时令牌（POST /api/call/token 下发）。
// 测试直接复用同一份 HMAC 逻辑签发。
const CALL_SECRET = 'test-call-secret-0123456789abcdef'
storage.setSetting('platform.secret', CALL_SECRET)
const tokenFor = (botId, sender, exp) => signCallToken(CALL_SECRET, { botId, sender, userId: 'user-1', ...(exp !== undefined ? { exp } : {}) })
const forgedToken = signCallToken('wrong-secret-xxxxxxxxxxxxxxxx', { botId: 'b1', sender: 'u1', userId: 'user-1' })
const service = createVoiceCallService({ storage, persona, memory: stubMemory, hub, log: () => {} })
ok(CALL_PATH === '/call', '升级路径 = /call')

console.log('== 通话令牌（B2）==')
ok(verifyCallToken(CALL_SECRET, tokenFor('b1', 'u1'))?.botId === 'b1', '令牌可验签并解出 botId')
ok(verifyCallToken(CALL_SECRET, forgedToken) === null, '错误密钥签发的令牌 → 拒绝')
ok(verifyCallToken(CALL_SECRET, tokenFor('b1', 'u1', Date.now() - 1)) === null, '过期令牌 → 拒绝')
ok(verifyCallToken('', tokenFor('b1', 'u1')) === null, '空密钥 → 拒绝')
ok(verifyCallToken(CALL_SECRET, 'garbage') === null, '坏格式令牌 → 拒绝')
ok(CALL_TOKEN_TTL_MS === 120_000, '令牌 TTL = 120s')
const httpServer = createServer((req, res) => { res.writeHead(404); res.end() })
httpServer.on('upgrade', (req, socket, head) => { service.handleUpgrade(req, socket, head) })
await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
const httpPort = httpServer.address().port

const firstMessage = (ws) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('ws 超时')), 8000)
  ws.once('message', (data) => { clearTimeout(timer); resolve(JSON.parse(data.toString())) })
  ws.once('error', (err) => { clearTimeout(timer); reject(err) })
})

// 1) 无令牌 → 鉴权失败（修复前这里能直接连上）
{
  const client = new WebSocket(`ws://127.0.0.1:${httpPort}/call?botId=b1&sender=u1`)
  const msg = await firstMessage(client)
  ok(msg.type === 'error' && msg.message.includes('通话鉴权失败'), '无令牌 → 拒绝连接（通话鉴权失败）')
  client.close()
}
// 2) 伪造签名 / 过期令牌 → 拒绝
{
  const client = new WebSocket(`ws://127.0.0.1:${httpPort}/call?token=${encodeURIComponent(forgedToken)}`)
  const msg = await firstMessage(client)
  ok(msg.type === 'error' && msg.message.includes('通话鉴权失败'), '伪造令牌 → 拒绝连接')
  client.close()
  const expired = new WebSocket(`ws://127.0.0.1:${httpPort}/call?token=${encodeURIComponent(tokenFor('b1', 'u1', Date.now() - 1000))}`)
  const msg2 = await firstMessage(expired)
  ok(msg2.type === 'error' && msg2.message.includes('通话鉴权失败'), '过期令牌 → 拒绝连接')
  expired.close()
}
// 3) 令牌与 URL 自报 botId 不一致 → 拒绝（防伪造他人身份）
{
  const client = new WebSocket(`ws://127.0.0.1:${httpPort}/call?botId=someone-else&token=${encodeURIComponent(tokenFor('b1', 'u1'))}`)
  const msg = await firstMessage(client)
  ok(msg.type === 'error' && msg.message.includes('与令牌不一致'), 'URL botId 与令牌不一致 → 拒绝')
  client.close()
}
// 4) 令牌合法但角色不存在 → 协议错误
{
  const client = new WebSocket(`ws://127.0.0.1:${httpPort}/call?token=${encodeURIComponent(tokenFor('nope', 'u1'))}`)
  const msg = await firstMessage(client)
  ok(msg.type === 'error' && msg.message === '角色不存在', '角色不存在 → {type:error, 角色不存在}')
  client.close()
}
// 5) 正常握手 → ready → stop → call_end（并落一张通话卡片）
{
  const client = new WebSocket(`ws://127.0.0.1:${httpPort}/call?token=${encodeURIComponent(tokenFor('b2', 'u1'))}`)
  const msg = await firstMessage(client)
  ok(msg.type === 'error' && msg.message.includes('Deepgram API Key 未配置'), '未配 Deepgram Key → 明确报错')
  client.close()
}
{
  const client = new WebSocket(`ws://127.0.0.1:${httpPort}/call?token=${encodeURIComponent(tokenFor('b1', 'u1'))}`)
  const ready = await firstMessage(client)
  ok(ready.type === 'ready', '握手成功 → {type:ready}')
  const ended = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws 超时')), 8000)
    client.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'call_end') { clearTimeout(timer); resolve(msg) }
    })
    client.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
  client.send(JSON.stringify({ type: 'stop' }))
  const endMsg = await ended
  ok(endMsg.type === 'call_end' && Array.isArray(endMsg.transcript), '挂断 → {type:call_end, transcript}')
  await new Promise((r) => setTimeout(r, 300))
  const cards = storage.prepare("SELECT * FROM messages WHERE reply_type='call'").all()
  ok(cards.length === 1 && String(cards[0].content).startsWith('通话时长'), '通话结束落一张「通话时长 xx」卡片')
  ok(cards[0].role === 'system' && cards[0].meta.includes('"initiator":"user"'), '卡片角色=system 且记录发起方 user')
  client.close()
}

llm.close()
httpServer.close()
storage.close()
rmSync(dir, { recursive: true, force: true })

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
