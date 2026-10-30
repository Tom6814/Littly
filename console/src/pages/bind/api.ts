/**
 * 账号绑定域 API（`/api/bind/*`，console-api routes-bind.ts）。
 *
 * 为什么自建：fe-core 的 `channelsApi.bindStatus()/unbind()` 是早期按猜测 key 写的
 * （`bindings`/`items`、unbind 无参数），与本页真实契约不符；本域页面只从
 * 这里 import，等 fe-core 修正后可直接换回。
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
          // 后端 SELECT 出的是 snake_case `expires_at`，这里两种都认。
          expiresAt: asStr(p.expiresAt) ?? asStr(p.expires_at),
        }))
        .filter((p) => p.kind !== ''),
    }
  },

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

  async unbind(channel: string, externalId: string): Promise<boolean> {
    const out = await http.post<unknown>('/api/bind/unbind', { channel, externalId })
    const rec = isRecord(out) ? out : {}
    return rec.ok === true
  },
}
