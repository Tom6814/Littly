#!/usr/bin/env node
/**
 * 心声回响（heartbeat）行为验证。
 * 运行：node scripts/verify-heartbeat.mjs
 *
 * 覆盖：退避序列 / 静默时段（Asia/Shanghai）/ 失败冷却 / JSON 稳健提取 /
 *       决策落地（speak→预约、memory→记忆、silent→只审计）/ 扫描守卫。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LittlyStorage } from '../packages/littly/storage/src/index.ts'
import {
  computeBackoff,
  executeHeartbeatAction,
  extractFirstJsonObject,
  formatSilence,
  inQuietHours,
  tickHeartbeat,
} from '../packages/littly/scheduler/src/heartbeat.ts'

let pass = 0
let fail = 0
const ok = (cond, name) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.error(`  ✗ ${name}`) }
}

console.log('== 退避序列 ==')
const b0 = computeBackoff({ proactiveSinceUser: 0, userSilenceSec: 0 })
ok(b0.backoffLevel === 0, '初始退避等级 = 0')
ok(b0.thresholdSec === 10 * 60, '基线阈值 = 10 分钟')
const b1 = computeBackoff({ proactiveSinceUser: 1, userSilenceSec: 0 })
ok(b1.thresholdSec === 20 * 60, '已发 1 条 proactive → 阈值翻倍 20 分钟')
const b2 = computeBackoff({ proactiveSinceUser: 2, userSilenceSec: 0 })
ok(b2.thresholdSec === 40 * 60, '已发 2 条 → 40 分钟')
// 用户静默每 12h 退避等级 +1
const bu = computeBackoff({ proactiveSinceUser: 0, userSilenceSec: 13 * 3600 })
ok(bu.backoffLevel === 1, '用户静默 13h → 退避等级 +1')
ok(bu.thresholdSec === 20 * 60, '用户静默 13h → 阈值 20 分钟')
// 上限随静默逐日放宽：24h 静默 → 上限 2h+2h=4h；阈值被上限夹住
const bg = computeBackoff({ proactiveSinceUser: 0, userSilenceSec: 24 * 3600 })
ok(bg.grownMaxSec === 4 * 3600, '静默 24h → 上限放宽到 4h')
const bc = computeBackoff({ proactiveSinceUser: 20, userSilenceSec: 0 })
ok(bc.thresholdSec <= 2 * 3600, '退避封顶 2h（不无限等）')
const bg2 = computeBackoff({ proactiveSinceUser: 20, userSilenceSec: 10 * 24 * 3600 })
ok(bg2.grownMaxSec === 12 * 3600, '静默 10 天 → 上限封顶 12h')

console.log('== 静默时段（Asia/Shanghai）==')
// 上海 23:00 = UTC 15:00；静默时段默认 23:00→08:00
const bot = { quiet_start: 23, quiet_end: 8 }
ok(inQuietHours(bot, new Date('2026-06-01T15:30:00Z')), '上海 23:30 在静默时段')
ok(inQuietHours(bot, new Date('2026-06-01T23:30:00Z')), '上海 07:30 在静默时段')
ok(!inQuietHours(bot, new Date('2026-06-01T05:00:00Z')), '上海 13:00 不在静默时段')
// 跨零点的时段
const wrap = { quiet_start: 2, quiet_end: 5 }
ok(inQuietHours(wrap, new Date('2026-06-01T19:00:00Z')), '跨零点时段：上海 03:00 在静默时段')
ok(!inQuietHours(wrap, new Date('2026-06-01T10:00:00Z')), '跨零点时段：上海 18:00 不在静默时段')

console.log('== JSON 稳健提取 ==')
ok(extractFirstJsonObject('{"action":"speak"}')?.['action'] === 'speak', '纯 JSON')
ok(extractFirstJsonObject('好的：{"action":"memory","content":"x"} 完毕')?.['action'] === 'memory', '前后夹带文字')
ok(extractFirstJsonObject('{"a":{"b":1},"action":"diary"}')?.['action'] === 'diary', '嵌套对象不被贪婪正则吞掉')
ok(extractFirstJsonObject('{"text":"含 } 的字符串","action":"silent"}')?.['action'] === 'silent', '字符串里的花括号不计入深度')
ok(extractFirstJsonObject('没有任何 JSON') === null, '无 JSON → null')
ok(extractFirstJsonObject('{坏的 json}') === null, '坏 JSON → null')

console.log('== 静默时长文案 ==')
ok(formatSilence(30) === '30 秒', '秒')
ok(formatSilence(120) === '2 分钟', '分钟')
ok(formatSilence(7200) === '2 小时', '小时')
ok(formatSilence(5400) === '1 小时 30 分钟', '小时+分钟')

console.log('== 决策落地（真实 SQLite）==')
const dir = mkdtempSync(join(tmpdir(), 'littly-hb-'))
const storage = new LittlyStorage({ logger: { info: () => {} } }, { file: join(dir, 'h.db') })
const remembered = []
const deps = {
  storage,
  hub: { tools: { collectTools: () => [], dispatch: async () => ({ ok: false, result: '{}' }) } },
  memory: {
    getHistoryDigest: () => null,
    remember: async (botId, sender, item) => {
      remembered.push({ botId, sender, item })
      return { id: 'mm1', dupSkipped: false }
    },
  },
  log: () => {},
}

const nowIso = new Date().toISOString()
storage.prepare("INSERT INTO bots (id, name, created_at, heartbeat_enabled, quiet_start, quiet_end) VALUES ('b1','小璃',?,1,23,8)").run(nowIso)
storage.prepare("INSERT INTO contacts (id, bot_id, sender, name, created_at, updated_at) VALUES ('c1','b1','u1','阿明',?,?)").run(nowIso, nowIso)

const botRow = storage.prepare("SELECT * FROM bots WHERE id='b1'").get()

// speak → 铸造一条 proactive 预约（origin=proactive，status=pending）
await executeHeartbeatAction(deps, {
  botId: 'b1', sender: 'u1', action: 'speak', reason: '惦记', content: '在忙吗',
  silenceSec: 900, backoffLevel: 0,
}, botRow, new Date())
const sm = storage.prepare("SELECT * FROM scheduled_messages WHERE bot_id='b1'").all()
ok(sm.length === 1, 'speak → 铸造 1 条预约')
ok(sm[0].origin === 'proactive', '预约 origin=proactive')
ok(sm[0].status === 'pending', '预约 status=pending（由 gate 放行）')
ok(sm[0].prompt === '在忙吗', '预约内容 = 决策 content')
ok(sm[0].strictness === 3, '回响预约 = 宽松履约等级 3')

// schedule → 预约落在未来，且夹在 10 分钟 ~ 7 天之间
await executeHeartbeatAction(deps, {
  botId: 'b1', sender: 'u1', action: 'schedule', reason: '等他忙完',
  content: '等他忙完这周约饭', fireAt: new Date(Date.now() - 1000).toISOString(),
  silenceSec: 900, backoffLevel: 0,
}, botRow, new Date())
const sm2 = storage.prepare("SELECT * FROM scheduled_messages WHERE bot_id='b1' ORDER BY created_at ASC").all()
ok(sm2.length === 2, 'schedule → 再铸造 1 条预约')
const fireAt = new Date(sm2[1].fire_at).getTime()
const nowMs = Date.now()
ok(fireAt >= nowMs + 9.5 * 60 * 1000, '过期的 fireAt 被夹到「至少 10 分钟后」')
ok(fireAt <= nowMs + 7 * 24 * 3600 * 1000 + 1000, 'fireAt 不超过 7 天')

// memory → 记一条 thought 记忆
await executeHeartbeatAction(deps, {
  botId: 'b1', sender: 'u1', action: 'memory', reason: '有点想念', content: '今天他没找我，我有点想他',
  silenceSec: 900, backoffLevel: 0,
}, botRow, new Date())
ok(remembered.length === 1, 'memory → 调用记忆写入')
ok(remembered[0].item.category === 'thought', '记忆类别 = thought')
ok(remembered[0].item.importance === 5, '内心反思记忆重要性 = 5')

// silent → 只审计，不产生任何副作用
const beforeCount = storage.prepare('SELECT COUNT(*) AS c FROM scheduled_messages').get().c
await executeHeartbeatAction(deps, {
  botId: 'b1', sender: 'u1', action: 'silent', reason: '没什么想说的',
  silenceSec: 900, backoffLevel: 0,
}, botRow, new Date())
ok(storage.prepare('SELECT COUNT(*) AS c FROM scheduled_messages').get().c === beforeCount, 'silent → 不产生预约')
ok(remembered.length === 1, 'silent → 不产生记忆')
const hbAudits = storage.prepare("SELECT action FROM audit_logs WHERE category='heartbeat'").all()
const hbActions = hbAudits.map((r) => r.action).sort()
ok(
  hbActions.length === 4 && ['memory', 'schedule', 'silent', 'speak'].every((a) => hbActions.includes(a)),
  `心跳审计逐条落库（speak/schedule/memory/silent）实际：${hbActions.join(',')}`,
)

console.log('== qzone 参数（B8）==')
// B8：post_qzone 的工具签名是 { text, photoIds } —— 旧实现传 { content, imageUrl }，
// 正文与配图两个字段都不被识别，空间动态必然失败。
{
  const photoId = 'photo-1'
  storage.prepare("INSERT INTO photos (id, bot_id, url, caption, tags, created_at) VALUES (?,?,?,?,?,?)")
    .run(photoId, 'b1', '/api/photos/file/photos/p1.png', '', '[]', new Date().toISOString())
  const calls = []
  const originalCollect = deps.hub.tools.collectTools
  const originalDispatch = deps.hub.tools.dispatch
  deps.hub.tools.collectTools = () => [{ type: 'function', function: { name: 'post_qzone', description: '', parameters: {} } }]
  deps.hub.tools.dispatch = async (name, args, execCtx) => { calls.push({ name, args, execCtx }); return { ok: true, result: '{}' } }
  await executeHeartbeatAction(deps, {
    botId: 'b1', sender: 'u1', action: 'qzone', reason: '想发条动态', content: '今天天气真好', photo: true,
    silenceSec: 900, backoffLevel: 0,
  }, botRow, new Date())
  ok(calls.length === 1 && calls[0].name === 'post_qzone', 'qzone 决策 → 调用 post_qzone 工具')
  ok(calls[0].args.text === '今天天气真好', 'B8：正文参数是 text（不是 content）')
  ok(Array.isArray(calls[0].args.photoIds) && calls[0].args.photoIds[0] === photoId, 'B8：配图参数是 photoIds 数组（相册照片 id）')
  ok(!('content' in calls[0].args) && !('imageUrl' in calls[0].args), 'B8：不再出现工具不认识的 content/imageUrl')
  ok(calls[0].execCtx.channelId === 'qqp', 'qzone 走 qqp 渠道上下文')

  // 无配图时只传 text
  calls.length = 0
  await executeHeartbeatAction(deps, {
    botId: 'b1', sender: 'u1', action: 'qzone', reason: '想发条动态', content: '只是想说说话',
    silenceSec: 900, backoffLevel: 0,
  }, botRow, new Date())
  ok(calls.length === 1 && !('photoIds' in calls[0].args), 'B8：无配图不传 photoIds')

  // 工具未接入 → 静默跳过并审计
  deps.hub.tools.collectTools = () => []
  calls.length = 0
  await executeHeartbeatAction(deps, {
    botId: 'b1', sender: 'u1', action: 'qzone', reason: '想发条动态', content: 'x',
    silenceSec: 900, backoffLevel: 0,
  }, botRow, new Date())
  ok(calls.length === 0, 'qzone 工具未接入 → 不派发')
  const skipAudit = storage.prepare("SELECT action FROM audit_logs WHERE category='heartbeat' AND action='qzone_skip'").get()
  ok(skipAudit?.action === 'qzone_skip', 'qzone 工具未接入 → 审计 qzone_skip')
  deps.hub.tools.collectTools = originalCollect
  deps.hub.tools.dispatch = originalDispatch
  storage.prepare('DELETE FROM photos WHERE id = ?').run(photoId)
}

console.log('== 扫描守卫 ==')
// 未开启心跳开关的 bot 不被扫描
storage.prepare("INSERT INTO bots (id, name, created_at, heartbeat_enabled) VALUES ('b2','另一个',?,0)").run(nowIso)
const res = await tickHeartbeat(deps, new Date())
ok(res.scanned === 1, '只扫描开启心跳开关的 bot（b1 有联系人，b2 无）')
ok(res.woken === 0, '未达静默阈值不唤醒')

// 从未聊过 → 不唤醒
storage.prepare("INSERT INTO bots (id, name, created_at, heartbeat_enabled) VALUES ('b3','新角色',?,1)").run(nowIso)
storage.prepare("INSERT INTO contacts (id, bot_id, sender, name, created_at, updated_at) VALUES ('c3','b3','u3',?,?,?)").run('新朋友', nowIso, nowIso)
const res2 = await tickHeartbeat(deps, new Date())
ok(res2.scanned === 2, '扫描数含新 bot 的联系人')
ok(res2.woken === 0, '从未聊过 → 不唤醒')

storage.close()
rmSync(dir, { recursive: true, force: true })

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
