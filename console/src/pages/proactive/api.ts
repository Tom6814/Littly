/**
 * 主动域 API：定时消息（预约/承诺线）+ 主动性/心声回响设置（bot settings 的 proactive 组）。
 *
 * 定时消息契约见 console-api routes-data.ts（scheduledView 字段）；
 * proactive 设置见 mapping.ts BOT_SETTING_GROUPS.proactive（读走 botSettingsView，
 * 写走 PATCH /api/bots/:id 的嵌套组，后端逐字段 merge）。
 */
import { asNum, asStr, http, isRecord, pickArray } from '@/api/client'
import { botsApi } from '@/api/endpoints'

export interface ScheduledMessage {
  id: string
  botId: string
  sender: string
  fireAt: string
  tolerance?: number
  /** 1=必须发生 / 2=尽量 / 3=可以错过（后端默认 3）。 */
  strictness: number
  prompt: string
  origin: string
  status: string
  failureReason: string
  channel: string
  createdAt?: string
  firedAt?: string
}

export interface ScheduledInput {
  botId: string
  fireAt: string
  prompt: string
  strictness: number
  origin?: string
}

function toScheduled(v: unknown): ScheduledMessage | undefined {
  if (!isRecord(v)) return undefined
  const id = asStr(v.id)
  if (!id) return undefined
  return {
    id,
    botId: asStr(v.botId) ?? '',
    sender: asStr(v.sender) ?? '',
    fireAt: asStr(v.fireAt) ?? '',
    tolerance: asNum(v.tolerance),
    strictness: asNum(v.strictness) ?? 3,
    prompt: asStr(v.prompt) ?? '',
    origin: asStr(v.origin) ?? '',
    status: asStr(v.status) ?? 'pending',
    failureReason: asStr(v.failureReason) ?? '',
    channel: asStr(v.channel) ?? '',
    createdAt: asStr(v.createdAt),
    firedAt: asStr(v.firedAt),
  }
}

export const scheduledApi = {
  async list(botId: string): Promise<ScheduledMessage[]> {
    const out = await http.get<unknown>('/api/scheduled-messages', { botId })
    const rec = isRecord(out) ? out : {}
    return pickArray(rec, 'scheduledMessages')
      .map(toScheduled)
      .filter((m): m is ScheduledMessage => m !== undefined)
      .sort((a, b) => a.fireAt.localeCompare(b.fireAt))
  },
  async create(input: ScheduledInput): Promise<void> {
    await http.post('/api/scheduled-messages', input)
  },
  async cancel(id: string): Promise<void> {
    await http.del(`/api/scheduled-messages/${encodeURIComponent(id)}`)
  },
}

export interface ProactiveSettings {
  enabled: boolean
  heartbeatEnabled: boolean
  /** 静默开始/结束小时（0-23）。 */
  quietStart: number
  quietEnd: number
  /** 每日主动上限。 */
  dailyLimit: number
  /** 两次主动的最小间隔（秒）。 */
  minInterval: number
}

const DEFAULTS: ProactiveSettings = {
  enabled: true,
  heartbeatEnabled: false,
  quietStart: 23,
  quietEnd: 8,
  dailyLimit: 8,
  minInterval: 7200,
}

function toProactive(settings: Record<string, unknown> | undefined): ProactiveSettings {
  const group = settings ? settings.proactive : undefined
  const rec = isRecord(group) ? group : {}
  return {
    enabled: typeof rec.enabled === 'boolean' ? rec.enabled : DEFAULTS.enabled,
    heartbeatEnabled: typeof rec.heartbeatEnabled === 'boolean' ? rec.heartbeatEnabled : DEFAULTS.heartbeatEnabled,
    quietStart: asNum(rec.quietStart) ?? DEFAULTS.quietStart,
    quietEnd: asNum(rec.quietEnd) ?? DEFAULTS.quietEnd,
    dailyLimit: asNum(rec.dailyLimit) ?? DEFAULTS.dailyLimit,
    minInterval: asNum(rec.minInterval) ?? DEFAULTS.minInterval,
  }
}

export const proactiveSettingsApi = {
  async get(botId: string): Promise<ProactiveSettings> {
    const bot = await botsApi.get(botId)
    return toProactive(bot?.settings)
  },
  /** 只提交要改的字段（后端按 `f.key in rec` 逐字段写，不会把其它字段清掉）。 */
  async save(botId: string, patch: Partial<ProactiveSettings>): Promise<void> {
    await botsApi.patch(botId, { proactive: patch })
  },
}
