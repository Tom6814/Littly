/**
 * 调度器依赖注入面（index.ts 装配，子模块共用）。
 */
import type { LittlyStorage } from '@littly/storage'
import type { LittlyHub } from '@littly/agents'
import type { LittlyMemory } from '@littly/memory'

export interface SchedulerDeps {
  storage: LittlyStorage
  hub: LittlyHub
  memory: LittlyMemory
  log: (msg: string, ...args: unknown[]) => void
}
