/**
 * 机器人端点：列表 / 详情（白名单字段，绝不回传渠道密钥）、创建 / 改 / 删、
 * 嵌套 settings 组读写、渠道配置（掩码回显 + hasToken，掩码输入不落库）。
 * 修复旧 §18.1 #1（角色列表泄露全部渠道密钥）与 §18.2 #12。
 */
import { randomUUID } from 'node:crypto'
import type { BotRow } from '@littly/storage'
import { json, err, bodyRecord, reqStr } from './http.ts'
import {
  botSummaryView, botSettingsView, applyBotSettingsPatch,
  botChannelsView, applyBotChannelsPatch,
} from './mapping.ts'
import { ensureSeed } from './seed.ts'
import { requireBotAccess, botOwnedBy } from './deps.ts'
import type { Deps, RegisterFn } from './deps.ts'

function botById(d: Deps, id: string): BotRow | undefined {
  return d.storage.prepare('SELECT * FROM bots WHERE id = ?').get(id) as BotRow | undefined
}

function applyPatch(d: Deps, id: string, columns: string[], values: unknown[]): number {
  if (columns.length === 0) return 0
  const sets = columns.map((c) => `${c} = ?`).join(', ')
  return Number(d.storage.prepare(`UPDATE bots SET ${sets} WHERE id = ?`).run(...values, id).changes)
}

export const registerBotRoutes: RegisterFn = (r, d) => {
  // B3：bot 归属守卫（覆盖带 botId 的 query/body 请求，如 /api/chat、/api/stream）。
  r.botGuard = (ctx, botId) => botOwnedBy(ctx, d, botId)
  // 列表：白名单字段
  r.get('/api/bots', 'required', (ctx) => {
    // 首启播种（照旧仓 ensureSeed）：空库时先给一个可用的 bot + 铁律 + 角色卡。
    // 否则全新部署打开控制台是一片空白，聊天页没有对象。
    ensureSeed(d)
    const allRows = d.storage.prepare('SELECT * FROM bots ORDER BY created_at ASC').all() as unknown as BotRow[]
    // B3 定调：admin 看全部；普通用户看「自己名下的 + 部署默认的她（第一个 bot）+ 未分配 owner 的 bot」。
    // 复用 botOwnedBy 作为唯一判定源，避免「能读消息却列不出 bot」这种前后端不一致。
    const rows = allRows.filter((b) => botOwnedBy(ctx, d, b.id))
    json(ctx.res, 200, {
      data: {
        bots: rows.map(botSummaryView),
        current: rows[0]?.id,
      },
    })
  })

  // 创建（admin）
  r.post('/api/bots', 'admin', (ctx) => {
    const body = bodyRecord(ctx.body)
    const name = reqStr(body, 'name', 'botName')?.trim()
    if (name === undefined || name === '') {
      err(ctx.res, 400, 'bad_request', '机器人名称不能为空')
      return
    }
    const id = randomUUID()
    // B3：创建者即 owner（admin 创建的 bot 归 admin；后续可转移）。
    d.storage.prepare('INSERT INTO bots (id, name, owner_id, created_at) VALUES (?,?,?,?)').run(id, name, ctx.user?.id ?? '', new Date().toISOString())
    const row = botById(d, id)
    if (row === undefined) {
      err(ctx.res, 500, 'internal', '创建失败')
      return
    }
    json(ctx.res, 200, { data: { bot: { ...botSummaryView(row), settings: botSettingsView(row) } } })
  })

  // 详情：白名单 + settings（密钥打码）
  r.get('/api/bots/:id', 'required', (ctx) => {
    const row = botById(d, ctx.params['id'] ?? '')
    if (row === undefined) {
      err(ctx.res, 404, 'not_found', '机器人不存在')
      return
    }
    if (!requireBotAccess(ctx, d, row.id)) return
    json(ctx.res, 200, { data: { bot: { ...botSummaryView(row), settings: botSettingsView(row) } } })
  })

  // 更新（admin）：settings 嵌套组 → 列
  r.patch('/api/bots/:id', 'admin', (ctx) => {
    const row = botById(d, ctx.params['id'] ?? '')
    if (row === undefined) {
      err(ctx.res, 404, 'not_found', '机器人不存在')
      return
    }
    const body = bodyRecord(ctx.body)
    let settings = bodyRecord(body['settings'])
    if (Object.keys(settings).length === 0) settings = body
    const patch = applyBotSettingsPatch(row, settings)
    applyPatch(d, row.id, patch.columns, patch.values)
    const updated = botById(d, row.id)
    if (updated === undefined) {
      err(ctx.res, 500, 'internal', '更新失败')
      return
    }
    json(ctx.res, 200, { data: { bot: { ...botSummaryView(updated), settings: botSettingsView(updated) } } })
  })

  // 删除（admin）
  r.del('/api/bots/:id', 'admin', (ctx) => {
    const row = botById(d, ctx.params['id'] ?? '')
    if (row === undefined) {
      err(ctx.res, 404, 'not_found', '机器人不存在')
      return
    }
    d.storage.prepare('DELETE FROM bots WHERE id = ?').run(row.id)
    json(ctx.res, 200, { data: { bot: botSummaryView(row) } })
  })

  // 渠道配置读取（掩码）
  r.get('/api/bots/:id/channels', 'required', (ctx) => {
    const row = botById(d, ctx.params['id'] ?? '')
    if (row === undefined) {
      err(ctx.res, 404, 'not_found', '机器人不存在')
      return
    }
    if (!requireBotAccess(ctx, d, row.id)) return
    json(ctx.res, 200, { data: { channels: botChannelsView(row) } })
  })

  // 渠道配置写入（admin）：掩码 / 空串 = 保持原值
  r.put('/api/bots/:id/channels', 'admin', (ctx) => {
    const row = botById(d, ctx.params['id'] ?? '')
    if (row === undefined) {
      err(ctx.res, 404, 'not_found', '机器人不存在')
      return
    }
    const body = bodyRecord(ctx.body)
    let channels = bodyRecord(body['channels'])
    if (Object.keys(channels).length === 0) channels = body
    const patch = applyBotChannelsPatch(row, channels)
    applyPatch(d, row.id, patch.columns, patch.values)
    const updated = botById(d, row.id)
    if (updated === undefined) {
      err(ctx.res, 500, 'internal', '更新失败')
      return
    }
    json(ctx.res, 200, { data: { channels: botChannelsView(updated) } })
  })
}
