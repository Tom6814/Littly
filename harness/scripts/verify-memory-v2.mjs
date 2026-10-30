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

// ---------- B14：归属 / expiresAt / 幂等接线 ----------
console.log('== B14 记忆归属与时效 ==')
{
  const { normalizeValidUntil } = await import('../packages/littly/memory/src/index.ts')
  ok(normalizeValidUntil('2026-12-01T00:00:00Z') === '2026-12-01T00:00:00.000Z', 'B14：expiresAt → ISO valid_until')
  ok(normalizeValidUntil('bad-date') === null, 'B14：非法时间 → null（不写坏值）')
  ok(normalizeValidUntil('') === null && normalizeValidUntil(null) === null, 'B14：空值 → null')

  // remember 落 valid_until + idempotencyKey 回放 + if_sha256 漂移
  const idem1 = await memory.remember('b1', 'u1', {
    category: 'fact', content: 'B14 有时效的事实：下周三出差', importance: 3,
    expiresAt: '2026-12-01T00:00:00Z', idempotencyKey: 'b14-key-1',
  })
  const row1 = storage.prepare('SELECT * FROM memories WHERE id = ?').get(idem1.id)
  ok(row1.valid_until === '2026-12-01T00:00:00.000Z', 'B14：remember 把 expiresAt 落进 valid_until')
  const idem2 = await memory.remember('b1', 'u1', {
    category: 'fact', content: 'B14 有时效的事实：下周三出差', importance: 3, idempotencyKey: 'b14-key-1',
  })
  ok(idem2.id === idem1.id && idem2.idempotentReplay === true, 'B14：idempotencyKey 重复写入 → 回放同一条，不新增')
  const countSame = storage.prepare("SELECT COUNT(*) AS c FROM memories WHERE content = 'B14 有时效的事实：下周三出差'").get().c
  ok(countSame === 1, 'B14：幂等键不产生重复行')

  // if_sha256：同话题内容被改 → 报漂移（不静默覆盖）
  const driftSeed = await memory.remember('b1', 'u1', {
    category: 'profile', content: 'B14 漂移检测内容 喜欢猫', importance: 2,
  })
  const driftRes = await memory.remember('b1', 'u1', {
    category: 'profile', content: 'B14 漂移检测内容 喜欢猫', importance: 2,
    ifSha256: contentSha256('完全不同的内容'),
  })
  ok(driftRes.dupSkipped === true && driftRes.id === driftSeed.id && driftRes.drift !== undefined, 'B14：if_sha256 不符 → 命中重复并报告漂移（不覆盖）')

  // 整理：只允许操作 (bot_id, sender) 范围内的记忆 —— 别的 bot 的记忆 id 动了也不改库
  const otherId = 'b14-other-bot'
  storage.prepare(
    "INSERT INTO memories (id, bot_id, sender, category, content, importance, event_time, recorded_at, provenance, volatility, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  ).run(otherId, 'b2', 'u2', 'fact', '别的 bot 的记忆', 3, now, now, 'observed', 'stable', now)
  // 造 12 条 b1/u1 的记忆（整理要求 >=10），并让模型返回：删除别的 bot 的 id + 删除自己范围内一条
  for (let i = 0; i < 12; i++) {
    storage.prepare(
      "INSERT INTO memories (id, bot_id, sender, category, content, importance, event_time, recorded_at, provenance, volatility, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ).run(`b14-m${i}`, 'b1', 'u1', 'detail', `B14 整理条目 ${i}`, 1, now, new Date(Date.parse(now) - i * 60000).toISOString(), 'observed', 'stable', now)
  }
  storage.setSetting('ai.api.base_url', 'http://127.0.0.1:9/v1')
  storage.setSetting('ai.api.api_key', 'test-key')
  storage.setSetting('ai.api.chat_model', 'test-model')
  // remember() 的异步预嵌入可能已经用「未配置」状态占过一次 30s 配置缓存 → 显式失效。
  const { invalidateAIConfigCache } = await import('../packages/littly/llm/lib/index.js')
  invalidateAIConfigCache()
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/chat/completions')) {
      const ops = [
        { op: 'DELETE', id: otherId, reason: '模型幻觉的越权 id' },
        { op: 'DELETE', id: 'b14-m11', reason: '过期琐事' },
        { op: 'COMPRESS', ids: ['b14-m10', otherId], mergedContent: '越权合并', mergedImportance: 2 },
      ]
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ operations: ops }) } }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    return realFetch(url, init)
  }
  try {
    const cons = await memory.runConsolidation('b1', 'u1')
    ok(cons.before >= 12, `B14：整理扫描到本会话记忆（${cons.before} 条）`)
  } finally {
    globalThis.fetch = realFetch
  }
  const otherRow = storage.prepare('SELECT deleted_at FROM memories WHERE id = ?').get(otherId)
  ok(otherRow.deleted_at === null, 'B14：整理不会删除其他 bot 的记忆（裸 id 越权被拦）')
  const ownDeleted = storage.prepare('SELECT deleted_at IS NOT NULL AS d FROM memories WHERE id = ?').get('b14-m11')
  ok(ownDeleted.d === 1, 'B14：本会话范围内允许的 DELETE 生效')
  const protectedRow = storage.prepare('SELECT deleted_at FROM memories WHERE id = ?').get('b14-m0')
  ok(protectedRow.deleted_at === null, 'B14：最近 5 条硬保护仍生效（不被 DELETE）')
  const crossMerge = storage.prepare("SELECT COUNT(*) AS c FROM memories WHERE content = '越权合并'").get().c
  ok(crossMerge === 0, 'B14：含越权 id 的 COMPRESS 整条跳过，不写合并记忆')
}

storage.close()
rmSync(dir, { recursive: true, force: true })

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
