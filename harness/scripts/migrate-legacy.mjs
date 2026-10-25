#!/usr/bin/env node
/**
 * 旧库一次性迁移：Prisma SQLite（旧项目 db/custom.db）→ 新业务 schema。
 * 旧库只读；新库已由 storage 插件建好 v1 表。
 * 记忆补 v2 字段初始值：event_time=record_time（衰减按发生时间，先与写入时间一致）、
 * provenance='user-stated' 缺省、墓碑字段空。
 *
 * 用法：node scripts/migrate-legacy.mjs <legacy.db> [target.db]
 */
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { MIGRATIONS } from '../packages/littly/storage/src/schema.ts'

const [legacyPath, targetPath] = process.argv.slice(2)
if (!legacyPath || !targetPath) {
  console.error('用法: node scripts/migrate-legacy.mjs <legacy.db> [target.db]')
  process.exit(1)
}

const legacy = new DatabaseSync(legacyPath, { readOnly: true })
const target = new DatabaseSync(targetPath)
target.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')

// 目标库没有新 schema 就地建（与 storage 插件同一份 DDL，保证迁移目标可用）
{
  const hasMigrations = target
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
    .get() !== undefined
  const applied = new Set(
    hasMigrations ? target.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version) : [],
  )
  let created = 0
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue
    if (!hasMigrations) {
      target.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
    }
    target.exec(m.sql)
    target.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(m.version, new Date().toISOString())
    created++
  }
  if (created > 0) console.log('[migrate] 目标库 schema v1 已创建（%d 个迁移）', created)
}

const count = (db, sql) => { try { return db.prepare(sql).get().c } catch { return 0 } }

console.log('[legacy] rows:', {
  bots: count(legacy, 'SELECT COUNT(*) c FROM Bot'),
  messages: count(legacy, 'SELECT COUNT(*) c FROM Message'),
  memories: count(legacy, 'SELECT COUNT(*) c FROM Memory'),
  contacts: count(legacy, 'SELECT COUNT(*) c FROM Contact'),
})

const iso = (v) => {
  if (!v) return new Date().toISOString()
  const d = new Date(typeof v === 'number' ? v : String(v).replace(' ', 'T') + (String(v).length === 19 ? 'Z' : ''))
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString()
}
const json = (v, fb = '[]') => { try { return JSON.stringify(typeof v === 'string' ? JSON.parse(v) : (v ?? JSON.parse(fb))) } catch { return fb } }
const str = (v, fb = '') => v === null || v === undefined ? fb : String(v)
const num = (v, fb = 0) => { const n = Number(v); return Number.isFinite(n) ? n : fb }
const bool = (v) => v === 1 || v === true || v === 'true' ? 1 : 0

target.exec('BEGIN IMMEDIATE')
try {
  // ---- Users（密码哈希原样带走：旧 bcrypt/scrypt 哈希不再可验证时，用户重置密码）----
  for (const u of legacy.prepare('SELECT * FROM User').all()) {
    target.prepare('INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING')
      .run(str(u.id, randomUUID()), str(u.username), str(u.passwordHash, 'x'), u.role === 'admin' ? 'admin' : 'user', iso(u.createdAt))
  }
  // ---- Bots（白名单字段 + 渠道 + AI 配置）----
  for (const b of legacy.prepare('SELECT * FROM Bot').all()) {
    target.prepare(`INSERT INTO bots (
      id, name, avatar, system_prompt, character_id, birthday, gender, appearance,
      ai_model, ai_temperature, ai_max_history, memory_scope,
      ai_humanize_enabled, ai_humanize_wechat, ai_hide_thinking,
      proactive_enabled, heartbeat_enabled, quiet_start, quiet_end, proactive_daily_limit, proactive_min_interval,
      ai_memory_consolidate_threshold, diary_enabled, diary_hour,
      ai_vision_enabled, ai_vision_base_url, ai_vision_model, ai_vision_api_key,
      ai_voice_enabled, ai_voice_model, ai_voice_reference_id, ai_voice_api_key, ai_voice_temperature, ai_voice_speed, ai_call_api_key,
      sleep_until,
      tg_enabled, tg_bot_token, tg_webhook_secret, tg_username, tg_mode, tg_last_update_id,
      wx_enabled, wx_hub_bot_id, wx_push_token, wx_push_endpoint, wx_verify_secret,
      wx_friend_display_enabled, wx_friend_alias, wx_friend_qrcode,
      qq_enabled, qq_app_id, qq_app_secret, qq_access_token, qq_token_expires_at,
      snowluma_enabled, snowluma_ws_url, snowluma_token, snowluma_account,
      discord_enabled, discord_bot_token, discord_client_id, discord_last_sequence, created_at
    ) VALUES (${Array(64).fill('?').join(',')}) ON CONFLICT DO NOTHING`).run(
      str(b.id), str(b.name), str(b.avatar), str(b.systemPrompt), b.aiCharacterId ?? null,
      str(b.birthday), str(b.gender), str(b.appearanceText),
      str(b.aiModel), num(b.aiTemperature, 0.8), num(b.aiMaxHistory, 20), str(b.aiMemoryScope ?? 'global') === 'free' ? 'free' : str(b.aiMemoryScope ?? 'global'),
      bool(b.aiHumanizeEnabled ?? 1), bool(b.aiHumanizeWechat ?? 1), bool(b.aiHideThinking ?? 1),
      bool(b.proactiveEnabled ?? 1), bool(b.heartbeatEnabled ?? 0), num(b.quietStart, 23), num(b.quietEnd, 8), num(b.proactiveDailyLimit, 8), num(b.proactiveMinInterval, 7200),
      num(b.aiMemoryConsolidateThreshold, 40), bool(b.diaryEnabled ?? 1), num(b.diaryHour, 23),
      bool(b.aiVisionEnabled), str(b.aiVisionBaseUrl), str(b.aiVisionModel), str(b.aiVisionApiKey),
      bool(b.aiVoiceEnabled), str(b.aiVoiceModel), str(b.aiVoiceReferenceId), str(b.aiVoiceApiKey), num(b.aiVoiceTemperature, 0.7), num(b.aiVoiceSpeed, 1), str(b.aiCallApiKey),
      b.aiSleepUntil ? iso(b.aiSleepUntil) : null,
      bool(b.tgEnabled), str(b.tgBotToken), str(b.tgWebhookSecret), str(b.tgUsername), b.tgMode === 'webhook' ? 'webhook' : 'polling', num(b.tgLastUpdateId),
      bool(b.wxEnabled), str(b.wxHubBotId), str(b.wxPushToken), str(b.wxPushEndpoint), str(b.wxVerifySecret),
      bool(b.wxFriendDisplayEnabled), str(b.wxFriendAlias), str(b.wxFriendQrcode),
      bool(b.qqEnabled), str(b.qqAppId), str(b.qqAppSecret), str(b.qqAccessToken), b.qqTokenExpiresAt ? iso(b.qqTokenExpiresAt) : null,
      // SnowLuma 是新渠道：沿用 qqp 旧配置作为初始连接参数（ws 地址/令牌），账号留空待绑定
      bool(b.qqpEnabled), str(b.qqpWsUrl), str(b.qqpToken), '',
      bool(b.discordEnabled), str(b.discordBotToken), str(b.discordClientId), b.discordLastSequence === null ? null : num(b.discordLastSequence),
      iso(b.createdAt),
    )
  }
  // ---- Characters / WorldEntries ----
  for (const c of legacy.prepare('SELECT * FROM Character').all()) {
    target.prepare('INSERT INTO characters (id, name, spec, data, system_prompt, first_mes, avatar, style_calibration, created_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING')
      .run(str(c.id), str(c.name), ['chara_card_v2', 'mask', 'deepseek_persona'].includes(c.spec) ? c.spec : 'chara_card_v2',
        str(c.cardJson, '{}'), str(c.systemPrompt), str(c.firstMes), str(c.avatar), str(c.styleCalibration, '{}'), iso(c.createdAt))
  }
  for (const w of legacy.prepare('SELECT * FROM WorldEntry').all()) {
    target.prepare('INSERT INTO world_entries (id, bot_id, character_id, keys, second_keys, logic, constant, probability, priority, position, enabled, content, comment) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING')
      .run(str(w.id), str(w.botId), str(w.characterId), json(w.keys), json(w.secondKeys), num(w.logic), bool(w.constant), num(w.probability, 85), num(w.priority, 100), num(w.position, 1), bool(w.enabled ?? 1), str(w.content), str(w.comment))
  }
  // ---- Contacts / Relations ----
  for (const c of legacy.prepare('SELECT * FROM Contact').all()) {
    target.prepare('INSERT INTO contacts (id, bot_id, sender, name, brief, profile, external_id, is_owner, blocked, user_id, channel, tg_username, metadata, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING')
      .run(str(c.id), str(c.botId), str(c.sender), str(c.name), str(c.brief), str(c.profile), str(c.externalId), bool(c.isOwner), bool(c.blocked), c.userId ?? null, str(c.channel), str(c.tgUsername),
        JSON.stringify({ blockedReason: str(c.blockedReason) }), iso(c.createdAt), iso(c.updatedAt))
  }
  for (const r of legacy.prepare('SELECT * FROM ContactRelation').all()) {
    target.prepare('INSERT INTO contact_relations (id, bot_id, from_sender, to_sender, relation, note, created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING')
      .run(str(r.id), str(r.botId), str(r.fromSender), str(r.toSender), str(r.relation), str(r.note), iso(r.createdAt))
  }
  // ---- Memories（补 v2 初始值）----
  for (const m of legacy.prepare('SELECT * FROM Memory').all()) {
    const recorded = iso(m.createdAt)
    target.prepare(`INSERT INTO memories (
      id, bot_id, contact_id, sender, category, content, importance,
      event_time, event_time_raw, recorded_at, last_verified,
      provenance, volatility, superseded_by, valid_until, tags, derived_from,
      embedding, consolidated, deleted_at, deleted_reason, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`).run(
      str(m.id, randomUUID()), str(m.botId), m.contactId ?? null, str(m.sender),
      ['profile', 'relationship', 'fact', 'detail', 'value', 'thought'].includes(m.category) ? m.category : 'fact',
      str(m.content), Math.min(5, Math.max(1, num(m.importance, 1))),
      recorded, '', recorded, recorded,
      'user-stated', m.category === 'thought' ? 'state' : 'stable',
      null, m.expiresAt ? iso(m.expiresAt) : null, '[]', '[]',
      m.embedding ?? null, bool(m.consolidated), m.deletedAt ? iso(m.deletedAt) : null, str(m.deletedReason), recorded,
    )
  }
  // ---- Messages（缓冲字段保留）----
  for (const m of legacy.prepare('SELECT * FROM Message').all()) {
    target.prepare('INSERT INTO messages (id, bot_id, sender, role, content, reply_type, reasoning, delivery_status, buffer_status, buffer_fire_at, channel_id, voice_url, voice_original_text, meta, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING')
      .run(str(m.id, randomUUID()), str(m.botId), str(m.sender),
        ['user', 'assistant', 'system'].includes(m.role) ? m.role : 'user',
        str(m.content),
        ['text', 'image', 'file', 'voice', 'call'].includes(m.replyType) ? m.replyType : 'text',
        str(m.reasoning), m.deliveryStatus ?? null, m.bufferStatus ?? null, m.bufferFireAt ? iso(m.bufferFireAt) : null,
        str(m.channelId), str(m.voiceUrl), str(m.voiceText), '{}', iso(m.createdAt))
  }
  // ---- Scheduled / PersonaRules / Diaries / HistorySummary / Growth / Photos / Identities / Audit ----
  for (const s of legacy.prepare('SELECT * FROM ScheduledMessage').all()) {
    target.prepare('INSERT INTO scheduled_messages (id, bot_id, sender, fire_at, tolerance, strictness, prompt, origin, status, failure_reason, channel, content, created_at, fired_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING')
      .run(str(s.id), str(s.botId), str(s.sender), iso(s.fireAt), s.tolerance === null ? null : num(s.tolerance), num(s.strictness, 3), str(s.prompt), str(s.origin) === 'promise' ? 'promise' : 'proactive',
        ['pending', 'sent', 'failed', 'cancelled'].includes(s.status) ? s.status : 'pending', str(s.failureReason), str(s.channel), str(s.content), iso(s.createdAt), s.firedAt ? iso(s.firedAt) : null)
  }
  for (const p of legacy.prepare('SELECT * FROM PersonaRule').all()) {
    target.prepare('INSERT INTO persona_rules (bot_id, rules_text, enabled, updated_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING')
      .run(str(p.botId), str(p.rulesText), bool(p.enabled ?? 1), iso(p.updatedAt))
  }
  for (const d of legacy.prepare('SELECT * FROM Diary').all()) {
    target.prepare('INSERT INTO diaries (id, bot_id, date, content, mood, snapshot, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING')
      .run(str(d.id), str(d.botId), str(d.date), str(d.content), str(d.mood), '{}', iso(d.createdAt), iso(d.updatedAt))
  }
  for (const h of legacy.prepare('SELECT * FROM HistorySummary').all()) {
    target.prepare('INSERT INTO history_summaries (id, bot_id, sender, summary, last_msg_id, last_msg_at, msg_count, updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING')
      .run(str(h.id), str(h.botId), str(h.sender), str(h.summary), h.lastMsgId ?? null, h.lastMsgAt ? iso(h.lastMsgAt) : null, num(h.msgCount), iso(h.updatedAt))
  }
  for (const g of legacy.prepare('SELECT * FROM GrowthProfile').all()) {
    target.prepare('INSERT INTO growth_profiles (id, bot_id, version, status, dimensions, life_stage, value_exclusions, derived_from, created_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING')
      .run(str(g.id), str(g.botId), num(g.version, 1), g.status === 'archived' ? 'archived' : 'active', json(g.dimensions), str(g.lifeStage), json(g.valueExclusions), g.derivedFrom ?? null, iso(g.createdAt))
  }
  for (const g of legacy.prepare('SELECT * FROM GrowthProposal').all()) {
    target.prepare('INSERT INTO growth_proposals (id, bot_id, based_version, status, changes, evidence, report, evaluator_model, created_at, decided_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING')
      .run(str(g.id), str(g.botId), num(g.basedVersion, 1), str(g.status), json(g.changes), json(g.evidence), str(g.report), str(g.evaluatorModel), iso(g.createdAt), g.decidedAt ? iso(g.decidedAt) : null, g.expiresAt ? iso(g.expiresAt) : null)
  }
  for (const p of legacy.prepare('SELECT * FROM Photo').all()) {
    target.prepare('INSERT INTO photos (id, bot_id, url, caption, tags, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING')
      .run(str(p.id), str(p.botId), str(p.url), str(p.caption), json(p.tags), iso(p.createdAt))
  }
  for (const i of legacy.prepare('SELECT * FROM ChannelIdentity').all()) {
    target.prepare('INSERT INTO channel_identities (id, user_id, channel, external_id, created_at) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING')
      .run(str(i.id, randomUUID()), str(i.userId), str(i.channel), str(i.externalId), iso(i.createdAt))
  }
  // 审计类别：新库 CHECK 只认 7 种；旧库的 call_summary 归到 heartbeat（同样属「回响」语义）
  const AUDIT_CATEGORY_MAP = { call_summary: 'heartbeat' }
  const AUDIT_CATEGORIES = ['tool_call', 'proactive_gate', 'consolidation', 'scheduled_fire', 'diary', 'heartbeat', 'growth']
  let auditRemapped = 0
  for (const a of legacy.prepare('SELECT * FROM AuditLog').all()) {
    const raw = str(a.category)
    const category = AUDIT_CATEGORY_MAP[raw] ?? (AUDIT_CATEGORIES.includes(raw) ? raw : 'tool_call')
    if (category !== raw) auditRemapped++
    target.prepare('INSERT INTO audit_logs (id, bot_id, category, action, detail, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING')
      .run(str(a.id, randomUUID()), str(a.botId), category, str(a.action), str(a.detail, '{}'), iso(a.createdAt))
  }
  if (auditRemapped > 0) console.log('[migrate] 审计类别重映射 %d 条（call_summary → heartbeat）', auditRemapped)

  // ---- 全局配置（模型配置的唯一真相源，必须带走）----
  let globalSettings = 0
  for (const g of legacy.prepare('SELECT * FROM GlobalSetting').all()) {
    target.prepare('INSERT INTO global_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(str(g.key), str(g.value))
    globalSettings++
  }

  // BindingToken：一次性绑定凭证，10 分钟时效 —— 迁移无意义（过期即废），故意跳过
  target.exec('COMMIT')
  console.log('[migrate] done →', targetPath)
  console.log('[migrate] new rows:', {
    bots: count(target, 'SELECT COUNT(*) c FROM bots'),
    messages: count(target, 'SELECT COUNT(*) c FROM messages'),
    memories: count(target, 'SELECT COUNT(*) c FROM memories'),
    contacts: count(target, 'SELECT COUNT(*) c FROM contacts'),
    globalSettings: count(target, 'SELECT COUNT(*) c FROM global_settings'),
  })
} catch (err) {
  target.exec('ROLLBACK')
  console.error('[migrate] FAILED, rolled back:', err)
  process.exit(1)
}
