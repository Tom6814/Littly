/**
 * 行类型：与 @littly/storage schema v1 的表一一对应（SQLite 文本日期 → ISO 字符串）。
 * persona / memory / console-api / channels 都以此为准，不复刻 Prisma 类型。
 */

export interface UserRow {
  id: string
  username: string
  password_hash: string
  role: 'admin' | 'user'
  created_at: string
}

export interface BotRow {
  id: string
  name: string
  /** B3：bot 归属用户 id（空串 = 仅 admin 可管理；迁移 v2 引入）。 */
  owner_id: string
  avatar: string
  system_prompt: string
  character_id: string | null
  birthday: string
  gender: string
  appearance: string
  ai_model: string
  ai_temperature: number
  ai_max_history: number
  memory_scope: 'global' | 'current' | 'free'
  ai_humanize_enabled: number
  ai_humanize_wechat: number
  ai_hide_thinking: number
  proactive_enabled: number
  heartbeat_enabled: number
  quiet_start: number
  quiet_end: number
  proactive_daily_limit: number
  proactive_min_interval: number
  ai_memory_consolidate_threshold: number
  diary_enabled: number
  diary_hour: number
  ai_vision_enabled: number
  ai_vision_base_url: string
  ai_vision_model: string
  ai_vision_api_key: string
  ai_voice_enabled: number
  ai_voice_model: string
  ai_voice_reference_id: string
  ai_voice_api_key: string
  ai_voice_temperature: number
  ai_voice_speed: number
  ai_call_api_key: string
  sleep_until: string | null
  tg_enabled: number
  tg_bot_token: string
  tg_webhook_secret: string
  tg_username: string
  tg_mode: 'polling' | 'webhook'
  tg_last_update_id: number
  wx_enabled: number
  wx_hub_bot_id: string
  wx_push_token: string
  wx_push_endpoint: string
  wx_verify_secret: string
  wx_friend_display_enabled: number
  wx_friend_alias: string
  wx_friend_qrcode: string
  qq_enabled: number
  qq_app_id: string
  qq_app_secret: string
  qq_access_token: string
  qq_token_expires_at: string | null
  snowluma_enabled: number
  snowluma_ws_url: string
  snowluma_token: string
  snowluma_account: string
  discord_enabled: number
  discord_bot_token: string
  discord_client_id: string
  discord_last_sequence: number | null
  created_at: string
}

export interface CharacterRow {
  id: string
  name: string
  spec: 'chara_card_v2' | 'mask' | 'deepseek_persona'
  data: string
  system_prompt: string
  first_mes: string
  avatar: string
  style_calibration: string
  created_at: string
}

export interface WorldEntryRow {
  id: string
  bot_id: string
  character_id: string
  keys: string
  second_keys: string
  logic: number
  constant: number
  probability: number
  priority: number
  position: number
  enabled: number
  content: string
  comment: string
}

export interface ContactRow {
  id: string
  bot_id: string
  sender: string
  name: string
  brief: string
  profile: string
  external_id: string
  is_owner: number
  blocked: number
  user_id: string | null
  channel: string
  tg_username: string
  metadata: string
  created_at: string
  updated_at: string
}

export interface ContactRelationRow {
  id: string
  bot_id: string
  from_sender: string
  to_sender: string
  relation: string
  note: string
  created_at: string
}

export interface MemoryRow {
  id: string
  bot_id: string
  contact_id: string | null
  sender: string
  category: 'profile' | 'relationship' | 'fact' | 'detail' | 'value' | 'thought'
  content: string
  importance: number
  event_time: string
  event_time_raw: string
  recorded_at: string
  last_verified: string | null
  provenance: 'user-stated' | 'observed' | 'inferred'
  volatility: 'stable' | 'state'
  superseded_by: string | null
  valid_until: string | null
  tags: string
  derived_from: string
  embedding: string | null
  consolidated: number
  deleted_at: string | null
  deleted_reason: string
  created_at: string
}

export interface MessageRow {
  id: string
  bot_id: string
  sender: string
  role: 'user' | 'assistant' | 'system'
  content: string
  reply_type: 'text' | 'image' | 'file' | 'voice' | 'call'
  reasoning: string
  delivery_status: 'sent' | 'failed' | null
  buffer_status: 'pending' | 'flushing' | 'flushed' | null
  buffer_fire_at: string | null
  channel_id: string
  voice_url: string
  voice_original_text: string
  meta: string
  created_at: string
}

export interface ScheduledMessageRow {
  id: string
  bot_id: string
  sender: string
  fire_at: string
  tolerance: number | null
  strictness: number
  prompt: string
  origin: string
  status: 'pending' | 'sent' | 'failed' | 'cancelled'
  failure_reason: string
  channel: string
  content: string
  created_at: string
  fired_at: string | null
}

export interface PersonaRuleRow {
  bot_id: string
  rules_text: string
  enabled: number
  updated_at: string
}

export interface DiaryRow {
  id: string
  bot_id: string
  date: string
  content: string
  mood: string
  snapshot: string
  created_at: string
  updated_at: string
}

export interface HistorySummaryRow {
  id: string
  bot_id: string
  sender: string
  summary: string
  last_msg_id: string | null
  last_msg_at: string | null
  msg_count: number
  updated_at: string
}

export interface GrowthProfileRow {
  id: string
  bot_id: string
  version: number
  status: 'active' | 'archived'
  dimensions: string
  life_stage: string
  value_exclusions: string
  derived_from: string | null
  created_at: string
}

export interface GrowthProposalRow {
  id: string
  bot_id: string
  based_version: number
  status: 'pending' | 'approved' | 'edited' | 'rejected' | 'expired' | 'cancelled'
  changes: string
  evidence: string
  report: string
  evaluator_model: string
  created_at: string
  decided_at: string | null
  expires_at: string | null
}

export interface PhotoRow {
  id: string
  bot_id: string
  url: string
  caption: string
  tags: string
  /** 文件内容 sha256（小写 hex；老照片为空串）。 */
  sha256: string
  /** 文件 mime（如 image/png；老照片为空串）。 */
  mime: string
  /** 语义分类（开心/无语/撒娇/生气/可爱/日常/其他；未分析为空串）。 */
  category: string
  /** 语义分析状态：none / pending / done / failed。 */
  semantic_status: 'none' | 'pending' | 'done' | 'failed'
  semantic_at: string | null
  semantic_error: string
  created_at: string
}

export interface ChannelIdentityRow {
  id: string
  user_id: string
  channel: string
  external_id: string
  created_at: string
}

export interface BindingTokenRow {
  id: string
  user_id: string
  bot_id: string
  token: string
  kind: string
  expires_at: string
  used_at: string | null
  created_at: string
}

export interface AuditLogRow {
  id: string
  bot_id: string
  category:
    | 'tool_call'
    | 'proactive_gate'
    | 'consolidation'
    | 'scheduled_fire'
    | 'diary'
    | 'heartbeat'
    | 'growth'
  action: string
  detail: string
  created_at: string
}
