#!/usr/bin/env node
/**
 * 人格成长系统行为验证（golden-baseline 风格：三铁律 + 月底窗口 + 提议-审批全链路逐项断言）。
 * 运行：node scripts/verify-growth.mjs
 *
 * 不依赖网络与模型：只验证服务端硬校验、时序窗口与状态机；
 * 潜意识评审 / 事实审计 / 对抗质询（需模型的部分）由 fail-open 路径覆盖。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LittlyStorage } from '../packages/littly/storage/src/index.ts'
import { LittlyGrowth } from '../packages/littly/growth/src/index.ts'
import {
  validateProposalChanges,
  applyChangesToDims,
  parseDimensions,
  parseChanges,
  parseAudit,
  MAX_LEVEL_STEP,
  MAX_TOTAL_DISPLACEMENT,
  MIN_EVIDENCE_PER_CHANGE,
} from '../packages/littly/growth/src/types.ts'
import { isMonthEndWindow, nextMonthEnd, shanghaiMonthKey, fmtShanghai } from '../packages/littly/growth/src/timing.ts'
import { extractKeywords } from '../packages/littly/growth/src/audit.ts'

let pass = 0
let fail = 0
const ok = (cond, name) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.error(`  ✗ ${name}`) }
}

// ---------- 纯函数：三铁律 ----------

console.log('== 三铁律服务端硬校验 ==')
const dims = parseDimensions(JSON.stringify([
  { key: '外向性', level: 3, desc: '主动开启话题' },
  { key: '戒备心', level: 2, desc: '先怀疑陌生人动机' },
  { key: '好奇心', level: 4, desc: '对新鲜事刨根问底' },
]))
ok(dims.length === 3, '维度解析')
ok(parseDimensions('not-json').length === 0, '坏 JSON → 空数组（fail-open）')

const ev = new Set(['m1', 'm2'])
const oneChange = [{ dimension: '外向性', fromLevel: 3, toLevel: 4, evidenceIds: ['m1', 'm2'], reasoning: 'r' }]

const v1 = validateProposalChanges(dims, null, oneChange, ev)
ok(v1.ok, '合规变更通过')

const vStep = validateProposalChanges(dims, null, [{ ...oneChange[0], toLevel: 5 }], ev)
ok(!vStep.ok && vStep.errors.some((e) => e.includes('幅度')), `铁律一：单维步长 >${MAX_LEVEL_STEP} 级被拒`)

const vEv = validateProposalChanges(dims, null, [{ ...oneChange[0], evidenceIds: ['m1'] }], ev)
ok(!vEv.ok && vEv.errors.some((e) => e.includes('证据不足')), `铁律二：证据 <${MIN_EVIDENCE_PER_CHANGE} 条被拒`)

const vGhost = validateProposalChanges(dims, null, [{ ...oneChange[0], evidenceIds: ['m1', 'ghost'] }], ev)
ok(!vGhost.ok && vGhost.errors.some((e) => e.includes('不存在')), '铁律二：引用不存在的证据被拒')

const vFrom = validateProposalChanges(dims, null, [{ ...oneChange[0], fromLevel: 1 }], ev)
ok(!vFrom.ok && vFrom.errors.some((e) => e.includes('起点等级')), '起点等级与档案不符被拒（防陈旧数据）')

const vDim = validateProposalChanges(dims, null, [{ ...oneChange[0], dimension: '不存在维度' }], ev)
ok(!vDim.ok && vDim.errors.some((e) => e.includes('不在当前档案')), '未知维度被拒')

const vDup = validateProposalChanges(dims, null, [oneChange[0], oneChange[0]], ev)
ok(!vDup.ok && vDup.errors.some((e) => e.includes('重复')), '重复维度被拒')

const vRange = validateProposalChanges(dims, null, [{ ...oneChange[0], toLevel: 9 }], ev)
ok(!vRange.ok && vRange.errors.some((e) => e.includes('越界')), '目标等级越界(1-5)被拒')

const vEmpty = validateProposalChanges(dims, null, [], ev)
ok(!vEmpty.ok && vEmpty.errors.some((e) => e.includes('没有任何变更')), '空提案被拒')

// 出厂基线总位移：单维都只走 +1 时，总位移才是唯一变量 —— 7 个维度各 +1 = 7 → 拒绝；6 个 = 通过
const wideDims = parseDimensions(JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ key: `d${i}`, level: 3, desc: 'x' }))))
const wideSeed = parseDimensions(JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ key: `d${i}`, level: 3, desc: 'x' }))))
const wideChanges = (n) => Array.from({ length: n }, (_, i) => ({ dimension: `d${i}`, fromLevel: 3, toLevel: 4, evidenceIds: ['m1', 'm2'], reasoning: 'r' }))
const vWide = validateProposalChanges(wideDims, wideSeed, wideChanges(7), ev)
ok(!vWide.ok && vWide.errors.some((e) => e.includes('总位移')), `铁律三：总位移 >${MAX_TOTAL_DISPLACEMENT} 被拒`)
ok(vWide.errors.every((e) => !e.includes('幅度')), '总位移超限时不是单维步长问题（各维均只走 1 级）')
ok(validateProposalChanges(wideDims, wideSeed, wideChanges(6), ev).ok, `总位移恰为 ${MAX_TOTAL_DISPLACEMENT} 通过`)

const applied = applyChangesToDims(dims, [{ dimension: '外向性', fromLevel: 3, toLevel: 4, toDesc: '更主动', evidenceIds: ['m1', 'm2'], reasoning: 'r' }])
ok(applied.find((d) => d.key === '外向性')?.level === 4, '变更套用到维度快照')
ok(applied.find((d) => d.key === '外向性')?.desc === '更主动', 'toDesc 覆盖判据')
ok(applied.find((d) => d.key === '戒备心')?.level === 2, '未变更维度保持原样')

ok(parseAudit('{"verdict":"reject","rejectEvidenceIds":["a"],"issues":["x"]}')?.verdict === 'reject', '审计结果解析')
ok(parseAudit('bad') === null, '坏审计 JSON → null')

// ---------- 月底窗口（中国时区） ----------

console.log('== 月度评审计时 ==')
// 上海 22:00 = UTC 14:00；构造「当月最后一天 22:00 上海」
const lastDayUtc = new Date(Date.UTC(2026, 6, 31, 14, 30))
ok(isMonthEndWindow(lastDayUtc), '月底最后一天 22:00（上海）= 窗口开启')
const earlyMonth = new Date(Date.UTC(2026, 6, 1, 4, 0))
ok(isMonthEndWindow(earlyMonth), '次月 1-3 日 = 补跑窗口')
const midMonth = new Date(Date.UTC(2026, 6, 15, 4, 0))
ok(!isMonthEndWindow(midMonth), '月中 = 窗口关闭')
const next = nextMonthEnd(midMonth)
ok(next.getTime() > midMonth.getTime(), 'nextMonthEnd 在未来')
ok(fmtShanghai(next).includes('22:00'), '展示文案带 22:00')
ok(shanghaiMonthKey(new Date('2026-03-05T00:00:00Z')) === '2026-03', '月份键（上海时区）')

// ---------- 证据关键词 ----------

console.log('== 事实审计关键词 ==')
ok(extractKeywords('她提到周末去日本出差旅行').length > 0, '抽出中文关键词')
ok(!extractKeywords('我们自己的一个那个什么').includes('我们'), '常见虚词被过滤')

// ---------- 提议-审批全链路（真实 SQLite） ----------

console.log('== 提议-审批全链路 ==')
const dir = mkdtempSync(join(tmpdir(), 'littly-growth-'))
const fakeCtx = { logger: { info: () => {} } }
const storage = new LittlyStorage(fakeCtx, { file: join(dir, 'g.db') })
const growth = new LittlyGrowth(storage)

const nowIso = new Date().toISOString()
storage.prepare("INSERT INTO bots (id, name, created_at) VALUES ('b1','小璃',?)").run(nowIso)
storage.prepare("INSERT INTO characters (id, name, spec, data, created_at) VALUES ('c1','小璃','chara_card_v2','{}',?)").run(nowIso)
storage.prepare("INSERT INTO memories (id, bot_id, sender, category, content, importance, event_time, recorded_at, created_at) VALUES ('m1','b1','u1','relationship','他很在意我','4',?,?,?)").run(nowIso, nowIso, nowIso)
storage.prepare("INSERT INTO memories (id, bot_id, sender, category, content, importance, event_time, recorded_at, created_at) VALUES ('m2','b1','u1','relationship','他主动分享日常','4',?,?,?)").run(nowIso, nowIso, nowIso)

// v1 档案
storage.prepare("INSERT INTO growth_profiles (id, bot_id, version, status, dimensions, life_stage, value_exclusions, derived_from, created_at) VALUES ('p1','b1',1,'active',?,?,?,'seed',?)")
  .run(JSON.stringify(dims), '刚工作', '[]', nowIso)

const pending = storage.prepare("SELECT * FROM growth_proposals WHERE bot_id='b1' AND status='pending'").all()
ok(pending.length === 0, '初始无待审提案')

// 注入文本 [2.4]
const injectText = growth.getActiveText('b1')
ok(typeof injectText === 'string' && injectText.includes('成长档案 v1'), '[2.4] 注入含版本号')
ok(injectText.includes('外向性') && injectText.includes('3/5'), '[2.4] 注入含维度与等级')
ok(growth.getActiveText('nobody') === undefined, '无档案 → undefined（fail-open）')

// 造一条待审提案（证据链合法）
storage.prepare("INSERT INTO growth_proposals (id, bot_id, based_version, status, changes, evidence, report, evaluator_model, created_at, decided_at, expires_at) VALUES ('pr1','b1',1,'pending',?,?,'','test-model',?,NULL,?)")
  .run(JSON.stringify(oneChange), JSON.stringify({ trigger: 'manual', majorEvents: '一次重要的出行' }), nowIso, new Date(Date.now() + 86400000).toISOString())

const snap = growth.snapshot('b1')
ok(snap.pendingProposals.length === 1, '快照含待审提案')
ok(snap.profile?.version === 1, '快照含生效档案 v1')
ok(typeof snap.nextReviewAt === 'string' && snap.nextReviewAt.length > 0, '快照含下次评审时间')

// 驳回
let res = await growth.decide('pr1', 'reject')
ok(res.ok && res.status === 'rejected', '驳回生效')
ok(storage.prepare("SELECT status FROM growth_proposals WHERE id='pr1'").get().status === 'rejected', '提案状态 → rejected')
ok(storage.prepare("SELECT COUNT(*) AS c FROM growth_profiles WHERE bot_id='b1' AND status='active'").get().c === 1, '驳回不动档案')

// 越权编辑稿（铁律违规）必须被拒
storage.prepare("INSERT INTO growth_proposals (id, bot_id, based_version, status, changes, evidence, report, evaluator_model, created_at, decided_at, expires_at) VALUES ('pr2','b1',1,'pending',?,?,'','test-model',?,NULL,?)")
  .run(JSON.stringify(oneChange), '{}', nowIso, new Date(Date.now() + 86400000).toISOString())
res = await growth.decide('pr2', 'approve_edited', [
  { dimension: '外向性', fromLevel: 3, toLevel: 5, evidenceIds: ['m1', 'm2'], reasoning: '越级' },
])
ok(!res.ok && res.error.includes('铁律'), '铁律违规的编辑稿被拒（服务端重放校验）')
ok(storage.prepare("SELECT status FROM growth_proposals WHERE id='pr2'").get().status === 'pending', '被拒后提案仍为 pending')
ok(storage.prepare("SELECT COUNT(*) AS c FROM growth_profiles WHERE bot_id='b1'").get().c === 1, '被拒后不产生新版本')

// 引用不存在证据 → 拒
res = await growth.decide('pr2', 'approve_edited', [
  { dimension: '外向性', fromLevel: 3, toLevel: 4, evidenceIds: ['m1', 'ghost'], reasoning: '伪造证据' },
])
ok(!res.ok && res.error.includes('铁律'), '伪造证据被拒')

// 正常批准（LLM 未配置 → 报告 fail-open，但审批本身成功）
res = await growth.decide('pr2', 'approve_edited', [
  { dimension: '外向性', fromLevel: 3, toLevel: 4, toDesc: '更主动地发起话题', evidenceIds: ['m1', 'm2'], reasoning: '他主动分享了日常' },
])
ok(res.ok && res.status === 'edited', '编辑后批准生效')
ok(storage.prepare("SELECT status FROM growth_proposals WHERE id='pr2'").get().status === 'edited', '提案状态 → edited')
ok(storage.prepare("SELECT COUNT(*) AS c FROM growth_profiles WHERE bot_id='b1' AND status='active'").get().c === 1, '仍只有一个生效版本')
const active = storage.prepare("SELECT * FROM growth_profiles WHERE bot_id='b1' AND status='active'").get()
ok(active.version === 2, '新版本 v2 生效')
ok(JSON.parse(active.dimensions).find((d) => d.key === '外向性').level === 4, 'v2 维度已更新')
ok(JSON.parse(active.dimensions).find((d) => d.key === '外向性').desc === '更主动地发起话题', 'v2 判据已更新')
ok(storage.prepare("SELECT status FROM growth_profiles WHERE id='p1'").get().status === 'archived', 'v1 被归档（历史不篡改）')

// 版本冲突护栏
storage.prepare("INSERT INTO growth_proposals (id, bot_id, based_version, status, changes, evidence, report, evaluator_model, created_at, decided_at, expires_at) VALUES ('pr3','b1',1,'pending',?,?,'','test-model',?,NULL,?)")
  .run(JSON.stringify(oneChange), '{}', nowIso, new Date(Date.now() + 86400000).toISOString())
res = await growth.decide('pr3', 'approve')
ok(!res.ok && res.error.includes('版本冲突'), '版本冲突护栏拦截陈旧提案')

// 取消
res = await growth.decide('pr3', 'cancel')
ok(res.ok && res.status === 'cancelled', '取消生效')

// 过期提案
storage.prepare("INSERT INTO growth_proposals (id, bot_id, based_version, status, changes, evidence, report, evaluator_model, created_at, decided_at, expires_at) VALUES ('pr4','b1',2,'pending',?,?,'','test-model',?,NULL,?)")
  .run(JSON.stringify(oneChange), '{}', nowIso, new Date(Date.now() - 1000).toISOString())
res = await growth.decide('pr4', 'approve')
ok(!res.ok && res.error.includes('过期'), '过期提案被拒')
ok(storage.prepare("SELECT status FROM growth_proposals WHERE id='pr4'").get().status === 'expired', '过期提案状态 → expired')

// 归档式回滚
const rb = growth.rollback('b1', 1)
ok(rb.ok === true, '回滚成功')
const activeAfterRb = storage.prepare("SELECT * FROM growth_profiles WHERE bot_id='b1' AND status='active'").get()
ok(activeAfterRb.version === 3, '回滚生成新版本 v3（不篡改历史）')
ok(JSON.parse(activeAfterRb.dimensions).find((d) => d.key === '外向性').level === 3, 'v3 内容 = v1 内容')
ok(storage.prepare("SELECT COUNT(*) AS c FROM growth_profiles WHERE bot_id='b1'").get().c === 3, '历史版本全部保留')

// 回滚到当前生效版本 → 拒绝
ok(growth.rollback('b1', 3).ok === false, '回滚到当前版本被拒')

// 审计日志
const audits = storage.prepare("SELECT * FROM audit_logs WHERE bot_id='b1' AND category='growth'").all()
ok(audits.length >= 4, '成长审计日志已写入')

storage.close()
rmSync(dir, { recursive: true, force: true })

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
