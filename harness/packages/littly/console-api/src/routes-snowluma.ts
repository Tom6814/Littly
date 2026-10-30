/**
 * SnowLuma 一键安装/配置控制台端点（与 @littly/snowluma 配套）。
 *
 * - GET  /api/snowluma/status        required；密码字段只给 admin（普通用户剥掉）
 * - POST /api/snowluma/install       admin {consent:true}；缺 consent → 400 consent_required
 * - POST /api/snowluma/start         admin
 * - POST /api/snowluma/stop          admin
 * - POST /api/snowluma/qr            admin → noVNC/WebUI 链接 + 密码 + 步骤
 * - GET  /api/snowluma/logs          admin ?tail=200（脱敏 + 单独返回密码）
 * - POST /api/snowluma/autoconfigure admin；读 onebot token → 等 3001 → 探测 → 写 bots 配置
 * - POST /api/snowluma/remove        admin {keepData?:boolean}
 *
 * EULA：SnowLuma 为第三方非商业自托管软件，安装/启动前必须用户显式勾选同意。
 */
import { json, err, bodyRecord, reqBool, reqNum } from './http.ts'
import type { RegisterFn } from './deps.ts'
import { SnowlumaError, type SnowlumaStatus } from '@littly/snowluma'

function unavailable(res: Parameters<typeof err>[0]): void {
  err(res, 501, 'snowluma_unavailable', 'SnowLuma 安装插件未装配（@littly/snowluma 未加载）')
}

function failSnowluma(ctx: { res: Parameters<typeof err>[0] }, error: unknown): void {
  if (error instanceof SnowlumaError) {
    err(ctx.res, error.status, error.code, error.message)
    return
  }
  err(ctx.res, 500, 'internal', 'SnowLuma 操作失败（内部错误）')
}

/** 非 admin 的 status：剥掉明文密码字段。 */
export function publicStatus(status: SnowlumaStatus, isAdmin: boolean): SnowlumaStatus {
  if (isAdmin) return status
  const { vncPassword: _vnc, webuiPassword: _webui, ...rest } = status
  return rest
}

export const registerSnowlumaInstallRoutes: RegisterFn = (r, d) => {
  r.get('/api/snowluma/status', 'required', async (ctx) => {
    const service = d.snowluma
    if (service === undefined) { unavailable(ctx.res); return }
    try {
      const isAdmin = ctx.user?.role === 'admin'
      json(ctx.res, 200, { data: publicStatus(await service.status(), isAdmin) })
    } catch (error) { failSnowluma(ctx, error) }
  })

  r.post('/api/snowluma/install', 'admin', async (ctx) => {
    const service = d.snowluma
    if (service === undefined) { unavailable(ctx.res); return }
    const body = bodyRecord(ctx.body)
    if (reqBool(body, 'consent') !== true) {
      err(ctx.res, 400, 'consent_required', 'SnowLuma 是第三方非商业自托管软件（EULA 对自动化部署有要求）：安装前请勾选同意。')
      return
    }
    try { json(ctx.res, 200, { data: await service.install({ consent: true }) }) } catch (error) { failSnowluma(ctx, error) }
  })

  r.post('/api/snowluma/start', 'admin', async (ctx) => {
    const service = d.snowluma
    if (service === undefined) { unavailable(ctx.res); return }
    try { json(ctx.res, 200, { data: await service.start() }) } catch (error) { failSnowluma(ctx, error) }
  })

  r.post('/api/snowluma/stop', 'admin', async (ctx) => {
    const service = d.snowluma
    if (service === undefined) { unavailable(ctx.res); return }
    try { json(ctx.res, 200, { data: await service.stop() }) } catch (error) { failSnowluma(ctx, error) }
  })

  r.post('/api/snowluma/qr', 'admin', async (ctx) => {
    const service = d.snowluma
    if (service === undefined) { unavailable(ctx.res); return }
    try { json(ctx.res, 200, { data: await service.qrInfo() }) } catch (error) { failSnowluma(ctx, error) }
  })

  r.get('/api/snowluma/logs', 'admin', async (ctx) => {
    const service = d.snowluma
    if (service === undefined) { unavailable(ctx.res); return }
    const tail = reqNum({ tail: ctx.query.get('tail') ?? undefined }, 'tail') ?? 200
    try { json(ctx.res, 200, { data: await service.logs({ tail }) }) } catch (error) { failSnowluma(ctx, error) }
  })

  r.post('/api/snowluma/autoconfigure', 'admin', async (ctx) => {
    const service = d.snowluma
    if (service === undefined) { unavailable(ctx.res); return }
    try {
      const result = await service.autoconfigure()
      json(ctx.res, 200, { data: result })
    } catch (error) { failSnowluma(ctx, error) }
  })

  r.post('/api/snowluma/remove', 'admin', async (ctx) => {
    const service = d.snowluma
    if (service === undefined) { unavailable(ctx.res); return }
    const body = bodyRecord(ctx.body)
    const keepData = reqBool(body, 'keepData')
    try {
      json(ctx.res, 200, { data: await service.remove({ ...(keepData !== undefined ? { keepData } : {}) }) })
    } catch (error) { failSnowluma(ctx, error) }
  })
}
