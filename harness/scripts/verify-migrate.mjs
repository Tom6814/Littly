#!/usr/bin/env node
/**
 * 旧库迁移工具的行为验证。
 * 运行：node scripts/verify-migrate.mjs
 *
 * 造一个旧 Prisma 形状的 SQLite 库（含边界样本：reasoning 为 NULL、
 * call_summary 审计类别、待办 fireAt 越界等），跑真实的 migrate-legacy.mjs，
 * 逐表核对行数与关键字段是否守恒。
 */
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
const ok = (cond, name) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.error(`  ✗ ${name}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'littly-migrate-'))
const legacyPath = join(dir, 'legacy.db')
const targetPath = join(dir, 'new.db')

// --- 造旧库（Prisma 表名与列名）---
const legacy = new DatabaseSync(legacyPath)
legacy.exec(`
CREATE TABLE User (id TEXT PRIMARY KEY, username TEXT, passwordHash TEXT, role TEXT, createdAt TEXT);
CREATE TABLE Bot (id TEXT PRIMARY KEY, name TEXT, avatar TEXT, systemPrompt TEXT, aiCharacterId TEXT, aiModel TEXT,
  aiTemperature REAL, aiMaxHistory INTEGER, memoryScope TEXT, aiHumanizeWechat INTEGER, proactiveEnabled INTEGER,
  proactiveDailyLimit INTEGER, proactiveMinInterval INTEGER, quietStart INTEGER, quietEnd INTEGER,
  createdAt TEXT, updatedAt TEXT);
CREATE TABLE Character (id TEXT PRIMARY KEY, name TEXT, spec TEXT, data TEXT, systemPrompt TEXT, firstMes TEXT,
  avatar TEXT, styleCalibration TEXT, createdAt TEXT, updatedAt TEXT);
CREATE TABLE WorldEntry (id TEXT PRIMARY KEY, botId TEXT, characterId TEXT, keys TEXT, secondKeys TEXT, logic INTEGER,
  constant INTEGER, probability INTEGER, priority INTEGER, position INTEGER, content TEXT, enabled INTEGER, createdAt TEXT);
CREATE TABLE Contact (id TEXT PRIMARY KEY, botId TEXT, sender TEXT, name TEXT, brief TEXT, profile TEXT, externalId TEXT,
  isOwner INTEGER, blocked INTEGER, userId TEXT, channel TEXT, createdAt TEXT, updatedAt TEXT);
CREATE TABLE ContactRelation (id TEXT PRIMARY KEY, botId TEXT, fromSender TEXT, toSender TEXT, relation TEXT, createdAt TEXT);
CREATE TABLE Memory (id TEXT PRIMARY KEY, botId TEXT, contactId TEXT, sender TEXT, category TEXT, content TEXT,
  importance INTEGER, eventTime TEXT, recordedAt TEXT, lastVerified TEXT, provenance TEXT, volatility TEXT,
  validUntil TEXT, tags TEXT, derivedFrom TEXT, embedding TEXT, consolidated INTEGER, deletedAt TEXT,
  deletedReason TEXT, createdAt TEXT, updatedAt TEXT);
CREATE TABLE Message (id TEXT PRIMARY KEY, botId TEXT, sender TEXT, role TEXT, content TEXT, replyType TEXT,
  reasoning TEXT, deliveryStatus TEXT, bufferStatus TEXT, bufferFireAt TEXT, channelId TEXT, voiceUrl TEXT,
  voiceText TEXT, meta TEXT, createdAt TEXT);
CREATE TABLE ScheduledMessage (id TEXT PRIMARY KEY, botId TEXT, sender TEXT, fireAt TEXT, tolerance INTEGER,
  strictness INTEGER, prompt TEXT, origin TEXT, status TEXT, failureReason TEXT, channel TEXT, content TEXT,
  createdAt TEXT, firedAt TEXT);
CREATE TABLE PersonaRule (botId TEXT PRIMARY KEY, rulesText TEXT, enabled INTEGER, updatedAt TEXT);
CREATE TABLE Diary (id TEXT PRIMARY KEY, botId TEXT, date TEXT, content TEXT, mood TEXT, snapshot TEXT, createdAt TEXT, updatedAt TEXT);
CREATE TABLE HistorySummary (id TEXT PRIMARY KEY, botId TEXT, sender TEXT, summary TEXT, lastMsgId TEXT, lastMsgAt TEXT,
  msgCount INTEGER, updatedAt TEXT);
CREATE TABLE GrowthProfile (id TEXT PRIMARY KEY, botId TEXT, version INTEGER, status TEXT, dimensions TEXT,
  lifeStage TEXT, valueExclusions TEXT, derivedFrom TEXT, createdAt TEXT);
CREATE TABLE GrowthProposal (id TEXT PRIMARY KEY, botId TEXT, basedVersion INTEGER, status TEXT, changes TEXT,
  evidence TEXT, report TEXT, evaluatorModel TEXT, createdAt TEXT, decidedAt TEXT, expiresAt TEXT);
CREATE TABLE Photo (id TEXT PRIMARY KEY, botId TEXT, url TEXT, caption TEXT, tags TEXT, createdAt TEXT);
CREATE TABLE ChannelIdentity (id TEXT PRIMARY KEY, userId TEXT, channel TEXT, externalId TEXT, createdAt TEXT);
CREATE TABLE AuditLog (id TEXT PRIMARY KEY, botId TEXT, category TEXT, action TEXT, detail TEXT, createdAt TEXT);
CREATE TABLE GlobalSetting (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE BindingToken (id TEXT PRIMARY KEY, userId TEXT, token TEXT, kind TEXT, expiresAt TEXT, usedAt TEXT, createdAt TEXT);
`)
const now = '2026-08-01T00:00:00Z'
legacy.prepare("INSERT INTO User VALUES ('u1','tori','hash','admin',?)").run(now)
legacy.prepare("INSERT INTO Bot (id,name,aiCharacterId,aiModel,aiTemperature,aiMaxHistory,memoryScope,createdAt) VALUES ('b1','小璃','c1','deepseek-flash',0.8,20,'global',?)").run(now)
legacy.prepare("INSERT INTO Character (id,name,spec,data,createdAt) VALUES ('c1','小璃','chara_card_v2','{\"data\":{\"description\":\"d\"}}',?)").run(now)
legacy.prepare("INSERT INTO Contact (id,botId,sender,name,createdAt) VALUES ('ct1','b1','u1','阿明',?)").run(now)
legacy.prepare("INSERT INTO Message (id,botId,sender,role,content,replyType,reasoning,deliveryStatus,bufferStatus,channelId,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
  .run('m1', 'b1', 'u1', 'user', '你好', 'text', null, 'sent', 'flushed', 'web', now)
legacy.prepare("INSERT INTO Message (id,botId,sender,role,content,replyType,reasoning,deliveryStatus,bufferStatus,channelId,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
  .run('m2', 'b1', 'u1', 'assistant', '在呢', 'text', '内心戏', 'sent', 'flushed', 'web', now)
legacy.prepare("INSERT INTO Message (id,botId,sender,role,content,replyType,reasoning,deliveryStatus,bufferStatus,channelId,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
  .run('m3', 'b1', 'u1', 'system', '通话时长 01:20', 'call', null, 'sent', 'flushed', 'web', now)
legacy.prepare("INSERT INTO Memory (id,botId,sender,category,content,importance,eventTime,recordedAt,createdAt) VALUES (?,?,?,?,?,?,?,?,?)")
  .run('mem1', 'b1', 'u1', 'relationship', '他很在意我', 4, now, now, now)
legacy.prepare("INSERT INTO AuditLog (id,botId,category,action,detail,createdAt) VALUES (?,?,?,?,?,?)")
  .run('a1', 'b1', 'call_summary', 'summarize', '{}', now)
legacy.prepare("INSERT INTO AuditLog (id,botId,category,action,detail,createdAt) VALUES (?,?,?,?,?,?)")
  .run('a2', 'b1', 'diary', 'write', '{}', now)
legacy.prepare("INSERT INTO GlobalSetting VALUES ('ai.api.api_key','sk-test')").run()
legacy.prepare("INSERT INTO GlobalSetting VALUES ('ai.api.chat_model','deepseek-flash')").run()
legacy.prepare("INSERT INTO ScheduledMessage (id,botId,sender,fireAt,strictness,prompt,origin,status,createdAt) VALUES (?,?,?,?,?,?,?,?,?)")
  .run('s1', 'b1', 'u1', now, 2, '记得吃饭', 'promise', 'sent', now)
legacy.prepare("INSERT INTO GrowthProfile (id,botId,version,status,dimensions,lifeStage,valueExclusions,derivedFrom,createdAt) VALUES (?,?,?,?,?,?,?,?,?)")
  .run('g1', 'b1', 1, 'active', '[{"key":"外向性","level":3,"desc":"主动"}]', '工作期', '[]', 'seed', now)
legacy.close()

// --- 跑真实迁移脚本 ---
const script = new URL('../scripts/migrate-legacy.mjs', import.meta.url).pathname
let out = ''
let failed = false
try {
  out = execFileSync('node', [script, legacyPath, targetPath], { encoding: 'utf8' })
} catch (e) {
  failed = true
  out = String(e.stdout ?? '') + String(e.stderr ?? '')
}
ok(!failed, '迁移脚本执行成功（无未捕获约束违例）')

if (failed) console.log(out)

const target = new DatabaseSync(targetPath)
const c = (sql) => { try { return target.prepare(sql).get().c } catch { return -1 } }

console.log('== 行数守恒 ==')
ok(c('SELECT COUNT(*) c FROM bots') === 1, 'bots')
ok(c('SELECT COUNT(*) c FROM messages') === 3, 'messages（3 条全部迁入，含 reasoning 为 NULL 的）')
ok(c('SELECT COUNT(*) c FROM memories') === 1, 'memories')
ok(c('SELECT COUNT(*) c FROM contacts') === 1, 'contacts')
ok(c('SELECT COUNT(*) c FROM global_settings') === 2, 'global_settings（模型配置必须带走）')
ok(c('SELECT COUNT(*) c FROM scheduled_messages') === 1, 'scheduled_messages')
ok(c('SELECT COUNT(*) c FROM growth_profiles') === 1, 'growth_profiles')
ok(c('SELECT COUNT(*) c FROM audit_logs') === 2, 'audit_logs')

console.log('== 关键字段 ==')
const m1 = target.prepare('SELECT * FROM messages WHERE id = ?').get('m1')
ok(m1.reasoning === '', 'reasoning 为 NULL 的行迁成空串（不丢行）')
ok(m1.reply_type === 'text' && m1.role === 'user', 'role/reply_type 原样')
const m3 = target.prepare('SELECT * FROM messages WHERE id = ?').get('m3')
ok(m3.reply_type === 'call', 'reply_type=call 保留')
const mem = target.prepare('SELECT * FROM memories WHERE id = ?').get('mem1')
ok(mem.provenance === 'user-stated', '记忆补 provenance 缺省')
ok(mem.event_time === mem.recorded_at, 'event_time 初值 = recorded_at（衰减按发生时间）')
ok(mem.volatility === 'stable', 'volatility 缺省 stable')
const a1 = target.prepare('SELECT * FROM audit_logs WHERE id = ?').get('a1')
ok(a1.category === 'heartbeat', 'call_summary 重映射为 heartbeat（满足新库 CHECK）')
const a2 = target.prepare('SELECT * FROM audit_logs WHERE id = ?').get('a2')
ok(a2.category === 'diary', '合法类别原样保留')
const gs = target.prepare('SELECT value FROM global_settings WHERE key = ?').get('ai.api.api_key')
ok(gs.value === 'sk-test', '全局配置值原样')
const gr = target.prepare('SELECT * FROM growth_profiles WHERE id = ?').get('g1')
ok(gr.status === 'active' && gr.life_stage === '工作期', '成长档案映射正确')

console.log('== 幂等（重复跑不炸）==')
let rerunOk = true
try {
  execFileSync('node', [script, legacyPath, targetPath], { encoding: 'utf8' })
} catch (e) {
  rerunOk = false
  console.log(String(e.stdout ?? '').slice(0, 400))
}
ok(rerunOk, '重复执行不失败（ON CONFLICT DO NOTHING）')
ok(c('SELECT COUNT(*) c FROM messages') === 3, '重复执行后行数不变')

target.close()
rmSync(dir, { recursive: true, force: true })

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
