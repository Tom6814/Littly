/**
 * 调度器依赖注入面（index.ts 装配，子模块共用）。
 */
import type { LittlyStorage } from '@littly/storage'
import type { LittlyHub } from '@littly/agents'
import type { LittlyMemory } from '@littly/memory'
import type { GrowthTickLike } from './growth-tick.ts'

export interface SchedulerDeps {
  storage: LittlyStorage
  hub: LittlyHub
  memory: LittlyMemory
  log: (msg: string, ...args: unknown[]) => void
  /** B9：成长系统服务（profile 未装配 growth 插件时为 undefined，静默跳过月度评审）。 */
  growth?: GrowthTickLike | undefined
}
