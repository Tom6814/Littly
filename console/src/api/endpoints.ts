/**
 * 端点清单 + 类型化封装 —— 只读盘点自 console-api/src/routes-*.ts（2026-10-31）。
 * 页面只调用这里的函数，不直接 fetch。onboarding / wechat 两族按 SPEC §2/§3
 * 契约先写好，后端未就绪时上层自动降级（mock 或 404 探测）。
 *
 * 盘点台账（全部 93 个 handler 的分组）：
 *   auth      POST /api/auth/register|login|logout, GET /api/auth/session
 *   bots      GET/POST /api/bots, GET/PATCH/DELETE /api/bots/:id,
 *             GET/PUT /api/bots/:id/channels
 *   chat      POST /api/chat, /api/chat/buffer[/flush], /api/chat/regenerate,
 *             /api/chat/edit, GET /api/messages, DELETE /api/messages/:id,
 *             POST /api/messages/:id/restore, GET /api/conversations,
 *             GET /api/stream (SSE), /api/stream helpers
 *   content   GET/POST/PATCH/DELETE /api/characters(+/import-png, /:id/export-png,
 *             /:id/avatar, /presets), /api/world-entries(+/test)
 *   data      contacts, relations, memories(+/explain,restore,consolidate),
 *             diaries(+/write), photos, scheduled-messages
 *   admin     persona-rules, settings/ai, settings/platform, growth(+/proposals),
 *             plugins(+/install,remove,enable,mcp,tools), bili/status,qr,cmd,
 *             debug/system-prompt, debug/audit, stats/activity, search, seed
 *   bind      POST /api/bind/:channel/code, GET /api/bind/status,
 *             POST /api/bind/unbind
 *   onboarding (契约，bugfix 实现中) GET /api/onboarding, POST /api/onboarding/test-model,
 *             POST /api/onboarding/complete
 *   wechat     (契约，wechat 实现中) POST /api/wechat/qr, GET /api/wechat/qr/:sessionId,
 *             GET /api/wechat/status, POST /api/wechat/friend-qr, POST /api/wechat/logout
 */
import { ApiError, asBool, asNum, asStr, firstOf, http, isRecord, pickArray, pickRecord, readErrorEnvelope } from './client'
import type {
  ActivityStats,
  AiSettings,
  BindCode,
  BindStatusItem,
  Bot,
  BufferStatus,
  ChannelConfig,
  Character,
  ChatMessage,
  ChatResponse,
  Conversation,
  OnboardingState,
  PlatformSettings,
  PluginsData,
  TestModelResult,
  User,
  WechatQrPoll,
  WechatQrSession,
  WechatStatus,
} from './types'

/* ---------------- 窄化助手 ---------------- */

function toUser(v: unknown): User | undefined {
  if (!isRecord(v)) return undefined
  const id = asStr(firstOf(v, 'id', 'userId', 'uid'))
  const username = asStr(firstOf(v, 'username', 'name'))
  if (!id && !username) return undefined
  return { id: id ?? username ?? '', username: username ?? id ?? '', role: asStr(v.role) }
}

function toMessage(v: unknown): ChatMessage | undefined {
  if (!isRecord(v)) return undefined
  const id = asStr(v.id)
  if (!id) return undefined
  const pieces = pickArray(v, 'pieces').filter(isRecord).map((p) => ({
    type: asStr(p.type) ?? 'text',
    text: asStr(p.text),
    url: asStr(p.url),
    name: asStr(p.name),
  }))
  return {
    id,
    role: asStr(v.role) ?? 'user',
    sender: asStr(v.sender) ?? '',
    botId: asStr(firstOf(v, 'botId', 'bot_id')) ?? '',
    createdAt: asStr(firstOf(v, 'createdAt', 'created_at')) ?? '',
    text: asStr(v.text) ?? asStr(v.content) ?? '',
    pieces,
    replyType: asStr(v.replyType),
    reasoning: asStr(v.reasoning),
    deliveryStatus: asStr(v.deliveryStatus),
    bufferStatus: asStr(v.bufferStatus),
    bufferFireAt: asStr(v.bufferFireAt),
  }
}

function toBot(v: unknown): Bot | undefined {
  if (!isRecord(v)) return undefined
  const id = asStr(firstOf(v, 'id', 'botId'))
  const name = asStr(firstOf(v, 'name', 'botName'))
  if (!id && !name) return undefined
  return {
    id: id ?? name ?? '',
    name: name ?? id ?? '',
    avatarUrl: asStr(firstOf(v, 'avatarUrl', 'avatar')),
    createdAt: asStr(firstOf(v, 'createdAt', 'created_at')),
    settings: pickRecord(v, 'settings'),
  }
}

/* ---------------- auth ---------------- */

export const authApi = {
  /** GET /api/auth/session → 当前用户；未登录 401。 */
  async session(): Promise<User | null> {
    const out = await http.get<unknown>('/api/auth/session', undefined, {
      silentUnauthorized: true,
      allowAnyStatus: true,
    })
    // 非 2xx（未登录）：{__status, __body} → 视为未登录。
    if (isRecord(out) && typeof out.__status === 'number') return null
    // 成功信封已解包为 { user }；也兼容裸 user 对象。
    const rec = isRecord(out) ? out : {}
    return toUser(rec.user ?? out) ?? null
  },
  async login(username: string, password: string): Promise<User> {
    const out = await http.post<unknown>('/api/auth/login', { username, password })
    const user = toUser(isRecord(out) ? (out.user ?? out) : out)
    if (!user) throw new ApiError(500, 'bad_response', '登录响应格式异常')
    return user
  },
  async register(username: string, password: string): Promise<User> {
    const out = await http.post<unknown>('/api/auth/register', { username, password })
    const user = toUser(isRecord(out) ? (out.user ?? out) : out)
    if (!user) throw new ApiError(500, 'bad_response', '注册响应格式异常')
    return user
  },
  async logout(): Promise<void> {
    await http.post('/api/auth/logout')
  },
}

/* ---------------- onboarding ---------------- */

export const onboardingApi = {
  /** GET /api/onboarding → {completed, steps:{model,persona,wechat}}。 */
  async get(): Promise<OnboardingState> {
    const out = await http.get<unknown>('/api/onboarding', undefined, {
      silentUnauthorized: true,
      allowAnyStatus: true,
    })
    if (isRecord(out) && typeof out.__status === 'number') {
      throw new ApiError(out.__status as number, 'onboarding_unavailable', '引导接口暂不可用')
    }
    const rec = isRecord(out) ? out : {}
    const steps = pickRecord(rec, 'steps') ?? {}
    return {
      completed: asBool(rec.completed) ?? false,
      steps: {
        model: asBool(steps.model),
        persona: asBool(steps.persona),
        wechat: asBool(steps.wechat),
      },
      source: 'api',
    }
  },
  /** POST /api/onboarding/test-model → {ok, latencyMs, error?}。 */
  async testModel(input: { baseUrl: string; apiKey: string; model: string }): Promise<TestModelResult> {
    const out = await http.post<unknown>('/api/onboarding/test-model', input, {
      allowAnyStatus: true,
    })
    const rec = isRecord(out) ? (pickRecord(out.__body, 'data') ?? out) : {}
    return {
      ok: asBool(rec.ok) ?? asBool(pickRecord(rec, 'data')?.ok) ?? false,
      latencyMs: asNum(rec.latencyMs ?? pickRecord(rec, 'data')?.latencyMs),
      error: asStr(rec.error ?? pickRecord(rec, 'data')?.error),
      model: asStr(rec.model),
    }
  },
  /** POST /api/onboarding/complete → 写 global_settings.onboarding。 */
  async complete(): Promise<void> {
    await http.post('/api/onboarding/complete')
  },
}

/* ---------------- bots ---------------- */

export const botsApi = {
  async list(): Promise<Bot[]> {
    const out = await http.get<unknown>('/api/bots')
    const rec = isRecord(out) ? out : {}
    return pickArray(rec, 'bots')
      .map(toBot)
      .filter((b): b is Bot => b !== undefined)
  },
  async get(id: string): Promise<Bot | undefined> {
    const out = await http.get<unknown>(`/api/bots/${encodeURIComponent(id)}`)
    const rec = isRecord(out) ? out : {}
    return toBot(rec.bot ?? rec)
  },
  async channels(id: string): Promise<Record<string, ChannelConfig>> {
    const out = await http.get<unknown>(`/api/bots/${encodeURIComponent(id)}/channels`)
    const rec = pickRecord(out, 'channels') ?? (isRecord(out) ? out : {})
    const result: Record<string, ChannelConfig> = {}
    for (const [k, v] of Object.entries(rec)) {
      if (isRecord(v)) result[k] = v as ChannelConfig
    }
    return result
  },
  async saveChannels(id: string, channels: Record<string, unknown>): Promise<void> {
    await http.put(`/api/bots/${encodeURIComponent(id)}/channels`, { channels })
  },
  async patch(id: string, patch: Record<string, unknown>): Promise<Bot | undefined> {
    const out = await http.patch<unknown>(`/api/bots/${encodeURIComponent(id)}`, { settings: patch })
    const rec = isRecord(out) ? out : {}
    return toBot(rec.bot ?? rec)
  },
}

/* ---------------- chat ---------------- */

function toChatResponse(v: unknown): ChatResponse {
  const rec = isRecord(v) ? v : {}
  const messages = pickArray(rec, 'messages')
    .map(toMessage)
    .filter((m): m is ChatMessage => m !== undefined)
  return {
    messages,
    reply: asStr(rec.reply) ?? '',
    toolCalls: pickArray(rec, 'toolCalls'),
    thinkingLength: asNum(rec.thinkingLength) ?? 0,
    silent: asBool(rec.silent) ?? false,
  }
}

export const chatApi = {
  async send(input: { botId: string; text: string; sender?: string }): Promise<ChatResponse> {
    const out = await http.post<unknown>('/api/chat', input)
    return toChatResponse(out)
  },
  async regenerate(input: { botId: string; sender?: string }): Promise<ChatResponse> {
    const out = await http.post<unknown>('/api/chat/regenerate', input)
    return toChatResponse(out)
  },
  async edit(input: { botId: string; messageId: string; text?: string; sender?: string }): Promise<ChatResponse> {
    const out = await http.post<unknown>('/api/chat/edit', input)
    return toChatResponse(out)
  },
  async messages(input: { botId: string; sender?: string; limit?: number }): Promise<ChatMessage[]> {
    const out = await http.get<unknown>('/api/messages', input)
    const rec = isRecord(out) ? out : {}
    return pickArray(rec, 'messages')
      .map(toMessage)
      .filter((m): m is ChatMessage => m !== undefined)
  },
  async conversations(botId: string): Promise<Conversation[]> {
    const out = await http.get<unknown>('/api/conversations', { botId })
    const rec = isRecord(out) ? out : {}
    return pickArray(rec, 'conversations').filter(isRecord).map((c) => ({
      sender: asStr(c.sender) ?? '',
      name: asStr(c.name) ?? asStr(c.sender) ?? '',
      isOwner: asBool(c.isOwner) ?? false,
      messageCount: asNum(c.messageCount) ?? 0,
      lastMessage: toMessage(c.lastMessage) ?? ({} as ChatMessage),
      lastAt: asStr(c.lastAt) ?? '',
    }))
  },
  async removeMessage(id: string): Promise<void> {
    await http.del(`/api/messages/${encodeURIComponent(id)}`)
  },
  async restoreMessage(id: string): Promise<void> {
    await http.post(`/api/messages/${encodeURIComponent(id)}/restore`)
  },
  async buffer(input: { botId: string; sender?: string }): Promise<BufferStatus> {
    const out = await http.get<unknown>('/api/chat/buffer', input)
    const rec = isRecord(out) ? out : {}
    return {
      buffered: asBool(rec.buffered) ?? false,
      fireAt: asStr(rec.fireAt),
      count: asNum(rec.count) ?? 0,
    }
  },
  async flushBuffer(input: { botId: string; sender?: string }): Promise<ChatResponse> {
    const out = await http.post<unknown>('/api/chat/buffer/flush', input)
    return toChatResponse(out)
  },
  /** SSE 流地址（EventSource 同源走 Cookie）。 */
  streamUrl(input: { botId: string; sender: string }): string {
    const qs = new URLSearchParams({ botId: input.botId, sender: input.sender })
    return `/api/stream?${qs.toString()}`
  },
}

/* ---------------- 语音通话来电（voice-call 主动来电队列） ---------------- */

export interface PendingCall {
  id: string
  botId: string
  sender: string
  reason?: string
  topic?: string
  createdAt?: string
}

export const callApi = {
  /** GET /api/call/requests?botId= → 未接来电（普通用户只看自己的）。 */
  async requests(botId: string): Promise<PendingCall[]> {
    const out = await http.get<unknown>('/api/call/requests', { botId })
    const rec = isRecord(out) ? out : {}
    return pickArray(rec, 'calls')
      .filter(isRecord)
      .map((c) => ({
        id: asStr(c.id) ?? '',
        botId: asStr(c.botId) ?? '',
        sender: asStr(c.sender) ?? '',
        reason: asStr(c.reason),
        topic: asStr(c.topic),
        createdAt: asStr(c.createdAt),
      }))
      .filter((c) => c.id !== '')
  },
  /** POST /api/call/requests/:id/accept → 消费来电请求（拿不到则 404/403）。 */
  async accept(id: string): Promise<PendingCall | null> {
    const out = await http.post<unknown>(`/api/call/requests/${encodeURIComponent(id)}/accept`)
    const rec = pickRecord(out, 'call') ?? (isRecord(out) ? out : {})
    if (!isRecord(rec)) return null
    const callId = asStr(rec.id)
    if (!callId) return null
    return {
      id: callId,
      botId: asStr(rec.botId) ?? '',
      sender: asStr(rec.sender) ?? '',
      reason: asStr(rec.reason),
      topic: asStr(rec.topic),
      createdAt: asStr(rec.createdAt),
    }
  },
}

/* ---------------- X（Twitter） ---------------- */

export interface XStatus {
  /** 是否已保存 auth_token/ct0（为 true 才可能登录成功）。 */
  configured: boolean
  username: string
  loggedInAt: string
  allowWrites: boolean
  /** twitter-cli 可执行文件路径（后端配置）。 */
  bin: string
  /** 二进制是否可执行（后端 60s 缓存 `twitter --version` 结果）。 */
  binOk: boolean
  /** 接口本身是否可用（404/未就绪时为 false，页面据此降级）。 */
  available: boolean
}

export interface XProbe {
  ok: boolean
  username?: string
  error?: string
}

export interface XCmdResult {
  ok: boolean
  output: string
  error?: string
}

function toXStatus(v: unknown, available = true): XStatus {
  if (isRecord(v) && typeof v.__status === 'number') {
    return { configured: false, username: '', loggedInAt: '', allowWrites: false, bin: '', binOk: false, available: false }
  }
  const rec = isRecord(v) ? v : {}
  return {
    configured: asBool(rec.configured) ?? false,
    username: asStr(rec.username) ?? '',
    loggedInAt: asStr(rec.loggedInAt) ?? asStr(rec.logged_in_at) ?? '',
    allowWrites: asBool(rec.allowWrites) ?? false,
    bin: asStr(rec.bin) ?? '',
    binOk: asBool(rec.binOk) ?? false,
    available,
  }
}

export const xApi = {
  /** GET /api/x/status（required）→ 状态（绝不回传 token）。 */
  async status(): Promise<XStatus> {
    const out = await http.get<unknown>('/api/x/status', undefined, {
      silentUnauthorized: true,
      allowAnyStatus: true,
    })
    if (isRecord(out) && typeof out.__status === 'number') {
      return toXStatus(null, false)
    }
    return toXStatus(out, true)
  },
  /** POST /api/x/login（admin）{cookie? | authToken+ct0, proxy?} → status。 */
  async login(input: { cookie?: string; authToken?: string; ct0?: string; proxy?: string }): Promise<XStatus> {
    const out = await http.post<unknown>('/api/x/login', input)
    return toXStatus(out, true)
  },
  /** POST /api/x/logout（admin）→ 清凭据。 */
  async logout(): Promise<void> {
    await http.post('/api/x/logout')
  },
  /** PUT /api/x/settings（admin）{allowWrites?, proxy?}。 */
  async saveSettings(input: { allowWrites?: boolean; proxy?: string }): Promise<void> {
    await http.put('/api/x/settings', input)
  },
  /** POST /api/x/probe（required）→ 跑 `twitter status`，验证登录是否有效。 */
  async probe(): Promise<XProbe> {
    const out = await http.post<unknown>('/api/x/probe', undefined, { allowAnyStatus: true })
    const rec = isRecord(out) && isRecord(out.__body) ? (pickRecord(out.__body, 'data') ?? {}) : pickRecord(out) ?? {}
    const ok = asBool(rec.ok) ?? false
    return {
      ok,
      username: asStr(rec.username),
      error: asStr(rec.error) ?? asStr(rec.message),
    }
  },
  /** POST /api/x/cmd（required）{argv, dryRun?} → 只读预览（写命令默认预演）。 */
  async cmd(argv: string[], dryRun = false): Promise<XCmdResult> {
    const out = await http.post<unknown>('/api/x/cmd', { argv, dryRun }, { allowAnyStatus: true })
    if (isRecord(out) && typeof out.__status === 'number') {
      return { ok: false, output: '', error: readErrorEnvelope(out.__body).message }
    }
    const rec = isRecord(out) ? out : {}
    const output =
      typeof rec.output === 'string'
        ? rec.output
        : JSON.stringify(rec.data ?? rec.result ?? rec, null, 2)
    return {
      ok: asBool(rec.ok) ?? true,
      output,
      error: asStr(rec.error) ?? undefined,
    }
  },
}

/* ---------------- QQ（SnowLuma OneBot v11 + 官方 QQBot，@littly/channel-qq） ---------------- */

export interface QqChannelState {
  enabled: boolean
  configured: boolean
  connected: boolean
  selfId: string
  nickname: string
  lastError: string
  /** ISO 时间（后端可能给毫秒时间戳，这里统一转 ISO）。 */
  lastEventAt: string
  /** SnowLuma：已保存的 OneBot ws 地址 / 是否已存 token。 */
  wsUrl: string
  hasToken: boolean
  /** 官方 QQBot：已保存的 AppID / 是否已存 secret。 */
  appId: string
  hasSecret: boolean
}

export interface QqStatus {
  /** 接口是否可用（404/未就绪 false，页面据此静默降级）。 */
  available: boolean
  snowluma: QqChannelState
  qqbot: QqChannelState
}

export interface QqProbeResult {
  ok: boolean
  selfId: string
  nickname: string
  error: string
}

function emptyQqChannel(): QqChannelState {
  return {
    enabled: false,
    configured: false,
    connected: false,
    selfId: '',
    nickname: '',
    lastError: '',
    lastEventAt: '',
    wsUrl: '',
    hasToken: false,
    appId: '',
    hasSecret: false,
  }
}

function asIsoTime(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return new Date(v).toISOString()
  if (typeof v === 'string' && v !== '') {
    const t = Date.parse(v)
    return Number.isFinite(t) ? new Date(t).toISOString() : v
  }
  return ''
}

function toQqChannel(v: unknown): QqChannelState {
  const rec = isRecord(v) ? v : {}
  return {
    enabled: asBool(rec.enabled) ?? false,
    configured: asBool(rec.configured) ?? false,
    connected: asBool(rec.connected) ?? false,
    selfId: asStr(rec.selfId) ?? asStr(rec.self_id) ?? '',
    nickname: asStr(rec.nickname) ?? '',
    lastError: asStr(rec.lastError) ?? '',
    lastEventAt: asIsoTime(rec.lastEventAt),
    wsUrl: asStr(rec.wsUrl) ?? '',
    hasToken: asBool(rec.hasToken) ?? false,
    appId: asStr(rec.appId) ?? '',
    hasSecret: asBool(rec.hasSecret) ?? false,
  }
}

function emptyQqStatus(available = false): QqStatus {
  return { available, snowluma: emptyQqChannel(), qqbot: emptyQqChannel() }
}

export const qqApi = {
  /** GET /api/qq/status（required）→ 两个渠道的 {enabled,connected,selfId?,lastError?,lastEventAt?}。 */
  async status(): Promise<QqStatus> {
    const out = await http.get<unknown>('/api/qq/status', undefined, {
      silentUnauthorized: true,
      allowAnyStatus: true,
    })
    if (isRecord(out) && typeof out.__status === 'number') return emptyQqStatus(false)
    const rec = isRecord(out) ? out : {}
    return {
      available: true,
      snowluma: toQqChannel(rec.snowluma),
      qqbot: toQqChannel(rec.qqbot),
    }
  },
  /** PUT /api/qq/snowluma（admin）{enabled, wsUrl?, token?}（token 空=不变）。 */
  async saveSnowluma(input: { enabled: boolean; wsUrl?: string; token?: string }): Promise<void> {
    await http.put('/api/qq/snowluma', input)
  },
  /** PUT /api/qq/qqbot（admin）{enabled, appId, appSecret?}（appSecret 空=不变）。 */
  async saveQqbot(input: { enabled: boolean; appId: string; appSecret?: string }): Promise<void> {
    await http.put('/api/qq/qqbot', input)
  },
  /** POST /api/qq/probe（required）{kind} → 真实连接探测。 */
  async probe(kind: 'snowluma' | 'qqbot'): Promise<QqProbeResult> {
    const out = await http.post<unknown>('/api/qq/probe', { kind }, { allowAnyStatus: true })
    if (isRecord(out) && typeof out.__status === 'number') {
      return { ok: false, selfId: '', nickname: '', error: readErrorEnvelope(out.__body).message }
    }
    const rec = isRecord(out) ? out : {}
    return {
      ok: asBool(rec.ok) ?? false,
      selfId: asStr(rec.selfId) ?? asStr(rec.self_id) ?? '',
      nickname: asStr(rec.nickname) ?? '',
      error: asStr(rec.error) ?? asStr(rec.message) ?? '',
    }
  },
  /**
   * GET /api/qq/logs?tail=N（admin）→ 适配器环形缓冲日志（后端脱敏）。
   * 后端行对象：{at, level, text}；这里渲染成 "[时间] LEVEL text" 单行文本。
   */
  async logs(tail = 100): Promise<string[]> {
    const out = await http.get<unknown>('/api/qq/logs', { tail })
    const rec = isRecord(out) ? out : {}
    const lines = pickArray(rec, 'logs', 'lines')
    if (lines.length > 0) {
      return lines
        .map((line) => {
          if (typeof line === 'string') return line
          const o = isRecord(line) ? line : {}
          const text = asStr(o.text) ?? ''
          const at = asStr(o.at) ?? ''
          const level = (asStr(o.level) ?? '').toUpperCase()
          return `${at ? `[${at}] ` : ''}${level ? `${level} ` : ''}${text}`.trim()
        })
        .filter((line) => line !== '')
    }
    if (typeof rec.logs === 'string') return rec.logs.split('\n')
    if (typeof out === 'string') return out.split('\n')
    return []
  },
}

/* ---------------- settings（模型 / 语音 / 通用） ---------------- */

export const settingsApi = {
  /** 出参：{baseURL, apiKey(打码), apiKeySet, chatModel, growthModel, webSearch, embedding, image} */
  async getAi(): Promise<AiSettings> {
    const out = await http.get<unknown>('/api/settings/ai')
    return (pickRecord(out, 'settings', 'ai') ?? (isRecord(out) ? out : {})) as AiSettings
  },
  /** 入参用后端字段名；打码的 apiKey 传回不会覆盖原值。 */
  async saveAi(settings: AiSettings): Promise<void> {
    await http.put('/api/settings/ai', settings)
  },
  async getPlatform(): Promise<PlatformSettings> {
    const out = await http.get<unknown>('/api/settings/platform')
    return (pickRecord(out, 'settings', 'platform') ?? (isRecord(out) ? out : {})) as PlatformSettings
  },
  async savePlatform(settings: PlatformSettings): Promise<void> {
    await http.put('/api/settings/platform', settings)
  },
}

/* ---------------- characters（/her/character） ---------------- */

export const charactersApi = {
  async list(): Promise<Character[]> {
    const out = await http.get<unknown>('/api/characters')
    const rec = isRecord(out) ? out : {}
    return pickArray(rec, 'characters').filter(isRecord).map((c) => ({
      id: asStr(c.id) ?? '',
      name: asStr(c.name) ?? '',
      avatarUrl: asStr(firstOf(c, 'avatarUrl', 'avatar')),
      description: asStr(c.description),
      persona: asStr(c.persona),
      scenario: asStr(c.scenario),
      createdAt: asStr(c.createdAt),
      ...c,
    }))
  },
  async create(payload: Record<string, unknown>): Promise<Character | undefined> {
    const out = await http.post<unknown>('/api/characters', payload)
    const rec = isRecord(out) ? out : {}
    const c = pickRecord(rec, 'character') ?? rec
    return isRecord(c) ? ({ ...c, id: asStr(c.id) ?? '', name: asStr(c.name) ?? '' } as Character) : undefined
  },
  async update(id: string, payload: Record<string, unknown>): Promise<void> {
    await http.patch(`/api/characters/${encodeURIComponent(id)}`, payload)
  },
  async remove(id: string): Promise<void> {
    await http.del(`/api/characters/${encodeURIComponent(id)}`)
  },
  /** 导入角色卡 PNG（admin；字段名 file）。 */
  async importPng(file: File): Promise<Character | undefined> {
    const fd = new FormData()
    fd.append('file', file)
    const out = await http.upload<unknown>('/api/characters/import-png', fd)
    const rec = pickRecord(out, 'character') ?? (isRecord(out) ? out : {})
    return isRecord(rec) ? ({ ...rec, id: asStr(rec.id) ?? '', name: asStr(rec.name) ?? '' } as Character) : undefined
  },
  /** 上传头像（admin；字段名 file）。 */
  async uploadAvatar(id: string, file: File): Promise<string> {
    const fd = new FormData()
    fd.append('file', file)
    const out = await http.upload<unknown>(`/api/characters/${encodeURIComponent(id)}/avatar`, fd)
    const rec = isRecord(out) ? out : {}
    return asStr(rec.avatarUrl) ?? asStr(rec.url) ?? ''
  },
  /** 导出角色卡 PNG 的直链（同源 Cookie 下载）。 */
  exportUrl(id: string): string {
    return `/api/characters/${encodeURIComponent(id)}/export-png`
  },
  async presets(): Promise<Record<string, unknown>[]> {
    const out = await http.get<unknown>('/api/characters/presets')
    return pickArray(out, 'presets', 'characters').filter(isRecord)
  },
}

/* ---------------- persona-rules（铁律，required 可读写） ---------------- */

export const personaApi = {
  async get(botId?: string): Promise<{ content: string; enabled: boolean }> {
    const out = await http.get<unknown>('/api/persona-rules', botId ? { botId } : undefined)
    const rec = isRecord(out) ? out : {}
    return {
      content: asStr(rec.content) ?? asStr(rec.rules) ?? '',
      enabled: asBool(rec.enabled) ?? true,
    }
  },
  async save(botId: string, content: string): Promise<void> {
    await http.put('/api/persona-rules', { botId, content })
  },
}

/* ---------------- plugins / debug / overview ---------------- */

export const systemApi = {
  async plugins(): Promise<PluginsData> {
    const out = await http.get<unknown>('/api/plugins')
    return (isRecord(out) ? out : {}) as PluginsData
  },
  async setPluginEnabled(input: { id?: string; name?: string; enabled: boolean }): Promise<void> {
    await http.post('/api/plugins/enable', input)
  },
  async activity(botId?: string): Promise<ActivityStats> {
    const out = await http.get<unknown>('/api/stats/activity', botId ? { botId } : undefined)
    const rec = isRecord(out) ? out : {}
    const toolCalls = pickArray(rec, 'toolCalls')
      .filter(isRecord)
      .map((t) => ({
        name: asStr(t.name) ?? asStr(t.action) ?? '',
        count: asNum(t.count) ?? asNum(t.c) ?? 0,
      }))
    return {
      daily: pickArray(rec, 'daily')
        .filter(isRecord)
        .map((d) => ({ date: asStr(d.date) ?? '', messages: asNum(d.messages) ?? 0 })),
      totals: pickRecord(rec, 'totals') ?? {},
      toolCalls,
    }
  },
  /** GET /api/debug/system-prompt?botId=（必填 botId，否则 400）。 */
  async systemPrompt(botId?: string): Promise<Record<string, unknown>> {
    const out = await http.get<unknown>('/api/debug/system-prompt', botId ? { botId } : undefined)
    return pickRecord(out) ?? {}
  },
  /** GET /api/debug/audit?botId= */
  async audit(botId?: string): Promise<Record<string, unknown>[]> {
    const out = await http.get<unknown>('/api/debug/audit', botId ? { botId } : undefined)
    const rec = isRecord(out) ? out : {}
    return pickArray(rec, 'entries', 'audit', 'logs').filter(isRecord)
  },
  async seed(): Promise<void> {
    await http.post('/api/seed')
  },
}

/* ---------------- channels ---------------- */

export interface BindIdentity {
  channel: string
  externalId: string
  createdAt: string
}

export const channelsApi = {
  async bindCode(channel: string, botId?: string): Promise<BindCode> {
    const out = await http.post<unknown>(`/api/bind/${encodeURIComponent(channel)}/code`, botId ? { botId } : undefined)
    const rec = pickRecord(out, 'code', 'bind') ?? (isRecord(out) ? out : {})
    return { channel, code: asStr(rec.code) ?? '', ...rec } as BindCode
  },
  /** {identities:[{channel, externalId, createdAt}], pending:[{kind,token,expires_at}]} */
  async bindStatus(): Promise<{ identities: BindIdentity[]; pending: BindStatusItem[] }> {
    const out = await http.get<unknown>('/api/bind/status')
    const rec = isRecord(out) ? out : {}
    const identities = pickArray(rec, 'identities').filter(isRecord).map((b) => ({
      channel: asStr(b.channel) ?? '',
      externalId: asStr(b.externalId) ?? '',
      createdAt: asStr(b.createdAt) ?? '',
    }))
    const pending = pickArray(rec, 'pending').filter(isRecord).map((b) => ({
      kind: asStr(b.kind) ?? '',
      token: asStr(b.token) ?? '',
      expiresAt: asStr(b.expiresAt) ?? asStr(b.expires_at) ?? '',
    }))
    return { identities, pending }
  },
  async unbind(channel: string, externalId: string): Promise<void> {
    await http.post('/api/bind/unbind', { channel, externalId })
  },
}

/* ---------------- wechat（契约，后端实现中） ---------------- */

export const wechatApi = {
  async qr(): Promise<WechatQrSession> {
    const out = await http.post<unknown>('/api/wechat/qr')
    const rec = isRecord(out) ? out : {}
    return {
      sessionId: asStr(rec.sessionId) ?? asStr(rec.session_id) ?? '',
      qrDataUrl: asStr(rec.qrDataUrl) ?? asStr(rec.qr_data_url) ?? '',
      expiresAt: asStr(rec.expiresAt),
    }
  },
  async qrStatus(sessionId: string): Promise<WechatQrPoll> {
    const out = await http.get<unknown>(`/api/wechat/qr/${encodeURIComponent(sessionId)}`)
    const rec = isRecord(out) ? out : {}
    return {
      status: asStr(rec.status) ?? 'wait',
      qrDataUrl: asStr(rec.qrDataUrl),
      expiresAt: asStr(rec.expiresAt),
      error: asStr(rec.error),
      ilinkBotId: asStr(rec.ilinkBotId),
      ilinkUserId: asStr(rec.ilinkUserId),
    }
  },
  async status(): Promise<WechatStatus> {
    const out = await http.get<unknown>('/api/wechat/status')
    const rec = isRecord(out) ? out : {}
    return {
      bound: asBool(rec.bound) ?? false,
      botId: asStr(rec.botId),
      ilinkBotId: asStr(rec.ilinkBotId),
      ilinkUserId: asStr(rec.ilinkUserId),
      nickname: asStr(rec.nickname),
      status: asStr(rec.status),
      windowFresh: asBool(rec.windowFresh),
      lastInboundAt: asNum(rec.lastInboundAt),
      friendQrDataUrl: asStr(rec.friendQrDataUrl),
      friendQrExpiresAt: asStr(rec.friendQrExpiresAt),
      note: asStr(rec.note),
      error: asStr(rec.error),
    }
  },
  async friendQr(): Promise<{ qrDataUrl: string; expiresAt?: string; note?: string; kind?: string }> {
    const out = await http.post<unknown>('/api/wechat/friend-qr')
    const rec = isRecord(out) ? out : {}
    return {
      qrDataUrl: asStr(rec.qrDataUrl) ?? '',
      expiresAt: asStr(rec.expiresAt),
      note: asStr(rec.note),
      kind: asStr(rec.kind),
    }
  },
  async logout(): Promise<void> {
    await http.post('/api/wechat/logout')
  },
}

/* ---------------- Bilibili（bilibili-cli 重写：扫码 / 浏览器 Cookie / 预览） ---------------- */

export interface BiliStatus {
  /** 接口是否可用（404/未就绪 false，页面据此静默降级）。 */
  available: boolean
  authenticated: boolean
  username: string
  mid: string
  avatarUrl: string
  /** 等级（字符串数字，展示为 Lv.N）。 */
  level: string
  /** 大会员文案（'' = 非会员）。 */
  vip: string
  /** 最近登录时间（ISO；后端未提供则空）。 */
  lastLoginAt: string
  /** 是否已开启写操作（后端可选返回；未知时 undefined）。 */
  allowWrites: boolean | undefined
  hint: string
  /** 最近错误（未登录以外的失败原因，后端返回时展示）。 */
  lastError: string
}

export interface BiliQrSession {
  available: boolean
  sessionId: string
  qrDataUrl: string
  link: string
  expiresInMs: number
}

export interface BiliQrPollResult {
  available: boolean
  /** wait | scaned | confirmed | expired（兼容 success/logined） */
  status: string
  message: string
  username: string
  mid: string
  avatarUrl: string
}

export interface BiliCmdResult {
  ok: boolean
  output: string
  error: string
}

function emptyBiliStatus(available = false): BiliStatus {
  return {
    available,
    authenticated: false,
    username: '',
    mid: '',
    avatarUrl: '',
    level: '',
    vip: '',
    lastLoginAt: '',
    allowWrites: undefined,
    hint: '',
    lastError: '',
  }
}

function asStrOrNum(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v === 'string') return v
  return ''
}

function toBiliStatus(v: unknown, available = true): BiliStatus {
  if (isRecord(v) && typeof v.__status === 'number') return emptyBiliStatus(false)
  const rec = isRecord(v) ? v : {}
  const user = pickRecord(rec, 'user', 'profile', 'account') ?? {}
  const authenticated =
    asBool(rec.authenticated) ?? asBool(rec.logined) ?? asBool(rec.loggedIn) ?? (Object.keys(user).length > 0)
  const vipRaw = user.vip ?? rec.vip
  let vip = ''
  if (typeof vipRaw === 'string') vip = vipRaw
  else if (isRecord(vipRaw)) {
    if (asBool(vipRaw.status) === true || asBool(vipRaw.vipStatus) === true) vip = asStr(vipRaw.label) ?? asStr(vipRaw.type) ?? '大会员'
  } else if (asBool(vipRaw) === true) vip = '大会员'
  // routes-bili 的 statusView 同时给扁平 vipLabel（user.vip 结构未知时兜底）。
  if (vip === '') vip = asStr(rec.vipLabel) ?? asStr(user.vipLabel) ?? ''
  const rawLast =
    asStr(rec.loggedInAt) ??
    asStr(user.lastLoginAt) ??
    asStr(user.last_login) ??
    asStr(rec.lastLoginAt) ??
    asStr(rec.last_login) ??
    asStr(rec.savedAt) ??
    asStr(rec.saved_at) ??
    asStr(rec.updated_at) ??
    ''
  const lastLoginAt = (() => {
    if (rawLast === '') return ''
    if (/^\d+$/.test(rawLast)) {
      const n = Number(rawLast)
      const ms = n > 1e12 ? n : n > 1e9 ? n * 1000 : NaN
      return Number.isFinite(ms) ? new Date(ms).toISOString() : ''
    }
    const t = Date.parse(rawLast)
    return Number.isFinite(t) ? new Date(t).toISOString() : rawLast
  })()
  return {
    available,
    authenticated,
    username:
      asStr(user.uname) ?? asStr(user.username) ?? asStr(rec.uname) ?? asStr(rec.username) ?? '',
    mid: asStrOrNum(user.mid) || asStrOrNum(user.dedeuserid) || asStrOrNum(rec.mid),
    avatarUrl: asStr(user.avatar) ?? asStr(user.face) ?? asStr(rec.avatar) ?? '',
    level: asStrOrNum(user.level) || asStrOrNum(user.level_id) || asStrOrNum(rec.level),
    vip,
    lastLoginAt,
    allowWrites: asBool(rec.allowWrites) ?? asBool(rec.allow_writes),
    hint: asStr(rec.hint) ?? '',
    lastError: asStr(rec.lastError) ?? '',
  }
}

function toBiliQrPoll(v: unknown): BiliQrPollResult {
  if (isRecord(v) && typeof v.__status === 'number') {
    return { available: false, status: '', message: '', username: '', mid: '', avatarUrl: '' }
  }
  const rec = isRecord(v) ? v : {}
  const user = pickRecord(rec, 'user', 'profile') ?? {}
  return {
    available: true,
    status: asStr(rec.status) ?? '',
    message: asStr(rec.message) ?? '',
    username: asStr(user.uname) ?? asStr(user.username) ?? asStr(rec.username) ?? '',
    mid: asStr(user.mid) ?? asStr(user.dedeuserid) ?? asStr(rec.mid) ?? '',
    avatarUrl: asStr(user.avatar) ?? asStr(user.face) ?? asStr(rec.avatar) ?? '',
  }
}

function toBiliCmd(v: unknown): BiliCmdResult {
  if (isRecord(v) && typeof v.__status === 'number') {
    return { ok: false, output: '', error: readErrorEnvelope(v.__body).message }
  }
  const rec = isRecord(v) ? v : {}
  if (asBool(rec.ok) === false) {
    return { ok: false, output: '', error: asStr(rec.error) ?? asStr(rec.message) ?? readErrorEnvelope(rec).message }
  }
  const payload = rec.data ?? rec.result ?? rec
  return { ok: true, output: JSON.stringify(payload, null, 2), error: '' }
}

export const biliApi = {
  /** GET /api/bili/status（required）→ 登录状态 + 账号信息（未登录不报错）。 */
  async status(): Promise<BiliStatus> {
    const out = await http.get<unknown>('/api/bili/status', undefined, {
      silentUnauthorized: true,
      allowAnyStatus: true,
    })
    return toBiliStatus(out)
  },
  /** POST /api/bili/qr/start（required）→ PNG data URL 二维码。 */
  async qrStart(): Promise<BiliQrSession> {
    const out = await http.post<unknown>('/api/bili/qr/start', undefined, { allowAnyStatus: true })
    if (isRecord(out) && typeof out.__status === 'number') {
      return { available: false, sessionId: '', qrDataUrl: '', link: '', expiresInMs: 0 }
    }
    const rec = isRecord(out) ? out : {}
    return {
      available: true,
      sessionId: asStr(rec.sessionId) ?? '',
      qrDataUrl: asStr(rec.qrDataUrl) ?? asStr(rec.qrImage) ?? '',
      link: asStr(rec.link) ?? asStr(rec.qrUrl) ?? '',
      expiresInMs: asNum(rec.expiresInMs) ?? 180_000,
    }
  },
  /** GET /api/bili/qr/status?sessionId=（required）→ 四态。 */
  async qrPoll(sessionId: string): Promise<BiliQrPollResult> {
    const out = await http.get<unknown>('/api/bili/qr/status', { sessionId }, { allowAnyStatus: true })
    return toBiliQrPoll(out)
  },
  /** POST /api/bili/extract-cookie（admin）→ 从本机浏览器提取 Cookie 后重新读取状态。 */
  async extractCookie(): Promise<BiliStatus> {
    const out = await http.post<unknown>('/api/bili/extract-cookie', undefined, { allowAnyStatus: true })
    return toBiliStatus(out)
  },
  /** POST /api/bili/logout（admin）→ 清除 CLI 凭证。 */
  async logout(): Promise<void> {
    await http.post('/api/bili/logout')
  },
  /**
   * 写操作开关。契约 §1.3 未列该端点（§1.1 用 `bili.allow_writes` 设置）：
   * 这里按 `PUT /api/bili/settings {allowWrites}` 对接；后端未提供时返回 available:false，
   * 页面据此提示「开关暂不可持久化」，不阻塞其它功能。
   */
  async saveSettings(allowWrites: boolean): Promise<{ available: boolean }> {
    const out = await http.put<unknown>('/api/bili/settings', { allowWrites }, { allowAnyStatus: true })
    if (isRecord(out) && typeof out.__status === 'number') return { available: false }
    return { available: true }
  },
  /** POST /api/bili/cmd（required）{argv, dryRun?} → 只读预览（写命令受开关限制）。 */
  async cmd(argv: string[], dryRun = false): Promise<BiliCmdResult> {
    const out = await http.post<unknown>('/api/bili/cmd', { argv, dryRun }, { allowAnyStatus: true })
    return toBiliCmd(out)
  },
}
