/**
 * Littly 业务库 schema（SQLite, node:sqlite DatabaseSync）。
 *
 * v1 = 旧项目 prisma/schema.prisma（20 表）的关系化移植 + 记忆引擎 v2 新列
 * （event_time / provenance / volatility / supersede 链 / write receipts）。
 * 与旧库的逐列对齐在迁移里程碑用 migrate 命令核对（旧库只读）。
 *
 * 约定（docs/PRINCIPLES.md）：
 * - 记忆永不物理删除：deleted_at = 淡忘池；superseded_by/valid_until = 取代链。
 * - 衰减一律按 event_time，不按 created_at。
 */

export interface Migration {
  version: number
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  created_at TEXT NOT NULL
);

CREATE TABLE bots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  character_id TEXT,
  birthday TEXT NOT NULL DEFAULT '',
  gender TEXT NOT NULL DEFAULT '',
  appearance TEXT NOT NULL DEFAULT '',
  -- AI
  ai_model TEXT NOT NULL DEFAULT '',
  ai_temperature REAL NOT NULL DEFAULT 0.8,
  ai_max_history INTEGER NOT NULL DEFAULT 20,
  memory_scope TEXT NOT NULL DEFAULT 'global' CHECK (memory_scope IN ('global','current','free')),
  -- 拟人化
  ai_humanize_enabled INTEGER NOT NULL DEFAULT 1,
  ai_humanize_wechat INTEGER NOT NULL DEFAULT 1,
  ai_hide_thinking INTEGER NOT NULL DEFAULT 1,
  -- 主动性
  proactive_enabled INTEGER NOT NULL DEFAULT 1,
  heartbeat_enabled INTEGER NOT NULL DEFAULT 0,
  quiet_start INTEGER NOT NULL DEFAULT 23,
  quiet_end INTEGER NOT NULL DEFAULT 8,
  proactive_daily_limit INTEGER NOT NULL DEFAULT 8,
  proactive_min_interval INTEGER NOT NULL DEFAULT 7200,
  -- 记忆 / 日记
  ai_memory_consolidate_threshold INTEGER NOT NULL DEFAULT 40,
  diary_enabled INTEGER NOT NULL DEFAULT 1,
  diary_hour INTEGER NOT NULL DEFAULT 23,
  -- 多模态 / 语音 / 通话
  ai_vision_enabled INTEGER NOT NULL DEFAULT 0,
  ai_vision_base_url TEXT NOT NULL DEFAULT '',
  ai_vision_model TEXT NOT NULL DEFAULT '',
  ai_vision_api_key TEXT NOT NULL DEFAULT '',
  ai_voice_enabled INTEGER NOT NULL DEFAULT 0,
  ai_voice_model TEXT NOT NULL DEFAULT '',
  ai_voice_reference_id TEXT NOT NULL DEFAULT '',
  ai_voice_api_key TEXT NOT NULL DEFAULT '',
  ai_voice_temperature REAL NOT NULL DEFAULT 0.7,
  ai_voice_speed REAL NOT NULL DEFAULT 1.0,
  ai_call_api_key TEXT NOT NULL DEFAULT '',
  -- 睡眠
  sleep_until TEXT,
  -- 渠道：Telegram
  tg_enabled INTEGER NOT NULL DEFAULT 0,
  tg_bot_token TEXT NOT NULL DEFAULT '',
  tg_webhook_secret TEXT NOT NULL DEFAULT '',
  tg_username TEXT NOT NULL DEFAULT '',
  tg_mode TEXT NOT NULL DEFAULT 'polling' CHECK (tg_mode IN ('polling','webhook')),
  tg_last_update_id INTEGER NOT NULL DEFAULT 0,
  -- 渠道：微信（iLink 直连 + 桥接）
  wx_enabled INTEGER NOT NULL DEFAULT 0,
  wx_hub_bot_id TEXT NOT NULL DEFAULT '',
  wx_push_token TEXT NOT NULL DEFAULT '',
  wx_push_endpoint TEXT NOT NULL DEFAULT '',
  wx_verify_secret TEXT NOT NULL DEFAULT '',
  wx_friend_display_enabled INTEGER NOT NULL DEFAULT 0,
  wx_friend_alias TEXT NOT NULL DEFAULT '',
  wx_friend_qrcode TEXT NOT NULL DEFAULT '',
  -- 渠道：QQ 官方
  qq_enabled INTEGER NOT NULL DEFAULT 0,
  qq_app_id TEXT NOT NULL DEFAULT '',
  qq_app_secret TEXT NOT NULL DEFAULT '',
  qq_access_token TEXT NOT NULL DEFAULT '',
  qq_token_expires_at TEXT,
  -- 渠道：SnowLuma（QQ 账号，多账号按 self_id）
  snowluma_enabled INTEGER NOT NULL DEFAULT 0,
  snowluma_ws_url TEXT NOT NULL DEFAULT '',
  snowluma_token TEXT NOT NULL DEFAULT '',
  snowluma_account TEXT NOT NULL DEFAULT '',
  -- 渠道：Discord
  discord_enabled INTEGER NOT NULL DEFAULT 0,
  discord_bot_token TEXT NOT NULL DEFAULT '',
  discord_client_id TEXT NOT NULL DEFAULT '',
  discord_last_sequence INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE characters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  spec TEXT NOT NULL DEFAULT 'chara_card_v2' CHECK (spec IN ('chara_card_v2','mask','deepseek_persona')),
  data TEXT NOT NULL DEFAULT '{}',
  system_prompt TEXT NOT NULL DEFAULT '',
  first_mes TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '',
  style_calibration TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE world_entries (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL DEFAULT '',
  character_id TEXT NOT NULL DEFAULT '',
  keys TEXT NOT NULL DEFAULT '[]',
  second_keys TEXT NOT NULL DEFAULT '[]',
  logic INTEGER NOT NULL DEFAULT 0,
  constant INTEGER NOT NULL DEFAULT 0,
  probability REAL NOT NULL DEFAULT 85,
  priority INTEGER NOT NULL DEFAULT 100,
  position INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  content TEXT NOT NULL DEFAULT '',
  comment TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_world_entries_bot ON world_entries(bot_id, enabled);

CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  brief TEXT NOT NULL DEFAULT '',
  profile TEXT NOT NULL DEFAULT '',
  external_id TEXT NOT NULL DEFAULT '',
  is_owner INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  user_id TEXT,
  channel TEXT NOT NULL DEFAULT '',
  tg_username TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (bot_id, sender)
);

CREATE TABLE contact_relations (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  from_sender TEXT NOT NULL,
  to_sender TEXT NOT NULL,
  relation TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_relations_bot ON contact_relations(bot_id);

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  contact_id TEXT,
  sender TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'fact'
    CHECK (category IN ('profile','relationship','fact','detail','value','thought')),
  content TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 1 CHECK (importance BETWEEN 1 AND 5),
  -- v2 三层时间：衰减按 event_time
  event_time TEXT NOT NULL,
  event_time_raw TEXT NOT NULL DEFAULT '',
  recorded_at TEXT NOT NULL,
  last_verified TEXT,
  -- v2 出处与波动性
  provenance TEXT NOT NULL DEFAULT 'user-stated'
    CHECK (provenance IN ('user-stated','observed','inferred')),
  volatility TEXT NOT NULL DEFAULT 'stable' CHECK (volatility IN ('stable','state')),
  -- v2 取代链（取代裸软删；deleted_at 保留为淡忘池语义）
  superseded_by TEXT,
  valid_until TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  derived_from TEXT NOT NULL DEFAULT '[]',
  -- 向量信封 {"m":model,"v":[...]}
  embedding TEXT,
  consolidated INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  deleted_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_memories_pool ON memories(bot_id, sender, deleted_at, created_at);
CREATE INDEX idx_memories_event_time ON memories(bot_id, event_time);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content TEXT NOT NULL DEFAULT '',
  reply_type TEXT NOT NULL DEFAULT 'text' CHECK (reply_type IN ('text','image','file','voice','call')),
  reasoning TEXT NOT NULL DEFAULT '',
  delivery_status TEXT,
  buffer_status TEXT,
  buffer_fire_at TEXT,
  channel_id TEXT NOT NULL DEFAULT '',
  voice_url TEXT NOT NULL DEFAULT '',
  voice_original_text TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_messages_conv ON messages(bot_id, sender, created_at);
CREATE INDEX idx_messages_buffer ON messages(bot_id, sender, buffer_status, buffer_fire_at);

CREATE TABLE scheduled_messages (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  fire_at TEXT NOT NULL,
  tolerance INTEGER,
  strictness INTEGER NOT NULL DEFAULT 3,
  prompt TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT 'proactive',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','cancelled')),
  failure_reason TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  fired_at TEXT
);
CREATE INDEX idx_scheduled_due ON scheduled_messages(status, fire_at);

CREATE TABLE persona_rules (
  bot_id TEXT PRIMARY KEY,
  rules_text TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE diaries (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  date TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  mood TEXT NOT NULL DEFAULT '',
  snapshot TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (bot_id, date)
);

CREATE TABLE history_summaries (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  last_msg_id TEXT,
  last_msg_at TEXT,
  msg_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE (bot_id, sender)
);

CREATE TABLE growth_profiles (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  dimensions TEXT NOT NULL DEFAULT '[]',
  life_stage TEXT NOT NULL DEFAULT '',
  value_exclusions TEXT NOT NULL DEFAULT '[]',
  derived_from TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (bot_id, version)
);

CREATE TABLE growth_proposals (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  based_version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','edited','rejected','expired','cancelled')),
  changes TEXT NOT NULL DEFAULT '[]',
  evidence TEXT NOT NULL DEFAULT '[]',
  report TEXT NOT NULL DEFAULT '',
  evaluator_model TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  decided_at TEXT,
  expires_at TEXT
);
CREATE INDEX idx_growth_proposals_pending ON growth_proposals(bot_id, status);

CREATE TABLE photos (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  url TEXT NOT NULL,
  caption TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_photos_bot ON photos(bot_id, created_at);

CREATE TABLE channel_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  external_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (channel, external_id),
  UNIQUE (user_id, channel)
);

CREATE TABLE binding_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL
    CHECK (category IN ('tool_call','proactive_gate','consolidation','scheduled_fire','diary','heartbeat','growth')),
  action TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_bot ON audit_logs(bot_id, category, created_at);

CREATE TABLE global_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 记忆写入幂等回执（tori-memex 借鉴 #10）
CREATE TABLE memory_write_receipts (
  idempotency_key TEXT PRIMARY KEY,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`,
  },
  {
    // B3：内容域归属校验 —— bots 加 owner_id；升级时把现有 bot 归给最早的 admin
    // （单用户本地库升级后 admin 仍能管理一切；多用户场景下新 bot 由创建者拥有）。
    version: 2,
    sql: `
ALTER TABLE bots ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
UPDATE bots
   SET owner_id = (SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1)
 WHERE owner_id = ''
   AND EXISTS (SELECT 1 FROM users WHERE role = 'admin');
CREATE INDEX IF NOT EXISTS idx_bots_owner ON bots(owner_id);
`,
  },
  {
    // C1：相册语义化 + meme 选图协议 —— 文件指纹 / mime / 语义分类与状态。
    // 老照片保留空 sha256（meme 回退到 id），由后台 / 控制台按需重新分析。
    version: 3,
    sql: `
ALTER TABLE photos ADD COLUMN sha256 TEXT NOT NULL DEFAULT '';
ALTER TABLE photos ADD COLUMN mime TEXT NOT NULL DEFAULT '';
ALTER TABLE photos ADD COLUMN category TEXT NOT NULL DEFAULT '';
ALTER TABLE photos ADD COLUMN semantic_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE photos ADD COLUMN semantic_at TEXT;
ALTER TABLE photos ADD COLUMN semantic_error TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_photos_bot_sha ON photos(bot_id, sha256);
`,
  },
]
