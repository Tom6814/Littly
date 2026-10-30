/**
 * @littly/console-api — 控制台 HTTP API 插件。
 *
 * 在 ctx.webServer 上以单个 '/api' 前缀路由承载全部控制台端点（内部极简路由表），
 * 鉴权走 httpOnly Cookie（手写 HS256 JWT，密钥取 GlobalSetting platform.secret）。
 * 安全修复对应旧 PROJECT-DESIGN §18.1：
 * - /api/bots 只回白名单字段，渠道密钥永不外传（#1）；
 * - 消息 / 会话 / 搜索按登录用户裁剪 sender（#2）；
 * - 消息与聊天写操作一律要求登录（#3/#4）；
 * - /api/seed 仅空库可写（#5）；
 * - 错误信封统一 {error:{code,message(中文)}}（§19.4）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import z from '@deepseek-ai/schemastery'
import type { LittlyStorage } from '@littly/storage'
import type { LittlyPersona } from '@littly/persona'
import type { LittlyMemory } from '@littly/memory'
import type { LittlyHub } from '@littly/agents'
import type { LittlyGrowth } from '@littly/growth'
import type { LittlyMcpManager } from '@littly/mcp'
import type { PluginManager as LittlyPluginManager } from '@deepseek-ai/dsh-plugin-manager'
import type { SkillRegistry as LittlySkillRegistry } from '@deepseek-ai/dsh-skill'
import { Router, type ApiRequest, type WebServerLike } from './http.ts'
import { registerConsoleStatic } from './static.ts'
import { SessionManager } from './auth.ts'
import type { Deps } from './deps.ts'
import { registerAuthRoutes } from './routes-auth.ts'
import { registerBotRoutes } from './routes-bots.ts'
import { registerContentRoutes } from './routes-content.ts'
import { registerChatRoutes } from './routes-chat.ts'
import { registerDataRoutes } from './routes-data.ts'
import { registerAdminRoutes } from './routes-admin.ts'
import { registerBindRoutes } from './routes-bind.ts'
import { registerOnboardingRoutes } from './routes-onboarding.ts'
import { registerWechatRoutes, createWechatServiceGetter } from './routes-wechat.ts'
import { registerXRoutes } from './routes-x.ts'
import { registerQqRoutes } from './routes-qq.ts'
import type { XService } from '@littly/x'
import type { QqChannelService } from '@littly/channel-qq'

export const name = 'littly-console-api'

/** 依赖的服务：业务存储 / 人格 / 记忆 / 对话枢纽 / webServer（named route 注册）。 */
export const inject = ['littlyStorage', 'littlyPersona', 'littlyMemory', 'littlyHub', 'littlyGrowth', 'littlyMcp', 'webServer']

export interface Config {}

export const Config: z<Config> = z.object({})

/** 健康检查 + 全部端点挂载。 */
export function apply(ctx: Context, _config: Config): void {
  const web = (ctx as unknown as { webServer?: WebServerLike }).webServer
  if (web === undefined) {
    ctx.logger.warn('littly-console-api: webServer 服务不可用，控制台 API 未挂载')
    return
  }
  const sessions = new SessionManager(ctx.littlyStorage as LittlyStorage)
  const deps: Deps = {
    storage: ctx.littlyStorage as LittlyStorage,
    persona: ctx.littlyPersona as LittlyPersona,
    memory: ctx.littlyMemory as LittlyMemory,
    hub: ctx.littlyHub as LittlyHub,
    growth: ctx.littlyGrowth as LittlyGrowth,
    mcp: ctx.littlyMcp as LittlyMcpManager,
    // dsh 原生服务：用 ctx.get 取（不写进 inject）——读得到就用，读不到就降级，
    // 不阻塞控制台启动（ctx.pluginManager 直接取会触发 Cordis 的 inject 守卫）。
    pluginManager: ctx.get('pluginManager') as LittlyPluginManager | undefined,
    skills: ctx.get('skills') as LittlySkillRegistry | undefined,
    x: ctx.get('littlyX') as XService | undefined,
    qq: ctx.get('littlyChannelQq') as QqChannelService | undefined,
    sessions,
    cwd: process.cwd(),
    log: (msg, ...args) => ctx.logger.info(msg, ...args),
  }

  const router = new Router()
  router.resolveUser = (req) => sessions.userFromRequest(req)
  registerAuthRoutes(router, deps)
  registerBotRoutes(router, deps)
  registerContentRoutes(router, deps)
  registerChatRoutes(router, deps)
  registerDataRoutes(router, deps)
  registerAdminRoutes(router, deps)
  registerBindRoutes(router, deps)
  registerOnboardingRoutes(router, deps)
  registerWechatRoutes(router, deps, createWechatServiceGetter(ctx))
  registerXRoutes(router, deps)
  registerQqRoutes(router, deps)
  router.get('/api', 'public', (a) => {
    jsonHealth(a)
  })

  ctx.effect(() => router.mount(web), 'littly-console-api: /api routes')

  // 控制台静态资源（SPA）：/api 之外的请求落到控制台前端
  const webWithFallback = web as unknown as {
    registerFallback?: (fallback: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) => () => void
  }
  const registerFallback = webWithFallback.registerFallback
  if (typeof registerFallback === 'function') {
    ctx.effect(
      () => registerConsoleStatic(registerFallback.bind(web) as never),
      'littly-console-api: console static',
    )
  }
  ctx.logger.info('littly console api ready')
}

/** GET /api → {ok:true}。 */
function jsonHealth(ctx: ApiRequest): void {
  ctx.res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  ctx.res.end(JSON.stringify({ ok: true }))
}

export type { WebServerLike }
