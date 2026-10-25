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
  const hub = new LittlyHub(
    ctx.littlyStorage as LittlyStorage,
    ctx.littlyPersona as LittlyPersona,
    ctx.littlyMemory as LittlyMemory,
    process.cwd(),
    (msg, ...args) => ctx.logger.info(msg, ...args),
  )
  ctx.provide('littlyHub', hub)
  ctx.logger.info('littly hub ready')
}

export { LittlyHub } from './hub.ts'
export type { LittlyHub as LittlyHubType, ChatRequest, ChatResponse, ChannelSender } from './hub.ts'
