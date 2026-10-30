/**
 * X（Twitter）控制台端点。
 *
 * 与 @littly/x 服务（`littlyX`）配套：
 * - GET  /api/x/status   → 凭据状态 + binOk（二进制是否可用，60s 缓存）+ 最近一次 probe 的错误
 * - POST /api/x/login    → admin；整串 cookie 或 auth_token+ct0；保存后立刻 whoami 验证
 * - POST /api/x/logout   → admin；清凭据
 * - PUT  /api/x/settings → admin；allowWrites 开关 / proxy
 * - POST /api/x/probe    → 跑一次 `twitter status`，返回 {ok, username?, error?}
 * - POST /api/x/cmd      → 控制台预览：走同一 service（同样受允许清单/写开关/限频约束）
 *
 * 安全：token/ct0 永不回传（只在 service 内部使用），状态只给 configured/username/binOk 等。
 */
import { json, err, bodyRecord, reqStr, reqBool } from './http.ts'
import type { RegisterFn } from './deps.ts'

/** X 服务未装配时的统一错误（profile 未启用该插件）。 */
function xUnavailable(res: Parameters<typeof err>[0]): void {
  err(res, 501, 'x_unavailable', 'X 插件未装配（@littly/x 未加载）')
}

export const registerXRoutes: RegisterFn = (r, d) => {
  r.get('/api/x/status', 'required', async (ctx) => {
    const x = d.x
    if (x === undefined) {
      xUnavailable(ctx.res)
      return
    }
    const binOk = await x.binOk()
    json(ctx.res, 200, {
      data: {
        ...x.status(),
        // 二进制可用性与「最近一次连不上」分开：前端可以显示「已安装但未登录/连不上」。
        binOk,
        lastProbe: x.lastProbe(),
      },
    })
  })

  r.post('/api/x/login', 'admin', async (ctx) => {
    const x = d.x
    if (x === undefined) {
      xUnavailable(ctx.res)
      return
    }
    const body = bodyRecord(ctx.body)
    const cookie = reqStr(body, 'cookie')
    const authToken = reqStr(body, 'authToken', 'auth_token')
    const ct0 = reqStr(body, 'ct0')
    const proxy = reqStr(body, 'proxy')
    const result = await x.login({
      ...(cookie !== undefined ? { cookie } : {}),
      ...(authToken !== undefined ? { authToken } : {}),
      ...(ct0 !== undefined ? { ct0 } : {}),
      ...(proxy !== undefined ? { proxy } : {}),
    })
    // 失败也保留已存凭据：200 + {ok:false,error}，前端据此展示可读错误。
    json(ctx.res, 200, { data: { ok: result.ok, status: result.status, ...(result.error !== undefined ? { error: result.error } : {}) } })
  })

  r.post('/api/x/logout', 'admin', (ctx) => {
    const x = d.x
    if (x === undefined) {
      xUnavailable(ctx.res)
      return
    }
    json(ctx.res, 200, { data: { ok: true, status: x.logout() } })
  })

  r.put('/api/x/settings', 'admin', (ctx) => {
    const x = d.x
    if (x === undefined) {
      xUnavailable(ctx.res)
      return
    }
    const body = bodyRecord(ctx.body)
    const allowWrites = reqBool(body, 'allowWrites', 'allow_writes')
    if (body['allowWrites'] !== undefined && allowWrites === undefined) {
      err(ctx.res, 400, 'bad_request', 'allowWrites 需为布尔值')
      return
    }
    const proxy = reqStr(body, 'proxy')
    json(ctx.res, 200, { data: { ok: true, status: x.settings({ ...(allowWrites !== undefined ? { allowWrites } : {}), ...(proxy !== undefined ? { proxy } : {}) }) } })
  })

  r.post('/api/x/probe', 'required', async (ctx) => {
    const x = d.x
    if (x === undefined) {
      xUnavailable(ctx.res)
      return
    }
    const result = await x.probe()
    json(ctx.res, 200, { data: result })
  })

  r.post('/api/x/cmd', 'required', async (ctx) => {
    const x = d.x
    if (x === undefined) {
      xUnavailable(ctx.res)
      return
    }
    const body = bodyRecord(ctx.body)
    const argv = Array.isArray(body['argv']) ? (body['argv'] as unknown[]).map((a) => String(a)) : []
    const dryRun = reqBool(body, 'dryRun')
    const botId = reqStr(body, 'botId') ?? ''
    const result = await x.run(argv, { ...(botId !== '' ? { botId } : {}), ...(dryRun !== undefined ? { dryRun } : {}) })
    // 参数/命令校验类错误 → 400（调用方 bug）；执行失败（未登录/限频/接口错误）→ 200 + ok:false。
    const validationCodes = new Set(['bad_request', 'command_not_allowed', 'flag_not_allowed'])
    if (!result.ok && result.error !== undefined && validationCodes.has(result.error.code)) {
      err(ctx.res, 400, result.error.code, result.error.message)
      return
    }
    json(ctx.res, 200, { data: result })
  })
}
