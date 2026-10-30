/**
 * 微信 iLink 控制台端点：扫码绑定 / 状态轮询 / 名片二维码 / 登出。
 *
 * 数据面全部来自 channel-wechat-ilink 插件提供的服务键 `littlyWechat`
 * （协议客户端 + 绑定会话 + 消息轮询都在插件内，本文件只做 HTTP 层与鉴权）。
 *
 * 契约（前端 /channels/wechat 与 onboarding 第 4 步使用）：
 * - POST /api/wechat/qr            admin    → {data:{sessionId, qrDataUrl, expiresAt, botId}}
 * - GET  /api/wechat/qr/:sessionId required → {data:{status: wait|scanned|expired|confirmed|failed,
 *                                              qrDataUrl, expiresAt, error, botId, ilinkBotId?}}
 * - GET  /api/wechat/status        required → {data:{bound, botId, ilinkBotId?, ilinkUserId?,
 *                                              status, windowFresh, lastInboundAt,
 *                                              friendQrDataUrl?, friendQrExpiresAt?, note}}
 * - POST /api/wechat/friend-qr     required → {data:{qrDataUrl, expiresAt, kind:'bot_qrcode', note}}
 * - POST /api/wechat/logout        admin    → {data:{ok, botId}}
 *
 * 信封与鉴权沿用 console-api 既有约定（成功 {data}、错误 {error:{code,message}}，
 * 未登录 401 / 非管理员 403 由 Router 统一裁决）。
 */
import { json, err, bodyRecord, reqStr } from './http.ts'
import type { Router } from './http.ts'
import type { Deps } from './deps.ts'
import type { WechatService } from '@littly/channel-wechat-ilink'

/** 服务获取器：console-api 启动时插件可能尚未 provide，取用时再解析（可降级 503）。 */
export type WechatServiceGetter = () => WechatService | undefined

/**
 * 从 cordis Context 构造服务获取器（延迟到请求时取，避免插件加载顺序耦合）。
 * @param ctx - console-api 的 cordis 上下文。
 * @returns `littlyWechat` 服务获取器。
 */
export function createWechatServiceGetter(ctx: unknown): WechatServiceGetter {
  return () => {
    const getter = (ctx as { get?: (name: string, strict?: boolean) => unknown }).get
    if (typeof getter !== 'function') return undefined
    // 非严格模式：插件未加载时返回 undefined（HTTP 层降级 503），不抛 cordis 的 inject 错误
    return getter.call(ctx, 'littlyWechat', false) as WechatService | undefined
  }
}

/** 「名片二维码」协议依据文案（与插件内 FRIEND_QR_NOTE 保持一致，避免前端硬编码）。 */
const FRIEND_QR_NOTE =
  'iLink 协议只有 bot 绑定二维码（get_bot_qrcode?bot_type=3），没有独立的名片码接口；' +
  '好友扫这张码即可在微信里加她（进入与 bot 的会话）。绑定码与名片码内容同源。'

/** 取服务；未加载时写 503 并返回 null。 */
function requireService(ctx: { res: Parameters<typeof json>[0] }, getService: WechatServiceGetter): WechatService | null {
  const service = getService()
  if (service === undefined) {
    err(ctx.res, 503, 'wechat_unavailable', '微信渠道插件未加载（littly-channel-wechat-ilink）')
    return null
  }
  return service
}

/** 取请求参数里的 botId（body 优先，其次 query；缺省由插件回落到默认 bot）。 */
function requestedBotId(ctx: { body: unknown; query: URLSearchParams }): string | undefined {
  const body = bodyRecord(ctx.body)
  const fromBody = reqStr(body, 'botId')
  if (fromBody !== undefined && fromBody !== '') return fromBody
  const fromQuery = ctx.query.get('botId')
  if (fromQuery !== null && fromQuery !== '') return fromQuery
  return undefined
}

/** 错误转中文 message（不把内部堆栈/URL 参数泄露给前端）。 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    // iLinkError 的 message 已是中文/协议描述；其它异常只保留 message 首行
    return error.message.split('\n')[0] ?? error.message
  }
  return String(error)
}

/**
 * 注册微信端点。
 * @param r - 控制台路由表。
 * @param _d - 控制台依赖（本模块只用服务键，保留签名统一）。
 * @param getService - `littlyWechat` 服务获取器。
 */
export function registerWechatRoutes(r: Router, _d: Deps, getService: WechatServiceGetter): void {
  // ---- 发起扫码绑定（admin：会变更渠道凭据）----
  r.post('/api/wechat/qr', 'admin', async (ctx) => {
    const service = requireService(ctx, getService)
    if (service === null) return
    const botId = requestedBotId(ctx)
    try {
      const started = await service.startBind({
        userId: ctx.user?.id ?? '',
        ...(botId !== undefined ? { botId } : {}),
      })
      json(ctx.res, 200, {
        data: {
          sessionId: started.sessionId,
          qrDataUrl: started.qrDataUrl,
          expiresAt: started.expiresAt,
          botId: service.status(botId).botId,
        },
      })
    } catch (error) {
      err(ctx.res, 502, 'wechat_bind_failed', `获取微信二维码失败：${errorMessage(error)}`)
    }
  })

  // ---- 轮询扫码状态 ----
  r.get('/api/wechat/qr/:sessionId', 'required', (ctx) => {
    const service = requireService(ctx, getService)
    if (service === null) return
    const sessionId = ctx.params['sessionId'] ?? ''
    const state = service.getBind(sessionId)
    if (state === null) {
      err(ctx.res, 404, 'not_found', '扫码会话不存在或已过期，请重新获取二维码')
      return
    }
    const data: Record<string, unknown> = {
      sessionId: state.id,
      status: state.status,
      qrDataUrl: state.qrDataUrl,
      expiresAt: state.expiresAt,
      error: state.error ?? null,
      botId: state.botId,
    }
    if (state.credentials !== undefined) {
      data['ilinkBotId'] = state.credentials.ilink_bot_id
      data['ilinkUserId'] = state.credentials.ilink_user_id
    }
    json(ctx.res, 200, { data })
  })

  // ---- 绑定/运行状态 ----
  r.get('/api/wechat/status', 'required', (ctx) => {
    const service = requireService(ctx, getService)
    if (service === null) return
    const botId = requestedBotId(ctx)
    const view = service.status(botId)
    json(ctx.res, 200, {
      data: {
        bound: view.bound,
        botId: view.botId,
        ...(view.ilinkBotId !== undefined ? { ilinkBotId: view.ilinkBotId } : {}),
        ...(view.ilinkUserId !== undefined ? { ilinkUserId: view.ilinkUserId } : {}),
        status: view.status,
        windowFresh: view.windowFresh,
        lastInboundAt: view.lastInboundAt,
        ...(view.friendQrDataUrl !== undefined ? { friendQrDataUrl: view.friendQrDataUrl } : {}),
        ...(view.friendQrExpiresAt !== undefined ? { friendQrExpiresAt: view.friendQrExpiresAt } : {}),
        note: FRIEND_QR_NOTE,
      },
    })
  })

  // ---- 名片二维码（好友扫码加她）----
  r.post('/api/wechat/friend-qr', 'required', async (ctx) => {
    const service = requireService(ctx, getService)
    if (service === null) return
    const botId = requestedBotId(ctx)
    try {
      const qr = await service.friendQr(botId)
      json(ctx.res, 200, {
        data: {
          qrDataUrl: qr.qrDataUrl,
          expiresAt: qr.expiresAt,
          kind: qr.kind,
          botId: service.status(botId).botId,
          note: FRIEND_QR_NOTE,
        },
      })
    } catch (error) {
      err(ctx.res, 502, 'wechat_friend_qr_failed', `生成名片二维码失败：${errorMessage(error)}`)
    }
  })

  // ---- 登出（admin：清凭据、停轮询）----
  r.post('/api/wechat/logout', 'admin', async (ctx) => {
    const service = requireService(ctx, getService)
    if (service === null) return
    const botId = requestedBotId(ctx)
    try {
      const result = await service.logout(botId)
      json(ctx.res, 200, { data: { ok: result.ok, botId: result.botId } })
    } catch (error) {
      err(ctx.res, 500, 'wechat_logout_failed', `微信登出失败：${errorMessage(error)}`)
    }
  })
}
