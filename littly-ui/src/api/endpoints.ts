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
  /** 分页拉取消息：不传 before 取最近一页；传 before 取更早一页（createdAt/id 双游标）。 */
  async messagesPage(input: {
    botId: string
    sender?: string
    limit?: number
    before?: { createdAt: string; id: string }
  }): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
    const params: Record<string, string | number> = { botId: input.botId }
    if (input.sender !== undefined && input.sender !== '') params['sender'] = input.sender
    if (input.limit !== undefined) params['limit'] = input.limit
    if (input.before !== undefined) {
      params['before'] = input.before.createdAt
      params['beforeId'] = input.before.id
    }
    const out = await http.get<unknown>('/api/messages', params)
    const rec = isRecord(out) ? out : {}
    return {
      messages: pickArray(rec, 'messages')
        .map(toMessage)
        .filter((m): m is ChatMessage => m !== undefined),
      hasMore: rec['hasMore'] === true,
    }
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
  /** 后端仍在等待扫码/WS 可达（autoconfigure 长等待中的回归态）。 */
  waiting: boolean
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
      return { ok: false, waiting: false, selfId: '', nickname: '', error: readErrorEnvelope(out.__body).message }
    }
    const rec = isRecord(out) ? out : {}
    return {
      ok: asBool(rec.ok) ?? false,
      waiting: asBool(rec.waiting) ?? false,
      selfId: asStrOrNum(rec.selfId) || asStrOrNum(rec.self_id),
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

/* ---------------- SnowLuma 一键安装（supervisor） ---------------- */

export interface SnowlumaInstallStatus {
  /** 接口是否可用（404/未就绪 false，页面据此静默降级）。 */
  available: boolean
  /** not_installed | pulling | installed | starting | waiting_scan | connected | error */
  state: string
  dockerOk: boolean
  image: { present: boolean; digest: string; tag: string }
  container: { exists: boolean; running: boolean; status: string }
  ports: { novnc: number; webui: number; ws: number }
  novncUrl: string
  webuiUrl: string
  wsUrl: string
  vncPassword: string
  webuiPassword: string
  /** 后端字段：onebot 配置是否已就绪（旧字段 configPatched 兼容保留）。 */
  configReady: boolean
  configPatched: boolean
  configWarning: string
  hasToken: boolean
  consent: boolean
  /** docker pull 流式进度文本（安装中展示）。 */
  pullProgress: string
  lastError: string
  logsTail: string
}

export interface SnowlumaQrInfo {
  novncUrl: string
  vncPassword: string
  webuiUrl: string
  webuiPassword: string
  steps: string[]
}

export interface SnowlumaAutoResult {
  ok: boolean
  /** 后端仍在等待扫码/WS 可达（autoconfigure 长等待中的回归态）。 */
  waiting: boolean
  selfId: string
  nickname: string
  error: string
}

function emptySnowlumaInstallStatus(available = false): SnowlumaInstallStatus {
  return {
    available,
    state: 'not_installed',
    dockerOk: false,
    image: { present: false, digest: '', tag: '' },
    container: { exists: false, running: false, status: '' },
    ports: { novnc: 6081, webui: 5099, ws: 3001 },
    novncUrl: 'http://127.0.0.1:6081/vnc.html',
    webuiUrl: 'http://127.0.0.1:5099',
    wsUrl: 'ws://127.0.0.1:3001',
    vncPassword: '',
    webuiPassword: '',
    configReady: false,
    configPatched: false,
    configWarning: '',
    hasToken: false,
    consent: false,
    pullProgress: '',
    lastError: '',
    logsTail: '',
  }
}

function toSnowlumaInstallStatus(v: unknown): SnowlumaInstallStatus {
  if (isRecord(v) && typeof v.__status === 'number') return emptySnowlumaInstallStatus(false)
  const rec = isRecord(v) ? v : {}
  const image = pickRecord(rec, 'image') ?? {}
  const container = pickRecord(rec, 'container') ?? {}
  const ports = pickRecord(rec, 'ports') ?? {}
  const base = emptySnowlumaInstallStatus(true)
  return {
    available: true,
    state: asStr(rec.state) ?? 'not_installed',
    dockerOk: asBool(rec.dockerOk) ?? false,
    image: {
      present: asBool(image.present) ?? false,
      digest: asStr(image.digest) ?? '',
      tag: asStr(image.tag) ?? '',
    },
    container: {
      exists: asBool(container.exists) ?? false,
      running: asBool(container.running) ?? false,
      status: asStr(container.status) ?? '',
    },
    ports: {
      novnc: asNum(ports.novnc) ?? base.ports.novnc,
      webui: asNum(ports.webui) ?? base.ports.webui,
      ws: asNum(ports.ws) ?? base.ports.ws,
    },
    novncUrl: asStr(rec.novncUrl) ?? base.novncUrl,
    webuiUrl: asStr(rec.webuiUrl) ?? base.webuiUrl,
    wsUrl: asStr(rec.wsUrl) ?? base.wsUrl,
    vncPassword: asStr(rec.vncPassword) ?? '',
    webuiPassword: asStr(rec.webuiPassword) ?? '',
    configReady: asBool(rec.configReady) ?? asBool(rec.configPatched) ?? false,
    configPatched: asBool(rec.configPatched) ?? asBool(rec.configReady) ?? false,
    configWarning: asStr(rec.configWarning) ?? '',
    hasToken: asBool(rec.hasToken) ?? false,
    consent: asBool(rec.consent) ?? false,
    pullProgress: asStr(rec.pullProgress) ?? '',
    lastError: asStr(rec.lastError) ?? '',
    logsTail: asStr(rec.logsTail) ?? '',
  }
}

/** 异步操作（install/start/stop/remove）的返回值可能是裸 status 或 {ok,status} 包装。 */
function toSnowlumaInstallStatusFromAction(v: unknown): SnowlumaInstallStatus {
  if (isRecord(v) && typeof v.__status === 'number') return emptySnowlumaInstallStatus(false)
  const rec = isRecord(v) ? v : {}
  const inner = pickRecord(rec, 'status')
  return toSnowlumaInstallStatus(inner ?? rec)
}

export const snowlumaInstallApi = {
  /** GET /api/snowluma/status（required）→ 安装/容器/扫码状态机。 */
  async status(): Promise<SnowlumaInstallStatus> {
    const out = await http.get<unknown>('/api/snowluma/status', undefined, {
      silentUnauthorized: true,
      allowAnyStatus: true,
    })
    return toSnowlumaInstallStatus(out)
  },
  /** POST /api/snowluma/install（admin）{consent:true} —— EULA 知情同意是硬前置。 */
  async install(consent: boolean): Promise<SnowlumaInstallStatus> {
    const out = await http.post<unknown>('/api/snowluma/install', { consent }, { allowAnyStatus: true })
    return toSnowlumaInstallStatusFromAction(out)
  },
  /** POST /api/snowluma/start（admin）→ 拉容器 + 补丁 onebot 配置。 */
  async start(): Promise<SnowlumaInstallStatus> {
    const out = await http.post<unknown>('/api/snowluma/start', undefined, { allowAnyStatus: true })
    return toSnowlumaInstallStatusFromAction(out)
  },
  /** POST /api/snowluma/stop（admin）→ 停止容器（保留数据卷与登录态）。 */
  async stop(): Promise<SnowlumaInstallStatus> {
    const out = await http.post<unknown>('/api/snowluma/stop', undefined, { allowAnyStatus: true })
    return toSnowlumaInstallStatusFromAction(out)
  },
  /** POST /api/snowluma/qr（admin）→ noVNC/WebUI 地址 + 密码 + 操作步骤。 */
  async qr(): Promise<SnowlumaQrInfo | null> {
    const out = await http.post<unknown>('/api/snowluma/qr', undefined, { allowAnyStatus: true })
    if (isRecord(out) && typeof out.__status === 'number') return null
    const rec = isRecord(out) ? out : {}
    const info = pickRecord(rec, 'qr') ?? rec
    const stepsRaw = pickArray(info, 'steps')
    return {
      novncUrl: asStr(info.novncUrl) ?? 'http://127.0.0.1:6081/vnc.html',
      vncPassword: asStr(info.vncPassword) ?? '',
      webuiUrl: asStr(info.webuiUrl) ?? 'http://127.0.0.1:5099',
      webuiPassword: asStr(info.webuiPassword) ?? '',
      steps: stepsRaw.map((x) => String(x)).filter((x) => x !== ''),
    }
  },
  /** GET /api/snowluma/logs?tail=N（admin）→ 容器日志（密码/令牌遮罩）。 */
  async logs(tail = 200): Promise<string[]> {
    const out = await http.get<unknown>('/api/snowluma/logs', { tail }, { allowAnyStatus: true })
    if (isRecord(out) && typeof out.__status === 'number') return []
    const rec = isRecord(out) ? out : {}
    const lines = pickArray(rec, 'logs', 'lines')
    if (lines.length > 0) {
      return lines
        .map((line) => {
          if (typeof line === 'string') return line
          const o = isRecord(line) ? line : {}
          return asStr(o.text) ?? asStr(o.line) ?? ''
        })
        .filter((line) => line !== '')
    }
    if (typeof rec.logs === 'string') return rec.logs.split('\n')
    return []
  },
  /** POST /api/snowluma/autoconfigure（admin）→ 探测 WS 并写 bots 的 snowluma_ws_url/enabled。 */
  async autoconfigure(): Promise<SnowlumaAutoResult> {
    const out = await http.post<unknown>('/api/snowluma/autoconfigure', undefined, { allowAnyStatus: true })
    if (isRecord(out) && typeof out.__status === 'number') {
      return { ok: false, waiting: false, selfId: '', nickname: '', error: readErrorEnvelope(out.__body).message }
    }
    const rec = isRecord(out) ? out : {}
    return {
      ok: asBool(rec.ok) ?? false,
      waiting: asBool(rec.waiting) ?? false,
      selfId: asStrOrNum(rec.selfId) || asStrOrNum(rec.self_id),
      nickname: asStr(rec.nickname) ?? '',
      error: asStr(rec.error) ?? asStr(rec.message) ?? '',
    }
  },
  /** POST /api/snowluma/remove（admin）{keepData:true} → 卸载容器，默认保留登录态数据卷。 */
  async remove(keepData = true): Promise<void> {
    await http.post('/api/snowluma/remove', { keepData })
  },
}

/* ---------------- MCP 管理（Cursor 格式） ---------------- */

export interface McpServer {
  name: string
  /** stdio | streamable-http（展示为 stdio / http） */
  transport: string
  command: string
  args: string[]
  url: string
  enabled: boolean
  /** env / headers 只回键名，不回值（安全）。 */
  envKeys: string[]
  headerKeys: string[]
  connected: boolean | undefined
  toolCount: number | undefined
  lastError: string
}

export interface McpToolInfo {
  server: string
  name: string
  description: string
}

export interface McpTestResult {
  ok: boolean
  tools: McpToolInfo[]
  toolCount: number
  error: string
}

export interface McpImportResult {
  added: string[]
  updated: string[]
  errors: Array<{ name: string; error: string }>
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.map((x) => (typeof x === 'string' ? x : String(x))).filter((x) => x !== '')
}

function toMcpServer(v: unknown): McpServer {
  const rec = isRecord(v) ? v : {}
  const args = asStringArray(rec.args)
  const envKeys = asStringArray(rec.envKeys ?? rec.env_keys)
  const headerKeys = asStringArray(rec.headerKeys ?? rec.header_keys)
  return {
    name: asStr(rec.name) ?? '',
    transport: asStr(rec.transport) ?? 'stdio',
    command: asStr(rec.command) ?? '',
    args,
    url: asStr(rec.url) ?? '',
    enabled: asBool(rec.enabled) ?? false,
    envKeys,
    headerKeys,
    connected: asBool(rec.connected),
    toolCount: asNum(rec.toolCount),
    lastError: asStr(rec.lastError) ?? '',
  }
}

function toMcpTool(v: unknown): McpToolInfo {
  const rec = isRecord(v) ? v : {}
  return {
    server: asStr(rec.server) ?? '',
    name: asStr(rec.name) ?? '',
    description: asStr(rec.description) ?? '',
  }
}

export interface McpServerInput {
  name: string
  transport: 'stdio' | 'streamable-http'
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
  enabled?: boolean
}

export const mcpApi = {
  /** GET /api/mcp/servers（required）→ 服务器列表（env/headers 只有键名）。 */
  async servers(): Promise<{ available: boolean; servers: McpServer[] }> {
    const out = await http.get<unknown>('/api/mcp/servers', undefined, {
      silentUnauthorized: true,
      allowAnyStatus: true,
    })
    if (isRecord(out) && typeof out.__status === 'number') return { available: false, servers: [] }
    const rec = isRecord(out) ? out : {}
    return { available: true, servers: pickArray(rec, 'servers').map(toMcpServer) }
  },
  /** POST /api/mcp/servers（admin）→ 单服务器 upsert。 */
  async upsert(input: McpServerInput): Promise<void> {
    await http.post('/api/mcp/servers', input)
  },
  /** PATCH /api/mcp/servers/:name（admin）→ 局部更新（改名=删除+新增）。 */
  async patch(name: string, input: Partial<Omit<McpServerInput, 'name'>>): Promise<void> {
    await http.patch(`/api/mcp/servers/${encodeURIComponent(name)}`, input)
  },
  /** DELETE /api/mcp/servers/:name（admin）。 */
  async remove(name: string): Promise<void> {
    await http.del(`/api/mcp/servers/${encodeURIComponent(name)}`)
  },
  /** POST /api/mcp/import（admin）→ 粘贴 Cursor 格式，部分成功。 */
  async importConfig(config: unknown): Promise<McpImportResult> {
    const out = await http.post<unknown>('/api/mcp/import', config, { allowAnyStatus: true })
    if (isRecord(out) && typeof out.__status === 'number') {
      return { added: [], updated: [], errors: [{ name: '*', error: readErrorEnvelope(out.__body).message }] }
    }
    const rec = isRecord(out) ? out : {}
    return {
      added: asStringArray(rec.added),
      updated: asStringArray(rec.updated),
      errors: pickArray(rec, 'errors')
        .filter(isRecord)
        .map((e) => ({ name: asStr(e.name) ?? '', error: asStr(e.error) ?? '' })),
    }
  },
  /** GET /api/mcp/export（admin）→ Cursor 格式（env/headers 含真实值）。 */
  async exportConfig(): Promise<Record<string, unknown>> {
    const out = await http.get<unknown>('/api/mcp/export', undefined, { allowAnyStatus: true })
    if (isRecord(out) && typeof out.__status === 'number') return {}
    return isRecord(out) ? out : {}
  },
  /** POST /api/mcp/servers/:name/test（admin）→ 连接并列出工具。 */
  async test(name: string): Promise<McpTestResult> {
    const out = await http.post<unknown>(`/api/mcp/servers/${encodeURIComponent(name)}/test`, undefined, {
      allowAnyStatus: true,
    })
    if (isRecord(out) && typeof out.__status === 'number') {
      return { ok: false, tools: [], toolCount: 0, error: readErrorEnvelope(out.__body).message }
    }
    const rec = isRecord(out) ? out : {}
    return {
      ok: asBool(rec.ok) ?? false,
      tools: pickArray(rec, 'tools').map(toMcpTool),
      toolCount: asNum(rec.toolCount) ?? 0,
      error: asStr(rec.error) ?? '',
    }
  },
  /** GET /api/mcp/tools（required）→ 所有启用服务器的工具聚合。 */
  async tools(): Promise<McpToolInfo[]> {
    const out = await http.get<unknown>('/api/mcp/tools', undefined, { allowAnyStatus: true })
    if (isRecord(out) && typeof out.__status === 'number') return []
    const rec = isRecord(out) ? out : {}
    return pickArray(rec, 'tools').map(toMcpTool)
  },
}

/* ---------------- 邮箱（@littly/mail：IMAP/SMTP） ---------------- */

export interface MailEndpoint {
  host: string
  port: number
  secure: boolean
  hasPassword: boolean
}

export interface MailStatus {
  /** 接口是否可用（404/未就绪 false，页面据此静默降级）。 */
  available: boolean
  configured: boolean
  address: string
  fromName: string
  imap: MailEndpoint
  smtp: MailEndpoint
  allowWrite: boolean
  verifiedAt: string
  lastError: string
}

export interface MailTestResult {
  ok: boolean
  imap: boolean
  smtp: boolean
  error: string
}

export interface MailMessage {
  uid: string
  from: string
  subject: string
  date: string
  unread: boolean
  snippet: string
}

export interface MailAttachment {
  filename: string
  size: number
  contentType: string
}

export interface MailMessageBody {
  uid: string
  from: string
  subject: string
  date: string
  text: string
  html: string
  attachments: MailAttachment[]
}

export interface MailCmdResult {
  ok: boolean
  dryRun: boolean
  data: unknown
  error: string
}

function emptyMailEndpoint(): MailEndpoint {
  return { host: '', port: 0, secure: true, hasPassword: false }
}

function toMailEndpoint(v: unknown): MailEndpoint {
  const rec = isRecord(v) ? v : {}
  return {
    host: asStr(rec.host) ?? '',
    port: asNum(rec.port) ?? 0,
    secure: asBool(rec.secure) ?? true,
    hasPassword: asBool(rec.hasPassword) ?? false,
  }
}

function emptyMailStatus(available = false): MailStatus {
  return {
    available,
    configured: false,
    address: '',
    fromName: '',
    imap: emptyMailEndpoint(),
    smtp: emptyMailEndpoint(),
    allowWrite: false,
    verifiedAt: '',
    lastError: '',
  }
}

function toMailStatus(v: unknown): MailStatus {
  if (isRecord(v) && typeof v.__status === 'number') return emptyMailStatus(false)
  const rec = isRecord(v) ? v : {}
  return {
    available: true,
    configured: asBool(rec.configured) ?? false,
    address: asStr(rec.address) ?? '',
    fromName: asStr(rec.fromName) ?? asStr(rec.from_name) ?? '',
    imap: toMailEndpoint(rec.imap),
    smtp: toMailEndpoint(rec.smtp),
    allowWrite: asBool(rec.allowWrite) ?? asBool(rec.allow_write) ?? false,
    verifiedAt: asStr(rec.verifiedAt) ?? '',
    lastError: asStr(rec.lastError) ?? '',
  }
}

/** 解析 mail cmd 的统一结果（后端可能返回 envelope/扁平/错误结构）。 */
function toMailCmdResult(v: unknown): MailCmdResult {
  if (isRecord(v) && typeof v.__status === 'number') {
    return { ok: false, dryRun: false, data: null, error: readErrorEnvelope(v.__body).message }
  }
  const rec = isRecord(v) ? v : {}
  const dryRun = asBool(rec.dryRun) ?? false
  if (asBool(rec.ok) === false) {
    const errRaw = rec.error
    const error = isRecord(errRaw)
      ? (asStr(errRaw.message) ?? readErrorEnvelope(errRaw).message)
      : (asStr(errRaw) ?? '邮件命令执行失败')
    return { ok: false, dryRun, data: null, error }
  }
  return { ok: asBool(rec.ok) ?? true, dryRun, data: rec.data ?? rec.result ?? rec, error: '' }
}

function mailFromText(v: unknown): string {
  if (typeof v === 'string') return v
  if (isRecord(v)) {
    const name = asStr(v.name) ?? asStr(v.fromName) ?? ''
    const address = asStr(v.address) ?? asStr(v.email) ?? ''
    if (name && address) return `${name} <${address}>`
    return name || address
  }
  return ''
}

function toMailMessages(data: unknown): MailMessage[] {
  const rec = isRecord(data) ? data : {}
  const raw = pickArray(rec, 'messages', 'emails', 'items')
  const list = raw.length > 0 ? raw : Array.isArray(data) ? data : []
  return list
    .filter(isRecord)
    .map((m) => {
      const flags = asStringArray(m.flags)
      return {
        uid: asStrOrNum(m.uid) || asStr(m.id) || '',
        from: mailFromText(m.from),
        subject: asStr(m.subject) ?? '(无主题)',
        date: asStr(m.date) ?? '',
        unread: (() => {
          const explicit = asBool(m.unread)
          if (explicit !== undefined) return explicit
          const seen = asBool(m.seen)
          if (seen !== undefined) return !seen
          return !flags.includes('\\Seen')
        })(),
        snippet: asStr(m.snippet) ?? asStr(m.preview) ?? asStr(m.text)?.slice(0, 160) ?? '',
      }
    })
    .filter((m) => m.uid !== '' || m.subject !== '')
}

function toMailBody(data: unknown): MailMessageBody {
  const rec = isRecord(data) ? data : {}
  const message = pickRecord(rec, 'message') ?? rec
  return {
    uid: asStrOrNum(message.uid) || '',
    from: mailFromText(message.from),
    subject: asStr(message.subject) ?? '(无主题)',
    date: asStr(message.date) ?? '',
    text: asStr(message.text) ?? '',
    html: asStr(message.html) ?? '',
    attachments: pickArray(message, 'attachments')
      .filter(isRecord)
      .map((a) => ({
        filename: asStr(a.filename) ?? asStr(a.name) ?? '',
        size: asNum(a.size) ?? 0,
        contentType: asStr(a.contentType) ?? asStr(a.content_type) ?? '',
      })),
  }
}

export interface MailAccountInput {
  address: string
  imapHost: string
  imapPort: number
  imapSecure: boolean
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  username: string
  password?: string
  fromName?: string
}

export const mailApi = {
  /** GET /api/mail/status（required）→ 绑定状态（密码永不回传，只有 hasPassword）。 */
  async status(): Promise<MailStatus> {
    const out = await http.get<unknown>('/api/mail/status', undefined, {
      silentUnauthorized: true,
      allowAnyStatus: true,
    })
    return toMailStatus(out)
  },
  /** PUT /api/mail/account（admin）→ 保存配置（password 空=不修改），返回 status。 */
  async saveAccount(input: MailAccountInput): Promise<MailStatus> {
    const out = await http.put<unknown>('/api/mail/account', input, { allowAnyStatus: true })
    // 路由返回 {ok, status}；兼容直接返回 status。
    const rec = isRecord(out) ? out : {}
    return toMailStatus(pickRecord(rec, 'status') ?? rec)
  },
  /** POST /api/mail/test（admin）→ IMAP/SMTP 分别连通性。 */
  async test(): Promise<MailTestResult> {
    const out = await http.post<unknown>('/api/mail/test', undefined, { allowAnyStatus: true })
    if (isRecord(out) && typeof out.__status === 'number') {
      return { ok: false, imap: false, smtp: false, error: readErrorEnvelope(out.__body).message }
    }
    const rec = isRecord(out) ? out : {}
    return {
      ok: asBool(rec.ok) ?? false,
      imap: asBool(rec.imap) ?? false,
      smtp: asBool(rec.smtp) ?? false,
      error: asStr(rec.error) ?? asStr(rec.message) ?? '',
    }
  },
  /** POST /api/mail/cmd（required）{command, params?, dryRun?} —— 读放行、写受开关限制。 */
  async cmd(command: string, params: Record<string, unknown> = {}, dryRun = false): Promise<MailCmdResult> {
    const out = await http.post<unknown>('/api/mail/cmd', { command, params, dryRun }, { allowAnyStatus: true })
    return toMailCmdResult(out)
  },
  /** PUT /api/mail/settings（admin）{allowWrite} —— 写操作开关。 */
  async saveSettings(allowWrite: boolean): Promise<void> {
    await http.put('/api/mail/settings', { allowWrite })
  },
  /** DELETE /api/mail/account（admin，二次确认）→ 清空凭据。 */
  async remove(): Promise<void> {
    await http.del('/api/mail/account')
  },
}

/** 邮箱命令返回 → 消息列表（供页面复用）。 */
export function mailMessagesFrom(data: unknown): MailMessage[] {
  return toMailMessages(data)
}

/** 邮箱命令返回 → 邮件正文（供页面复用）。 */
export function mailBodyFrom(data: unknown): MailMessageBody {
  return toMailBody(data)
}

/* ---------------- 记忆 vault（Markdown 真相 + 派生索引） ---------------- */

export interface MemoryVaultProfile {
  available: boolean
  /** PROFILE.md 原文（Markdown）。 */
  content: string
  updatedAt: string
  /** 是否因 2000 字预算被截断。 */
  truncated: boolean
  /** 是否含自动生成区（<!-- memory:auto:begin -->）。 */
  autoGenerated: boolean
  entryCount: number
}

export interface MemoryVaultDomain {
  domain: string
  label: string
  /** 域 README 的一句话自述（人写，程序不覆盖）。 */
  description: string
  count: number
  recentTitle: string
  recentTimeLabel: string
  updatedAt: string
}

export interface MemoryVaultEntry {
  entryId: string
  domain: string
  title: string
  /** 自然语言时间标签，如「两个月前（2026-08）」。 */
  timeLabel: string
  /** 有效（未失效、未被取代、未过 valid_until）。 */
  valid: boolean
  supersededBy: string
  eventTime: string
  recordTime: string
  lastVerified: string
  importance: number
  kind: string
  provenance: string
  volatility: string
  tags: string[]
  related: string[]
  thread: string
  sourceRef: string
}

export interface MemoryVaultEntryDetail extends MemoryVaultEntry {
  body: string
  eventRaw: string
  supersedes: string[]
  sources: string[]
  tombstone: boolean
  tombstoneReason: string
}

export interface MemoryVaultHit {
  entryId: string
  domain: string
  title: string
  timeLabel: string
  score: number
  matchedLayer: string
  path: string
  line: number
}

export interface MemoryVaultStagingItem {
  id: string
  content: string
  sourceRef: string
  createdAt: string
  status: string
}

export interface MemoryDreamReport {
  added: number
  merged: number
  invalidated: number
  archived: number
  durationMs: number
  at: string
  error: string
}

export interface MemoryDreamStatus {
  available: boolean
  running: boolean
  lastRunAt: string
  nextRunAt: string
  lastReport: MemoryDreamReport | null
  lastError: string
}

function asIsoTimeLoose(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return new Date(v).toISOString()
  if (typeof v === 'string' && v !== '') {
    const t = Date.parse(v)
    return Number.isFinite(t) ? new Date(t).toISOString() : v
  }
  return ''
}

function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v
    .map((x) => {
      if (typeof x === 'string') return x
      if (isRecord(x)) return asStr(x.entryId) ?? asStr(x.id) ?? asStr(x.title) ?? ''
      return String(x)
    })
    .filter((x) => x !== '')
}

function toVaultEntry(v: unknown): MemoryVaultEntry | undefined {
  if (!isRecord(v)) return undefined
  const entryId = asStr(v.entryId) ?? asStr(v.entry_id) ?? asStr(v.id) ?? ''
  if (entryId === '') return undefined
  const supersededBy = asStr(v.supersededBy) ?? asStr(v.superseded_by) ?? ''
  const validUntil = asIsoTimeLoose(v.validUntil ?? v.valid_until)
  const explicitValid = asBool(v.valid) ?? asBool(v.active)
  const expired = validUntil !== '' && Date.parse(validUntil) <= Date.now()
  return {
    entryId,
    domain: asStr(v.domain) ?? '',
    title: asStr(v.title) ?? asStr(v.name) ?? entryId,
    timeLabel: asStr(v.timeLabel) ?? asStr(v.time_label) ?? asStr(v.eventLabel) ?? '',
    valid: explicitValid ?? (supersededBy === '' && !expired),
    supersededBy,
    eventTime: asIsoTimeLoose(v.eventTime ?? v.event_time),
    recordTime: asIsoTimeLoose(v.recordTime ?? v.record_time ?? v.recordedAt ?? v.recorded_at),
    lastVerified: asIsoTimeLoose(v.lastVerified ?? v.last_verified),
    importance: asNum(v.importance) ?? 0,
    kind: asStr(v.kind) ?? '',
    provenance: asStr(v.provenance) ?? '',
    volatility: asStr(v.volatility) ?? '',
    tags: stringList(v.tags),
    related: stringList(v.related),
    thread: asStr(v.thread) ?? '',
    sourceRef: asStr(v.sourceRef) ?? asStr(v.source_ref) ?? asStr(v.source) ?? '',
  }
}

function toVaultEntryDetail(v: unknown): MemoryVaultEntryDetail | undefined {
  if (isRecord(v) && typeof v.__status === 'number') return undefined
  const rec = isRecord(v) ? v : {}
  const inner = pickRecord(rec, 'entry') ?? rec
  const base = toVaultEntry(inner)
  if (base === undefined) return undefined
  const history = pickRecord(rec, 'tombstone') ?? pickRecord(inner, 'tombstone') ?? {}
  return {
    ...base,
    body: asStr(inner.content) ?? asStr(inner.body) ?? asStr(inner.markdown) ?? '',
    eventRaw: asStr(inner.eventRaw) ?? asStr(inner.event_raw) ?? '',
    supersedes: stringList(inner.supersedes),
    sources: stringList(inner.sources ?? inner.sourceMessages ?? inner.source_messages).concat(
      base.sourceRef !== '' ? [base.sourceRef] : [],
    ),
    tombstone: asBool(history.deleted) ?? asBool(inner.tombstone) ?? base.domain === 'history',
    tombstoneReason:
      asStr(history.reason) ?? asStr(inner.tombstoneReason) ?? asStr(inner.deletedReason) ?? '',
  }
}

function toDomain(v: unknown): MemoryVaultDomain {
  const rec = isRecord(v) ? v : {}
  const latest = pickRecord(rec, 'latest', 'recent') ?? {}
  const domain = asStr(rec.domain) ?? asStr(rec.name) ?? ''
  return {
    domain,
    label: asStr(rec.label) ?? asStr(rec.title) ?? domain,
    description: asStr(rec.description) ?? asStr(rec.readme) ?? asStr(rec.summary) ?? '',
    count: asNum(rec.count) ?? asNum(rec.entryCount) ?? 0,
    recentTitle: asStr(latest.title) ?? asStr(rec.recentTitle) ?? asStr(rec.recent_title) ?? '',
    recentTimeLabel: asStr(latest.timeLabel) ?? asStr(rec.recentTimeLabel) ?? asStr(rec.recent_time_label) ?? '',
    updatedAt: asIsoTimeLoose(rec.updatedAt ?? rec.updated_at ?? latest.eventTime ?? latest.updatedAt),
  }
}

function toDreamReport(v: unknown): MemoryDreamReport | null {
  if (!isRecord(v)) return null
  return {
    added: asNum(v.added) ?? 0,
    merged: asNum(v.merged) ?? 0,
    invalidated: asNum(v.invalidated) ?? 0,
    archived: asNum(v.archived) ?? 0,
    durationMs: asNum(v.durationMs) ?? asNum(v.duration_ms) ?? 0,
    at: asIsoTimeLoose(v.at ?? v.finishedAt ?? v.created_at),
    error: asStr(v.error) ?? '',
  }
}

function toDreamStatus(v: unknown): MemoryDreamStatus {
  if (isRecord(v) && typeof v.__status === 'number') {
    return { available: false, running: false, lastRunAt: '', nextRunAt: '', lastReport: null, lastError: '' }
  }
  const rec = isRecord(v) ? v : {}
  const report = pickRecord(rec, 'lastReport', 'report', 'last_report') ?? constNull()
  return {
    available: true,
    running: asBool(rec.running) ?? asBool(rec.isRunning) ?? false,
    lastRunAt: asIsoTimeLoose(rec.lastRunAt ?? rec.last_run_at ?? rec.lastConsolidateAt),
    nextRunAt: asIsoTimeLoose(rec.nextRunAt ?? rec.next_run_at),
    lastReport: report === null ? null : toDreamReport(report),
    lastError: asStr(rec.lastError) ?? asStr(rec.error) ?? '',
  }
}

function constNull(): null {
  return null
}

export interface MemoryVaultList {
  available: boolean
  entries: MemoryVaultEntry[]
  total: number
}

export interface MemoryVaultStaging {
  available: boolean
  items: MemoryVaultStagingItem[]
  total: number
}

export const memoryVaultApi = {
  /** GET /api/memory/profile?botId&contactId → 档案（Markdown）+ 更新时间 + 截断标记。 */
  async profile(botId: string, contactId: string): Promise<MemoryVaultProfile> {
    const out = await http.get<unknown>('/api/memory/profile', { botId, contactId }, { allowAnyStatus: true })
    if (isRecord(out) && typeof out.__status === 'number') {
      return { available: false, content: '', updatedAt: '', truncated: false, autoGenerated: false, entryCount: 0 }
    }
    const rec = isRecord(out) ? out : {}
    // 后端 profile 字段是 Markdown 字符串（不是对象）；同时兼容对象包裹的旧契约。
    const profile = pickRecord(rec, 'profile') ?? {}
    const content =
      asStr(rec.profile) ?? asStr(profile.content) ?? asStr(rec.content) ?? asStr(rec.markdown) ?? ''
    return {
      available: true,
      content,
      updatedAt: asIsoTimeLoose(rec.updatedAt ?? rec.updated_at ?? profile.updatedAt ?? rec.mtime),
      truncated: asBool(rec.truncated) ?? asBool(profile.truncated) ?? false,
      autoGenerated: asBool(rec.autoGenerated) ?? content.includes('memory:auto:begin'),
      entryCount: asNum(rec.entryCount) ?? asNum(rec.entry_count) ?? 0,
    }
  },
  /** GET /api/memory/profile?...&rebuild=1 → 触发重建后返回新档案。 */
  async rebuildProfile(botId: string, contactId: string): Promise<MemoryVaultProfile> {
    const out = await http.get<unknown>(
      '/api/memory/profile',
      { botId, contactId, rebuild: 'true' },
      { allowAnyStatus: true },
    )
    if (isRecord(out) && typeof out.__status === 'number') {
      return { available: false, content: '', updatedAt: '', truncated: false, autoGenerated: false, entryCount: 0 }
    }
    const rec = isRecord(out) ? out : {}
    // 后端 profile 字段是 Markdown 字符串（不是对象）；同时兼容对象包裹的旧契约。
    const profile = pickRecord(rec, 'profile') ?? {}
    const content =
      asStr(rec.profile) ?? asStr(profile.content) ?? asStr(rec.content) ?? asStr(rec.markdown) ?? ''
    return {
      available: true,
      content,
      updatedAt: asIsoTimeLoose(rec.updatedAt ?? rec.updated_at ?? profile.updatedAt ?? rec.mtime),
      truncated: asBool(rec.truncated) ?? asBool(profile.truncated) ?? false,
      autoGenerated: asBool(rec.autoGenerated) ?? content.includes('memory:auto:begin'),
      entryCount: asNum(rec.entryCount) ?? asNum(rec.entry_count) ?? 0,
    }
  },
  /** GET /api/memory/domains?botId&contactId → 9 域统计。 */
  async domains(botId: string, contactId: string): Promise<{ available: boolean; domains: MemoryVaultDomain[] }> {
    const out = await http.get<unknown>('/api/memory/domains', { botId, contactId }, { allowAnyStatus: true })
    if (isRecord(out) && typeof out.__status === 'number') return { available: false, domains: [] }
    const rec = isRecord(out) ? out : {}
    return { available: true, domains: pickArray(rec, 'domains').map(toDomain) }
  },
  /** GET /api/memory/entries?botId&contactId&domain&limit&offset → 条目列表（含 timeLabel）。 */
  async entries(input: {
    botId: string
    contactId: string
    domain?: string
    limit?: number
    offset?: number
    timeline?: boolean
  }): Promise<MemoryVaultList> {
    const out = await http.get<unknown>(
      '/api/memory/entries',
      {
        botId: input.botId,
        contactId: input.contactId,
        domain: input.domain,
        limit: input.limit,
        offset: input.offset,
        ...(input.timeline === true ? { timeline: 'true' } : {}),
      },
      { allowAnyStatus: true },
    )
    if (isRecord(out) && typeof out.__status === 'number') return { available: false, entries: [], total: 0 }
    const rec = isRecord(out) ? out : {}
    const entries = pickArray(rec, 'entries', 'items')
      .map(toVaultEntry)
      .filter((e): e is MemoryVaultEntry => e !== undefined)
    return { available: true, entries, total: asNum(rec.total) ?? entries.length }
  },
  /** GET /api/memory/entries/:entryId?botId&contactId → 详情（正文/时间/取代链/来源/墓碑）。 */
  async entry(entryId: string, botId: string, contactId: string): Promise<MemoryVaultEntryDetail | null> {
    const out = await http.get<unknown>(
      `/api/memory/entries/${encodeURIComponent(entryId)}`,
      { botId, contactId },
      { allowAnyStatus: true },
    )
    return toVaultEntryDetail(out) ?? null
  },
  /** PUT /api/memory/entries/:entryId（admin）→ 人工编辑正文/标签/重要度。 */
  async update(
    entryId: string,
    patch: { content?: string; tags?: string[]; importance?: number; eventTime?: string },
    botId: string,
    contactId: string,
  ): Promise<void> {
    await http.put(`/api/memory/entries/${encodeURIComponent(entryId)}`, patch, {
      query: { botId, contactId },
    })
  },
  /**
   * 标记失效（墓碑）。契约 §6 只给了 PUT 编辑；这里以 `invalid:true + validUntil=now`
   * 表达失效（后端若实现专门 forget 语义可替换 endpoint）。
   */
  async invalidate(entryId: string, botId: string, contactId: string): Promise<void> {
    await http.put(
      `/api/memory/entries/${encodeURIComponent(entryId)}`,
      { invalid: true, validUntil: new Date().toISOString() },
      { query: { botId, contactId } },
    )
  },
  /** GET /api/memory/search?botId&contactId&q&domain&limit → 跨域检索命中。 */
  async search(input: {
    botId: string
    contactId: string
    q: string
    domain?: string
    limit?: number
  }): Promise<{ available: boolean; hits: MemoryVaultHit[] }> {
    const out = await http.get<unknown>(
      '/api/memory/search',
      { botId: input.botId, contactId: input.contactId, q: input.q, domain: input.domain, limit: input.limit },
      { allowAnyStatus: true },
    )
    if (isRecord(out) && typeof out.__status === 'number') return { available: false, hits: [] }
    const rec = isRecord(out) ? out : {}
    const raw = pickArray(rec, 'results', 'hits', 'entries')
    return {
      available: true,
      hits: raw.filter(isRecord).map((r) => {
        const entry = toVaultEntry(r)
        return {
          entryId: entry?.entryId ?? '',
          domain: entry?.domain ?? asStr(r.domain) ?? '',
          title: entry?.title ?? asStr(r.title) ?? '',
          timeLabel: entry?.timeLabel ?? '',
          score: asNum(r.score) ?? 0,
          matchedLayer: asStr(r.matchedLayer) ?? '',
          path: asStr(r.path) ?? '',
          line: asNum(r.line) ?? 0,
        }
      }),
    }
  },
  /** GET /api/memory/staging?botId&contactId → 暂存区候选列表。 */
  async staging(botId: string, contactId: string): Promise<MemoryVaultStaging> {
    const out = await http.get<unknown>('/api/memory/staging', { botId, contactId }, { allowAnyStatus: true })
    if (isRecord(out) && typeof out.__status === 'number') return { available: false, items: [], total: 0 }
    const rec = isRecord(out) ? out : {}
    const items = pickArray(rec, 'items', 'staging', 'entries')
      .filter(isRecord)
      .map((v) => ({
        id: asStr(v.id) ?? asStr(v.stagingId) ?? '',
        content: asStr(v.content) ?? asStr(v.text) ?? '',
        sourceRef: asStr(v.sourceRef) ?? asStr(v.source_ref) ?? '',
        createdAt: asIsoTimeLoose(v.createdAt ?? v.created_at),
        status: asStr(v.status) ?? '',
      }))
      .filter((v) => v.id !== '')
    return { available: true, items, total: asNum(rec.total) ?? items.length }
  },
  /** POST /api/memory/staging/consolidate（admin）→ 立即整理。 */
  async consolidate(botId: string, contactId: string): Promise<{ ok: boolean; report: MemoryDreamReport | null }> {
    const out = await http.post<unknown>(
      '/api/memory/staging/consolidate',
      { botId, contactId },
      { allowAnyStatus: true },
    )
    if (isRecord(out) && typeof out.__status === 'number') return { ok: false, report: null }
    const rec = isRecord(out) ? out : {}
    return { ok: asBool(rec.ok) ?? true, report: toDreamReport(rec.report ?? rec) }
  },
  /** GET /api/memory/dream/status?botId&contactId → 运行中/上次/下次/最近报告。 */
  async dreamStatus(botId: string, contactId: string): Promise<MemoryDreamStatus> {
    const out = await http.get<unknown>('/api/memory/dream/status', { botId, contactId }, { allowAnyStatus: true })
    return toDreamStatus(out)
  },
  /** POST /api/memory/migrate（admin，一次性）→ 迁移旧 memories 表。 */
  async migrate(botId: string, contactId?: string): Promise<void> {
    await http.post('/api/memory/migrate', { botId, ...(contactId !== undefined ? { contactId } : {}) })
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
