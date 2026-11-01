#!/usr/bin/env node
/**
 * 心声回响（heartbeat）行为验证。
 * 运行：node scripts/verify-heartbeat.mjs
 *
 * 覆盖：退避序列（按唤醒/决策尝试计数）/ 静默时段（Asia/Shanghai）/ JSON 稳健提取 /
 *       决策落地（speak→预约、schedule→随机区间、memory→记忆、silent→只审计）/
 *       未回硬停（连续 4 条无回复 → skip + audit）/ 最小间隔随机延后 / 扫描守卫。
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
  isBackoffElapsed,
  tickHeartbeat,
} from '../packages/littly/scheduler/src/heartbeat.ts'
import {
  evaluateProactiveGate,
  processScheduledMessages,
} from '../packages/littly/scheduler/src/scheduled.ts'
import {
  HEARTBEAT_WAKE_COOLDOWN_SEC,
  PROACTIVE_MAX_UNANSWERED,
  computeProactiveDelaySec,
  countUnansweredProactive,
  heartbeatDetail,
  proactiveJitterRange,
  readWakeAttempts,
} from '../packages/littly/scheduler/src/proactive.ts'

let pass = 0
let fail = 0
const ok = (cond, name) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.error(`  ✗ ${name}`) }
}

console.log('== 退避序列（按唤醒/决策尝试次数）==')
const b0 = computeBackoff({ attemptsSinceUser: 0, userSilenceSec: 0 })
ok(b0.backoffLevel === 0, '初始退避等级 = 0')
ok(b0.thresholdSec === 10 * 60, '基线阈值 = 10 分钟')
const b1 = computeBackoff({ attemptsSinceUser: 1, userSilenceSec: 0 })
ok(b1.thresholdSec === 20 * 60, '1 次决策 → 阈值翻倍 20 分钟')
const b2 = computeBackoff({ attemptsSinceUser: 2, userSilenceSec: 0 })
ok(b2.thresholdSec === 40 * 60, '2 次决策 → 40 分钟')
// silent / gate-cancelled 也算决策：3 次尝试 → 80 分钟（旧实现只数 sent，会停在 10 分钟）
const b3 = computeBackoff({ attemptsSinceUser: 3, userSilenceSec: 0 })
ok(b3.thresholdSec === 80 * 60, '3 次决策（含 silent/取消）→ 80 分钟')
// 用户静默每 12h 退避等级 +1
const bu = computeBackoff({ attemptsSinceUser: 0, userSilenceSec: 13 * 3600 })
ok(bu.backoffLevel === 1, '用户静默 13h → 退避等级 +1')
ok(bu.thresholdSec === 20 * 60, '用户静默 13h → 阈值 20 分钟')
// 上限随静默逐日放宽：24h 静默 → 上限 2h+2h=4h；阈值被上限夹住
const bg = computeBackoff({ attemptsSinceUser: 0, userSilenceSec: 24 * 3600 })
ok(bg.grownMaxSec === 4 * 3600, '静默 24h → 上限放宽到 4h')
const bc = computeBackoff({ attemptsSinceUser: 20, userSilenceSec: 0 })
ok(bc.thresholdSec <= 2 * 3600, '退避封顶 2h（不无限等）')
const bg2 = computeBackoff({ attemptsSinceUser: 20, userSilenceSec: 10 * 24 * 3600 })
ok(bg2.grownMaxSec === 12 * 3600, '静默 10 天 → 上限封顶 12h')

console.log('== 退避闸门（距上次唤醒的间隔，不是总静默）==')
// P0：阈值封顶后，如果拿「总静默 ≥ 阈值」判断，总静默永远更大 → 每个 60s tick 都空转。
const capped = computeBackoff({ attemptsSinceUser: 12, userSilenceSec: 3 * 3600 })
ok(capped.thresholdSec === 2 * 3600, '多次尝试 + 3h 静默 → 阈值封顶 2h')
ok(
  !isBackoffElapsed({ sinceLastWakeSec: 60, thresholdSec: capped.thresholdSec }),
  '上次唤醒 60s 后不再唤醒（修复旧实现的 60s 空转）',
)
ok(!isBackoffElapsed({ sinceLastWakeSec: 2 * 3600 - 1, thresholdSec: capped.thresholdSec }), '距上次唤醒未满 2h 不唤醒')
ok(isBackoffElapsed({ sinceLastWakeSec: 2 * 3600, thresholdSec: capped.thresholdSec }), '距上次唤醒满 2h 才再次唤醒')
ok(isBackoffElapsed({ sinceLastWakeSec: 10 * 60, thresholdSec: 10 * 60 }), '首轮：静默 10 分钟达到基线')

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
let hubCalls = 0
const deps = {
  storage,
  hub: {
    tools: { collectTools: () => [], dispatch: async () => ({ ok: false, result: '{}' }) },
    // 主动消息被 gate 拦下时不应走到生成；计数用于断言「硬停不调模型」。
    runTurn: async () => {
      hubCalls++
      return { reply: '不该被生成', toolCalls: [] }
    },
  },
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

// schedule → 时刻不再采用模型给的 fireAt：在 [min, 3×min（≤12h）] 内随机并落库。
// bot 默认 proactive_min_interval=7200 → [2h, 6h]；注入 rng 让断言可复现。
const scheduleNow = new Date()
deps.rng = () => 0.5
await executeHeartbeatAction(deps, {
  botId: 'b1', sender: 'u1', action: 'schedule', reason: '等他忙完',
  content: '等他忙完这周约饭', fireAt: new Date(scheduleNow.getTime() - 1000).toISOString(),
  silenceSec: 900, backoffLevel: 0,
}, botRow, scheduleNow)
const sm2 = storage.prepare("SELECT * FROM scheduled_messages WHERE bot_id='b1' ORDER BY rowid ASC").all()
ok(sm2.length === 2, 'schedule → 再铸造 1 条预约')
const scheduleFireAt = new Date(sm2[1].fire_at).getTime()
const scheduleDelaySec = (scheduleFireAt - scheduleNow.getTime()) / 1000
ok(scheduleDelaySec === 4 * 3600, 'schedule 随机排期：rng=0.5 → 2h + 0.5×(6h-2h) = 4h')
ok(scheduleDelaySec >= 2 * 3600 && scheduleDelaySec <= 6 * 3600, 'schedule 落库时刻在 [min,max] 内')
// 同一动作换一个 rng → 不同时刻（不是固定整点）
scheduleNow.setSeconds(scheduleNow.getSeconds() + 1)
deps.rng = () => 0
await executeHeartbeatAction(deps, {
  botId: 'b1', sender: 'u1', action: 'schedule', reason: '再约一次', content: '再过一会儿问问',
  silenceSec: 900, backoffLevel: 0,
}, botRow, scheduleNow)
const sm3 = storage.prepare("SELECT * FROM scheduled_messages WHERE bot_id='b1' ORDER BY rowid ASC").all()
const delay2 = (new Date(sm3[2].fire_at).getTime() - scheduleNow.getTime()) / 1000
ok(delay2 === 2 * 3600, 'schedule 随机排期：rng=0 → 取下界 min=2h')
ok(new Date(sm3[2].fire_at).getTime() !== scheduleFireAt, '两次生成排期的 fire_at 不同（随机、非固定节奏）')
ok(sm3[2].origin === 'proactive' && sm3[2].status === 'pending', '随机排期仍走原状态机（proactive/pending）')

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
  hbActions.length === 5 && ['memory', 'schedule', 'schedule', 'silent', 'speak'].every((a, i) => hbActions[i] === a),
  `心跳审计逐条落库（speak/schedule×2/memory/silent）实际：${hbActions.join(',')}`,
)

console.log('== 唤醒尝试计数（P0 修复：silent / gate-cancelled 也退避）==')
// 决策尝试按 audit action='decision' 统计；silent / gate-cancelled 的决策都会先落一条。
let auditSeq = 0
const insertAudit = (botId, action, detail, at) => {
  auditSeq++
  storage
    .prepare("INSERT INTO audit_logs (id, bot_id, category, action, detail, created_at) VALUES (?,?,'heartbeat',?,?,?)")
    .run(`va-${auditSeq}`, botId, action, detail, at.toISOString())
}
const tSilent = new Date('2026-05-01T12:00:00.000Z')
const tCancelled = new Date('2026-05-01T12:10:00.000Z')
const tUserReply = new Date('2026-05-01T12:30:00.000Z')
insertAudit('b1', 'decision', heartbeatDetail('u1', { silence: 600, level: 0, decision: 'silent' }), tSilent)
insertAudit('b1', 'decision', heartbeatDetail('u1', { silence: 1200, level: 1, decision: 'speak-cancelled' }), tCancelled)
insertAudit('b1', 'decision', heartbeatDetail('u1x', { silence: 1200, level: 1 }), tCancelled) // 前缀不同号
insertAudit('b1', 'silent', 'silence=600s level=0 reason=无话', tCancelled)
insertAudit('b1', 'speak', 'silence=600s level=0 reason=想她', tCancelled)
const wake = readWakeAttempts(storage, 'b1', 'u1', null)
ok(wake.attempts === 2, `silent + gate-cancelled 两次决策都计入尝试（实际 ${wake.attempts}）`)
ok(wake.lastAt === tCancelled.toISOString(), '最近决策时间取第二次决策（供短冷却判断）')
ok(HEARTBEAT_WAKE_COOLDOWN_SEC === 5 * 60, '唤醒短冷却 = 5 分钟（防 60s tick 抖动）')
const backoffFromAttempts = computeBackoff({ attemptsSinceUser: wake.attempts, userSilenceSec: 0 })
ok(backoffFromAttempts.thresholdSec === 40 * 60, '按 2 次尝试重算 → 阈值 40 分钟（旧实现只会停在 10 分钟）')
ok(readWakeAttempts(storage, 'b1', 'u1', tUserReply.toISOString()).attempts === 0, '用户发言窗口之后的尝试数归零')

console.log('== 随机排期区间（避免整点/固定节拍）==')
const rangeDefault = proactiveJitterRange(0)
ok(rangeDefault.minSec === 2 * 3600 && rangeDefault.maxSec === 6 * 3600, '≤0 → 2h 兜底，max = 3×min = 6h')
ok(proactiveJitterRange(7200).minSec === 2 * 3600, 'min = bot.proactive_min_interval（默认 7200s）')
const range7h = proactiveJitterRange(7 * 3600)
ok(range7h.minSec === 7 * 3600 && range7h.maxSec === 12 * 3600, '7h → max 被 12h 硬顶夹住')
const range20h = proactiveJitterRange(20 * 3600)
ok(range20h.maxSec >= range20h.minSec, 'min 超过 12h 时 max ≥ min（区间不反转）')
ok(computeProactiveDelaySec(7200, () => 0).delaySec === 2 * 3600, 'rng=0 → 取下界 min')
ok(computeProactiveDelaySec(7200, () => 0.5).delaySec === 4 * 3600, 'rng=0.5 → 区间中点')
const upper = computeProactiveDelaySec(7200, () => 1).delaySec
ok(upper === 6 * 3600, 'rng=1 → 取上界 max')
const samples = Array.from({ length: 200 }, () => computeProactiveDelaySec(7200).delaySec)
ok(samples.every((v) => v >= 2 * 3600 && v <= 6 * 3600), '200 次采样全部落在 [min,max]')
ok(new Set(samples).size > 50, '采样不是固定值（随机抖动生效）')

console.log('== 未回硬停（连续 N 条主动消息无回复）==')
// 隔离 b1 的 pending 排期到远未来：下面用固定日期驱动 gate，避免真实时钟让 b1 的行提前到期。
storage.prepare("UPDATE scheduled_messages SET fire_at = '2099-01-01T00:00:00.000Z' WHERE bot_id = 'b1' AND status = 'pending'").run()
const capNow = new Date('2026-05-02T12:00:00.000Z')
const capUserAt = new Date(capNow.getTime() - 5 * 3600 * 1000)
storage.prepare("INSERT INTO bots (id, name, created_at, proactive_min_interval) VALUES ('b4','硬停',?,60)").run(nowIso)
storage.prepare("INSERT INTO contacts (id, bot_id, sender, name, created_at, updated_at) VALUES ('c4','b4','u4','阿四',?,?)").run(nowIso, nowIso)
storage.prepare("INSERT INTO messages (id, bot_id, sender, role, content, created_at) VALUES ('m4','b4','u4','user','在吗',?)").run(capUserAt.toISOString())
for (let i = 0; i < PROACTIVE_MAX_UNANSWERED; i++) {
  const firedAt = new Date(capNow.getTime() - (i + 1) * 3600 * 1000).toISOString()
  storage.prepare(
    "INSERT INTO scheduled_messages (id, bot_id, sender, fire_at, strictness, prompt, origin, status, created_at, fired_at) VALUES (?, 'b4','u4', ?, 3, '主动', 'proactive', 'sent', ?, ?)",
  ).run(`sm4-sent-${i}`, firedAt, nowIso, firedAt)
}
storage.prepare(
  "INSERT INTO scheduled_messages (id, bot_id, sender, fire_at, strictness, prompt, origin, status, created_at) VALUES ('sm4-due','b4','u4',?,3,'该被硬停','proactive','pending',?)",
).run(capNow.toISOString(), nowIso)
const bot4 = storage.prepare("SELECT * FROM bots WHERE id='b4'").get()
ok(
  countUnansweredProactive(storage, 'b4', 'u4', capUserAt.toISOString()) === PROACTIVE_MAX_UNANSWERED,
  `最后一条用户消息之后有 ${PROACTIVE_MAX_UNANSWERED} 条已发主动消息`,
)
const capGate = evaluateProactiveGate(storage, bot4, { sender: 'u4' }, capNow)
ok(capGate?.code === 'unanswered_cap', '达到 N 条 → gate 返回 unanswered_cap')
const beforeHub = hubCalls
const capFired = await processScheduledMessages(deps, capNow)
const capTick = capFired.find((r) => r.id === 'sm4-due')
ok(capTick?.status === 'cancelled', '硬停：到期 proactive 被 skip（cancelled）')
ok(hubCalls === beforeHub, '硬停：不调用 hub.runTurn（不烧模型）')
ok(
  storage.prepare("SELECT status FROM scheduled_messages WHERE id='sm4-due'").get().status === 'cancelled',
  '硬停：落库 status=cancelled',
)
const capAudit = storage.prepare("SELECT detail FROM audit_logs WHERE category='proactive_gate' AND action='unanswered_cap'").get()
ok(capAudit?.detail.includes('sm4-due'), '硬停：审计 action=unanswered_cap 且带预约 id')
// 用户再开口 → 窗口左移，计数归零、硬停自动解除
storage.prepare("INSERT INTO messages (id, bot_id, sender, role, content, created_at) VALUES ('m4b','b4','u4','user','我回来了',?)").run(capNow.toISOString())
ok(countUnansweredProactive(storage, 'b4', 'u4', capNow.toISOString()) === 0, '用户发言后未回计数自然归零')
ok(
  evaluateProactiveGate(storage, bot4, { sender: 'u4' }, new Date(capNow.getTime() + 60 * 1000)) === null,
  '用户发言后 gate 恢复放行（硬停自动解除）',
)

console.log('== 最小间隔：随机延后而不是取消（scheduled.ts）==')
const deferNow = new Date('2026-05-03T12:00:00.000Z')
const lastSentAt = new Date(deferNow.getTime() - 60 * 1000)
storage.prepare("INSERT INTO bots (id, name, created_at, proactive_min_interval) VALUES ('b6','抖动',?,7200)").run(nowIso)
storage.prepare("INSERT INTO contacts (id, bot_id, sender, name, created_at, updated_at) VALUES ('c6','b6','u6','小六',?,?)").run(nowIso, nowIso)
storage.prepare(
  "INSERT INTO scheduled_messages (id, bot_id, sender, fire_at, strictness, prompt, origin, status, created_at, fired_at) VALUES ('sm6-last','b6','u6',?,3,'上一次','proactive','sent',?,?)",
).run(lastSentAt.toISOString(), nowIso, lastSentAt.toISOString())
storage.prepare(
  "INSERT INTO scheduled_messages (id, bot_id, sender, fire_at, strictness, prompt, origin, status, created_at) VALUES ('sm6-due','b6','u6',?,3,'太早了','proactive','pending',?)",
).run(deferNow.toISOString(), nowIso)
const bot6 = storage.prepare("SELECT * FROM bots WHERE id='b6'").get()
ok(evaluateProactiveGate(storage, bot6, { sender: 'u6' }, deferNow)?.code === 'min_interval', '距上次不足最小间隔 → gate 返回 min_interval')
deps.rng = () => 0.5
const deferFired = await processScheduledMessages(deps, deferNow)
const deferRow = storage.prepare("SELECT * FROM scheduled_messages WHERE id='sm6-due'").get()
ok(deferFired.find((r) => r.id === 'sm6-due')?.status === 'deferred', '最小间隔未到 → 本次返回 deferred（不取消）')
ok(deferRow.status === 'pending', '随机延后后仍保持 pending（等下个到期窗口）')
const deferDelaySec = (new Date(deferRow.fire_at).getTime() - deferNow.getTime()) / 1000
ok(deferDelaySec === 4 * 3600, '延后时刻 = now + random[min,max]（rng=0.5 → 4h）')
ok(
  !!storage.prepare("SELECT 1 AS x FROM audit_logs WHERE category='proactive_gate' AND action='defer' AND instr(detail,'sm6-due') > 0").get(),
  '随机延后写审计 action=defer',
)
const rerun = await processScheduledMessages(deps, deferNow)
ok(rerun.length === 0, '延后行不会在同一时刻被重复处理（fire_at 已推到未来）')

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
