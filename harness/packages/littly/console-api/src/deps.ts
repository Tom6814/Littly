/**
 * 路由模块共享依赖与鉴权辅助。
 */
import type { LittlyStorage, BotRow } from '@littly/storage'
import type { LittlyPersona } from '@littly/persona'
import type { LittlyMemory } from '@littly/memory'
import type { LittlyHub } from '@littly/agents'
import type { LittlyGrowth } from '@littly/growth'
import type { SessionManager } from './auth.ts'
import type { Router, ApiRequest } from './http.ts'

export interface Deps {
  storage: LittlyStorage
  persona: LittlyPersona
  memory: LittlyMemory
  hub: LittlyHub
  growth: LittlyGrowth
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
