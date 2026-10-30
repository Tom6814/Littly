/** 控制台 API 数据模型（与 console-api 的视图映射对齐）。 */

export interface User {
  id: string
  username: string
  role?: string
}

export interface Bot {
  id: string
  name: string
  avatarUrl?: string
  createdAt?: string
  settings?: Record<string, unknown>
}

export interface ChatMessagePiece {
  type: 'text' | 'image' | 'voice' | 'file' | string
  text?: string
  url?: string
  name?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | string
  sender: string
  botId: string
  createdAt: string
  text: string
  pieces: ChatMessagePiece[]
  replyType?: string
  reasoning?: string
  deliveryStatus?: string
  bufferStatus?: string
  bufferFireAt?: string
  /** 本地乐观消息（尚未落库）。 */
  pending?: boolean
}

export interface Conversation {
  sender: string
  name: string
  isOwner: boolean
  messageCount: number
  lastMessage: ChatMessage
  lastAt: string
}

export interface ChatResponse {
  messages: ChatMessage[]
  reply: string
  toolCalls: unknown[]
  thinkingLength: number
  silent: boolean
}

export interface BufferStatus {
  buffered: boolean
  fireAt?: string | null
  count: number
}

export type AgentStatus = 'thinking' | 'generating' | 'tool' | 'silent' | string

export interface StreamToolCall {
  id: string
  name: string
  status: string
}

export interface Character {
  id: string
  name: string
  avatarUrl?: string
  description?: string
  persona?: string
  scenario?: string
  firstMes?: string
  spec?: string
  /** characterView 把 chara_card_v2 的 data 解析成 card 对象。 */
  card?: Record<string, unknown>
  createdAt?: string
  [key: string]: unknown
}

export interface OnboardingState {
  completed: boolean
  steps: {
    model?: boolean
    persona?: boolean
    wechat?: boolean
  }
  /** mock = 后端 onboarding API 尚未就绪时本地降级。 */
  source?: 'api' | 'mock'
}

export interface TestModelResult {
  ok: boolean
  latencyMs?: number
  error?: string
  model?: string
}

export interface WechatStatus {
  bound: boolean
  botId?: string
  ilinkBotId?: string
  ilinkUserId?: string
  nickname?: string
  /** connected | connecting | session_expired | error | stopped */
  status?: string
  /** iLink 24h 会话窗口是否新鲜（可主动发消息） */
  windowFresh?: boolean
  lastInboundAt?: number
  friendQrDataUrl?: string
  friendQrExpiresAt?: string
  /** 名片码的协议依据说明（后端提供，直接展示） */
  note?: string
  error?: string
}

export interface WechatQrSession {
  sessionId: string
  qrDataUrl: string
  expiresAt?: string
}

export interface WechatQrPoll {
  status: 'wait' | 'scanned' | 'scaned' | 'expired' | 'confirmed' | 'failed' | 'scaned_but_redirect' | string
  qrDataUrl?: string
  expiresAt?: string
  error?: string
  ilinkBotId?: string
  ilinkUserId?: string
}

export interface BindStatusItem {
  kind: string
  token: string
  expiresAt: string
}

export interface BindCode {
  channel: string
  code: string
  expiresAt?: string
  deepLink?: string
  instruction?: string
  [key: string]: unknown
}

export interface ChannelConfig {
  enabled?: boolean
  [key: string]: unknown
}

export interface AiSettings {
  baseUrl?: string
  apiKey?: string
  model?: string
  chatModel?: string
  embeddingModel?: string
  reasoningModel?: string
  [key: string]: unknown
}

export interface PlatformSettings {
  [key: string]: unknown
}

export interface ActivityStats {
  daily?: Array<{ date: string; messages: number }>
  totals?: Record<string, unknown>
  /** 后端出参是 {name, count}（旧映射曾用 {action,c}，这里统一成 name/count）。 */
  toolCalls?: Array<{ name: string; count: number }>
  [key: string]: unknown
}

export interface PluginsData {
  installed?: Array<Record<string, unknown>>
  bundles?: Array<Record<string, unknown>>
  mcp?: Array<Record<string, unknown>>
  tools?: Array<Record<string, unknown>>
  skills?: Array<Record<string, unknown>>
  dsh?: Array<Record<string, unknown>>
  [key: string]: unknown
}

export interface DebugPrompt {
  prompt?: string
  systemPrompt?: string
  [key: string]: unknown
}

export interface AuditEntry {
  id?: string
  action?: string
  category?: string
  createdAt?: string
  [key: string]: unknown
}
