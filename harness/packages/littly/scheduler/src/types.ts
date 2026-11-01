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
  /** 可注入随机源（主动排期抖动；测试传定值，生产缺省用 Math.random）。 */
  rng?: (() => number) | undefined
  /** B9：成长系统服务（profile 未装配 growth 插件时为 undefined，静默跳过月度评审）。 */
  growth?: GrowthTickLike | undefined
  /** 记忆 vault（profile 未装配 memory vault 时为 undefined，静默跳过每日 Dream 整理）。 */
  memoryVault?: MemoryVaultTickLike | undefined
}

/** 记忆 vault 的定时整理最小结构面（避免 scheduler→memory 的实现耦合）。 */
export interface MemoryVaultTickLike {
  consolidateDue(kind: 'threshold' | 'daily', now: Date): Promise<Array<{ status: string; added: number; merged: number; superseded: number; archived: number }>>
}
