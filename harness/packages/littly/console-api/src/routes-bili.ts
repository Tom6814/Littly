/**
 * Bilibili 控制台端点（@littly/bili：bilibili-cli 壳 + 扫码 / 浏览器 Cookie 认证）。
 *
 * 端点（/tmp/bili-spec.md §1.3 + 前端已对接的 settings）：
 * - GET  /api/bili/status          → 登录状态 / 账号信息 / 写开关 / binOk / 最近错误
 * - POST /api/bili/qr/start        → 生成二维码（passport HTTP → 零依赖 QR PNG data URL）
 * - GET  /api/bili/qr/status       → 轮询四态 wait/scaned/confirmed/expired
 * - POST /api/bili/extract-cookie  → admin；删凭证后让 CLI 从本机浏览器提取
 * - POST /api/bili/logout          → admin；清除 CLI 凭证
 * - PUT  /api/bili/settings        → admin；写开关（global_settings['bili.allow_writes']）
 * - POST /api/bili/cmd             → 控制台预览：走同一 service（允许清单/写开关/限频/审计一致）
 *
 * 安全：凭证（SESSDATA 等）永不回传；status 只给账号展示字段与凭证摘要（存在性/时间）。
 */
import { json, err, bodyRecord, reqStr, reqBool } from './http.ts'
import type { RegisterFn, BiliStatusLike, BiliProbeInfoLike, BiliUserLike } from './deps.ts'

/** 插件未装配时的统一错误（profile 未启用 @littly/bili）。 */
function biliUnavailable(res: Parameters<typeof err>[0]): void {
  err(res, 501, 'bili_unavailable', 'Bilibili 插件未装配（@littly/bili 未加载）')
}

/** 可读错误文本（未知异常兜底）。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 账号展示视图（前端 toBiliStatus 兼容 uname/username/mid/avatarUrl/vipLabel）。 */
function userViewOf(user: BiliUserLike): Record<string, unknown> {
  return {
    id: user.id,
    mid: user.mid,
    uid: user.mid,
    name: user.name,
    username: user.username,
    uname: user.uname,
    avatarUrl: user.avatarUrl,
    level: user.level,
    coins: user.coins,
    sign: user.sign,
    vip: user.vip,
    vipLabel: user.vip.label,
  }
}

/**
 * 状态出参：同时给前端已兼容的标准字段（authenticated/user/allowWrites/binOk）
 * 与展示用扁平字段（username/mid/level/vipLabel/loggedInAt）。
 */
function statusView(
  status: BiliStatusLike,
  binOk: boolean,
  lastProbe: BiliProbeInfoLike | null,
): Record<string, unknown> {
  const user = status.user
  const userView = user === null ? null : userViewOf(user)
  const notAuthenticated = !status.authenticated && (status.error === undefined || status.error.code === 'not_authenticated')
  return {
    authenticated: status.authenticated,
    user: userView,
    username: user?.username ?? '',
    mid: user?.mid ?? '',
    level: user?.level ?? 0,
    vipLabel: user?.vip.label ?? '',
    loggedInAt: status.credential.savedAt,
    savedAt: status.credential.savedAt,
    credential: { present: status.credential.present, hasBuvid: status.credential.hasBuvid },
    allowWrites: status.allowWrites,
    bin: status.bin,
    binOk,
    lastProbe,
    lastError: status.error?.message ?? lastProbe?.error ?? '',
    ...(status.error !== undefined ? { error: status.error } : {}),
    ...(notAuthenticated
      ? { hint: '未登录：可以「扫码登录」（手机 B 站 App 扫码），或在运行本服务的机器上「提取浏览器 Cookie」。' }
      : {}),
  }
}

/** 扫码类错误 → 502（外部 passport 不可达/失败），文案可读。 */
function qrFailure(res: Parameters<typeof err>[0], error: unknown): void {
  err(res, 502, 'bili_qr_failed', `B 站扫码登录失败：${messageOf(error)}`)
}

/** cmd 的参数校验类错误（调用方 bug）→ 400。 */
const VALIDATION_CODES = new Set(['bad_request', 'command_not_allowed', 'flag_not_allowed'])

export const registerBiliRoutes: RegisterFn = (r, d) => {
  r.get('/api/bili/status', 'required', async (ctx) => {
    const bili = d.bili
    if (bili === undefined) {
      biliUnavailable(ctx.res)
      return
    }
    try {
      const [status, binOk] = await Promise.all([bili.status(), bili.binOk()])
      json(ctx.res, 200, { data: statusView(status, binOk, bili.lastProbe()) })
    } catch (error) {
      err(ctx.res, 502, 'bili_status_failed', `读取 B 站状态失败：${messageOf(error)}`)
    }
  })

  r.post('/api/bili/qr/start', 'required', async (ctx) => {
    const bili = d.bili
    if (bili === undefined) {
      biliUnavailable(ctx.res)
      return
    }
    try {
      const result = await bili.qrStart()
      json(ctx.res, 200, { data: result })
    } catch (error) {
      qrFailure(ctx.res, error)
    }
  })

  r.get('/api/bili/qr/status', 'required', async (ctx) => {
    const bili = d.bili
    if (bili === undefined) {
      biliUnavailable(ctx.res)
      return
    }
    const sessionId = (ctx.query.get('sessionId') ?? ctx.query.get('session_id') ?? '').trim()
    if (sessionId === '') {
      err(ctx.res, 400, 'bad_request', '缺少 sessionId')
      return
    }
    try {
      const result = await bili.qrPoll(sessionId)
      json(ctx.res, 200, { data: result })
    } catch (error) {
      // 轮询失败对前端仍是一个「可继续轮询」的状态，不抛 5xx 打断二维码界面。
      json(ctx.res, 200, { data: { status: 'error', message: `轮询扫码状态失败：${messageOf(error)}` } })
    }
  })

  r.post('/api/bili/extract-cookie', 'admin', async (ctx) => {
    const bili = d.bili
    if (bili === undefined) {
      biliUnavailable(ctx.res)
      return
    }
    try {
      const result = await bili.browserExtract()
      const binOk = await bili.binOk()
      json(ctx.res, 200, {
        data: {
          ok: result.ok,
          ...statusView(result.status, binOk, bili.lastProbe()),
          ...(result.hint !== undefined ? { hint: result.hint } : {}),
          ...(result.error !== undefined ? { extractError: result.error } : {}),
        },
      })
    } catch (error) {
      err(ctx.res, 502, 'bili_extract_failed', `提取浏览器 Cookie 失败：${messageOf(error)}`)
    }
  })

  r.post('/api/bili/logout', 'admin', async (ctx) => {
    const bili = d.bili
    if (bili === undefined) {
      biliUnavailable(ctx.res)
      return
    }
    try {
      const result = await bili.logout()
      json(ctx.res, 200, { data: { ok: true, cleared: result.cleared } })
    } catch (error) {
      err(ctx.res, 502, 'bili_logout_failed', `登出失败：${messageOf(error)}`)
    }
  })

  r.put('/api/bili/settings', 'admin', (ctx) => {
    const bili = d.bili
    if (bili === undefined) {
      biliUnavailable(ctx.res)
      return
    }
    const body = bodyRecord(ctx.body)
    const allowWrites = reqBool(body, 'allowWrites', 'allow_writes')
    if (body['allowWrites'] !== undefined && allowWrites === undefined) {
      err(ctx.res, 400, 'bad_request', 'allowWrites 需为布尔值')
      return
    }
    const result = bili.settings(allowWrites !== undefined ? { allowWrites } : {})
    json(ctx.res, 200, { data: { ok: result.ok, allowWrites: result.allowWrites } })
  })

  r.post('/api/bili/cmd', 'required', async (ctx) => {
    const bili = d.bili
    if (bili === undefined) {
      biliUnavailable(ctx.res)
      return
    }
    const body = bodyRecord(ctx.body)
    const argv = Array.isArray(body['argv']) ? body['argv'].map(String) : []
    const dryRun = reqBool(body, 'dryRun', 'dry_run')
    const botId = reqStr(body, 'botId', 'bot_id') ?? ''
    try {
      const result = await bili.run(argv, {
        ...(botId !== '' ? { botId } : {}),
        ...(dryRun !== undefined ? { dryRun } : {}),
      })
      if (!result.ok && result.error !== undefined && VALIDATION_CODES.has(result.error.code)) {
        err(ctx.res, 400, result.error.code, result.error.message)
        return
      }
      // 前端把 error 当字符串展示；结构化的错误码单独给 code。
      const failure =
        result.error === undefined
          ? { error: 'B 站命令执行失败', code: 'bili_api_error' }
          : { error: result.error.message, code: result.error.code }
      json(ctx.res, 200, {
        data: {
          ok: result.ok,
          dryRun: result.dryRun,
          exitCode: result.exitCode,
          command: result.command,
          argv: result.argv,
          ...(result.data !== undefined ? { data: result.data } : {}),
          ...(result.note !== undefined ? { note: result.note } : {}),
          ...(result.outputDir !== undefined ? { outputDir: result.outputDir } : {}),
          ...(result.ok ? {} : failure),
        },
      })
    } catch (error) {
      err(ctx.res, 502, 'bili_cmd_failed', `B 站命令执行失败：${messageOf(error)}`)
    }
  })
}
