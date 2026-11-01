#!/usr/bin/env node
/**
 * 记忆 vault 验证（P1+P2）：Markdown 真相 + 派生索引 + 暂存/Dream + 迁移 + 工具。
 * 运行：node scripts/verify-memory-vault.mjs
 *
 * 真 SQLite + 临时 vault 目录，不联网（fake embedding / fake LLM 注入）。
 */
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LittlyStorage } from '../packages/littly/storage/src/index.ts'
import { MemoryVault } from '../packages/littly/memory/src/vault/service.ts'
import { MEMORY_DOMAINS, VaultError, normalizeWriteInput } from '../packages/littly/memory/src/vault/types.ts'
import {
  defaultVaultRoot, ensureVault, entryFile, vaultPaths, safeSegment, listStaging, writeProfile,
} from '../packages/littly/memory/src/vault/store.ts'
import { relativeLabel, timeLabelsFor } from '../packages/littly/memory/src/vault/time.ts'
import {
  acquireDreamLock, releaseDreamLock, buildProfileMarkdown, buildDreamPrompt, dreamDue, estimateTokens,
  parseDreamOutput, DREAM_COOLDOWN_MS, DREAM_MIN_STAGING,
} from '../packages/littly/memory/src/vault/dream.ts'
import { RANK_WEIGHTS, halfLifeDays, importanceWeight, recencyWeight } from '../packages/littly/memory/src/vault/rank.ts'
import { MEMORY_TOOLS, registerMemoryTools } from '../packages/littly/memory/src/vault/tools.ts'

let pass = 0
let fail = 0
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? `（${detail}）` : ''}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? `（${detail}）` : ''}`) }
}
const throwsCode = (fn, code) => {
  try { fn(); return false } catch (error) { return error instanceof VaultError && error.code === code }
}

const dir = mkdtempSync(join(tmpdir(), 'littly-vault-'))
const root = join(dir, 'memory')
const storage = new LittlyStorage({ logger: { info: () => {} } }, { file: join(dir, 'm.db') })
storage.setSetting('platform.secret', 'vault-test')
const now = () => new Date('2026-10-30T08:00:00+08:00')
const fakeEmbed = async (texts) => texts.map((text) => (text.includes('考研') ? [1, 0, 0] : text.includes('睡眠') ? [0, 1, 0] : [0.2, 0.2, 0.9]))
const llmOutput = JSON.stringify([
  { domain: 'about-user', kind: 'about-user', title: '住在杭州', body: '在杭州工作生活。', provenance: 'user-stated', event_time: '2026-10-20T10:00:00+08:00', importance: 4, tags: ['城市'] },
  { domain: 'feedback', kind: 'rule', title: '不喜欢被叫全名', body: '称呼用昵称即可。', provenance: 'user-stated', volatility: 'stable' },
  { domain: 'notes', kind: 'agent-note', title: '最近在准备考研', body: '多次提到复习进度，推断在备考。', provenance: 'inferred' },
])
const llmCalls = []
const vault = new MemoryVault(storage, {
  rootDir: root,
  now,
  embed: fakeEmbed,
  complete: async (prompt) => { llmCalls.push(prompt); return llmOutput },
})
const scope = { botId: 'bot-1', contactId: 'user-1' }

console.log('== 路径 / 布局 / 穿越防护 ==')
{
  ok(defaultVaultRoot().endsWith('memory'), '默认 vault 根目录 LITTLY_DATA_DIR/memory')
  const paths = vaultPaths(root, 'bot-1', 'user-1')
  ok(paths.contactDir === join(root, 'bot-1', 'user-1'), '目录布局 memory/<bot>/<contact>')
  ok(safeSegment('3f9c2b1a-5d4e-4f6a-8b7c-1d2e3f4a5b6c', 'contact') === '3f9c2b1a-5d4e-4f6a-8b7c-1d2e3f4a5b6c', 'UUID 联系人目录可直接使用')
  ok(throwsCode(() => safeSegment('../evil', 'bot'), 'bad_path'), 'botId ../ 被拒绝')
  ok(throwsCode(() => safeSegment('..', 'contact'), 'bad_path'), 'contactId .. 被拒绝')
  ok(throwsCode(() => safeSegment('a/b', 'x'), 'bad_path'), '含 / 的 id 被拒绝（穿越防护）')
  ok(throwsCode(() => entryFile(paths, 'life', '../escape'), 'bad_path'), 'entryId 穿越被拒绝')
  ok(throwsCode(() => entryFile(paths, '../life', 'ok'), 'bad_path'), 'domain 穿越被拒绝')
  ensureVault(paths)
  for (const d of ['domains', 'domains/about-user', 'domains/feedback', 'domains/notes', 'domains/history', 'threads', '_staging', '_history', '_meta']) {
    ok(existsSync(join(paths.contactDir, d)), `目录已创建：${d}`)
  }
  ok(existsSync(join(paths.domainsDir, 'life', 'README.md')), '域 README.md 已生成（程序不覆盖）')
  ok(vault.paths('bot-1', 'user-1').contactDir === paths.contactDir, 'service.paths 与 store.vaultPaths 一致')
  ok(throwsCode(() => vault.paths('', 'x'), 'bad_scope'), 'botId 空 → bad_scope')
  ok(throwsCode(() => vault.paths('b', ''), 'bad_scope'), 'contactId 空 → bad_scope')
}

console.log('== 写入 / frontmatter / 幂等 / 冲突 / 校验 ==')
let entryA
{
  const written = vault.write(scope, {
    domain: 'projects', title: '在准备考研', body: '目标院校是浙大，最近在刷数学。',
    event_time: '2026-09-01T09:00:00+08:00', event_raw: '九月开始准备考研', provenance: 'user-stated',
    importance: 4, tags: ['考研', '学习'], thread: '考研',
  })
  entryA = written.entry
  ok(written.created === true, 'memory_write 新建条目')
  ok(existsSync(written.path), '条目文件已落盘')
  const text = readFileSync(written.path, 'utf8')
  ok(text.startsWith('---') && text.includes('domain: "projects"'), 'frontmatter 序列化正确')
  ok(text.includes('event_raw: "九月开始准备考研"'), 'event_raw 原话保留')
  ok(text.includes('在准备考研'), '正文写入')
  const again = vault.write(scope, {
    id: entryA.id, domain: 'projects', title: '在准备考研', body: '目标院校是浙大，最近在刷数学。',
    event_time: '2026-09-01T09:00:00+08:00', event_raw: '九月开始准备考研', provenance: 'user-stated',
    importance: 4, tags: ['考研', '学习'], thread: '考研',
  })
  ok(again.duplicate === true && again.created === false, '同 id 同内容重复写幂等（duplicate）')
  ok(throwsCode(() => vault.write(scope, { id: entryA.id, domain: 'projects', title: '在准备考研', body: '完全不同的正文' }), 'entry_conflict'), '同 id 不同内容 → entry_conflict 409')
  ok(throwsCode(() => vault.write(scope, { domain: 'nope', title: 'x', body: 'y' }), 'bad_domain'), '非法 domain → bad_domain')
  ok(throwsCode(() => vault.write(scope, { domain: 'notes', kind: 'about-user', title: 'x', body: 'y' }), 'bad_entry'), 'notes 域必须是 agent-note（推断）')
  ok(throwsCode(() => vault.write(scope, { domain: 'feedback', kind: 'about-user', title: 'x', body: 'y' }), 'bad_entry'), 'feedback 规则 kind 校验')
  ok(throwsCode(() => vault.write(scope, { domain: 'life', title: '', body: 'y' }), 'bad_entry'), '空 title → bad_entry')
  ok(throwsCode(() => vault.write(scope, { domain: 'life', title: 'x', body: 'y', importance: 9 }), 'bad_entry'), 'importance 越界 → bad_entry')
  ok(throwsCode(() => vault.write(scope, { domain: 'life', title: 'x', body: 'y', event_time: '不是时间' }), 'bad_entry'), '非法时间 → bad_entry')
  ok(throwsCode(() => vault.write(scope, { domain: 'life', title: 'x', body: 'y', provenance: 'nope' }), 'bad_entry'), '非法 provenance → bad_entry')
  const note = normalizeWriteInput({ domain: 'notes', title: '推断标题', body: '推断正文' }, now)
  ok(note.kind === 'agent-note' && note.provenance === 'inferred', 'notes 默认 agent-note/inferred')
  const rule = normalizeWriteInput({ domain: 'feedback', title: '规则', body: '正文' }, now)
  ok(rule.kind === 'rule' && rule.provenance === 'user-stated', 'feedback 默认 rule/user-stated')
}

console.log('== 索引：重建 / source_digest / FTS / 行号 / 时间标签 ==')
{
  const rebuild1 = vault.rebuildIndex(scope)
  ok(rebuild1.count === 1, '索引重建 1 条')
  const digest1 = vault.index().getMeta('source_digest')
  ok(digest1.length === 64 && rebuild1.buildId.length > 0, 'source_digest/build_id 已写入')
  const rebuild2 = vault.rebuildIndex(scope)
  ok(vault.index().getMeta('source_digest') === digest1, '同内容重建 digest 稳定')
  ok(rebuild2.buildId !== rebuild1.buildId, 'build_id 每次重建不同（可校验重建）')
  vault.write(scope, { domain: 'life', title: '睡眠 5 小时', body: '昨晚一点多睡，七点起。' })
  vault.rebuildIndex(scope)
  ok(vault.index().getMeta('source_digest') !== digest1, '新增条目后 source_digest 变化')
  const fts = await vault.search(scope, '考研')
  ok(fts.length > 0, 'FTS 关键词命中「考研」')
  ok(fts[0].path.includes('projects/') && Number(fts[0].line) >= 1, '命中可定位 path + line', `${fts[0].path}:${fts[0].line}`)
  ok(fts[0].matchedLayer === 'fts' || fts[0].matchedLayer === 'both', 'matchedLayer 标注来源')
  ok(typeof fts[0].timeLabel === 'string' && fts[0].timeLabel !== '', '检索结果带自然语言时间标签')
  const empty = await vault.search(scope, '完全不存在的内容xyz')
  ok(empty.length === 0, '无关检索为空（不硬凑）')
  // 向量层
  const all = vault.entries(scope, { limit: 10 })
  const sleepRow = all.find((r) => r.title.includes('睡眠'))
  vault.index().setVector(sleepRow.entryId, 'fake', [0, 1, 0])
  const vecHit = await vault.search(scope, '睡眠')
  ok(vecHit.some((h) => h.entryId === sleepRow.entryId), '向量层可命中（fake embedding）')
  ok(vecHit.find((h) => h.entryId === sleepRow.entryId)?.matchedLayer === 'both', 'FTS+向量融合 matchedLayer=both')
  ok(vault.index().getVector(sleepRow.entryId)?.length === 3, '向量 BLOB 可读回')
  // 时间标签随「现在」老化
  ok(relativeLabel('2026-08-01T00:00:00+08:00', new Date('2026-10-30T00:00:00+08:00')).includes('个月前'), '相对时间：两个月前（月粒度）')
  ok(relativeLabel('2026-10-29T20:00:00+08:00', new Date('2026-10-30T08:00:00+08:00')).includes('小时前'), '相对时间：小时前')
  ok(relativeLabel('2026-10-23T10:00:00+08:00', new Date('2026-10-30T08:00:00+08:00')).includes('天前'), '相对时间：天前')
  const labels1 = timeLabelsFor({ ...entryA, event_time: '2026-08-01T00:00:00+08:00' }, new Date('2026-10-30T00:00:00+08:00'))
  const labels2 = timeLabelsFor({ ...entryA, event_time: '2026-08-01T00:00:00+08:00' }, new Date('2027-03-01T00:00:00+08:00'))
  ok(labels1.eventLabel !== labels2.eventLabel, '不同「现在」生成不同相对时间词（自动老化）')
  ok(labels1.recordedLabel.includes('记录于'), '记录时间标签带「记录于」')
  ok(relativeLabel('2026-10-20T00:00:00+08:00', new Date('2026-11-01T00:00:00+08:00'), { keyDate: true }).includes('（'), '关键时间保留绝对日期')
}

console.log('== 写路径保留向量（entry_id + sha256）==')
{
  const vecScope = { botId: 'bot-1', contactId: 'vec-user' }
  const vecVault = new MemoryVault(storage, { rootDir: root, now, embed: fakeEmbed, complete: async () => '[]' })
  const first = vecVault.write(vecScope, { domain: 'life', title: '向量甲', body: '第一条正文。' })
  const second = vecVault.write(vecScope, { domain: 'life', title: '向量乙', body: '第二条正文。' })
  vecVault.index().setVector(first.entry.id, 'fake', [0, 1, 0])
  vecVault.index().setVector(second.entry.id, 'fake', [1, 0, 0])
  ok(vecVault.index().vectorCount(vecScope) === 2, '初始化两条向量')
  // memory_write → rebuildIndex → rebuildScope：不能把该 scope 的向量全清掉（历史 bug）
  vecVault.write(vecScope, { domain: 'life', title: '向量丙', body: '第三条正文。' })
  ok(vecVault.index().vectorCount(vecScope) === 2, 'memory_write 后向量数不归零（未变化条目保留）', `2 → ${vecVault.index().vectorCount(vecScope)}`)
  ok(vecVault.index().getVector(first.entry.id)?.length === 3, '未变化条目的向量原样保留')
  // 内容变化 → 旧向量删除（不凭空重算），等下次 Dream 重建
  vecVault.update(vecScope, first.entry.id, { body: '改过的正文（内容变化）。' })
  ok(vecVault.index().getVector(first.entry.id) === null, '正文变化的条目向量被删除（等 Dream 重建）')
  ok(vecVault.index().getVector(second.entry.id) !== null, '其它条目向量不受影响')
  const noVec = await vecVault.search(vecScope, '改过的正文')
  ok(noVec.some((h) => h.entryId === first.entry.id), '无向量条目仍可被 FTS 召回')
}

console.log('== 检索加权：相关度 / 重要度 / 新鲜度 ==')
{
  ok(RANK_WEIGHTS.relevance === 0.55 && RANK_WEIGHTS.importance === 0.25 && RANK_WEIGHTS.recency === 0.20, '权重 0.55/0.25/0.20')
  ok(halfLifeDays('relationships', 'stable') === 365 && halfLifeDays('feedback', 'stable') === 365, 'relationships/feedback 半衰期 365 天')
  ok(halfLifeDays('life', 'stable') === 30 && halfLifeDays('health', 'stable') === 30, 'life/health 半衰期 30 天')
  ok(halfLifeDays('projects', 'stable') === 180 && halfLifeDays('interests', 'stable') === 180 && halfLifeDays('about-user', 'stable') === 180, 'projects/interests/about-user 半衰期 180 天')
  ok(halfLifeDays('notes', 'stable') === 90, '未列出的域默认 90 天')
  ok(halfLifeDays('relationships', 'state') === 7 && halfLifeDays('life', 'state') === 7, 'volatility=state 半衰期封顶 7 天')
  ok(Math.abs(recencyWeight(new Date(now().getTime() - 30 * 86_400_000).toISOString(), now(), 'life', 'stable') - 0.5) < 1e-9, '生活域 30 天新鲜度衰减到 0.5')
  ok(recencyWeight('不是时间', now(), 'life', 'stable') === 0, '时间不可解析 → 新鲜度 0（不奖励脏数据）')
  ok(importanceWeight(5) === 1 && Math.abs(importanceWeight(1) - 0.2) < 1e-9 && importanceWeight(99) === 1, '重要度归一 1-5 → 0.2-1')

  const rankScope = { botId: 'bot-1', contactId: 'rank-user' }
  const rankVault = new MemoryVault(storage, { rootDir: root, now, embed: fakeEmbed, complete: async () => '[]' })
  // 两条都命中「登山」：旧 + 低重要度 vs 新 + 高重要度
  rankVault.write(rankScope, { domain: 'life', title: '登山旧事', body: '去年和朋友去登山，很累。', event_time: '2026-01-01T10:00:00+08:00', importance: 1 })
  rankVault.write(rankScope, { domain: 'projects', title: '登山计划', body: '下个月去登山，正在做攻略。', event_time: '2026-10-29T10:00:00+08:00', importance: 5 })
  const ranked = await rankVault.search(rankScope, '登山')
  ok(ranked.length === 2, '加权检索命中两条同等相关条目')
  ok(ranked[0].title === '登山计划', 'importance/recency 高者排前', ranked.map((h) => h.title).join(' > '))
  ok(typeof ranked[0].scoreBreakdown === 'object' && ranked[0].scoreBreakdown !== null, '结果带 scoreBreakdown')
  ok(ranked[0].scoreBreakdown.importance > ranked[1].scoreBreakdown.importance, '分项 importance 反映 5 vs 1')
  ok(ranked[0].scoreBreakdown.recency > ranked[1].scoreBreakdown.recency, '分项 recency 按 event_time 衰减')
  ok(ranked.every((h) => h.score >= 0 && h.score <= 1), '最终分归一到 0..1')
  ok(ranked[0].score === ranked[0].scoreBreakdown.final, 'score 与 scoreBreakdown.final 一致')
  ok((await rankVault.search(rankScope, '登山', { minScore: 1.01 })).length === 0, 'minScore 过滤最终加权分（>1 全过滤）')
  ok((await rankVault.search(rankScope, '登山', { minScore: 0.5 })).length >= 1, 'minScore 低于最终分时保留命中')
  // 同等相关/重要度，只让 event_time 不同
  rankVault.write(rankScope, { domain: 'interests', title: '跑步旧习惯', body: '以前每周跑步三次。', event_time: '2025-01-01T00:00:00+08:00', importance: 3 })
  rankVault.write(rankScope, { domain: 'interests', title: '跑步比赛', body: '刚报名了跑步比赛。', event_time: '2026-10-28T00:00:00+08:00', importance: 3 })
  const byRecency = await rankVault.search(rankScope, '跑步')
  ok(byRecency.length === 2 && byRecency[0].title === '跑步比赛', '同等相关/重要度 → event_time 新者排前', byRecency.map((h) => h.title).join(' > '))
  // 同等相关/时间，只让 importance 不同
  rankVault.write(rankScope, { domain: 'life', title: '养猫日常', body: '家里养猫，日常铲屎。', event_time: '2026-10-20T00:00:00+08:00', importance: 1 })
  rankVault.write(rankScope, { domain: 'life', title: '养猫开销', body: '养猫每月花费不少。', event_time: '2026-10-20T00:00:00+08:00', importance: 5 })
  const byImportance = await rankVault.search(rankScope, '养猫')
  ok(byImportance.length === 2 && byImportance[0].title === '养猫开销', '同等相关/时间 → importance 高者排前', byImportance.map((h) => h.title).join(' > '))
}

console.log('== 9 域地图 / 条目列表 / 详情 / 人工编辑 ==')
{
  const domains = vault.domains(scope)
  ok(domains.length === 9, 'domains 返回 9 域')
  ok(domains.every((d) => MEMORY_DOMAINS.includes(d.domain)), '域枚举与常量一致')
  ok(domains.every((d) => typeof d.label === 'string' && d.label !== ''), '每域带中文 label')
  ok(domains.find((d) => d.domain === 'projects').count >= 1, 'projects 域统计条目数')
  ok(Array.isArray(domains.find((d) => d.domain === 'projects').latest), '每域带 latest 数组（fe 契约）')
  const entries = vault.entries(scope, { domain: 'projects', limit: 10 })
  ok(entries.length >= 1 && entries[0].entryId === entryA.id, '条目列表可按域过滤')
  ok(typeof entries[0].eventLabel === 'string' && entries[0].isInference === false, '列表含时间标签与推断标记')
  const detail = vault.getEntry(scope, entryA.id)
  ok(detail.body.includes('浙大') && detail.path.includes('projects/'), '详情含正文与文件路径')
  ok(detail.event_raw.includes('九月开始准备考研') && detail.source_ref !== undefined, '详情含原话/来源')
  ok(detail.state === 'active' && Array.isArray(detail.supersededChain), '详情含状态与取代链')
  ok(throwsCode(() => vault.getEntry(scope, 'not-exist'), 'entry_not_found'), '不存在条目抛出 VaultError（entry_not_found）')
  let notFound = null
  try { vault.getEntry(scope, 'not-exist') } catch (e) { notFound = e }
  ok(notFound instanceof VaultError && notFound.status === 404, '不存在条目 → 404 entry_not_found')
  const updated = vault.update(scope, entryA.id, { body: '目标院校改为复旦。', tags: ['考研', '复旦'], importance: 5 })
  ok(updated.body.includes('复旦') && updated.importance === 5, '人工编辑正文/重要度生效')
  ok(vault.getEntry(scope, entryA.id).body.includes('复旦'), '编辑已落盘')
  const audit = storage.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'memory_edit'").get()
  ok(audit.c >= 1, '人工编辑写审计 memory_edit')
}

console.log('== PROFILE / RULES（预算截断 / 区间保护）==')
{
  const profile = vault.profile(scope)
  ok(profile.markdown.includes('memory:auto:begin') && profile.markdown.includes('memory:auto:end'), 'PROFILE 自动区标记存在')
  ok(profile.markdown.includes('自动生成'), 'PROFILE 标注自动生成')
  ok(profile.chars > 0 && profile.truncated === false, 'PROFILE 未超预算不截断')
  const paths = vault.paths('bot-1', 'user-1')
  writeProfile(paths, `${readFileSync(paths.profileFile, 'utf8').replace('<!-- memory:auto:end -->', '<!-- memory:auto:end -->\n\n## 人工备注\n这是人工补充，重建必须保留。')}`)
  vault.profile(scope, { rebuild: true })
  ok(readFileSync(paths.profileFile, 'utf8').includes('人工补充'), '重建 PROFILE 保留自动区外人工内容')
  const small = buildProfileMarkdown(paths, vault.index(), now(), 120, scope)
  ok(small.truncated === true && small.markdown.includes('已截断'), '超预算 → 显式截断标注')
  const rules = vault.rules(scope)
  ok(rules.markdown.includes('memory:rules:auto:begin'), 'RULES 自动区标记存在')
  vault.write(scope, { domain: 'feedback', kind: 'rule', title: '不喜欢被叫全名', body: '用昵称。', provenance: 'user-stated', volatility: 'stable' })
  vault.profile(scope, { rebuild: true })
  ok(vault.rules(scope).entries.some((e) => e.title.includes('全名')), 'RULES 汇总 feedback 规则')
}

console.log('== 暂存区 / Dream 整理（fake LLM）==')
{
  // 预置一次「一小时前刚整理过」的报告：新的冷却触发（6h）因此不会在 stage() 时自动起跑，
  // 让下面的断言保持确定性；dreamDue 的 OR 行为在紧随其后的单元断言里单独覆盖。
  vault.index().insertDreamReport({
    id: 'seed-recent-dream', bot_id: 'bot-1', contact_id: 'user-1', at: new Date(now().getTime() - 60 * 60_000).toISOString(),
    added: 0, merged: 0, superseded: 0, archived: 0, duration_ms: 0, tokens: 0, status: 'ok', error: '',
  })
  const stage = vault.stage(scope, '用户说最近搬到杭州了', 'message:m1')
  ok(typeof stage.staging.id === 'string' && stage.stagingCount === 1, 'memory_stage 写入 _staging')
  ok(listStaging(vault.paths('bot-1', 'user-1')).length === 1, '暂存文件落盘')
  ok(listStaging(vault.paths('bot-1', 'user-1'))[0].source_ref === 'message:m1', '暂存保留 source_ref')
  ok(DREAM_MIN_STAGING === 25, '阈值常量 25')
  ok(DREAM_COOLDOWN_MS === 6 * 60 * 60_000, '冷却常量 6h')
  ok(dreamDue(0, '', now()) === false, '无暂存 → 不整理')
  ok(dreamDue(24, '', now()) === true, '有暂存但无上次记录 → due（低流量首次兜底）')
  ok(dreamDue(1, new Date(now().getTime() - 7 * 60 * 60_000).toISOString(), now()) === true, '低 staging 但超过冷却 → due（OR）')
  ok(dreamDue(1, new Date(now().getTime() - 60 * 60_000).toISOString(), now()) === false, '低 staging 且未到冷却 → 不整理')
  ok(dreamDue(25, new Date(now().getTime() - 60_000).toISOString(), now()) === true, 'staging≥25 → due（不看冷却）')
  ok(dreamDue(24, new Date(now().getTime() - 7 * 60 * 60_000).toISOString(), now()) === true, '24 条 + 过了冷却 → due（阈值/冷却取或）')
  // 构造一条旧条目供 supersede
  const old = vault.write(scope, { domain: 'life', title: '旧作息：两点睡', body: '经常两点睡。', event_time: '2026-08-01T00:00:00+08:00' }).entry
  // 模型输出含 supersede
  llmCalls.length = 0
  const vaultSup = new MemoryVault(storage, {
    rootDir: root, now, embed: fakeEmbed,
    complete: async () => JSON.stringify([
      { domain: 'about-user', title: '住在杭州', body: '在杭州工作生活。', provenance: 'user-stated' },
      { domain: 'life', title: '新作息：十一点睡', body: '最近十一点前睡。', provenance: 'observed', supersedes: [old.id] },
    ]),
  })
  vaultSup.stage(scope, '住在杭州；最近作息提前了')
  const report = await vaultSup.consolidate(scope, { reason: 'manual' })
  ok(report.status === 'ok', 'Dream 整理成功', report.error)
  ok(report.added >= 2, 'Dream 新增条目数 ≥2')
  ok(report.superseded >= 1, 'Dream 记录 supersede 数')
  const after = vaultSup.entries(scope, { limit: 50 })
  ok(after.some((e) => e.title === '住在杭州'), '整理后条目出现在索引')
  const oldAfter = vaultSup.getEntry(scope, old.id)
  ok(oldAfter.supersededBy === null || oldAfter.state === 'superseded' || oldAfter.validUntil !== null, '旧条目被标记失效/取代')
  const tomb = join(vaultSup.paths('bot-1', 'user-1').historyDir, `${old.id}.md`)
  ok(existsSync(tomb) && readFileSync(tomb, 'utf8').includes('曾经是真的') === false && readFileSync(tomb, 'utf8').includes('墓碑'), '被取代条目写墓碑')
  ok(listStaging(vaultSup.paths('bot-1', 'user-1')).length === 0, '成功后清空 staging')
  const dbReports = vaultSup.index().listDreamReports('bot-1', 'user-1', 5)
  ok(dbReports.length >= 1 && dbReports[0].status === 'ok', 'Dream 报告写 dream_reports 表')
  const logFile = join(vaultSup.paths('bot-1', 'user-1').metaDir, 'dream-log.jsonl')
  ok(existsSync(logFile) && readFileSync(logFile, 'utf8').includes('"added"'), 'Dream 报告写 _meta/dream-log.jsonl')
  ok(vaultSup.profile(scope).markdown.includes('住在杭州'), '整理后 PROFILE 重建包含新事实')
  // 锁
  const paths = vaultSup.paths('bot-1', 'user-1')
  const lock = acquireDreamLock(paths, now())
  ok(lock.ok === true, 'Dream 锁可获取')
  const lockedReport = await vaultSup.consolidate(scope, { reason: 'manual' })
  ok(lockedReport.status === 'locked', '并发整理返回 locked（不重复跑）')
  releaseDreamLock(paths)
  ok(acquireDreamLock(paths, now()).ok === true, '释放后可再次加锁')
  releaseDreamLock(paths)
  // token 预算
  const records = Array.from({ length: 30 }, (_, i) => ({ id: `stg-${i}`, content: '内容'.repeat(400), source_ref: '', status: 'pending', created_at: now().toISOString() }))
  const prompt = buildDreamPrompt(records, [], 2000)
  ok(prompt.usedRecords.length < records.length && prompt.tokens <= 2000, 'token 预算截断候选（不超预算）')
  ok(estimateTokens('中文内容'.repeat(10)) > 0, 'token 估算可用')
  const parsed = parseDreamOutput('```json\n[{"a":1}]\n```')
  ok(Array.isArray(parsed) && parsed.length === 1, '模型输出可从 markdown 代码块稳健解析')
  let parseErr = null
  try { parseDreamOutput('完全不是 JSON') } catch (e) { parseErr = e }
  ok(parseErr instanceof Error, '非法模型输出抛可读错误')
  // 空暂存整理 → skipped
  const emptyVault = new MemoryVault(storage, { rootDir: root, now, embed: fakeEmbed, complete: async () => '[]' })
  const skipped = await emptyVault.consolidate({ botId: 'bot-1', contactId: 'nobody' }, { reason: 'manual' })
  ok(skipped.status === 'skipped', '空暂存区 → skipped（不报错）')
}

console.log('== 遗忘 / 墓碑 / 详情链 ==')
{
  const victim = vault.write(scope, { domain: 'health', title: '失眠记录', body: '连续三天失眠。', provenance: 'observed' }).entry
  const result = vault.forget(scope, victim.id, '用户要求遗忘')
  ok(result.ok === true && existsSync(result.tombstone) && readFileSync(result.tombstone, 'utf8').includes('墓碑'), 'memory_forget 写墓碑文件')
  const after = vault.getEntry(scope, victim.id)
  ok(after.validUntil !== null || after.state !== 'active', '遗忘后条目失效')
  ok(after.state === 'superseded' || after.state === 'expired', '遗忘后状态为 superseded/expired')
  ok(after.tombstone.includes('原正文'), '详情带墓碑内容')
  ok(vault.entries(scope, { domain: 'health', limit: 10 }).every((e) => e.entryId !== victim.id || e.state !== 'active'), '遗忘条目不作为 active 出现')
}

console.log('== 迁移旧 memories（映射/幂等/旧表保留）==')
{
  const insert = storage.prepare('INSERT INTO memories (id, bot_id, contact_id, sender, category, content, importance, event_time, event_time_raw, recorded_at, valid_until, provenance, volatility, tags, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  insert.run('mem-1', 'bot-1', 'u-gold', 'u-gold', 'profile', '住在杭州，做后端开发。', 4, '2026-03-01T00:00:00+08:00', '我是杭州的', '2026-03-02T00:00:00+08:00', null, 'user-stated', 'stable', '["城市","职业"]', '2026-03-02T00:00:00+08:00')
  insert.run('mem-2', 'bot-1', 'u-gold', 'u-gold', 'relationship', '和妈妈关系很好。', 3, '2026-04-01T00:00:00+08:00', '', '2026-04-02T00:00:00+08:00', null, 'observed', 'stable', '[]', '2026-04-02T00:00:00+08:00')
  insert.run('mem-3', 'bot-1', 'u-gold', 'u-gold', 'thought', '可能最近压力大。', 2, '2026-05-01T00:00:00+08:00', '', '2026-05-02T00:00:00+08:00', null, 'inferred', 'state', '[]', '2026-05-02T00:00:00+08:00')
  // 旧 contact_id 是 contacts.id（≠ sender）：scope 必须按 sender 落目录，不能被拆成两个文件夹
  insert.run('mem-4', 'bot-1', 'cmt2jnhee-legacy-contact-id', 'u-gold', 'detail', '周末喜欢去西湖边散步。', 3, '2026-06-01T00:00:00+08:00', '', '2026-06-02T00:00:00+08:00', null, 'observed', 'stable', '[]', '2026-06-02T00:00:00+08:00')
  const before = storage.prepare('SELECT COUNT(*) AS c FROM memories').get().c
  const migrated = vault.migrate({})
  ok(migrated.migrated >= 4, '迁移条目数 ≥4')
  ok(migrated.migrated === 4 && migrated.scopes === 1, 'contact_id≠sender 的旧行不新增 scope（同一真人 1 个文件夹）')
  const gold = vault.paths('bot-1', 'u-gold')
  ok(existsSync(join(gold.domainsDir, 'life', 'mem-4.md')), 'contact_id≠sender → 落到 <bot>/<sender>/（sender scope）')
  ok(!existsSync(join(root, 'bot-1', 'cmt2jnhee-legacy-contact-id')), '没有按 memories.contact_id 生成多余目录')
  ok(readFileSync(join(gold.domainsDir, 'life', 'mem-4.md'), 'utf8').includes('legacy_contact_id:cmt2jnhee-legacy-contact-id'), '旧 contact_id 作为元数据保留在 source_ref（不参与目录）')
  ok(existsSync(join(gold.domainsDir, 'about-user', 'mem-1.md')), 'profile→about-user 映射落盘')
  ok(existsSync(join(gold.domainsDir, 'relationships', 'mem-2.md')), 'relationship→relationships 映射落盘')
  ok(existsSync(join(gold.domainsDir, 'notes', 'mem-3.md')), 'thought→notes 映射落盘')
  const mem3 = vault.getEntry({ botId: 'bot-1', contactId: 'u-gold' }, 'mem-3')
  ok(mem3.kind === 'agent-note' && mem3.provenance === 'inferred', 'thought → agent-note（推断保留）')
  const mem1 = readFileSync(join(gold.domainsDir, 'about-user', 'mem-1.md'), 'utf8')
  ok(mem1.includes('source: "migration"') && mem1.includes('source_ref: "memory:mem-1"'), '迁移条目标注 source=migration/source_ref')
  ok(mem1.includes('杭州'), '迁移保留正文')
  const again = vault.migrate({})
  ok(again.migrated === 0 && again.skipped >= 4, '迁移幂等（按 bot+sender+id）：第二次全部 skipped')
  ok(storage.prepare('SELECT COUNT(*) AS c FROM memories').get().c === before, '旧 memories 表保留（只读过渡）')
  ok(vault.profile({ botId: 'bot-1', contactId: 'u-gold' }).markdown.includes('杭州'), '迁移后生成 PROFILE 首版')
}

console.log('== 工具注册（memory_*）==')
{
  const tools = []
  const hub = { tools: { registerChannelTool: (def, exec) => tools.push({ name: def.function.name, def, exec }) } }
  registerMemoryTools(hub, vault)
  ok(tools.length === 9, '注册 9 个 memory_* 工具')
  for (const name of ['memory_profile', 'memory_rules', 'memory_domains', 'memory_index', 'memory_search', 'memory_get', 'memory_write', 'memory_stage', 'memory_forget']) {
    ok(tools.some((t) => t.name === name), `工具存在：${name}`)
  }
  ok(MEMORY_TOOLS.every((t) => t.function.description.length > 10), '每个工具都有中文描述')
  const ctx = { botId: 'bot-1', sender: 'user-1' }
  const profile = await tools.find((t) => t.name === 'memory_profile').exec({}, ctx)
  ok(JSON.parse(profile.result).ok === true && JSON.parse(profile.result).profile.includes('memory:auto:begin'), '工具 memory_profile 可读档案')
  const write = await tools.find((t) => t.name === 'memory_write').exec({ domain: 'interests', title: '喜欢爬山', body: '周末常去爬山。' }, ctx)
  const writeJson = JSON.parse(write.result)
  ok(writeJson.ok === true && writeJson.entryId !== undefined, '工具 memory_write 写入成功')
  const search = await tools.find((t) => t.name === 'memory_search').exec({ query: '爬山' }, ctx)
  ok(JSON.parse(search.result).ok === true, '工具 memory_search 可用')
  const staged = await tools.find((t) => t.name === 'memory_stage').exec({ content: '候选：喜欢猫' }, ctx)
  ok(JSON.parse(staged.result).ok === true && JSON.parse(staged.result).stagingCount >= 1, '工具 memory_stage 可用')
  const badWrite = await tools.find((t) => t.name === 'memory_write').exec({ domain: 'nope', title: 'x', body: 'y' }, ctx)
  ok(JSON.parse(badWrite.result).ok === false && JSON.parse(badWrite.result).error.code === 'bad_domain', '工具错误返回可读 code')
  const forget = await tools.find((t) => t.name === 'memory_forget').exec({ entryId: writeJson.entryId }, ctx)
  ok(JSON.parse(forget.result).ok === true, '工具 memory_forget 可用')
}

console.log('== dreamStatus / 自动触发 / 定时 ==')
{
  const status = vault.dreamStatus({ botId: 'bot-1', contactId: 'u-gold' })
  ok(typeof status.running === 'boolean' && typeof status.stagingCount === 'number', 'dreamStatus 基础字段')
  ok('lastRunAt' in status && 'nextRunAt' in status, 'dreamStatus 含 lastRunAt/nextRunAt（fe 契约）')
  const scopeX = { botId: 'bot-1', contactId: 'auto-user' }
  // 预置 10 分钟前刚整理过：阈值优先于冷却——25 条仍然 due，且前 24 条不会提前触发后台整理
  vault.index().insertDreamReport({
    id: 'seed-auto-user', bot_id: 'bot-1', contact_id: 'auto-user', at: new Date(now().getTime() - 10 * 60_000).toISOString(),
    added: 0, merged: 0, superseded: 0, archived: 0, duration_ms: 0, tokens: 0, status: 'ok', error: '',
  })
  for (let i = 0; i < 25; i++) vault.stage(scopeX, `候选 ${i}`)
  const auto = vault.dreamStatus(scopeX)
  ok(auto.stagingCount === 25 && auto.due === true, 'staging≥25 → due=true（阈值优先于冷却）')
  // consolidateDue 只在 03:00 跑 daily
  const notThree = await vault.consolidateDue('daily', new Date('2026-10-30T10:00:00+08:00'))
  ok(notThree.length === 0, '非 03:00 不跑 daily 整理')
  const threshold = await vault.consolidateDue('threshold', now())
  ok(Array.isArray(threshold), 'consolidateDue(threshold) 返回报告数组（不抛）')
}

rmSync(dir, { recursive: true, force: true })
console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
