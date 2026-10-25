/**
 * @littly/bili — bilibili 能力的「收敛口」。
 *
 * 计划 v2 §7：「harness 挂 `mcp/bili`，AI 侧收敛为带护栏的 `bili` 元工具」。
 *
 * 两条面同时存在：
 * 1. MCP 面：harness 通过 dsh 的 mcp-client 挂上 bili 的 MCP 服务器（stdio），
 *    工具名 mcp__bili__<tool>（上游实测 17 个：12 只读 + 5 写）。
 *    —— 这是「她能链接更多东西」的通道：MCP 原生接入，不自己造轮子。
 * 2. 元工具面：模型真正能调的是内置 `bili` 元工具 → 走 sidecar HTTP /cmd，
 *    由 sidecar 强制「子命令白名单 + 写操作默认 dry-run + 每日限频 + 审计」。
 *
 * 本插件负责第 2 条的收敛：用 tools/pre-execute 把原始 MCP 工具全部挡住，
 * 逼模型只能走带护栏的元工具（否则 MCP 的写工具会绕过白名单与 dry-run）。
 *
 * 账号隔离：BILI_CLI_HOME 指向她自己的 bilibili home，与主人无关。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

export const name = 'littly-bili'

export const inject = ['tools']

export interface Config {
  /** 是否拦截原始 MCP 工具（默认 true = 收敛到 bili 元工具）。 */
  converge: boolean
  /** 被收敛的 MCP 工具名前缀（默认 mcp__bili__）。 */
  mcpPrefix: string
}

export const Config: z<Config> = z.object({
  converge: z.boolean().default(true),
  mcpPrefix: z.string().default('mcp__bili__'),
})

/** 收敛提示：告诉模型该走哪条路，而不是让它以为工具坏了。 */
export const CONVERGE_REASON =
  'bilibili 能力统一走 bili 元工具（子命令白名单 + 写操作默认预演 + 审计），请改用 bili 工具。'

export function apply(ctx: Context, config: Config): void {
  if (!config.converge) {
    ctx.logger.info('littly bili ready (MCP 工具未收敛)')
    return
  }
  ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    if (exec.name.startsWith(config.mcpPrefix)) {
      ctx.logger.info('[littly-bili] 收敛原始 MCP 工具：%s', exec.name)
      return { kind: 'deny' as const, reason: CONVERGE_REASON }
    }
    return next()
  })
  ctx.logger.info('littly bili ready (原始 MCP 工具已收敛到 bili 元工具)')
}
