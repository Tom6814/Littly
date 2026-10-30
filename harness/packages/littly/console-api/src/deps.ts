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
import type { SessionManager } from './auth.ts'
import { err, type Router, type ApiRequest } from './http.ts'

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
  return row !== undefined && typeof row.owner_id === 'string' && row.owner_id !== '' && row.owner_id === user.id
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
