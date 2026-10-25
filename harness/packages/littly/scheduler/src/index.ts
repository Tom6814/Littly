/**
 * @littly/scheduler — 60s 业务 tick（旧 bot/manager.ts checkScheduledMessages 的移植基线）：
 *
 * a) hub.recoverStalled() 僵死批次恢复 + 到期缓冲兜底（旧 tickBufferFlush 语义；
 *    hub 的认领是原子的，与本兜底并行安全）。
 * b) 到期预约消息：gate（promise 永远放行；proactive 过三道闸）→ hub.runTurn 生成
 *    并按 scheduled.channel 投递 → 状态落库 + 审计（proactive_gate / scheduled_fire）。
 * c) 日记自动写作（diary 审计）。
 * d) TODO(M3) 心声回响（heartbeat）：旧 bot/heartbeat.ts 的静默扫描 + 指数退避唤醒，
 *    今晚不移植；用户来消息唤醒（hub.runTurn 清 sleep_until）语义已就位。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { LittlyStorage } from '@littly/storage'
import type { LittlyHub } from '@littly/agents'
import type { LittlyMemory } from '@littly/memory'
import { runDiaryTick } from './diary.ts'
import { processScheduledMessages } from './scheduled.ts'
import type { SchedulerDeps } from './types.ts'

export const name = 'littly-scheduler'

export const inject = ['littlyStorage', 'littlyHub', 'littlyMemory']

export interface Config {
  /** tick 间隔（毫秒），下限 5000 */
  tickMs: number
}

export const Config: z<Config> = z.object({
  tickMs: z.number().default(60_000),
})

/** 到期缓冲兜底：pending 且已到期的批次补一把 flush（关闭页面 / 计时器丢失时的恢复路径）。 */
async function flushDueBatches(deps: SchedulerDeps): Promise<void> {
  const due = deps.storage
    .prepare("SELECT DISTINCT bot_id, sender FROM messages WHERE buffer_status = 'pending' AND buffer_fire_at <= ?")
    .all(new Date().toISOString()) as Array<{ bot_id: string; sender: string }>
  for (const row of due) {
    try {
      await deps.hub.flushBuffered(row.bot_id, row.sender)
    } catch {
      // 单批失败下个 tick 重试
    }
  }
}

export async function tick(deps: SchedulerDeps, now: Date, opts: { skipDiary: boolean }): Promise<void> {
  // a) 僵死批次恢复 + 到期缓冲兜底
  deps.hub.recoverStalled()
  await flushDueBatches(deps)

  // b) 到期预约消息
  const fired = await processScheduledMessages(deps, now)
  if (fired.length > 0) deps.log('[scheduler] 预约消息处理 %d 条', fired.length)

  // c) 日记自动写作（首 tick 跳过，旧行为）
  if (!opts.skipDiary) {
    const written = await runDiaryTick(deps, now)
    if (written > 0) deps.log('[scheduler] 日记写作 %d 篇', written)
  }

  // d) TODO(M3) heartbeat（心声回响）
}

export function apply(ctx: Context, config: Config): void {
  const deps: SchedulerDeps = {
    storage: ctx.littlyStorage as LittlyStorage,
    hub: ctx.littlyHub as LittlyHub,
    memory: ctx.littlyMemory as LittlyMemory,
    log: (msg, ...args) => ctx.logger.info(msg, ...args),
  }
  const tickMs = Math.max(5_000, Math.round(config.tickMs) || 60_000)

  // 首 tick 立即跑（跳过日记）；上一 tick 未结束时跳过本轮（LLM 调用可能超 60s）
  let firstTick = true
  let running = false
  ctx.effect(() => {
    const runTick = (): void => {
      if (running) return
      running = true
      const skipDiary = firstTick
      firstTick = false
      void tick(deps, new Date(), { skipDiary })
        .catch((err) => deps.log('[scheduler] tick 失败: %s', String(err)))
        .finally(() => {
          running = false
        })
    }
    runTick()
    const timer = setInterval(runTick, tickMs)
    return () => clearInterval(timer)
  }, 'littly-scheduler.tick')

  ctx.logger.info('littly scheduler ready (tick=%dms)', tickMs)
}
