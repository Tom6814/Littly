/**
 * @littly/x — X（Twitter）接入插件。
 *
 * 用户需求：让她拥有自己的 X 账号，基于 twitter-cli（`twitter`，v0.8.5）。
 *
 * 组成：
 * 1. `littlyX` 服务（凭据 / 登录 / 探测 / 护栏化的命令执行）→ console-api 路由与 `x` 工具共用；
 * 2. 模型工具 `x`：argv 子命令 + 写操作默认 dry-run，护栏在 service 内（模型绕不过去）。
 *
 * 装配：`@littly/bundle` 的 cordis.patch.yml 加一行；工具注册等 littlyHub 就绪后
 * 用 ctx.inject 挂到 Littly 工具表（模型真正能调的是这张表）。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { LittlyStorage } from '@littly/storage'
import { createXService, type XService } from './service.ts'
import { registerXTool, type XToolRegistryLike } from './tool.ts'

export const name = 'littly-x'

/** 依赖：dsh 工具服务（保留给后续 dsh 原生工具面）+ 业务存储。 */
export const inject = ['tools', 'littlyStorage']

export interface Config {
  /** twitter-cli 可执行文件；默认 process.env.X_BIN || 'twitter'。 */
  bin?: string
  /** 单次命令超时毫秒；默认 60000。 */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  bin: z.string(),
  timeoutMs: z.number(),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    littlyX: XService
  }
}

/** 装配：提供服务键 littlyX，并在 hub 就绪后注册 `x` 工具。 */
export function apply(ctx: Context, config: Config = {}): void {
  const storage = ctx.littlyStorage as LittlyStorage
  const bin = (config.bin ?? '').trim() || (process.env['X_BIN'] ?? '').trim() || 'twitter'
  const timeoutMs = typeof config.timeoutMs === 'number' && config.timeoutMs > 0 ? config.timeoutMs : 60_000
  const service = createXService(storage, { bin, timeoutMs })
  ctx.provide('littlyX', service)

  // hub 是后装配的服务（cordis.patch.yml 里 littly-agents 在 console-api 之前），
  // 用 ctx.inject 等它就绪再注册工具，避免装配顺序耦合。
  ctx.inject(['littlyHub'], (child) => {
    const hub = (child as unknown as { littlyHub?: XToolRegistryLike }).littlyHub
    if (hub === undefined) return
    registerXTool(hub, service)
    child.logger.info('littly x tool registered')
  })

  ctx.logger.info('littly x ready (bin=%s, timeout=%dms)', bin, timeoutMs)
}

export { createXService, parseXCookie, extractJsonObject, mapXError, sanitizeArgv } from './service.ts'
export type { XService, XStatus, XRunResult, XLoginInput, XProbeResult, XErrorInfo } from './service.ts'
export { X_TOOL, registerXTool } from './tool.ts'
