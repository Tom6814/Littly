/**
 * 账号绑定域 API（`/api/bind/*`，console-api routes-bind.ts）。
 *
 * 渠道页共用：`components/AccountBindSection.vue` 只从这里取，不直接散调 http。
 * `channelsApi`（api/endpoints.ts）里也有一组等价方法，属于历史遗留；
 * 本模块是账号绑定 UI 的单一来源，避免两处契约各自漂移。
 */
import { asStr, http, isRecord, pickArray } from '@/api/client'

export interface BindIdentity {
  channel: string
  externalId: string
  createdAt?: string
}

export interface PendingBind {
  kind: string
  expiresAt?: string
}

export interface BindStatus {
  identities: BindIdentity[]
  pending: PendingBind[]
}

export interface BindCode {
  channel: string
  kind: string
  code: string
  expiresAt: string
  instruction: string
}

export const bindApi = {
  /** `GET /api/bind/status`：当前登录用户在各渠道已绑定的身份 + 未消费的码。 */
  async status(): Promise<BindStatus> {
    const out = await http.get<unknown>('/api/bind/status')
    const rec = isRecord(out) ? out : {}
    return {
      identities: pickArray(rec, 'identities')
        .filter(isRecord)
        .map((i) => ({
          channel: asStr(i.channel) ?? '',
          externalId: asStr(i.externalId) ?? '',
          createdAt: asStr(i.createdAt),
        }))
        .filter((i) => i.channel !== ''),
      pending: pickArray(rec, 'pending')
        .filter(isRecord)
        .map((p) => ({
          kind: asStr(p.kind) ?? '',
          // 后端 SELECT 出的是 snake_case `expires_at`，两种都认。
          expiresAt: asStr(p.expiresAt) ?? asStr(p.expires_at),
        }))
        .filter((p) => p.kind !== ''),
    }
  },

  /** `POST /api/bind/:channel/code`：一次性绑定码（10 分钟；同 kind 新码顶掉旧码）。 */
  async createCode(channel: string, botId?: string): Promise<BindCode> {
    const out = await http.post<unknown>(`/api/bind/${encodeURIComponent(channel)}/code`, {
      ...(botId ? { botId } : {}),
    })
    const rec = isRecord(out) ? out : {}
    return {
      channel: asStr(rec.channel) ?? channel,
      kind: asStr(rec.kind) ?? '',
      code: asStr(rec.code) ?? '',
      expiresAt: asStr(rec.expiresAt) ?? '',
      instruction: asStr(rec.instruction) ?? '',
    }
  },

  /** `POST /api/bind/unbind`：解绑某渠道身份（历史与记忆保留）。 */
  async unbind(channel: string, externalId: string): Promise<boolean> {
    const out = await http.post<unknown>('/api/bind/unbind', { channel, externalId })
    const rec = isRecord(out) ? out : {}
    return rec.ok === true
  },
}
