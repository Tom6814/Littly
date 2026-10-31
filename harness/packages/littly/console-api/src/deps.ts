/**
 * 路由模块共享依赖与鉴权辅助。
 */
import type { LittlyStorage, BotRow } from '@littly/storage'
import type { LittlyPersona } from '@littly/persona'
import type { LittlyMemory } from '@littly/memory'
import type { LittlyHub } from '@littly/agents'
import type { LittlyGrowth } from '@littly/growth'
import type { LittlyMcpManager } from '@littly/mcp'
import type { PluginManager } from '@deepseek-ai/dsh-plugin-manager'
import type { SkillRegistry } from '@deepseek-ai/dsh-skill'
import type { XService } from '@littly/x'
import type { QqChannelService } from '@littly/channel-qq'
import type { SnowlumaService } from '@littly/snowluma'
import type { MailService } from '@littly/mail'
import type { MemoryVault } from '@littly/memory'
import type { SessionManager } from './auth.ts'
import { err, type Router, type ApiRequest } from './http.ts'


/** Bilibili 服务（@littly/bili）的结构面；profile 未启用该插件时为 undefined。 */
export interface BiliUserLike {
  id: string
  mid: string
  name: string
  username: string
  uname: string
  level: number
  coins: number
  sign: string
  vip: { status: number; type: number; label: string }
  avatarUrl: string
}

/** 凭证摘要（不含 Cookie 值）。 */
export interface BiliCredentialLike {
  present: boolean
  savedAt: string
  hasBuvid: boolean
}

/** 统一错误信息。 */
export interface BiliErrorLike {
  code: string
  message: string
  raw?: string
}

/** 登录状态。 */
export interface BiliStatusLike {
  authenticated: boolean
  user: BiliUserLike | null
  credential: BiliCredentialLike
  allowWrites: boolean
  bin: string
  error?: BiliErrorLike
}

/** 命令执行结果。 */
export interface BiliRunResultLike {
  ok: boolean
  dryRun: boolean
  exitCode: number
  command: string
  argv: string[]
  data?: unknown
  error?: BiliErrorLike
  note?: string
  outputDir?: string
}

/** 扫码开始结果。 */
export interface BiliQrStartLike {
  sessionId: string
  qrDataUrl: string
  link: string
  expiresInMs: number
}

/** 扫码轮询结果。 */
export interface BiliQrPollLike {
  status: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'error'
  message?: string
  user?: BiliUserLike | null
  expiresInMs?: number
}

/** 浏览器 Cookie 提取结果。 */
export interface BiliBrowserExtractLike {
  ok: boolean
  status: BiliStatusLike
  hint?: string
  error?: string
}

/** 最近一次探测记录。 */
export interface BiliProbeInfoLike {
  ok: boolean
  error: string
  at: string
}

/** Bilibili 服务最小面（@littly/bili 的 littlyBili 服务）。 */
export interface BiliServiceLike {
  status(): Promise<BiliStatusLike>
  browserExtract(): Promise<BiliBrowserExtractLike>
  qrStart(): Promise<BiliQrStartLike>
  qrPoll(sessionId: string): Promise<BiliQrPollLike>
  logout(): Promise<{ ok: boolean; cleared: boolean }>
  settings(input: { allowWrites?: boolean }): { ok: boolean; allowWrites: boolean }
  binOk(): Promise<boolean>
  lastProbe(): BiliProbeInfoLike | null
  run(argv: string[], opts?: { botId?: string; dryRun?: boolean }): Promise<BiliRunResultLike>
}

export interface Deps {
  storage: LittlyStorage
  persona: LittlyPersona
  memory: LittlyMemory
  hub: LittlyHub
  growth: LittlyGrowth
  mcp: LittlyMcpManager
  /** dsh 原生插件管理器（插件清单/启停/安装）；profile 未装时为 undefined。 */
  pluginManager: PluginManager | undefined
  /** dsh 原生技能注册表；profile 未装时为 undefined。 */
  skills: SkillRegistry | undefined
  /** X（Twitter）服务；profile 未启用 @littly/x 时为 undefined。 */
  x: XService | undefined
  /** QQ 渠道（SnowLuma/官方 QQBot）服务；profile 未启用 @littly/channel-qq 时为 undefined。 */
  qq: QqChannelService | undefined
  /** SnowLuma 一键安装服务；profile 未启用 @littly/snowluma 时为 undefined。 */
  snowluma: SnowlumaService | undefined
  /** 邮箱服务；profile 未启用 @littly/mail 时为 undefined。 */
  mail: MailService | undefined
  /** 记忆 vault 服务；profile 未启用 @littly/memory 时为 undefined。 */
  memoryVault: MemoryVault | undefined
  /** Bilibili 服务；profile 未启用 @littly/bili 时为 undefined。 */
  bili: BiliServiceLike | undefined
  sessions: SessionManager
  cwd: string
  log: (msg: string, ...args: unknown[]) => void
}

export type RegisterFn = (r: Router, d: Deps) => void

/** 当前登录用户的 web sender（= 用户 id）。 */
export function ownSender(ctx: ApiRequest): string {
  return ctx.user?.id ?? ''
}

/** 是否管理员。 */
export function isAdmin(ctx: ApiRequest): boolean {
  return ctx.user?.role === 'admin'
}

/**
 * 会话级 sender 裁决：管理员可用任意 sender（不传回落自己）；
 * 普通用户强制自己的 sender（修复旧 §18.1 #2/#3 的越权）。
 */
export function resolveSender(ctx: ApiRequest, requested: string | undefined): string {
  if (isAdmin(ctx)) return requested !== undefined && requested !== '' ? requested : ownSender(ctx)
  return ownSender(ctx)
}

/** 非 admin 时拒绝指定他人 sender。 */
export function senderAllowed(ctx: ApiRequest, sender: string): boolean {
  return isAdmin(ctx) || sender === ownSender(ctx)
}

export function queryStr(ctx: ApiRequest, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = ctx.query.get(k)
    if (v !== null && v !== '') return v
  }
  return undefined
}

/** bot 存在性检查（400 语义统一）。 */
export function loadBot(d: Deps, botId: string | undefined): BotRow | null {
  if (botId === undefined || botId === '') return null
  return d.persona.loadBot(botId)
}

export function nowIso(): string {
  return new Date().toISOString()
}

/**
 * B3：内容域归属 —— admin 或 bot.owner_id === 当前用户。
 * 空 owner（旧库/播种 bot）视为「仅 admin 可管理」，不把无主资源开放给任意注册用户。
 */
export function botOwnedBy(ctx: ApiRequest, d: Deps, botId: string): boolean {
  if (isAdmin(ctx)) return true
  const user = ctx.user
  if (user === null || botId === '') return false
  const row = d.storage.prepare('SELECT owner_id FROM bots WHERE id = ?').get(botId) as { owner_id?: string } | undefined
  if (row === undefined) return false
  const ownerId = typeof row.owner_id === 'string' ? row.owner_id : ''
  // 本产品的形态是「一个她 + 多个真人用户各聊各的」（sender 才是会话主键），不是多租户多角色。
  // 因此**部署里的第一个 bot（默认的她）对所有登录用户开放**：否则新装实例里第二个非 admin
  // 账号会读不到自己的消息/流（B3 引入的回归）。隔离只针对后续显式创建的额外 bot。
  const first = d.storage.prepare('SELECT id FROM bots ORDER BY created_at ASC LIMIT 1').get() as
    | { id: string }
    | undefined
  if (first !== undefined && first.id === botId) return true
  if (ownerId === '') return true
  return ownerId === user.id
}

/** 校验 bot 归属；无权限时回 403 并返回 false。 */
export function requireBotAccess(ctx: ApiRequest, d: Deps, botId: string): boolean {
  if (botOwnedBy(ctx, d, botId)) return true
  err(ctx.res, 403, 'forbidden', '无权访问该角色')
  return false
}

/**
 * B3：按资源行上的 bot_id 做归属校验。
 * 行没有 bot_id（字符卡级资源）时只允许 admin —— 避免无主资源对任意注册用户开放。
 */
export function requireRowBotAccess(ctx: ApiRequest, d: Deps, botId: string | null | undefined): boolean {
  if (botId === undefined || botId === null || botId === '') {
    if (isAdmin(ctx)) return true
    err(ctx.res, 403, 'forbidden', '无权访问该角色的内容')
    return false
  }
  return requireBotAccess(ctx, d, botId)
}
