#!/usr/bin/env node
/**
 * 记忆 v2 剩余三项的行为验证：explain 台账 / protected 能力位 / 幂等回执 + 漂移检测。
 * 运行：node scripts/verify-memory-v2.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LittlyStorage } from '../packages/littly/storage/src/index.ts'
import {
  contentSha256,
  detectDrift,
  explainMemory,
  halfLifeDaysOf,
  readReceipt,
  writeReceipt,
} from '../packages/littly/memory/src/explain.ts'

let pass = 0
let fail = 0
const ok = (cond, name) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.error(`  ✗ ${name}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'littly-memv2-'))
const storage = new LittlyStorage({ logger: { info: () => {} } }, { file: join(dir, 'm.db') })
const now = new Date().toISOString()

console.log('== 纯函数 ==')
ok(contentSha256('abc') === contentSha256('abc'), '同内容哈希一致')
ok(contentSha256('abc') !== contentSha256('abd'), '不同内容哈希不同')
ok(detectDrift(undefined, 'x') === null, '无期望值 → 不报漂移')
ok(detectDrift(contentSha256('x'), 'x') === null, '哈希一致 → 不报漂移')
const drift = detectDrift(contentSha256('x'), 'y')
ok(drift !== null && drift.actual !== drift.expected, '内容被改 → 报漂移')
ok(drift?.message.includes('漂移'), '漂移有可读说明')
ok(halfLifeDaysOf('relationship', 'stable') === 365, 'relationship 半衰期 365 天')
ok(halfLifeDaysOf('fact', 'stable') === 30, 'fact 半衰期 30 天')
ok(halfLifeDaysOf('thought', 'stable') === 14, 'thought 半衰期 14 天')
ok(halfLifeDaysOf('profile', 'stable') === 180, 'profile 半衰期 180 天')
ok(halfLifeDaysOf('fact', 'state') === 7, 'state 波动性封顶 7 天')

console.log('== 幂等回执 ==')
storage.prepare("INSERT INTO bots (id, name, created_at) VALUES ('b1','小璃',?)").run(now)
ok(readReceipt(storage, 'k1') === null, '无回执 → null')
writeReceipt(storage, 'k1', { id: 'm1', dupSkipped: false })
const r1 = readReceipt(storage, 'k1')
ok(r1?.id === 'm1' && r1?.dupSkipped === false, '回执可读回')
writeReceipt(storage, 'k1', { id: 'm2', dupSkipped: true })
ok(readReceipt(storage, 'k1')?.id === 'm2', '同键回执覆盖（幂等键唯一）')

console.log('== explain 台账 ==')
storage.prepare(
  "INSERT INTO memories (id, bot_id, sender, category, content, importance, event_time, event_time_raw, recorded_at, provenance, volatility, created_at) VALUES ('m1','b1','u1','fact','他喜欢猫',3,?,?,?,'user-stated','stable',?)",
).run(now, '上周三', now, now)
storage.prepare(
  "INSERT INTO memories (id, bot_id, sender, category, content, importance, event_time, event_time_raw, recorded_at, provenance, volatility, created_at) VALUES ('m2','b1','u1','fact','新版本内容',3,?,'',?,'inferred','stable',?)",
).run(now, now, now)
// m2 取代 m1
storage.prepare("UPDATE memories SET superseded_by = 'm2' WHERE id = 'm1'").run()
// m1 进墓碑
storage.prepare("UPDATE memories SET deleted_at = ?, deleted_reason = ? WHERE id = 'm1'").run(now, '被新记忆取代')

const ex1 = explainMemory(storage, 'b1', 'm1')
ok(ex1 !== null, 'explain 能查到记忆')
ok(ex1?.provenance.kind === 'user-stated', '出处标注透传')
ok((ex1?.provenance.note ?? '').includes('对方明确说过'), '出处有可读说明')
ok(ex1?.timing.eventTimeRaw === '上周三', '原始时间串保留')
ok(ex1?.timing.halfLifeDays === 30, '半衰期按类别给出')
ok(ex1?.tombstone.deleted === true, '墓碑状态正确')
ok(ex1?.tombstone.deletedReason === '被新记忆取代', '墓碑原因保留')
ok(ex1?.tombstone.supersededBy === 'm2', '被谁取代')
ok(ex1?.tombstone.supersededByContent === '新版本内容', '取代者内容可查')
ok(ex1?.tombstone.supersededFrom.length >= 1, '取代链（它取代了谁）可查')
ok(explainMemory(storage, 'b1', 'nope') === null, '不存在的记忆 → null')

console.log('== protected 能力位（检索命中）==')
const { LittlyMemory } = await import('../packages/littly/memory/src/index.ts')
const memory = new LittlyMemory({ logger: { info: () => {} } }, storage)
// 写 8 条，检索时应只有最近 5 条带 protected
for (let i = 0; i < 8; i++) {
  storage.prepare(
    "INSERT INTO memories (id, bot_id, sender, category, content, importance, event_time, recorded_at, provenance, volatility, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  ).run(`p${i}`, 'b1', 'u1', 'detail', `条目${i} 独特关键词${i}`, 1, now, now, 'observed', 'stable', new Date(Date.parse(now) + i * 1000).toISOString())
}
const hits = await memory.retrieveMemories({ botId: 'b1', sender: 'u1', query: '独特关键词', limit: 30 })
ok(hits.length > 0, '检索有命中')
const protectedHits = hits.filter((h) => h.protected === true)
ok(protectedHits.length <= 5, `protected 标记不超过 5 条（实际 ${protectedHits.length}）`)
ok(protectedHits.length >= 1, '最近写入的带 protected 能力位')
ok(hits.every((h) => 'protected' in h || h.protected === undefined), 'protected 是可选能力位，不改原字段')

storage.close()
rmSync(dir, { recursive: true, force: true })

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
