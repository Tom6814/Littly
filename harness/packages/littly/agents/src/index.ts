/**
 * agents 插件：装配 LittlyHub（对话主链路 + 缓冲窗口 + 渠道投递）。
 * 服务键 'littlyHub'，console-api / 渠道插件 / 调度器共同消费。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { LittlyStorage } from '@littly/storage'
import type { LittlyPersona } from '@littly/persona'
import type { LittlyMemory } from '@littly/memory'
import { LittlyHub } from './hub.ts'
import { repairContacts } from './contacts.ts'
import { createDshToolBridge, type DshToolsLike } from './dsh-bridge.ts'

export const name = 'littly-agents'

export const inject = ['littlyStorage', 'littlyPersona', 'littlyMemory']

export interface Config {}

export const Config: z<Config> = z.object({})

declare module '@deepseek-ai/cordis' {
  interface Context {
    littlyHub: LittlyHub
  }
}

export function apply(ctx: Context, _config: Config): void {
  // dsh 插件工具桥：社区插件/MCP 注册的工具对模型可见可调（ctx.tools 不在时为空桥）
  // 用 ctx.get 取（不写进 inject）：取不到就当没有 dsh 工具（ctx.tools 直接取会触发 Cordis 的 inject 守卫）
  const dshTools = createDshToolBridge(() => ctx.get('tools') as DshToolsLike | undefined)
  const hub = new LittlyHub(
    ctx.littlyStorage as LittlyStorage,
    ctx.littlyPersona as LittlyPersona,
    ctx.littlyMemory as LittlyMemory,
    process.cwd(),
    (msg, ...args) => ctx.logger.info(msg, ...args),
    dshTools,
  )
  ctx.provide('littlyHub', hub)
  // 存量联系人身份修复（幂等；跨平台同一用户=同一联系人）。失败不阻塞启动。
  try {
    const repaired = repairContacts(ctx.littlyStorage as LittlyStorage)
    ctx.logger.info('[contacts] repaired %d (scanned %d)', repaired.repaired, repaired.scanned)
    if (repaired.repaired > 0) ctx.logger.warn('[contacts] repaired %d legacy contact row(s) (scanned %d)', repaired.repaired, repaired.scanned)
  } catch (error) {
    ctx.logger.warn('[contacts] repair 失败: %s', String(error))
  }
  ctx.logger.info('littly hub ready')
}

export { LittlyHub } from './hub.ts'
export { resolveContact, promoteContact, repairContacts, looksLikeRawId } from './contacts.ts'
export type { ContactRowLite, ResolveContactHints, ResolvedContact } from './contacts.ts'
export { createDshToolBridge, renderDshResult } from './dsh-bridge.ts'
export type { DshToolBridge, DshToolsLike } from './dsh-bridge.ts'
export type { LittlyHub as LittlyHubType, ChatRequest, ChatResponse, ChannelSender } from './hub.ts'
