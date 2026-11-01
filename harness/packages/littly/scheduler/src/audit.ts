/**
 * 审计日志写入（audit_logs；分类受 CHECK 约束，勿越界）。
 */
import { randomUUID } from 'node:crypto'
import type { SchedulerDeps } from './types.ts'

export type AuditCategory =
  | 'tool_call'
  | 'proactive_gate'
  | 'consolidation'
  | 'scheduled_fire'
  | 'diary'
  | 'heartbeat'
  | 'growth'

export function audit(
  deps: SchedulerDeps,
  botId: string,
  category: AuditCategory,
  action: string,
  detail: string,
  /** 审计时间（tick 传入 now，便于测试与同一 tick 内排序；缺省取当前时间）。 */
  at?: Date,
): void {
  try {
    deps.storage
      .prepare('INSERT INTO audit_logs (id, bot_id, category, action, detail, created_at) VALUES (?,?,?,?,?,?)')
      .run(randomUUID(), botId, category, action, detail, (at ?? new Date()).toISOString())
  } catch {
    // 审计失败不阻断主流程
  }
}
