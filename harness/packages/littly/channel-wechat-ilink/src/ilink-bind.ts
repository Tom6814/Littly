/**
 * iLink 扫码绑定服务：二维码会话生命周期（取码 → 长轮询状态 → 确认落凭据）。
 *
 * 协议真源是 openilink SDK 的 `LoginWithQR`（`/tmp/ois-go/auth.go`）；与 hub 的差别是这里
 * 把「一次阻塞式 loginWithQr」换成**可轮询的会话对象**：
 * - `startBind` 取一张码（await 首帧，保证接口返回就有 data URL），后台跑状态机；
 * - `get(sessionId)` 给控制台轮询即时快照（不阻塞 HTTP 35s）；
 * - 状态机内部处理 `scaned_but_redirect`（切 host）与 `expired`（自动换码，最多 3 次）；
 * - `confirmed` 后立即调 onConfirmed 落凭据 + 启动消息轮询，状态缓存给断线重连的客户端。
 *
 * 会话状态持久化在 global_settings，模块重载/服务重启后仍可继续轮询。
 */
import { randomUUID } from 'node:crypto'
import type { LittlyStorage } from '@littly/storage'
import {
  ILinkClient,
  ILinkError,
  type ILinkClientOptions,
  type ILinkCredentials,
} from './ilink-client.ts'
import { qrContentToDataUrl } from './ilink-qr.ts'
import {
  QR_TTL_MS,
  deleteBindSession,
  getBindSession,
  setBindSession,
  setFriendQr,
  type ILinkBindSessionState,
  type WechatBindStatus,
} from './ilink-store.ts'

/** 登录流程总超时（SDK defaultLoginTimeout = 8 分钟）。 */
export const LOGIN_TIMEOUT_MS = 8 * 60 * 1000
/** 二维码最多自动刷新次数（SDK maxQRRefreshCount = 3）。 */
export const MAX_QR_REFRESH = 3
/** confirmed 结果保留时长（断线重连的客户端仍能取回，hub 同语义 60s）。 */
const CONFIRMED_CACHE_MS = 60 * 1000
/** 状态轮询的最小间隔（长轮询正常会阻塞 35s，这里防御服务端立刻返回 wait 造成忙等）。 */
const POLL_MIN_GAP_MS = 250

/** 创建协议客户端的工厂（mock 测试注入 fetchImpl/baseUrl）。 */
export type ILinkClientFactory = (options?: ILinkClientOptions) => ILinkClient

/** 绑定服务依赖。 */
export interface ILinkBindDeps {
  storage: LittlyStorage
  log: (msg: string, ...args: unknown[]) => void
  /** confirmed 回调：落凭据 + 认领身份 + 启动消息轮询（index.ts 注入）。 */
  onConfirmed: (input: { botId: string; userId: string; credentials: ILinkCredentials }) => Promise<void> | void
  /** 客户端工厂（默认真实网络）。 */
  clientFactory?: ILinkClientFactory | undefined
  /** scaned_but_redirect 切换协议（默认 https；mock 测试用 http 模拟同机新 host）。 */
  redirectScheme?: 'https' | 'http' | undefined
  /** 当前毫秒（可注入假时钟）。 */
  now?: (() => number) | undefined
}

/** startBind 入参。 */
export interface StartBindInput {
  botId: string
  userId: string
  /** 二维码/会话有效期（默认 QR_TTL_MS=5min）。 */
  ttlMs?: number | undefined
}

/** startBind 返回（API 契约）。 */
export interface StartBindResult {
  sessionId: string
  qrDataUrl: string
  /** 二维码原始载荷（排障用，不进 API 就删掉即可）。 */
  payload: string
  expiresAt: number
}

/** 一个后台轮询循环的句柄。 */
interface BindLoop {
  cancelled: boolean
}

/** 扫码会话服务。 */
export class ILinkBindService {
  private readonly deps: ILinkBindDeps
  private readonly loops = new Map<string, BindLoop>()
  private readonly now: () => number
  private readonly clientFactory: ILinkClientFactory
  private readonly redirectScheme: 'https' | 'http'
  /** 内存缓存（DB 为准；内存只是减少读库）。 */
  private readonly cache = new Map<string, ILinkBindSessionState>()

  constructor(deps: ILinkBindDeps) {
    this.deps = deps
    this.now = deps.now ?? ((): number => Date.now())
    this.clientFactory =
      deps.clientFactory ??
      ((options?: ILinkClientOptions): ILinkClient => new ILinkClient(options))
    this.redirectScheme = deps.redirectScheme ?? 'https'
  }

  /**
   * 发起扫码绑定：取首张二维码并返回 data URL，同时启动后台状态机。
   * @param input - botId / 发起用户 / 可选 TTL。
   * @returns 会话 id、二维码 data URL、过期时刻。
   */
  async startBind(input: StartBindInput): Promise<StartBindResult> {
    const client = this.clientFactory()
    const qr = await client.getBotQrCode()
    const normalized = qrContentToDataUrl(qr.qrcode_img_content)
    const now = this.now()
    const state: ILinkBindSessionState = {
      id: `wx-bind-${input.botId}-${randomUUID().slice(0, 8)}`,
      botId: input.botId,
      userId: input.userId,
      status: 'wait',
      qrcode: qr.qrcode,
      qrDataUrl: normalized.dataUrl,
      payload: normalized.payload,
      refreshCount: 0,
      expiresAt: now + (input.ttlMs ?? QR_TTL_MS),
      updatedAt: now,
    }
    this.persist(state)
    const loop: BindLoop = { cancelled: false }
    this.loops.set(state.id, loop)
    this.deps.log('[wechat-bind] 会话创建 (session=%s, bot=%s, qr=%s…)', state.id, input.botId, qr.qrcode.slice(0, 8))
    void this.runLoop(state.id, client, loop).catch((err: unknown) => {
      this.fail(state.id, err instanceof Error ? err.message : String(err))
    })
    return { sessionId: state.id, qrDataUrl: normalized.dataUrl, payload: normalized.payload, expiresAt: state.expiresAt }
  }

  /**
   * 读会话快照（内存 → DB；过期/不存在返回 null）。
   * @param sessionId - 会话 id。
   */
  get(sessionId: string): ILinkBindSessionState | null {
    const mem = this.cache.get(sessionId)
    if (mem !== undefined) return mem
    const stored = getBindSession(this.deps.storage, sessionId)
    if (stored !== null) this.cache.set(sessionId, stored)
    return stored
  }

  /** 取消一个会话（登出/重新绑定时调用）。 */
  cancel(sessionId: string): void {
    const loop = this.loops.get(sessionId)
    if (loop !== undefined) loop.cancelled = true
    this.loops.delete(sessionId)
    this.cache.delete(sessionId)
    deleteBindSession(this.deps.storage, sessionId)
  }

  /** 取消全部会话（插件卸载）。 */
  cancelAll(): void {
    for (const sessionId of [...this.loops.keys()]) this.cancel(sessionId)
    this.cache.clear()
  }

  /**
   * 取消某 bot 的全部进行中会话（登出/重新绑定时调用）。
   * @param botId - bot id。
   */
  cancelForBot(botId: string): void {
    for (const [sessionId, state] of [...this.cache.entries()]) {
      if (state.botId === botId) this.cancel(sessionId)
    }
  }

  /** 当前活跃会话数（自检/日志用）。 */
  activeCount(): number {
    return this.loops.size
  }

  // --- 内部 ---

  /** 写内存 + DB。 */
  private persist(state: ILinkBindSessionState): void {
    state.updatedAt = this.now()
    this.cache.set(state.id, state)
    setBindSession(this.deps.storage, state)
  }

  /** 标记失败（保留状态给前端展示）。 */
  private fail(sessionId: string, error: string): void {
    const state = this.get(sessionId)
    if (state === null) return
    state.status = 'failed'
    state.error = error
    this.persist(state)
    this.loops.delete(sessionId)
    this.deps.log('[wechat-bind] 会话失败 (session=%s): %s', sessionId, error)
  }

  /** 更新状态字面量。 */
  private setStatus(sessionId: string, status: WechatBindStatus): void {
    const state = this.get(sessionId)
    if (state === null) return
    state.status = status
    this.persist(state)
  }

  /**
   * 后台状态机（auth.go LoginWithQR 的会话版）。
   * @param sessionId - 会话 id。
   * @param client - 协议客户端（初始无 token）。
   * @param loop - 取消句柄。
   */
  private async runLoop(sessionId: string, client: ILinkClient, loop: BindLoop): Promise<void> {
    let pollBase: string | undefined
    let lastPollAt = 0
    while (!loop.cancelled) {
      const state = this.get(sessionId)
      if (state === null || state.status === 'confirmed' || state.status === 'failed') return
      if (this.now() > state.expiresAt) {
        this.fail(sessionId, '二维码会话超时，请重新获取')
        return
      }
      // 长轮询正常阻塞 35s；若服务端立刻返回（wait），至少隔 250ms 再打，避免忙等
      const since = this.now() - lastPollAt
      if (since < POLL_MIN_GAP_MS) await sleep(POLL_MIN_GAP_MS - since, () => loop.cancelled)
      if (loop.cancelled) return
      lastPollAt = this.now()

      let status: Awaited<ReturnType<ILinkClient['pollQrStatus']>>
      try {
        status = await client.pollQrStatus(state.qrcode, { baseUrl: pollBase })
      } catch (err) {
        this.deps.log('[wechat-bind] 轮询异常 (session=%s): %s', sessionId, err instanceof Error ? err.message : String(err))
        // 网络抖动不算失败：等后台继续（会话 TTL 到点自然失败）
        await sleep(2_000, () => loop.cancelled)
        continue
      }
      if (loop.cancelled) return

      switch (status.status) {
        case 'wait':
          continue
        case 'scaned': {
          if (state.status !== 'scanned') {
            this.setStatus(sessionId, 'scanned')
            this.deps.log('[wechat-bind] 已扫码，等待手机确认 (session=%s)', sessionId)
          }
          continue
        }
        case 'scaned_but_redirect': {
          if (typeof status.redirect_host === 'string' && status.redirect_host !== '') {
            pollBase = `${this.redirectScheme}://${status.redirect_host}`
            this.deps.log('[wechat-bind] 切换轮询 host → %s', pollBase)
          }
          continue
        }
        case 'expired': {
          const next = state.refreshCount + 1
          if (next > MAX_QR_REFRESH) {
            this.fail(sessionId, `二维码过期次数过多（${String(MAX_QR_REFRESH)} 次），请重新获取`)
            return
          }
          const fresh = await this.clientFactory().getBotQrCode()
          const normalized = qrContentToDataUrl(fresh.qrcode_img_content)
          state.qrcode = fresh.qrcode
          state.qrDataUrl = normalized.dataUrl
          state.payload = normalized.payload
          state.refreshCount = next
          state.status = 'expired'
          state.expiresAt = this.now() + QR_TTL_MS
          this.persist(state)
          pollBase = undefined
          this.deps.log('[wechat-bind] 二维码过期，已自动刷新 (session=%s, %d/%d)', sessionId, next, MAX_QR_REFRESH)
          continue
        }
        case 'confirmed': {
          const botId = status.ilink_bot_id ?? ''
          if (botId === '') {
            this.fail(sessionId, '服务端未返回 ilink_bot_id（绑定未成功）')
            return
          }
          const credentials: ILinkCredentials = {
            bot_token: status.bot_token ?? '',
            baseurl: status.baseurl ?? '',
            ilink_bot_id: botId,
            ilink_user_id: status.ilink_user_id ?? '',
          }
          if (credentials.bot_token === '') {
            this.fail(sessionId, '服务端未返回 bot_token（绑定未成功）')
            return
          }
          try {
            await this.deps.onConfirmed({ botId: state.botId, userId: state.userId, credentials })
          } catch (err) {
            this.fail(sessionId, `凭据落库失败：${err instanceof Error ? err.message : String(err)}`)
            return
          }
          state.status = 'confirmed'
          state.credentials = credentials
          state.expiresAt = this.now() + CONFIRMED_CACHE_MS
          state.error = undefined
          this.persist(state)
          this.loops.delete(sessionId)
          this.deps.log(
            '[wechat-bind] ✓ 绑定成功 (session=%s, bot=%s, ilink_bot_id=%s, ilink_user_id=%s)',
            sessionId,
            state.botId,
            credentials.ilink_bot_id,
            credentials.ilink_user_id,
          )
          return
        }
        default:
          continue
      }
    }
  }
}

// --- 名片二维码（好友扫码加她） ---

/** 名片二维码返回（API 契约）。 */
export interface FriendQrResult {
  qrDataUrl: string
  payload: string
  expiresAt: number
  /** 语义标记：iLink 协议只有 bot 绑定码，没有独立名片码。 */
  kind: 'bot_qrcode'
}

/**
 * 生成「名片二维码」：好友扫码 → 加这个微信 bot。
 *
 * 协议依据：iLink 只提供 `get_bot_qrcode?bot_type=3` 一种二维码（扫码绑定 bot / 加好友走同一条
 * 微信链路），hub 的 wx_friend_* 只是配置展示位、无独立协议接口。因此这里复用绑定码接口，
 * 并在响应里带 `kind:'bot_qrcode'` + 文案说明，前端据此展示「扫码加她」。
 * @param deps - 依赖（存储 + 客户端工厂）。
 * @param botId - bot id。
 * @param ttlMs - 有效期（默认 QR_TTL_MS）。
 */
export async function createFriendQr(
  deps: Pick<ILinkBindDeps, 'storage' | 'log' | 'clientFactory'>,
  botId: string,
  ttlMs = QR_TTL_MS,
): Promise<FriendQrResult> {
  const factory = deps.clientFactory ?? ((options?: ILinkClientOptions): ILinkClient => new ILinkClient(options))
  const qr = await factory().getBotQrCode()
  const normalized = qrContentToDataUrl(qr.qrcode_img_content)
  const expiresAt = Date.now() + ttlMs
  setFriendQr(deps.storage, botId, { dataUrl: normalized.dataUrl, payload: normalized.payload, expiresAt })
  deps.log('[wechat] 名片二维码已生成 (bot=%s, ttl=%dms)', botId, ttlMs)
  return { qrDataUrl: normalized.dataUrl, payload: normalized.payload, expiresAt, kind: 'bot_qrcode' }
}

/** 可取消的 sleep（250ms 粒度检查取消标志）。 */
async function sleep(ms: number, isCancelled: () => boolean): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (isCancelled()) return
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now())))
    })
  }
}

export { ILinkError }
