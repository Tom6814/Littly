/**
 * QQ 渠道控制台端点（新：SnowLuma OneBot v11 + 官方 QQBot 双渠道）。
 *
 * - GET  /api/qq/status      → 两个渠道的聚合状态（enabled/configured/connected/lastError…）
 * - PUT  /api/qq/snowluma    → admin；`{enabled, wsUrl?, token?, botId?}`（token 掩码写：省略/掩码=不变）
 * - PUT  /api/qq/qqbot       → admin；`{enabled, appId?, appSecret?, botId?}`（secret 掩码写：省略/掩码=不变）
 * - POST /api/qq/probe       → required；`{kind:'snowluma'|'qqbot', botId?}` 真实连接探测
 * - GET  /api/qq/logs        → admin；适配器最近日志环形缓冲（服务端脱敏后返回）
 *
 * SnowLuma 由用户自行安装/启动（非商业自托管，遵守其 EULA）；后端只做连接与状态。
 */
import { randomUUID } from 'node:crypto'
import { json, err, bodyRecord, reqStr, reqBool, reqNum } from './http.ts'
import { isMaskedInput } from './mapping.ts'
import type { RegisterFn } from './deps.ts'
import type { QqChannelKind } from '@littly/channel-qq'

/** 服务未装配（profile 没启用 @littly/channel-qq）。 */
function unavailable(res: Parameters<typeof err>[0]): void {
  err(res, 501, 'qq_unavailable', 'QQ 渠道插件未装配（@littly/channel-qq 未加载）')
}

/** 日志脱敏：token/secret/密码值替换为 ***。 */
export function maskQqLog(text: string): string {
  return text
    .replace(/((?:access[_-]?token|auth[_-]?token|token|secret|app[_-]?secret|password|passwd)\s*[:=]\s*)(\S+)/giu, '$1***')
    .replace(/(access_token=)[^&\s]+/giu, '$1***')
}

interface TargetBotRow {
  id: string
  snowluma_enabled: number
  snowluma_ws_url: string
  snowluma_token: string
  qq_enabled: number
  qq_app_id: string
  qq_app_secret: string
}

function targetBots(r: { storage: { prepare: (sql: string) => { all: (...a: unknown[]) => unknown } } }, botId: string | undefined): TargetBotRow[] {
  const sql = 'SELECT id, snowluma_enabled, snowluma_ws_url, snowluma_token, qq_enabled, qq_app_id, qq_app_secret FROM bots'
  const all = r.storage.prepare(botId !== undefined && botId !== '' ? `${sql} WHERE id = ?` : `${sql} ORDER BY created_at ASC`).all as (...a: unknown[]) => unknown
  return (botId !== undefined && botId !== '' ? all(botId) : all()) as TargetBotRow[]
}

export const registerQqRoutes: RegisterFn = (r, d) => {
  r.get('/api/qq/status', 'required', (ctx) => {
    const service = d.qq
    if (service === undefined) {
      unavailable(ctx.res)
      return
    }
    json(ctx.res, 200, { data: service.status() })
  })

  r.put('/api/qq/snowluma', 'admin', (ctx) => {
    const service = d.qq
    if (service === undefined) {
      unavailable(ctx.res)
      return
    }
    const body = bodyRecord(ctx.body)
    const enabled = reqBool(body, 'enabled') === true
    const wsUrl = reqStr(body, 'wsUrl')
    const token = reqStr(body, 'token')
    const botId = reqStr(body, 'botId')
    const rows = targetBots({ storage: d.storage }, botId)
    if (rows.length === 0) {
      err(ctx.res, 400, 'bot_missing', '没有可配置的 bot（先创建/播种角色）')
      return
    }
    const current = rows[0] as TargetBotRow
    const nextUrl = wsUrl !== undefined ? wsUrl.trim() : current.snowluma_ws_url
    if (nextUrl !== '') {
      try {
        const parsed = new URL(nextUrl)
        if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') throw new Error('protocol')
      } catch {
        err(ctx.res, 400, 'bad_request', `WS 地址必须以 ws:// 或 wss:// 开头（收到 ${nextUrl}）`)
        return
      }
    }
    if (enabled && nextUrl === '') {
      err(ctx.res, 400, 'bad_request', '启用 SnowLuma 前请先填写 OneBot WS 地址（ws://127.0.0.1:3001）')
      return
    }
    for (const row of rows) {
      const nextToken = token === undefined || isMaskedInput(token) ? row.snowluma_token : token.trim()
      d.storage
        .prepare('UPDATE bots SET snowluma_enabled = ?, snowluma_ws_url = ?, snowluma_token = ? WHERE id = ?')
        .run(enabled ? 1 : 0, nextUrl, nextToken, row.id)
    }
    void service.sync()
    json(ctx.res, 200, { data: { ok: true, updated: rows.length, status: service.status() } })
  })

  r.put('/api/qq/qqbot', 'admin', (ctx) => {
    const service = d.qq
    if (service === undefined) {
      unavailable(ctx.res)
      return
    }
    const body = bodyRecord(ctx.body)
    const enabled = reqBool(body, 'enabled') === true
    const appId = reqStr(body, 'appId')
    const appSecret = reqStr(body, 'appSecret')
    const botId = reqStr(body, 'botId')
    const rows = targetBots({ storage: d.storage }, botId)
    if (rows.length === 0) {
      err(ctx.res, 400, 'bot_missing', '没有可配置的 bot（先创建/播种角色）')
      return
    }
    const current = rows[0] as TargetBotRow
    const nextAppId = appId !== undefined ? appId.trim() : current.qq_app_id
    if (enabled && nextAppId === '') {
      err(ctx.res, 400, 'bad_request', '启用官方 QQBot 前请填写 AppID')
      return
    }
    for (const row of rows) {
      const nextSecret = appSecret === undefined || isMaskedInput(appSecret) ? row.qq_app_secret : appSecret.trim()
      if (enabled && nextSecret === '') {
        err(ctx.res, 400, 'bad_request', '启用官方 QQBot 前请填写 AppSecret')
        return
      }
      const secretChanged = nextSecret !== row.qq_app_secret
      const idChanged = nextAppId !== row.qq_app_id
      d.storage
        .prepare('UPDATE bots SET qq_enabled = ?, qq_app_id = ?, qq_app_secret = ? WHERE id = ?')
        .run(enabled ? 1 : 0, nextAppId, nextSecret, row.id)
      if (secretChanged || idChanged) {
        // AppID/Secret 变了 → 清 access_token 缓存（下次连接重新换 token）
        d.storage.prepare('UPDATE bots SET qq_access_token = ?, qq_token_expires_at = NULL WHERE id = ?').run('', row.id)
      }
    }
    void service.sync()
    json(ctx.res, 200, { data: { ok: true, updated: rows.length, status: service.status() } })
  })

  r.post('/api/qq/probe', 'required', async (ctx) => {
    const service = d.qq
    if (service === undefined) {
      unavailable(ctx.res)
      return
    }
    const body = bodyRecord(ctx.body)
    const kindRaw = reqStr(body, 'kind') ?? 'snowluma'
    if (kindRaw !== 'snowluma' && kindRaw !== 'qqbot') {
      err(ctx.res, 400, 'bad_request', "kind 必须是 'snowluma' 或 'qqbot'")
      return
    }
    const kind: QqChannelKind = kindRaw
    const botId = reqStr(body, 'botId')
    json(ctx.res, 200, { data: await service.probe(kind, botId) })
  })

  r.get('/api/qq/logs', 'admin', (ctx) => {
    const service = d.qq
    if (service === undefined) {
      unavailable(ctx.res)
      return
    }
    const tail = reqNum({ tail: ctx.query.get('tail') ?? undefined }, 'tail') ?? 100
    const lines = service.logs(tail)
    json(ctx.res, 200, {
      data: {
        logs: lines.map((line) => ({ ...line, text: maskQqLog(line.text) })),
        count: lines.length,
      },
    })
  })
}

/** 生成不重复的占位 id（保留给未来 upsert 用；避免 tree-shake 后 import 报错）。 */
export function makeQqRequestId(): string {
  return randomUUID()
}
