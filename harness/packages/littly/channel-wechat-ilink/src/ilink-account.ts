/**
 * iLink 账号运行时：消息长轮询（自动重连）+ 出站发送（context_token / 24h 窗口）。
 *
 * 逐字对齐 openilink SDK 的 `Monitor`（`/tmp/ois-go/monitor.go`）与 hub 的 provider.Send：
 * - getUpdates 长轮询 35s，游标 `get_updates_buf` 持久化，重启续拉；
 * - 连续失败 <3 → 2s 重试，≥3 → 30s 退避；`errcode=-14` 会话过期 → 标记 session_expired，
 *   暂停 1h 后重试（用户重新扫码后会被 `restart` 覆盖）；
 * - 服务端下发 `longpolling_timeout_ms` 时采纳；
 * - 入站消息先缓存 context_token（内存 + DB，带时间戳供 24h 窗口判定），再交给 onInbound；
 * - 出站必须带「该会话最近一次入站消息」的 context_token；超出 24h 窗口明确报错（不静默重试）。
 */
import type { LittlyStorage } from '@littly/storage'
import {
  ILinkApiError,
  ILinkClient,
  ILinkError,
  MESSAGE_TYPE_BOT,
  SESSION_EXPIRED_ERR_CODE,
  extractText,
  type ILinkClientOptions,
  type ILinkCredentials,
  type ILinkMessage,
} from './ilink-client.ts'
import {
  CONTEXT_TOKEN_TTL_MS,
  getContextTokenState,
  getCredentials,
  getSyncBuf,
  listBoundBotIds,
  setContextToken,
  setSyncBuf,
} from './ilink-store.ts'

/** 连续失败阈值 / 退避（SDK maxConsecutiveFailures / backoffDelay / retryDelay）。 */
const MAX_CONSECUTIVE_FAILURES = 3
const BACKOFF_DELAY_MS = 30_000
const RETRY_DELAY_MS = 2_000
/** 会话过期后的暂停（SDK SESSION_EXPIRED_PAUSE_MS = 1h）。 */
const SESSION_EXPIRED_PAUSE_MS = 60 * 60 * 1000

/** 账号运行状态（控制台展示）。 */
export type ILinkAccountStatus = 'connected' | 'connecting' | 'session_expired' | 'error' | 'stopped'

/** 账号管理依赖。 */
export interface ILinkAccountDeps {
  storage: LittlyStorage
  log: (msg: string, ...args: unknown[]) => void
  /** 入站正文回调（index.ts 注入 → inbound.processWechatMessage）。 */
  onInbound: (input: { botId: string; fromUserId: string; text: string; message: ILinkMessage }) => Promise<void> | void
  /** 客户端工厂（mock 测试注入 fetchImpl/baseUrl）。 */
  clientFactory?: ((options?: ILinkClientOptions) => ILinkClient) | undefined
  /** 当前毫秒（测试可注入）。 */
  now?: (() => number) | undefined
}

/** 单账号运行循环。 */
interface AccountLoop {
  cancelled: boolean
  status: ILinkAccountStatus
  client: ILinkClient
}

/** iLink 账号管理器（一个 bot 一个长轮询循环）。 */
export class ILinkAccountManager {
  private readonly deps: ILinkAccountDeps
  private readonly loops = new Map<string, AccountLoop>()
  private readonly now: () => number
  private readonly clientFactory: (options?: ILinkClientOptions) => ILinkClient

  constructor(deps: ILinkAccountDeps) {
    this.deps = deps
    this.now = deps.now ?? ((): number => Date.now())
    this.clientFactory = deps.clientFactory ?? ((options?: ILinkClientOptions): ILinkClient => new ILinkClient(options))
  }

  /** 某 bot 的运行状态。 */
  status(botId: string): ILinkAccountStatus {
    return this.loops.get(botId)?.status ?? 'stopped'
  }

  /** 是否在轮询。 */
  isRunning(botId: string): boolean {
    return this.loops.has(botId)
  }

  /**
   * 自愈：为所有「已绑定凭据但没在轮询」的 bot 启动循环（幂等）。
   * @returns 本次新启动的数量。
   */
  ensureAll(): number {
    let started = 0
    for (const botId of listBoundBotIds(this.deps.storage)) {
      if (this.start(botId)) started++
    }
    return started
  }

  /**
   * 启动某 bot 的长轮询（幂等：已在跑返回 false）。
   * @param botId - bot id。
   */
  start(botId: string): boolean {
    if (this.loops.has(botId)) return false
    const credentials = getCredentials(this.deps.storage, botId)
    if (credentials === null) {
      this.deps.log('[wechat] 跳过轮询 (bot=%s)：无 iLink 凭据（先扫码绑定）', botId)
      return false
    }
    const client = this.createClient(credentials)
    const loop: AccountLoop = { cancelled: false, status: 'connecting', client }
    this.loops.set(botId, loop)
    this.deps.log(
      '[wechat] 启动消息轮询 (bot=%s, ilink_bot_id=%s, endpoint=%s)',
      botId,
      credentials.ilink_bot_id,
      credentials.baseurl !== '' ? credentials.baseurl : '默认',
    )
    void this.runLoop(botId, client, loop).catch((err: unknown) => {
      this.deps.log('[wechat] 轮询循环异常退出 (bot=%s): %s', botId, err instanceof Error ? err.message : String(err))
      this.loops.delete(botId)
    })
    return true
  }

  /** 停止某 bot 的轮询（logout / 重新绑定）。 */
  stop(botId: string): void {
    const loop = this.loops.get(botId)
    if (loop === undefined) return
    loop.cancelled = true
    loop.status = 'stopped'
    this.loops.delete(botId)
    this.deps.log('[wechat] 停止消息轮询 (bot=%s)', botId)
  }

  /** 重启（绑定确认后调用：用新凭据重建客户端）。 */
  restart(botId: string): boolean {
    this.stop(botId)
    return this.start(botId)
  }

  /** 停止全部（插件卸载）。 */
  stopAll(): void {
    for (const botId of [...this.loops.keys()]) this.stop(botId)
  }

  /** 取（或临时构造）某 bot 的客户端；循环在跑时复用同一实例（context_token 缓存一致）。 */
  private clientFor(botId: string): ILinkClient | null {
    const loop = this.loops.get(botId)
    if (loop !== undefined) return loop.client
    const credentials = getCredentials(this.deps.storage, botId)
    if (credentials === null) return null
    return this.createClient(credentials)
  }

  /** 按凭据构造客户端。 */
  private createClient(credentials: ILinkCredentials): ILinkClient {
    const options: ILinkClientOptions = { token: credentials.bot_token }
    if (credentials.baseurl !== '') options.baseUrl = credentials.baseurl
    return this.clientFactory(options)
  }

  /**
   * 发文本（出站）：解析投递地址 + context_token + 24h 窗口，然后 sendmessage。
   * @param botId - bot id。
   * @param toUserId - 微信外部 id（from_user_id 原值，`<wxid>@im.wechat`）。
   * @param text - 正文。
   * @returns 出站 client_id。
   */
  async sendText(botId: string, toUserId: string, text: string): Promise<{ clientId: string }> {
    if (toUserId === '') throw new ILinkError('微信发送失败：缺少收件人微信 id', 'ilink_no_recipient')
    if (text === '') throw new ILinkError('微信发送失败：正文为空', 'ilink_empty_text')
    const state = getContextTokenState(this.deps.storage, botId, toUserId)
    if (state === null || state.token === '') {
      throw new ILinkError(
        '微信 24 小时窗口未开启：对方需要先给 bot 发一条消息（拿到 context_token 后才能回复）',
        'ilink_no_context_token',
      )
    }
    const age = this.now() - state.at
    if (age > CONTEXT_TOKEN_TTL_MS) {
      throw new ILinkError(
        `微信 24 小时窗口已过期（最后入站 ${String(Math.round(age / 3_600_000))} 小时前），请对方再发一条消息刷新窗口`,
        'ilink_window_expired',
      )
    }
    const client = this.clientFor(botId)
    if (client === null) throw new ILinkError('微信未绑定：缺少 iLink 凭据', 'ilink_not_bound')
    // 循环内客户端已有缓存，这里再兜底同步一次（重启后循环未跑时的场景）
    if (client.getContextToken(toUserId) === undefined) client.setContextToken(toUserId, state.token)
    const result = await client.sendText(toUserId, text, state.token)
    this.deps.log('[wechat] 出站 send_message (bot=%s, to=%s, len=%d, client_id=%s)', botId, toUserId, text.length, result.clientId)
    return result
  }

  /**
   * 发/取消「正在输入」状态（先 getConfig 取 typing_ticket）。
   * @param botId - bot id。
   * @param toUserId - 微信外部 id。
   * @param typing - true=正在输入。
   */
  async sendTyping(botId: string, toUserId: string, typing: boolean): Promise<void> {
    const client = this.clientFor(botId)
    if (client === null) throw new ILinkError('微信未绑定：缺少 iLink 凭据', 'ilink_not_bound')
    const state = getContextTokenState(this.deps.storage, botId, toUserId)
    if (state === null) throw new ILinkError('缺少 context_token，无法发送输入状态', 'ilink_no_context_token')
    const config = await client.getConfig(toUserId, state.token)
    await client.sendTyping(toUserId, config.typing_ticket ?? '', typing)
  }

  // --- 长轮询循环 ---

  /**
   * 单 bot 长轮询（monitor.go Monitor 的移植）。
   * @param botId - bot id。
   * @param client - 协议客户端。
   * @param loop - 取消/状态句柄。
   */
  private async runLoop(botId: string, client: ILinkClient, loop: AccountLoop): Promise<void> {
    let buf = getSyncBuf(this.deps.storage, botId)
    let failures = 0
    let nextTimeoutMs: number | undefined
    loop.status = 'connected'
    while (!loop.cancelled) {
      let response: Awaited<ReturnType<ILinkClient['getUpdates']>>
      try {
        response = await client.getUpdates(buf, { timeoutMs: nextTimeoutMs })
      } catch (err) {
        if (loop.cancelled) return
        failures++
        this.deps.log(
          '[wechat] getUpdates 失败 (bot=%s, %d/%d): %s',
          botId,
          failures,
          MAX_CONSECUTIVE_FAILURES,
          err instanceof Error ? err.message : String(err),
        )
        loop.status = 'error'
        const wait = failures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS
        if (failures >= MAX_CONSECUTIVE_FAILURES) failures = 0
        await sleep(wait, () => loop.cancelled)
        continue
      }
      if (loop.cancelled) return

      // 服务端建议下一次长轮询超时（错误响应也可能带，先采纳）
      if (typeof response.longpolling_timeout_ms === 'number' && response.longpolling_timeout_ms > 0) {
        nextTimeoutMs = response.longpolling_timeout_ms
      }

      const ret = Number(response.ret ?? 0)
      const errcode = Number(response.errcode ?? 0)
      if (ret !== 0 || errcode !== 0) {
        const expired = errcode === SESSION_EXPIRED_ERR_CODE || ret === SESSION_EXPIRED_ERR_CODE
        if (expired) {
          loop.status = 'session_expired'
          this.deps.log('[wechat] 会话过期 (bot=%s)：需要重新扫码绑定，暂停 1h 后重试', botId)
          failures = 0
          await sleep(SESSION_EXPIRED_PAUSE_MS, () => loop.cancelled)
          continue
        }
        failures++
        this.deps.log('[wechat] getUpdates API 错误 (bot=%s, %d/%d): %s', botId, failures, MAX_CONSECUTIVE_FAILURES, response.errmsg ?? '')
        const wait = failures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS
        if (failures >= MAX_CONSECUTIVE_FAILURES) failures = 0
        await sleep(wait, () => loop.cancelled)
        continue
      }

      failures = 0
      loop.status = 'connected'

      // 游标推进（空游标保持旧值）
      if (typeof response.get_updates_buf === 'string' && response.get_updates_buf !== '') {
        buf = response.get_updates_buf
        setSyncBuf(this.deps.storage, botId, buf)
      }

      for (const message of response.msgs ?? []) {
        if (loop.cancelled) return
        await this.handleInbound(botId, client, message)
      }
    }
  }

  /**
   * 单条入站消息：缓存 context_token → 过滤 bot 自己消息 → 抽正文 → 交给 onInbound。
   * @param botId - bot id。
   * @param client - 客户端（同步内存 context_token 缓存）。
   * @param message - 入站消息。
   */
  private async handleInbound(botId: string, client: ILinkClient, message: ILinkMessage): Promise<void> {
    const fromUserId = message.from_user_id ?? ''
    if (fromUserId === '') return
    const at = this.now()
    if (typeof message.context_token === 'string' && message.context_token !== '') {
      client.setContextToken(fromUserId, message.context_token)
      setContextToken(this.deps.storage, botId, fromUserId, message.context_token, at)
    }
    // bot 自己发出的消息（message_type=2）不回环
    if (message.message_type === MESSAGE_TYPE_BOT) return
    const text = extractText(message)
    if (text === '') {
      this.deps.log('[wechat] 跳过无正文消息 (bot=%s, from=%s, type=%s)', botId, fromUserId, String(message.message_type ?? '?'))
      return
    }
    this.deps.log('[wechat] 入站 (bot=%s, from=%s, len=%d)', botId, fromUserId, text.length)
    try {
      await this.deps.onInbound({ botId, fromUserId, text, message })
    } catch (err) {
      this.deps.log('[wechat] 入站处理失败 (bot=%s, from=%s): %s', botId, fromUserId, err instanceof Error ? err.message : String(err))
    }
  }
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

/** 判断错误是否 iLink API 错误（导出给调用方做细分处理）。 */
export function isILinkApiError(err: unknown): err is ILinkApiError {
  return err instanceof ILinkApiError
}
