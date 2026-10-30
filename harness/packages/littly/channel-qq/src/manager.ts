/**
 * QQ 双渠道管理器（简化移植自 lane-bridge `lib/channels/manager.js`，MIT）。
 *
 * 与 lane-bridge 的差异：只保留两种渠道（snowluma / qqbot），生命周期键为
 * `${botId}:${kind}`（一个 bot 各一条连接），状态与日志按 bot 聚合给控制台。
 * 入站消息统一经 onMessage 回调交给 inbound.ts；出站由 hub 的 registerChannel 调用。
 */
import type { BotRow, LittlyStorage } from '@littly/storage'
import { SnowLumaAdapter } from './adapters/snowluma.ts'
import { QqbotAdapter, type QqbotSdkLike } from './adapters/qqbot.ts'
import type { AdapterLogger, InboundMessage, OutboundConversation } from './adapters/base.ts'
import type { WebSocketLike } from './adapters/onebot-ws.ts'

export type QqChannelKind = 'snowluma' | 'qqbot'

export interface QqChannelStatus {
  enabled: boolean
  configured: boolean
  connected: boolean
  selfId?: string
  nickname?: string
  lastError?: string
  lastEventAt?: number
  wsUrl?: string
  hasToken?: boolean
  appId?: string
  hasSecret?: boolean
}

export interface QqStatusResult {
  snowluma: QqChannelStatus
  qqbot: QqChannelStatus
  bots: number
}

export interface QqLogLine {
  at: string
  level: 'debug' | 'info' | 'warn' | 'error'
  text: string
}

export interface QqProbeResult {
  ok: boolean
  selfId?: string
  nickname?: string
  error?: string
}

export interface QqManagerDeps {
  storage: LittlyStorage
  log: (msg: string, ...args: unknown[]) => void
  onMessage: (message: InboundMessage, bot: BotRow) => void
  /** 测试注入。 */
  loadQqbotModule?: (() => Promise<QqbotSdkLike>) | null
  webSocketFactory?: ((url: string) => WebSocketLike) | null
  /** initData 默认 3000（拼接 webui 等外部 URL 时用） */
  publicBaseUrl?: string
}

interface ManagedAdapter {
  botId: string
  kind: QqChannelKind
  adapter: SnowLumaAdapter | QqbotAdapter
}

const MAX_LOG_LINES = 300

export class QqChannelManager {
  private readonly deps: QqManagerDeps
  private readonly entries = new Map<string, ManagedAdapter>()
  private readonly logLines: QqLogLine[] = []
  private readonly logger: AdapterLogger
  private syncQueue: Promise<void> = Promise.resolve()
  /** 最近入站消息 id（被动回复窗口）：key = `${botId}:${kind}:${externalId}`，60min TTL。 */
  private readonly recentMessageIds = new Map<string, { msgId: string; at: number }>()
  private readonly lastInbounds = new Map<string, { kind: 'group' | 'private'; externalId: string; hubChannel: string; at: number }>()

  constructor(deps: QqManagerDeps) {
    this.deps = deps
    const record = (level: QqLogLine['level'], args: unknown[]): void => {
      const text = args.map((v) => (typeof v === 'string' ? v : String((v as { message?: unknown } | null)?.message ?? v))).join(' ')
      this.logLines.push({ at: new Date().toISOString(), level, text: text.slice(0, 2000) })
      if (this.logLines.length > MAX_LOG_LINES) this.logLines.splice(0, this.logLines.length - MAX_LOG_LINES)
    }
    const base = deps.log
    this.logger = {
      debug: (...args: unknown[]) => { record('debug', args); base('[qq][debug]', ...args) },
      info: (...args: unknown[]) => { record('info', args); base('[qq]', ...args) },
      warn: (...args: unknown[]) => { record('warn', args); base('[qq][warn]', ...args) },
      error: (...args: unknown[]) => { record('error', args); base('[qq][error]', ...args) },
    }
  }

  logs(tail = 100): QqLogLine[] {
    const n = Math.min(MAX_LOG_LINES, Math.max(1, Math.round(tail)))
    return this.logLines.slice(-n).reverse()
  }

  private bots(): BotRow[] {
    return this.deps.storage.prepare('SELECT * FROM bots ORDER BY created_at ASC').all() as unknown as BotRow[]
  }

  /** 幂等同步：按 bots 表启停/补齐两个适配器。串行化，避免并发 sync 交叉重启。 */
  sync(): Promise<void> {
    this.syncQueue = this.syncQueue.then(() => this.runSync()).catch((error: unknown) => {
      this.logger.warn?.(`[channel-qq] sync 失败：${(error as Error)?.message ?? String(error)}`)
    })
    return this.syncQueue
  }

  private async runSync(): Promise<void> {
    const bots = this.bots()
    const wanted = new Set<string>()
    for (const bot of bots) {
      if (bot.snowluma_enabled === 1 && bot.snowluma_ws_url.trim() !== '') {
        wanted.add(`${bot.id}:snowluma`)
        await this.ensure(bot, 'snowluma')
      }
      if (bot.qq_enabled === 1 && bot.qq_app_id.trim() !== '' && bot.qq_app_secret.trim() !== '') {
        wanted.add(`${bot.id}:qqbot`)
        await this.ensure(bot, 'qqbot')
      }
    }
    // 停掉不再需要的
    for (const [key, entry] of [...this.entries]) {
      if (wanted.has(key)) continue
      this.entries.delete(key)
      try {
        await entry.adapter.stop()
      } catch {
        // ignore
      }
    }
  }

  private async ensure(bot: BotRow, kind: QqChannelKind): Promise<void> {
    const key = `${bot.id}:${kind}`
    const existing = this.entries.get(key)
    const signature = kind === 'snowluma'
      ? `${bot.snowluma_ws_url}\u0000${bot.snowluma_token}\u0000${bot.snowluma_account}`
      : `${bot.qq_app_id}\u0000${bot.qq_app_secret}`
    const stored = this.entries.get(key) as (ManagedAdapter & { signature?: string }) | undefined
    if (existing !== undefined && stored?.signature === signature) return
    if (existing !== undefined) {
      this.entries.delete(key)
      try { await existing.adapter.stop() } catch { /* ignore */ }
    }
    const adapter = kind === 'snowluma'
      ? new SnowLumaAdapter({
          config: {
            wsUrl: bot.snowluma_ws_url,
            accessToken: bot.snowluma_token,
            homeDir: process.env['SNOWLUMA_HOME'] ?? '',
            account: bot.snowluma_account,
          },
          logger: this.logger,
          webSocketFactory: this.deps.webSocketFactory ?? null,
        })
      : new QqbotAdapter({
          config: { appId: bot.qq_app_id, appSecret: bot.qq_app_secret, allowActive: true },
          logger: this.logger,
          loadQqbotModule: this.deps.loadQqbotModule ?? null,
        })
    const entry: ManagedAdapter & { signature?: string } = { botId: bot.id, kind, adapter, signature }
    this.entries.set(key, entry)
    adapter.on('message', (message: InboundMessage) => {
      const externalId = message.kind === 'group' ? message.externalId : message.senderId
      if (message.replyToId !== undefined && message.replyToId !== '') {
        this.recentMessageIds.set(`${bot.id}:${kind}:${externalId}`, { msgId: message.replyToId, at: Date.now() })
        if (this.recentMessageIds.size > 500) {
          const cutoff = Date.now() - 60 * 60_000
          for (const [k, v] of this.recentMessageIds) if (v.at < cutoff) this.recentMessageIds.delete(k)
        }
      }
      try {
        this.deps.onMessage(message, bot)
      } catch (error) {
        this.logger.warn?.(`[channel-qq] 入站消息分发失败：${(error as Error)?.message ?? String(error)}`)
      }
    })
    adapter.on('status', (status: { lastError?: string; connected?: boolean }) => {
      if (status.lastError !== undefined && status.lastError !== '') this.logger.warn?.(`[${kind}] ${status.lastError}`)
      else if (status.connected === true) this.logger.info?.(`[${kind}] 已连接 (bot=${bot.name})`)
    })
    await adapter.start()
  }

  private entryFor(botId: string, kind: QqChannelKind): ManagedAdapter | undefined {
    return this.entries.get(`${botId}:${kind}`)
  }

  private firstEntry(kind: QqChannelKind): ManagedAdapter | undefined {
    for (const entry of this.entries.values()) if (entry.kind === kind) return entry
    return undefined
  }

  /** 聚合状态（多个 bot 取「任一启用/任一连接」+ 第一个具体信息）。 */
  status(): QqStatusResult {
    const bots = this.bots()
    const aggregate = (kind: QqChannelKind): QqChannelStatus => {
      const adapterEntries = [...this.entries.values()].filter((e) => e.kind === kind)
      const statuses = adapterEntries.map((e) => e.adapter.status())
      const connected = statuses.find((s) => s.connected)
      const bot = bots[0]
      const enabled = kind === 'snowluma'
        ? bots.some((b) => b.snowluma_enabled === 1)
        : bots.some((b) => b.qq_enabled === 1)
      const configured = kind === 'snowluma'
        ? bots.some((b) => b.snowluma_ws_url.trim() !== '')
        : bots.some((b) => b.qq_app_id.trim() !== '' && b.qq_app_secret.trim() !== '')
      const lastError = statuses.map((s) => s.lastError).find((e) => e !== '') ?? ''
      return {
        enabled,
        configured,
        connected: connected !== undefined,
        ...(connected?.selfId ? { selfId: connected.selfId } : {}),
        ...(connected?.nickname ? { nickname: connected.nickname } : {}),
        ...(lastError !== '' ? { lastError } : {}),
        lastEventAt: Math.max(0, ...statuses.map((s) => s.lastEventAt)),
        ...(kind === 'snowluma' ? { wsUrl: bot?.snowluma_ws_url ?? '', hasToken: (bot?.snowluma_token ?? '') !== '' } : { appId: bot?.qq_app_id ?? '', hasSecret: (bot?.qq_app_secret ?? '') !== '' }),
      }
    }
    return { snowluma: aggregate('snowluma'), qqbot: aggregate('qqbot'), bots: bots.length }
  }

  /** 出站：把文本投递到指定渠道的指定会话。 */
  async send(botId: string, kind: QqChannelKind, conversation: OutboundConversation, messages: string[]): Promise<{ ok: boolean; sent: number; error?: string }> {
    const entry = this.entryFor(botId, kind)
    if (entry === undefined) return { ok: false, sent: 0, error: kind === 'snowluma' ? 'SnowLuma 未启用/未连接' : 'QQ Bot 未启用/未连接' }
    try {
      const results = await entry.adapter.send(conversation, messages)
      return { ok: results.every((r) => r.ok !== false), sent: results.length, ...(results.length === 0 ? { error: '没有可发送的内容' } : {}) }
    } catch (error) {
      return { ok: false, sent: 0, error: (error as Error)?.message ?? String(error) }
    }
  }

  /** 记录最近一次入站会话（出站默认回到「来的地方」：群回群、私聊回私聊）。 */
  noteInbound(botId: string, sender: string, conversation: { kind: 'group' | 'private'; externalId: string; hubChannel: string }): void {
    this.lastInbounds.set(`${botId}:${sender}`, { ...conversation, at: Date.now() })
    if (this.lastInbounds.size > 1000) {
      const cutoff = Date.now() - 60 * 60_000
      for (const [k, v] of this.lastInbounds) if (v.at < cutoff) this.lastInbounds.delete(k)
    }
  }

  /** 最近一次入站会话（60min 内有效）。 */
  lastInbound(botId: string, sender: string, now = Date.now()): { kind: 'group' | 'private'; externalId: string; hubChannel: string } | null {
    const found = this.lastInbounds.get(`${botId}:${sender}`)
    if (found === undefined) return null
    if (now - found.at > 60 * 60_000) {
      this.lastInbounds.delete(`${botId}:${sender}`)
      return null
    }
    return { kind: found.kind, externalId: found.externalId, hubChannel: found.hubChannel }
  }

  /** 出站图片（仅 SnowLuma 适配器；相册 URL → SnowLuma 服务端拉取）。 */
  async sendPhoto(botId: string, conversation: OutboundConversation, imageUrl: string, caption?: string): Promise<{ ok: boolean; error?: string }> {
    const entry = this.entryFor(botId, 'snowluma')
    if (entry === undefined || !(entry.adapter instanceof SnowLumaAdapter)) return { ok: false, error: 'SnowLuma 未启用/未连接' }
    try {
      await entry.adapter.sendImage(conversation, imageUrl, caption)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: (error as Error)?.message ?? String(error) }
    }
  }

  /** 最近入站消息 id（被动回复窗口；5 分钟内可用于被动回复）。 */
  recentMessageId(botId: string, kind: QqChannelKind, externalId: string, now = Date.now()): string {
    const found = this.recentMessageIds.get(`${botId}:${kind}:${externalId}`)
    if (found === undefined) return ''
    if (now - found.at > 60 * 60_000) {
      this.recentMessageIds.delete(`${botId}:${kind}:${externalId}`)
      return ''
    }
    return found.msgId
  }

  /** OneBot 动作调用（渠道工具用；仅 snowluma）。 */
  async callAction(botId: string, action: string, params: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const entry = this.entryFor(botId, 'snowluma')
    if (entry === undefined || !(entry.adapter instanceof SnowLumaAdapter)) return null
    return await entry.adapter.callAction(action, params)
  }

  /** 真实连接探测：snowluma 走 get_login_info；qqbot 看连接状态。 */
  async probe(kind: QqChannelKind, botId?: string): Promise<QqProbeResult> {
    const entry = botId !== undefined && botId !== '' ? this.entryFor(botId, kind) : this.firstEntry(kind)
    if (entry === undefined) return { ok: false, error: kind === 'snowluma' ? 'SnowLuma 未启用或未配置 ws 地址' : 'QQ Bot 未启用或未配置 AppID/Secret' }
    const status = entry.adapter.status()
    if (!status.connected) {
      await this.sync()
      const after = entry.adapter.status()
      if (!after.connected) return { ok: false, error: after.lastError !== '' ? after.lastError : '未连接（检查配置/网络后重试）' }
    }
    if (kind === 'snowluma' && entry.adapter instanceof SnowLumaAdapter) {
      const info = await entry.adapter.callAction('get_login_info', {}, 8000)
      if (info === null) return { ok: false, error: 'SnowLuma 未响应 get_login_info' }
      const data = info['data'] as { user_id?: unknown; nickname?: unknown } | null
      return { ok: true, ...(data?.user_id !== undefined ? { selfId: String(data.user_id) } : {}), ...(typeof data?.nickname === 'string' ? { nickname: data.nickname } : {}) }
    }
    return { ok: true, ...(status.selfId !== '' ? { selfId: status.selfId } : {}) }
  }

  async stopAll(): Promise<void> {
    for (const entry of this.entries.values()) {
      try { await entry.adapter.stop() } catch { /* ignore */ }
    }
    this.entries.clear()
  }

  /** 测试/控制台用：当前适配器状态列表。 */
  adapterStatuses(): Array<{ botId: string; kind: QqChannelKind; status: ReturnType<SnowLumaAdapter['status']> }> {
    return [...this.entries.entries()].map(([key, entry]) => ({
      botId: key.split(':')[0] ?? entry.botId,
      kind: entry.kind,
      status: entry.adapter.status(),
    }))
  }
}
