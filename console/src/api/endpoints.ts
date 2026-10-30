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
import { ApiError, asBool, asNum, asStr, firstOf, http, isRecord, pickArray, pickRecord } from './client'
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

/* ---------------- Bilibili sidecar ---------------- */

export const biliApi = {
  async status(): Promise<Record<string, unknown>> {
    const out = await http.get<unknown>('/api/bili/status')
    return pickRecord(out) ?? {}
  },
  async qrStart(): Promise<Record<string, unknown>> {
    const out = await http.post<unknown>('/api/bili/qr/start')
    return pickRecord(out) ?? {}
  },
  async qrStatus(sessionId: string): Promise<Record<string, unknown>> {
    const out = await http.get<unknown>('/api/bili/qr/status', { sessionId })
    return pickRecord(out) ?? {}
  },
  async command(argv: string[]): Promise<Record<string, unknown>> {
    const out = await http.post<unknown>('/api/bili/cmd', { argv })
    return pickRecord(out) ?? {}
  },
}
