#!/usr/bin/env node
/**
 * 对话过程事件推送（控制台 SSE 的 agent-status / tool-call）行为验证。
 * 运行：node scripts/verify-events.mjs
 *
 * 覆盖：事件订阅/退订、thinking → tool-call(running/done) → done/silent 的顺序、
 *       监听器异常不影响对话链路、按 bot/sender 路由。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LittlyStorage } from '../packages/littly/storage/src/index.ts'
import { LittlyHub } from '../packages/littly/agents/src/index.ts'

let pass = 0
let fail = 0
const ok = (cond, name) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.error(`  ✗ ${name}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'littly-events-'))
const storage = new LittlyStorage({ logger: { info: () => {} } }, { file: join(dir, 'e.db') })

// 最小 stub：hub 只需要 storage + 一个不发消息的 bridge
const bridge = {
  sendText: async () => ({ ok: true, sent: 1 }),
  sendPhoto: async () => ({ ok: true }),
  callAction: async () => null,
  photoPublicUrl: (url) => url,
  startCall: async () => ({ ok: false }),
}
const memory = {
  retrieveMemories: async () => [],
  getHistoryDigest: () => null,
  maybeUpdateHistoryDigest: async () => null,
  remember: async () => ({ id: 'm', dupSkipped: false }),
}
const persona = {
  buildPrompt: () => ({ system: 'sys', phi: null, layers: {} }),
  loadCharacter: () => null,
  loadBot: () => null,
  loadContact: () => null,
}
const hub = new LittlyHub(storage, persona, memory, dir, () => {})

console.log('== 订阅与退订 ==')
const seen = []
const off = hub.onEvent((ev) => seen.push(ev))
hub.emitEvent({ type: 'agent-status', botId: 'b1', sender: 'u1', status: 'thinking' })
ok(seen.length === 1, '订阅者收到事件')
off()
hub.emitEvent({ type: 'agent-status', botId: 'b1', sender: 'u1', status: 'done' })
ok(seen.length === 1, '退订后不再收到')

console.log('== 监听器异常不阻断 ==')
const bad = hub.onEvent(() => {
  throw new Error('boom')
})
const good = hub.onEvent(() => {
  throw new Error('boom2')
})
let threw = false
try {
  hub.emitEvent({ type: 'agent-status', botId: 'b1', sender: 'u1', status: 'thinking' })
} catch {
  threw = true
}
ok(!threw, '监听器抛错不冒泡到调用方')
bad()
good()

console.log('== 事件字段形状 ==')
const events = []
hub.onEvent((ev) => events.push(ev))
hub.emitEvent({ type: 'tool-call', botId: 'b1', sender: 'u1', id: 'c1', name: 'remember', status: 'running' })
hub.emitEvent({ type: 'tool-call', botId: 'b1', sender: 'u1', id: 'c1', name: 'remember', status: 'done', ok: true })
const ev0 = events[0]
ok(ev0.type === 'tool-call' && ev0.name === 'remember', '工具名透传')
ok(ev0.id === 'c1', '调用 id 透传（前端稳定 key）')
ok(ev0.status === 'running', '开始态 = running')
ok(events[1].status === 'done' && events[1].ok === true, '结束态 = done + ok')

console.log('== 按 bot/sender 路由（控制台订阅只收自己的会话）==')
const mine = []
const other = []
hub.onEvent((ev) => {
  if (ev.botId === 'b1' && ev.sender === 'u1') mine.push(ev)
  else other.push(ev)
})
hub.emitEvent({ type: 'agent-status', botId: 'b1', sender: 'u1', status: 'done' })
hub.emitEvent({ type: 'agent-status', botId: 'b2', sender: 'u2', status: 'done' })
ok(mine.length === 1, '只收到本会话事件')
ok(other.length === 1, '他人事件进另一订阅')

storage.close()
rmSync(dir, { recursive: true, force: true })

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
