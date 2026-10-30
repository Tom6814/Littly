/**
 * @littly/bili — B 站（bilibili）接入插件。
 *
 * 用户需求：抄 public-clis/bilibili-cli（PyPI `bilibili-cli`，命令 `bili`），让 AI 拥有
 * 自己的 B 站账号：视频/用户/搜索/热门/排行/动态/收藏/互动，并支持智能认证
 * （自动提取浏览器 Cookie 或控制台扫码）。
 *
 * 组成：
 * 1. `littlyBili` 服务（CLI 壳 / 允许清单 / 写护栏 / 限频 / 审计 / 扫码 / 凭证）——
 *    console-api 路由与模型工具共用；
 * 2. 模型工具 `bili { argv, dryRun? }`：护栏在 service 内，模型绕不过去；
 * 3. 收敛门：若还挂着旧 bili MCP 服务器（`mcp__bili__*`），一律 deny 并指向元工具
 *    （bilibili-cli 没有 MCP 面；这条兼容逻辑只为旧装配不把模型带偏）。
 *
 * 装配：`@littly/bundle` 的 cordis.patch.yml 已有 `littly-bili` 一行；工具注册等
 * littlyHub 就绪后用 ctx.inject 挂到 Littly 工具表。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { createBiliService, type BiliService, type BiliStorageLike } from './service.ts'
import { registerBiliTool, type BiliToolRegistryLike } from './tool.ts'

export const name = 'littly-bili'

/** 依赖：dsh 工具服务（模型工具面收敛）+ 业务存储（写开关 / 审计 / 限频）。 */
export const inject = ['tools', 'littlyStorage']

export interface Config {
  /** bilibili-cli 可执行文件；默认 process.env.BILI_BIN || 'bili'。 */
  bin?: string
  /** 单次命令超时毫秒；默认 60000。 */
  timeoutMs?: number
  /** bili CLI 的 HOME（默认 BILI_CLI_HOME / 当前用户 HOME）。 */
  homeDir?: string
  /** passport 源（排障/测试用，默认官方）。 */
  passportBaseUrl?: string
  /** 是否收敛旧 mcp__bili__* 工具（默认 true）。 */
  converge?: boolean
  /** 被收敛的 MCP 工具名前缀（默认 mcp__bili__）。 */
  mcpPrefix?: string
}

export const Config: z<Config> = z.object({
  bin: z.string(),
  timeoutMs: z.number(),
  homeDir: z.string(),
  passportBaseUrl: z.string(),
  converge: z.boolean().default(true),
  mcpPrefix: z.string().default('mcp__bili__'),
})

/** 收敛提示：告诉模型该走哪条路，而不是让它以为工具坏了。 */
export const CONVERGE_REASON =
  'bilibili 能力统一走 bili 元工具（子命令允许清单 + 写操作默认预演 + 限频 + 审计），请改用 bili 工具。'

declare module '@deepseek-ai/cordis' {
  interface Context {
    littlyBili: BiliService
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  const storage = ctx.littlyStorage as unknown as BiliStorageLike
  const bin = (config.bin ?? '').trim() || (process.env['BILI_BIN'] ?? '').trim() || 'bili'
  const timeoutMs = typeof config.timeoutMs === 'number' && config.timeoutMs > 0 ? config.timeoutMs : 60_000
  const homeDir = (config.homeDir ?? '').trim() || process.env['BILI_CLI_HOME'] || undefined
  const service = createBiliService(storage, {
    bin,
    timeoutMs,
    ...(homeDir !== undefined && homeDir !== '' ? { homeDir } : {}),
    ...(typeof config.passportBaseUrl === 'string' && config.passportBaseUrl.trim() !== ''
      ? { passportBaseUrl: config.passportBaseUrl.trim() }
      : {}),
  })
  ctx.provide('littlyBili', service)

  // 模型工具：等 hub 就绪再注册（装配顺序解耦，与 @littly/x 同款）。
  ctx.inject(['littlyHub'], (child) => {
    const hub = (child as unknown as { littlyHub?: BiliToolRegistryLike }).littlyHub
    if (hub === undefined) return
    registerBiliTool(hub, service)
    child.logger.info('littly bili tool registered')
  })

  // 收敛门：旧装配里的 `mcp-bili` 已被 bilibili-cli 取代（上游没有 mcp 命令）。
  if (config.converge !== false) {
    const prefix = (config.mcpPrefix ?? '').trim() || 'mcp__bili__'
    ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
      if (exec.name.startsWith(prefix)) {
        ctx.logger.info('[littly-bili] 收敛原始 MCP 工具：%s', exec.name)
        return { kind: 'deny' as const, reason: CONVERGE_REASON }
      }
      return next()
    })
  }

  ctx.logger.info('littly bili ready (bin=%s, timeout=%dms)', bin, timeoutMs)
}

export { createBiliService } from './service.ts'
export type {
  BiliService,
  BiliStatus,
  BiliUser,
  BiliRunResult,
  BiliQrStartResult,
  BiliQrPollResult,
  BiliBrowserExtractResult,
  BiliErrorInfo,
  BiliStorageLike,
} from './service.ts'
export {
  BILI_READ_COMMANDS,
  BILI_WRITE_COMMANDS,
  BILI_BLOCKED_FLAGS,
  BILI_READ_LIMIT_PER_HOUR,
  BILI_WRITE_LIMIT_PER_HOUR,
  BILI_KEYS,
  extractJsonObject,
  mapBiliError,
  sanitizeArgv,
  redactSecrets,
  normalizeBiliUser,
} from './service.ts'
export { qrGenerate, qrPollOnce } from './qr.ts'
export { defaultCredentialPath, readCredential, writeCredential, credentialInfo } from './credential.ts'
export { BILI_TOOL, registerBiliTool } from './tool.ts'
