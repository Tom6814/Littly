/**
 * 角色卡与世界书端点。
 * 角色卡：CRUD + PNG 导入导出（tEXt 'chara' chunk）+ 头像上传 + 内置预设。
 * 世界书：CRUD + 命中测试（与正式匹配共用 @littly/persona 的纯函数）。
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, basename, extname, resolve, sep } from 'node:path'
import { downloadsDir, type CharacterRow, type WorldEntryRow } from '@littly/storage'
import { WI_LOGIC, evaluateWorldEntry } from '@littly/persona/src/worldbook.ts'
import { json, err, bodyRecord, reqStr, reqNum, reqBool, type ApiRequest } from './http.ts'
import { characterView, worldEntryView } from './mapping.ts'
import { buildCharacterPng, extractCharaCard } from './png.ts'
import { loadBot, nowIso, queryStr, botOwnedBy, requireRowBotAccess } from './deps.ts'
import type { Deps, RegisterFn } from './deps.ts'

// B11：上传目录改为持久卷（LITTLY_DATA_DIR/downloads；默认 <cwd>/data/downloads）。
// 对外的 /api/photos/file/* URL 保持不变。
const AVATAR_DIR = 'avatars'
const EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

function charRow(d: Deps, id: string): CharacterRow | undefined {
  return d.storage.prepare('SELECT * FROM characters WHERE id = ?').get(id) as CharacterRow | undefined
}

/** 第一个上传文件（按字段名优先）。 */
function pickFile(ctx: ApiRequest, field: string): { data: Buffer; filename: string; contentType: string } | null {
  const wanted = ctx.files.find((f) => f.field === field) ?? ctx.files[0]
  if (wanted === undefined || wanted.data.length === 0) return null
  return { data: wanted.data, filename: wanted.filename, contentType: wanted.contentType }
}

function avatarPath(row: CharacterRow): string | null {
  if (row.avatar === '') return null
  const name = basename(row.avatar)
  const file = join(downloadsDir(), AVATAR_DIR, name)
  if (!existsSync(file)) return null
  return file
}

function saveUpload(dir: string, filename: string, data: Buffer): string {
  const safeBase = basename(filename).replace(/[^\w.-]/g, '_') || 'upload'
  const ext = extname(safeBase) || '.png'
  const name = `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`
  const dirAbs = join(downloadsDir(), dir)
  mkdirSync(dirAbs, { recursive: true })
  writeFileSync(join(dirAbs, name), data)
  return join(dir, name)
}

export const registerContentRoutes: RegisterFn = (r, d) => {
  // B3：内容域归属守卫 —— 带 botId 的请求要求 admin 或该 bot 的 owner。
  r.botGuard = (ctx, botId) => botOwnedBy(ctx, d, botId)
  // ---- 角色卡 ----

  r.get('/api/characters', 'required', (ctx) => {
    const rows = d.storage.prepare('SELECT * FROM characters ORDER BY created_at ASC').all() as unknown as CharacterRow[]
    json(ctx.res, 200, { data: { characters: rows.map(characterView) } })
  })

  r.post('/api/characters', 'admin', (ctx) => {
    const body = bodyRecord(ctx.body)
    const name = reqStr(body, 'name', 'characterName')?.trim()
    if (name === undefined || name === '') {
      err(ctx.res, 400, 'bad_request', '角色名不能为空')
      return
    }
    const card = bodyRecord(body['card'])
    const mask = reqStr(body, 'mask', 'maskText')
    const tags = Array.isArray(body['deepseekPersonaTags'])
      ? (body['deepseekPersonaTags'] as unknown[]).map((t) => String(t)).filter((t) => t !== '')
      : undefined
    const spec: CharacterRow['spec'] = mask !== undefined && mask !== '' ? 'mask' : tags !== undefined && tags.length > 0 ? 'deepseek_persona' : 'chara_card_v2'
    const data = mask !== undefined && mask !== '' ? mask : tags !== undefined && tags.length > 0 ? tags.join('\n') : JSON.stringify(card)
    const id = randomUUID()
    d.storage.prepare('INSERT INTO characters (id, name, spec, data, system_prompt, first_mes, avatar, style_calibration, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, name, spec, data, reqStr(body, 'systemPrompt') ?? '', reqStr(body, 'firstMes') ?? '', '', '{}', nowIso())
    const row = charRow(d, id)
    if (row === undefined) {
      err(ctx.res, 500, 'internal', '创建失败')
      return
    }
    json(ctx.res, 200, { data: { character: characterView(row) } })
  })

  r.patch('/api/characters/:id', 'admin', (ctx) => {
    const row = charRow(d, ctx.params['id'] ?? '')
    if (row === undefined) {
      err(ctx.res, 404, 'not_found', '角色不存在')
      return
    }
    const body = bodyRecord(ctx.body)
    const columns: string[] = []
    const values: unknown[] = []
    const name = reqStr(body, 'name', 'characterName')
    if (name !== undefined && name.trim() !== '') {
      columns.push('name')
      values.push(name.trim())
    }
    if ('card' in body && body['card'] !== undefined && typeof body['card'] === 'object') {
      columns.push('spec')
      values.push('chara_card_v2')
      columns.push('data')
      values.push(JSON.stringify(body['card']))
    }
    const mask = reqStr(body, 'mask', 'maskText')
    if (mask !== undefined && mask !== '') {
      columns.push('spec')
      values.push('mask')
      columns.push('data')
      values.push(mask)
    }
    const systemPrompt = reqStr(body, 'systemPrompt')
    if (systemPrompt !== undefined) {
      columns.push('system_prompt')
      values.push(systemPrompt)
    }
    const firstMes = reqStr(body, 'firstMes')
    if (firstMes !== undefined) {
      columns.push('first_mes')
      values.push(firstMes)
    }
    if (columns.length > 0) {
      d.storage.prepare(`UPDATE characters SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...values, row.id)
    }
    const updated = charRow(d, row.id)
    if (updated === undefined) {
      err(ctx.res, 500, 'internal', '更新失败')
      return
    }
    json(ctx.res, 200, { data: { character: characterView(updated) } })
  })

  r.del('/api/characters/:id', 'admin', (ctx) => {
    const row = charRow(d, ctx.params['id'] ?? '')
    if (row === undefined) {
      err(ctx.res, 404, 'not_found', '角色不存在')
      return
    }
    d.storage.prepare('UPDATE bots SET character_id = NULL WHERE character_id = ?').run(row.id)
    d.storage.prepare('DELETE FROM characters WHERE id = ?').run(row.id)
    json(ctx.res, 200, { data: { character: characterView(row) } })
  })

  // PNG 导入（multipart file）
  r.post('/api/characters/import-png', 'admin', (ctx) => {
    const file = pickFile(ctx, 'file')
    if (file === null) {
      err(ctx.res, 400, 'bad_request', '缺少上传文件')
      return
    }
    const cardText = extractCharaCard(file.data)
    if (cardText === null) {
      err(ctx.res, 400, 'bad_request', 'PNG 中没有找到角色卡数据')
      return
    }
    let card: Record<string, unknown>
    try {
      card = JSON.parse(cardText) as Record<string, unknown>
    } catch {
      err(ctx.res, 400, 'bad_request', '角色卡数据不是合法 JSON')
      return
    }
    const dataPart = (typeof card['data'] === 'object' && card['data'] !== null ? card['data'] : card) as Record<string, unknown>
    const name = typeof dataPart['name'] === 'string' && dataPart['name'] !== '' ? dataPart['name'] : '导入角色'
    const id = randomUUID()
    d.storage.prepare('INSERT INTO characters (id, name, spec, data, system_prompt, first_mes, avatar, style_calibration, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, name, 'chara_card_v2', cardText, '', typeof dataPart['first_mes'] === 'string' ? dataPart['first_mes'] : '', '', '{}', nowIso())
    const row = charRow(d, id)
    if (row === undefined) {
      err(ctx.res, 500, 'internal', '导入失败')
      return
    }
    json(ctx.res, 200, { data: { character: characterView(row) } })
  })

  // PNG 导出（带 chara chunk 下载）
  r.get('/api/characters/:id/export-png', 'required', (ctx) => {
    const row = charRow(d, ctx.params['id'] ?? '')
    if (row === undefined) {
      err(ctx.res, 404, 'not_found', '角色不存在')
      return
    }
    let card: Record<string, unknown>
    try {
      card = JSON.parse(row.data) as Record<string, unknown>
    } catch {
      card = {}
    }
    const cardJson = JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { ...card, name: row.name } })
    const avatarFile = avatarPath(row)
    let avatarPng: Buffer | null = null
    if (avatarFile !== null) avatarPng = readFileSync(avatarFile)
    const png = buildCharacterPng(avatarPng, cardJson)
    ctx.res.writeHead(200, {
      'content-type': 'image/png',
      'content-disposition': `attachment; filename="${encodeURIComponent(`${row.name}.png`)}"`,
      'cache-control': 'no-store',
    })
    ctx.res.end(png)
  })

  // 头像上传（multipart file）
  r.post('/api/characters/:id/avatar', 'admin', (ctx) => {
    const row = charRow(d, ctx.params['id'] ?? '')
    if (row === undefined) {
      err(ctx.res, 404, 'not_found', '角色不存在')
      return
    }
    const file = pickFile(ctx, 'file')
    if (file === null) {
      err(ctx.res, 400, 'bad_request', '缺少上传文件')
      return
    }
    const rel = saveUpload(AVATAR_DIR, file.filename, file.data)
    const url = `/api/photos/file/${rel.split(sep).join('/')}`
    d.storage.prepare('UPDATE characters SET avatar = ? WHERE id = ?').run(url, row.id)
    json(ctx.res, 200, { data: { avatarUrl: url, url } })
  })

  // ---- 世界书 ----

  r.get('/api/world-entries', 'required', (ctx) => {
    const botId = queryStr(ctx, 'botId') ?? ''
    const rows = d.storage.prepare('SELECT * FROM world_entries WHERE bot_id = ? ORDER BY priority DESC, comment ASC').all(botId) as unknown as WorldEntryRow[]
    json(ctx.res, 200, { data: { entries: rows.map(worldEntryView) } })
  })

  r.post('/api/world-entries', 'required', (ctx) => {
    const body = bodyRecord(ctx.body)
    const botId = reqStr(body, 'botId') ?? ''
    const keys = Array.isArray(body['keys']) ? (body['keys'] as unknown[]).map((k) => String(k)).filter((k) => k !== '') : []
    const secondKeys = Array.isArray(body['secondKeys']) ? (body['secondKeys'] as unknown[]).map((k) => String(k)).filter((k) => k !== '') : []
    const logicText = reqStr(body, 'logic', 'matchLogic') ?? 'AND_ANY'
    const logic = (WI_LOGIC as Record<string, number>)[logicText] ?? WI_LOGIC.AND_ANY
    const positionText = reqStr(body, 'position') ?? 'after'
    const id = randomUUID()
    d.storage.prepare(
      'INSERT INTO world_entries (id, bot_id, character_id, keys, second_keys, logic, constant, probability, priority, position, enabled, content, comment) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      id, botId, reqStr(body, 'characterId') ?? '',
      JSON.stringify(keys), JSON.stringify(secondKeys),
      logic,
      reqBool(body, 'constant', 'isConstant') === true ? 1 : 0,
      reqNum(body, 'probability', 'triggerProbability') ?? 85,
      reqNum(body, 'priority') ?? 100,
      positionText === 'before' ? 0 : 1,
      reqBool(body, 'enabled') === false ? 0 : 1,
      reqStr(body, 'content', 'text') ?? '',
      reqStr(body, 'comment') ?? '',
    )
    const row = d.storage.prepare('SELECT * FROM world_entries WHERE id = ?').get(id) as WorldEntryRow | undefined
    if (row === undefined) {
      err(ctx.res, 500, 'internal', '创建失败')
      return
    }
    json(ctx.res, 200, { data: { entry: worldEntryView(row) } })
  })

  r.patch('/api/world-entries/:id', 'required', (ctx) => {
    const row = d.storage.prepare('SELECT * FROM world_entries WHERE id = ?').get(ctx.params['id'] ?? '') as WorldEntryRow | undefined
    if (row === undefined) {
      err(ctx.res, 404, 'not_found', '词条不存在')
      return
    }
    if (!requireRowBotAccess(ctx, d, row.bot_id)) return
    const body = bodyRecord(ctx.body)
    const columns: string[] = []
    const values: unknown[] = []
    const put = (column: string, value: unknown): void => {
      columns.push(column)
      values.push(value)
    }
    if (Array.isArray(body['keys'])) put('keys', JSON.stringify((body['keys'] as unknown[]).map((k) => String(k))))
    if (Array.isArray(body['secondKeys'])) put('second_keys', JSON.stringify((body['secondKeys'] as unknown[]).map((k) => String(k))))
    const logicText = reqStr(body, 'logic', 'matchLogic')
    if (logicText !== undefined && logicText in WI_LOGIC) put('logic', (WI_LOGIC as Record<string, number>)[logicText])
    const constant = reqBool(body, 'constant', 'isConstant')
    if (constant !== undefined) put('constant', constant ? 1 : 0)
    const probability = reqNum(body, 'probability', 'triggerProbability')
    if (probability !== undefined) put('probability', probability)
    const priority = reqNum(body, 'priority')
    if (priority !== undefined) put('priority', priority)
    const position = reqStr(body, 'position')
    if (position !== undefined) put('position', position === 'before' ? 0 : 1)
    const enabled = reqBool(body, 'enabled')
    if (enabled !== undefined) put('enabled', enabled ? 1 : 0)
    const content = reqStr(body, 'content', 'text')
    if (content !== undefined) put('content', content)
    const comment = reqStr(body, 'comment')
    if (comment !== undefined) put('comment', comment)
    if (columns.length > 0) {
      d.storage.prepare(`UPDATE world_entries SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...values, row.id)
    }
    const updated = d.storage.prepare('SELECT * FROM world_entries WHERE id = ?').get(row.id) as WorldEntryRow | undefined
    if (updated === undefined) {
      err(ctx.res, 500, 'internal', '更新失败')
      return
    }
    json(ctx.res, 200, { data: { entry: worldEntryView(updated) } })
  })

  r.del('/api/world-entries/:id', 'required', (ctx) => {
    const row = d.storage.prepare('SELECT * FROM world_entries WHERE id = ?').get(ctx.params['id'] ?? '') as WorldEntryRow | undefined
    if (row === undefined) {
      err(ctx.res, 404, 'not_found', '词条不存在')
      return
    }
    if (!requireRowBotAccess(ctx, d, row.bot_id)) return
    d.storage.prepare('DELETE FROM world_entries WHERE id = ?').run(row.id)
    json(ctx.res, 200, { data: { entry: worldEntryView(row) } })
  })

  // 命中测试：与正式匹配同一套判定（evaluateWorldEntry，纯函数不掷骰）
  r.post('/api/world-entries/test', 'required', (ctx) => {
    const body = bodyRecord(ctx.body)
    const botId = reqStr(body, 'botId') ?? ''
    const text = reqStr(body, 'text') ?? ''
    const bot = loadBot(d, botId)
    if (bot === null) {
      err(ctx.res, 400, 'bad_request', '机器人不存在')
      return
    }
    const rows = d.storage.prepare("SELECT * FROM world_entries WHERE enabled = 1 AND (character_id = '' OR character_id = ?) AND (bot_id = '' OR bot_id = ?)")
      .all(bot.character_id ?? '', botId) as unknown as WorldEntryRow[]
    const matches = rows
      .map((entry) => ({ id: entry.id, comment: entry.comment, evaluation: evaluateWorldEntry(entry, text) }))
      .filter((m) => m.evaluation.active)
      .map((m) => ({ id: m.id, comment: m.comment, hitKeys: m.evaluation.hitKeys }))
    json(ctx.res, 200, { data: { matches, matchedIds: matches.map((m) => m.id) } })
  })

  // ---- 内置预设（§18.3 #16 语义：源码内硬编码演示卡，不入库）----

  r.get('/api/characters/presets', 'required', (ctx) => {
    const presets: Array<Record<string, unknown>> = [
      {
        id: 'preset-gentle',
        name: '温柔邻家（演示）',
        preset: true,
        card: {
          spec: 'chara_card_v2',
          data: {
            name: '温柔邻家',
            description: '一个说话轻声细语、爱笑的邻家女孩，喜欢猫和热可可。',
            personality: '温柔、耐心、有点小迷糊',
            scenario: '你们是邻居，经常在楼道偶遇。',
            first_mes: '（抱着一箱刚拆的快递朝你挥挥手）嗨——又见面啦。',
          },
        },
      },
      {
        id: 'preset-cool',
        name: '高冷学姐（演示）',
        preset: true,
        card: {
          spec: 'chara_card_v2',
          data: {
            name: '高冷学姐',
            description: '成绩顶尖的学姐，话不多但句句在点上，嘴硬心软。',
            personality: '高冷、毒舌、可靠',
            scenario: '你们在图书馆同一个自习区。',
            first_mes: '（头也没抬）那个位置是我的，坐对面吧。',
          },
        },
      },
    ]
    json(ctx.res, 200, { data: { presets } })
  })

  // 静态文件（公开、路径穿越防护、不可变缓存；tools 写文件的 URL 也指向这里）
  r.get('/api/photos/file/*', 'public', (ctx) => {
    const rest = ctx.params['*'] ?? ''
    if (rest === '') {
      err(ctx.res, 404, 'not_found', '文件不存在')
      return
    }
    const legacyBase = resolve(d.cwd, 'public', 'downloads')
    for (const base of [downloadsDir(), legacyBase]) {
      const target = resolve(base, rest)
      if (target !== base && !target.startsWith(base + sep)) {
        err(ctx.res, 400, 'bad_request', '非法路径')
        return
      }
      if (!existsSync(target)) continue
      const mime = EXT_MIME[extname(target).toLowerCase()] ?? 'application/octet-stream'
      const body = readFileSync(target)
      ctx.res.writeHead(200, {
        'content-type': mime,
        'cache-control': 'public, max-age=31536000, immutable',
      })
      ctx.res.end(body)
      return
    }
    // 两个目录都不存在 → 404（旧目录 public/downloads 仅作升级兼容的只读回退）
    err(ctx.res, 404, 'not_found', '文件不存在')
  })
}
