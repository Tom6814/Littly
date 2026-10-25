/**
 * 行 → 前端 JSON 形态的映射，以及 bot 设置组 / 渠道配置的字段表。
 * 安全约定（旧 PROJECT-DESIGN §18.1 #1/#12）：
 * - /api/bots 列表与详情只返回白名单字段，绝不回传渠道密钥明文；
 * - settings / channels 中的密钥字段以掩码回显，PUT 时掩码或空串 = 保持不变。
 */
import type {
  BotRow, CharacterRow, ContactRow, ContactRelationRow, DiaryRow, MemoryRow, MessageRow,
  PhotoRow, ScheduledMessageRow, UserRow, WorldEntryRow,
} from '@littly/storage'

// ---- 通用 JSON 助手 ----

export function parseJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) return parsed.map((x) => String(x)).filter((x) => x !== '')
  } catch {
    // 非 JSON → 按分隔符拆
  }
  return raw.split(/[,，]/).map((x) => x.trim()).filter((x) => x !== '')
}

export function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    // ignore
  }
  return {}
}

/** 密钥掩码：非空值显示为 '••••' + 末 4 位。 */
export function maskSecret(value: string): string {
  if (value === '') return ''
  const tail = value.length > 4 ? value.slice(-4) : ''
  return `••••${tail}`
}

/** 掩码判定：PUT 侧遇到空串或含掩码点号 → 保持原值。 */
export function isMaskedInput(value: string): boolean {
  return value === '' || value.includes('•')
}

// ---- 基础行映射 ----

export function userView(row: UserRow): Record<string, unknown> {
  return { id: row.id, username: row.username, role: row.role }
}

export interface MessageView extends Record<string, unknown> {
  id: string
  role: string
  sender: string
  botId: string
  createdAt: string
  text: string
  pieces: Array<Record<string, unknown>>
}

export function messageView(row: MessageRow): MessageView {
  const meta = parseJsonObject(row.meta)
  const pieces: Array<Record<string, unknown>> = []
  if (row.voice_url !== '') {
    pieces.push({ type: 'voice', url: row.voice_url, text: row.voice_original_text || undefined })
  }
  const imageUrl = typeof meta.imageUrl === 'string' ? meta.imageUrl : ''
  if (imageUrl !== '') {
    pieces.push({ type: 'image', url: imageUrl })
  }
  const fileUrl = typeof meta.fileUrl === 'string' ? meta.fileUrl : ''
  if (fileUrl !== '') {
    pieces.push({ type: 'file', url: fileUrl, name: typeof meta.fileName === 'string' ? meta.fileName : '文件' })
  }
  pieces.push({ type: 'text', text: row.content })
  return {
    id: row.id,
    role: row.role,
    sender: row.sender,
    botId: row.bot_id,
    createdAt: row.created_at,
    text: row.content,
    pieces,
    replyType: row.reply_type,
    reasoning: row.reasoning,
    deliveryStatus: row.delivery_status,
    bufferStatus: row.buffer_status,
    bufferFireAt: row.buffer_fire_at,
  }
}

export function characterView(row: CharacterRow): Record<string, unknown> {
  const card = row.spec === 'chara_card_v2' ? parseJsonObject(row.data) : {}
  return {
    id: row.id,
    name: row.name,
    spec: row.spec,
    card,
    mask: row.spec === 'mask' ? row.data : undefined,
    deepseekPersonaTags: row.spec === 'deepseek_persona' ? row.data.split(/\n+/).map((x) => x.trim()).filter(Boolean) : [],
    systemPrompt: row.system_prompt,
    firstMes: row.first_mes,
    avatarUrl: row.avatar,
    styleCalibration: parseJsonObject(row.style_calibration),
    preset: false,
    createdAt: row.created_at,
  }
}

export function worldEntryView(row: WorldEntryRow): Record<string, unknown> {
  const logicNames = ['AND_ANY', 'NOT_ALL', 'NOT_ANY', 'AND_ALL']
  return {
    id: row.id,
    botId: row.bot_id,
    characterId: row.character_id,
    keys: parseJsonArray(row.keys),
    secondKeys: parseJsonArray(row.second_keys),
    logic: logicNames[row.logic] ?? 'AND_ANY',
    probability: row.probability,
    priority: row.priority,
    position: row.position === 0 ? 'before' : 'after',
    constant: row.constant === 1,
    enabled: row.enabled === 1,
    content: row.content,
    comment: row.comment,
  }
}

export function contactView(row: ContactRow): Record<string, unknown> {
  return {
    id: row.sender,
    rowId: row.id,
    botId: row.bot_id,
    sender: row.sender,
    name: row.name || row.sender,
    brief: row.brief,
    profile: row.profile === '' ? undefined : parseJsonObject(row.profile),
    isOwner: row.is_owner === 1,
    blocked: row.blocked === 1,
    channel: row.channel,
    externalId: row.external_id,
    userId: row.user_id,
    lastActiveAt: row.updated_at,
    createdAt: row.created_at,
  }
}

export function relationView(row: ContactRelationRow, nameBySender: Map<string, string>): Record<string, unknown> {
  return {
    id: row.id,
    botId: row.bot_id,
    fromContactId: row.from_sender,
    toContactId: row.to_sender,
    fromName: nameBySender.get(row.from_sender) ?? row.from_sender,
    toName: nameBySender.get(row.to_sender) ?? row.to_sender,
    type: row.relation,
    description: row.note,
    createdAt: row.created_at,
  }
}

export function memoryView(row: MemoryRow, protectedIds?: ReadonlySet<string>): Record<string, unknown> {
  return {
    ...(protectedIds?.has(row.id) === true ? { protected: true } : {}),
    id: row.id,
    botId: row.bot_id,
    sender: row.sender,
    category: row.category,
    importance: row.importance,
    eventTime: row.event_time,
    eventTimeRaw: row.event_time_raw,
    recordedAt: row.recorded_at,
    provenance: row.provenance,
    volatility: row.volatility,
    content: row.content,
    tags: parseJsonArray(row.tags),
    supersededBy: row.superseded_by,
    validUntil: row.valid_until,
    consolidated: row.consolidated === 1,
    deletedAt: row.deleted_at,
    deletedReason: row.deleted_reason,
    createdAt: row.created_at,
  }
}

export function diaryView(row: DiaryRow): Record<string, unknown> {
  return { id: row.id, botId: row.bot_id, date: row.date, content: row.content, mood: row.mood, createdAt: row.created_at }
}

export function photoView(row: PhotoRow): Record<string, unknown> {
  return { id: row.id, botId: row.bot_id, url: row.url, caption: row.caption, tags: parseJsonArray(row.tags), createdAt: row.created_at }
}

export function scheduledView(row: ScheduledMessageRow): Record<string, unknown> {
  return {
    id: row.id,
    botId: row.bot_id,
    sender: row.sender,
    fireAt: row.fire_at,
    tolerance: row.tolerance,
    strictness: row.strictness,
    prompt: row.prompt,
    origin: row.origin,
    status: row.status,
    failureReason: row.failure_reason,
    channel: row.channel,
    createdAt: row.created_at,
    firedAt: row.fired_at,
  }
}

// ---- Bot 白名单视图（绝不包含渠道密钥）----

export function botSummaryView(row: BotRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    avatarUrl: row.avatar,
    createdAt: row.created_at,
  }
}

// ---- Bot 设置组（组名 → 字段名 → 列）----

export interface SettingField {
  key: string
  column: keyof BotRow
  secret?: boolean
}

export const BOT_SETTING_GROUPS: Array<{ group: string; fields: SettingField[] }> = [
  {
    group: 'profile',
    fields: [
      { key: 'birthday', column: 'birthday' },
      { key: 'gender', column: 'gender' },
      { key: 'appearance', column: 'appearance' },
      { key: 'systemPrompt', column: 'system_prompt' },
    ],
  },
  {
    group: 'ai',
    fields: [
      { key: 'model', column: 'ai_model' },
      { key: 'temperature', column: 'ai_temperature' },
      { key: 'maxHistory', column: 'ai_max_history' },
      { key: 'memoryScope', column: 'memory_scope' },
      { key: 'hideThinking', column: 'ai_hide_thinking' },
      { key: 'visionEnabled', column: 'ai_vision_enabled' },
      { key: 'visionBaseURL', column: 'ai_vision_base_url' },
      { key: 'visionModel', column: 'ai_vision_model' },
      { key: 'visionApiKey', column: 'ai_vision_api_key', secret: true },
    ],
  },
  {
    group: 'humanize',
    fields: [
      { key: 'enabled', column: 'ai_humanize_enabled' },
      { key: 'wechatStyle', column: 'ai_humanize_wechat' },
    ],
  },
  {
    group: 'proactive',
    fields: [
      { key: 'enabled', column: 'proactive_enabled' },
      { key: 'heartbeatEnabled', column: 'heartbeat_enabled' },
      { key: 'quietStart', column: 'quiet_start' },
      { key: 'quietEnd', column: 'quiet_end' },
      { key: 'dailyLimit', column: 'proactive_daily_limit' },
      { key: 'minInterval', column: 'proactive_min_interval' },
    ],
  },
  {
    group: 'memory',
    fields: [{ key: 'consolidateThreshold', column: 'ai_memory_consolidate_threshold' }],
  },
  {
    group: 'diary',
    fields: [
      { key: 'enabled', column: 'diary_enabled' },
      { key: 'hour', column: 'diary_hour' },
    ],
  },
  {
    group: 'voice',
    fields: [
      { key: 'enabled', column: 'ai_voice_enabled' },
      { key: 'model', column: 'ai_voice_model' },
      { key: 'referenceId', column: 'ai_voice_reference_id' },
      { key: 'temperature', column: 'ai_voice_temperature' },
      { key: 'speed', column: 'ai_voice_speed' },
      { key: 'apiKey', column: 'ai_voice_api_key', secret: true },
    ],
  },
  {
    group: 'call',
    fields: [{ key: 'apiKey', column: 'ai_call_api_key', secret: true }],
  },
]

/** bot 行 → 嵌套 settings（布尔 0/1 → boolean；密钥打码）。 */
export function botSettingsView(row: BotRow): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const g of BOT_SETTING_GROUPS) {
    const groupObj: Record<string, unknown> = {}
    for (const f of g.fields) {
      const raw = row[f.column]
      if (f.secret === true && typeof raw === 'string') {
        groupObj[f.key] = maskSecret(raw)
        groupObj[`${f.key}Set`] = raw !== ''
      } else if (typeof raw === 'number') {
        groupObj[f.key] = raw === 0 || raw === 1 ? raw === 1 : raw
      } else if (typeof raw === 'string') {
        groupObj[f.key] = raw
      }
    }
    out[g.group] = groupObj
  }
  out['effective'] = {
    model: row.ai_model,
    temperature: row.ai_temperature,
    maxHistory: row.ai_max_history,
    memoryScope: row.memory_scope,
  }
  return out
}

/** PATCH settings：把嵌套组写回列；密钥字段空串/掩码保持不变。 */
export function applyBotSettingsPatch(row: BotRow, settings: Record<string, unknown>): { columns: string[]; values: unknown[] } {
  const columns: string[] = []
  const values: unknown[] = []
  for (const g of BOT_SETTING_GROUPS) {
    const groupVal = settings[g.group]
    if (typeof groupVal !== 'object' || groupVal === null || Array.isArray(groupVal)) continue
    const rec = groupVal as Record<string, unknown>
    for (const f of g.fields) {
      if (!(f.key in rec)) continue
      const incoming = rec[f.key]
      if (f.secret === true) {
        if (typeof incoming !== 'string' || isMaskedInput(incoming)) continue
        columns.push(String(f.column))
        values.push(incoming)
        continue
      }
      const columnType = typeof row[f.column]
      if (columnType === 'number') {
        const num = typeof incoming === 'number' ? incoming : typeof incoming === 'boolean' ? (incoming ? 1 : 0) : Number(incoming)
        if (Number.isFinite(num)) {
          columns.push(String(f.column))
          values.push(num)
        }
      } else if (typeof incoming === 'string') {
        columns.push(String(f.column))
        values.push(incoming)
      }
    }
  }
  return { columns, values }
}

// ---- 渠道配置（渠道名 → 字段名 → 列）----

export const BOT_CHANNEL_GROUPS: Array<{ channel: string; fields: SettingField[] }> = [
  {
    channel: 'telegram',
    fields: [
      { key: 'enabled', column: 'tg_enabled' },
      { key: 'botToken', column: 'tg_bot_token', secret: true },
      { key: 'webhookSecret', column: 'tg_webhook_secret', secret: true },
      { key: 'username', column: 'tg_username' },
      { key: 'mode', column: 'tg_mode' },
    ],
  },
  {
    channel: 'snowluma',
    fields: [
      { key: 'enabled', column: 'snowluma_enabled' },
      { key: 'wsUrl', column: 'snowluma_ws_url' },
      { key: 'token', column: 'snowluma_token', secret: true },
      { key: 'account', column: 'snowluma_account' },
    ],
  },
  {
    channel: 'qq',
    fields: [
      { key: 'enabled', column: 'qq_enabled' },
      { key: 'appId', column: 'qq_app_id' },
      { key: 'appSecret', column: 'qq_app_secret', secret: true },
      { key: 'accessToken', column: 'qq_access_token', secret: true },
    ],
  },
  {
    channel: 'discord',
    fields: [
      { key: 'enabled', column: 'discord_enabled' },
      { key: 'botToken', column: 'discord_bot_token', secret: true },
      { key: 'clientId', column: 'discord_client_id' },
    ],
  },
  {
    channel: 'wechat',
    fields: [
      { key: 'enabled', column: 'wx_enabled' },
      { key: 'hubBotId', column: 'wx_hub_bot_id' },
      { key: 'pushToken', column: 'wx_push_token', secret: true },
      { key: 'pushEndpoint', column: 'wx_push_endpoint' },
      { key: 'verifySecret', column: 'wx_verify_secret', secret: true },
      { key: 'friendDisplayEnabled', column: 'wx_friend_display_enabled' },
      { key: 'friendAlias', column: 'wx_friend_alias' },
      { key: 'friendQrcode', column: 'wx_friend_qrcode' },
    ],
  },
]

/** bot 行 → 渠道配置（密钥打码 + hasToken 布尔）。 */
export function botChannelsView(row: BotRow): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const g of BOT_CHANNEL_GROUPS) {
    const channelObj: Record<string, unknown> = {}
    let hasToken = false
    for (const f of g.fields) {
      const raw = row[f.column]
      if (f.secret === true && typeof raw === 'string') {
        channelObj[f.key] = maskSecret(raw)
        if (raw !== '') hasToken = true
        continue
      }
      if (typeof raw === 'number') {
        channelObj[f.key] = raw === 0 || raw === 1 ? raw === 1 : raw
      } else if (typeof raw === 'string') {
        channelObj[f.key] = raw
      }
    }
    channelObj['hasToken'] = hasToken
    out[g.channel] = channelObj
  }
  return out
}

/** PUT channels：写回列；密钥字段空串/掩码保持不变。 */
export function applyBotChannelsPatch(row: BotRow, channels: Record<string, unknown>): { columns: string[]; values: unknown[] } {
  const columns: string[] = []
  const values: unknown[] = []
  for (const g of BOT_CHANNEL_GROUPS) {
    const channelVal = channels[g.channel]
    if (typeof channelVal !== 'object' || channelVal === null || Array.isArray(channelVal)) continue
    const rec = channelVal as Record<string, unknown>
    for (const f of g.fields) {
      if (!(f.key in rec)) continue
      const incoming = rec[f.key]
      if (f.secret === true) {
        if (typeof incoming !== 'string' || isMaskedInput(incoming)) continue
        columns.push(String(f.column))
        values.push(incoming)
        continue
      }
      const columnType = typeof row[f.column]
      if (columnType === 'number') {
        const num = typeof incoming === 'number' ? incoming : typeof incoming === 'boolean' ? (incoming ? 1 : 0) : Number(incoming)
        if (Number.isFinite(num)) {
          columns.push(String(f.column))
          values.push(num)
        }
      } else if (typeof incoming === 'string') {
        columns.push(String(f.column))
        values.push(incoming)
      }
    }
  }
  return { columns, values }
}
