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
): void {
  try {
    deps.storage
      .prepare('INSERT INTO audit_logs (id, bot_id, category, action, detail, created_at) VALUES (?,?,?,?,?,?)')
      .run(randomUUID(), botId, category, action, detail, new Date().toISOString())
  } catch {
    // 审计失败不阻断主流程
  }
}
