/**
 * 数据端点：联系人 / 关系 / 记忆（双池 + 整理）/ 日记 / 相册 / 定时消息。
 * 相册上传写 <cwd>/public/downloads/photos，URL 走公开的 /api/photos/file 路由。
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import type { ContactRow, ContactRelationRow, DiaryRow, MemoryRow, PhotoRow, ScheduledMessageRow } from '@littly/storage'
import { chatComplete } from '@littly/llm'
import { json, err, bodyRecord, reqStr, reqNum, reqBool } from './http.ts'
import { contactView, relationView, memoryView, diaryView, photoView, scheduledView, parseJsonArray } from './mapping.ts'
import { isAdmin, resolveSender, senderAllowed, ownSender, loadBot, queryStr, nowIso } from './deps.ts'
import type { Deps, RegisterFn } from './deps.ts'

/** ⑨ newest-N 硬保护条数（与 memory 包同口径）。 */
const HARD_PROTECT_COUNT = 5

function savePhotoFile(d: Deps, filename: string, data: Buffer): string {
  const safeBase = basename(filename).replace(/[^\w.-]/g, '_') || 'photo'
  const ext = extname(safeBase) || '.png'
  const name = `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`
  const dir = join(d.cwd, 'public', 'downloads', 'photos')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), data)
  return `/api/photos/file/photos/${name}`
}

function memoryRow(d: Deps, id: string): MemoryRow | undefined {
  return d.storage.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined
}

/**
 * 联系人解析：优先 (botId, sender)；botId 缺省时（前端单 id 调用）按 sender /
 * 行 id 全局找最近更新的一条。
 */
function findContact(d: Deps, botId: string, idOrSender: string): ContactRow | undefined {
  if (idOrSender === '') return undefined
  if (botId !== '') return d.persona.loadContact(botId, idOrSender) ?? undefined
  const bySender = d.storage.prepare(
    'SELECT * FROM contacts WHERE sender = ? ORDER BY updated_at DESC LIMIT 1',
  ).get(idOrSender) as ContactRow | undefined
  if (bySender !== undefined) return bySender
  return d.storage.prepare('SELECT * FROM contacts WHERE id = ? LIMIT 1').get(idOrSender) as ContactRow | undefined
}

export const registerDataRoutes: RegisterFn = (r, d) => {
  // ---- 联系人 ----

  r.get('/api/contacts', 'required', (ctx) => {
    const botId = queryStr(ctx, 'botId') ?? ''
    const rows = d.persona.loadContacts(botId)
    json(ctx.res, 200, { data: { contacts: rows.map(contactView) } })
  })

  r.get('/api/contacts/:id', 'required', (ctx) => {
    // :id 为 sender 标识（前端 Contact.id = sender）；botId 可缺省
    const row = findContact(d, queryStr(ctx, 'botId') ?? '', ctx.params['id'] ?? '')
    if (row === undefined) {
      err(ctx.res, 404, 'not_found', '联系人不存在')
      return
    }
    json(ctx.res, 200, { data: { contact: contactView(row) } })
  })

  r.patch('/api/contacts/:id', 'required', (ctx) => {
    const row = findContact(d, queryStr(ctx, 'botId') ?? '', ctx.params['id'] ?? '')
    if (row === undefined) {
      err(ctx.res, 404, 'not_found', '联系人不存在')
      return
    }
    const body = bodyRecord(ctx.body)
    const columns: string[] = []
    const values: unknown[] = []
    const put = (column: string, value: unknown): void => {
      columns.push(column)
      values.push(value)
    }
    const name = reqStr(body, 'name', 'nickname', 'displayName')
    if (name !== undefined) put('name', name)
    const brief = reqStr(body, 'brief')
    if (brief !== undefined) put('brief', brief)
    const profile = reqStr(body, 'profile')
    if (profile !== undefined) {
      put('profile', profile)
    } else if (typeof body['profile'] === 'object' && body['profile'] !== null) {
      put('profile', JSON.stringify(body['profile']))
    }
    const blocked = reqBool(body, 'blocked', 'isBlocked')
    if (blocked !== undefined) put('blocked', blocked ? 1 : 0)
    const isOwner = reqBool(body, 'isOwner', 'owner')
    if (isOwner !== undefined && isAdmin(ctx)) {
      if (isOwner) d.storage.prepare('UPDATE contacts SET is_owner = 0 WHERE bot_id = ?').run(row.bot_id)
      put('is_owner', isOwner ? 1 : 0)
    }
    if (columns.length > 0) {
      columns.push('updated_at')
      values.push(nowIso())
      d.storage.prepare(`UPDATE contacts SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...values, row.id)
    }
    const updated = d.persona.loadContact(row.bot_id, row.sender)
    json(ctx.res, 200, { data: { contact: updated === null ? contactView(row) : contactView(updated) } })
  })

  r.del('/api/contacts/:id', 'required', (ctx) => {
    const row = findContact(d, queryStr(ctx, 'botId') ?? '', ctx.params['id'] ?? '')
    if (row === undefined) {
      err(ctx.res, 404, 'not_found', '联系人不存在')
      return
    }
    d.storage.prepare('DELETE FROM contacts WHERE id = ?').run(row.id)
    json(ctx.res, 200, { data: { contact: contactView(row) } })
  })

  // ---- 关系 ----

  r.get('/api/relations', 'required', (ctx) => {
    const botId = queryStr(ctx, 'botId') ?? ''
    const rows = d.persona.loadRelations(botId) as ContactRelationRow[]
    const nameBySender = new Map<string, string>()
    for (const c of d.persona.loadContacts(botId)) nameBySender.set(c.sender, c.name || c.sender)
    json(ctx.res, 200, { data: { relations: rows.map((row) => relationView(row, nameBySender)) } })
  })

  r.post('/api/relations', 'required', (ctx) => {
    const body = bodyRecord(ctx.body)
    const botId = reqStr(body, 'botId') ?? queryStr(ctx, 'botId') ?? ''
    const fromSender = reqStr(body, 'fromSender', 'fromContactId', 'from') ?? ''
    const toSender = reqStr(body, 'toSender', 'toContactId', 'to') ?? ''
    const relation = reqStr(body, 'relation', 'type') ?? ''
    if (fromSender === '' || toSender === '' || relation === '') {
      err(ctx.res, 400, 'bad_request', 'fromSender、toSender、relation 不能为空')
      return
    }
    const existing = d.storage.prepare(
      'SELECT id FROM contact_relations WHERE bot_id = ? AND from_sender = ? AND to_sender = ?',
    ).get(botId, fromSender, toSender) as { id: string } | undefined
    const note = reqStr(body, 'note', 'description') ?? ''
    if (existing !== undefined) {
      d.storage.prepare('UPDATE contact_relations SET relation = ?, note = ? WHERE id = ?').run(relation, note, existing.id)
    } else {
      d.storage.prepare(
        'INSERT INTO contact_relations (id, bot_id, from_sender, to_sender, relation, note, created_at) VALUES (?,?,?,?,?,?,?)',
      ).run(randomUUID(), botId, fromSender, toSender, relation, note, nowIso())
    }
    const rows = d.storage.prepare(
      'SELECT * FROM contact_relations WHERE bot_id = ? AND from_sender = ? AND to_sender = ?',
    ).all(botId, fromSender, toSender) as unknown as ContactRelationRow[]
    const nameBySender = new Map<string, string>()
    for (const c of d.persona.loadContacts(botId)) nameBySender.set(c.sender, c.name || c.sender)
    const view = rows[0] !== undefined ? relationView(rows[0], nameBySender) : {}
    json(ctx.res, 200, { data: { relation: view } })
  })

  // ---- 记忆 ----

  r.get('/api/memories', 'required', (ctx) => {
    const botId = queryStr(ctx, 'botId') ?? ''
    const includeDeleted = ctx.query.get('includeDeleted') === 'true'
    const requested = queryStr(ctx, 'sender')
    const sender = isAdmin(ctx) ? requested : ownSender(ctx)
    const rows = (
      sender !== undefined
        ? d.storage.prepare(
          `SELECT * FROM memories WHERE bot_id = ? AND sender = ?${includeDeleted ? '' : ' AND deleted_at IS NULL'} ORDER BY recorded_at DESC LIMIT 500`,
        ).all(botId, sender)
        : d.storage.prepare(
          `SELECT * FROM memories WHERE bot_id = ?${includeDeleted ? '' : ' AND deleted_at IS NULL'} ORDER BY recorded_at DESC LIMIT 500`,
        ).all(botId)
    ) as unknown as MemoryRow[]
    // ⑨ newest-N 硬保护：列表里也标出来（与召回结果同一口径）
    const newest = [...rows].sort((a, b) => (b.recorded_at || b.created_at).localeCompare(a.recorded_at || a.created_at))
    const protectedIds = new Set(newest.slice(0, HARD_PROTECT_COUNT).map((r) => r.id))
    json(ctx.res, 200, { data: { memories: rows.map((r) => memoryView(r, protectedIds)) } })
  })

  r.post('/api/memories', 'required', async (ctx) => {
    const body = bodyRecord(ctx.body)
    const botId = reqStr(body, 'botId') ?? ''
    const bot = loadBot(d, botId)
    if (bot === null) {
      err(ctx.res, 400, 'bad_request', '机器人不存在')
      return
    }
    const sender = resolveSender(ctx, reqStr(body, 'sender', 'contactId'))
    const content = reqStr(body, 'content', 'text', 'event') ?? ''
    if (content.trim() === '') {
      err(ctx.res, 400, 'bad_request', '记忆内容不能为空')
      return
    }
    const item: { category?: string; content: string; importance?: number; expiresAt?: string | null; provenance?: string } = { content }
    const category = reqStr(body, 'category', 'type')
    if (category !== undefined) item.category = category
    const importance = reqNum(body, 'importance')
    if (importance !== undefined) item.importance = Math.min(5, Math.max(1, Math.round(importance)))
    const provenance = reqStr(body, 'provenance', 'source')
    if (provenance !== undefined) item.provenance = provenance
    const expiresAt = reqStr(body, 'validUntil', 'expiresAt')
    if (expiresAt !== undefined) item.expiresAt = expiresAt
    try {
      const result = await d.memory.remember(botId, sender, item)
      const row = memoryRow(d, result.id)
      json(ctx.res, 200, { data: { memory: row === undefined ? { id: result.id, dupSkipped: result.dupSkipped } : memoryView(row), dupSkipped: result.dupSkipped } })
    } catch (error) {
      err(ctx.res, 500, 'internal', `记忆写入失败：${error instanceof Error ? error.message : String(error)}`)
    }
  })

  r.patch('/api/memories/:id', 'required', (ctx) => {
    const row = memoryRow(d, ctx.params['id'] ?? '')
    if (row === undefined) {
      err(ctx.res, 404, 'not_found', '记忆不存在')
      return
    }
    if (!senderAllowed(ctx, row.sender)) {
      err(ctx.res, 403, 'forbidden', '只能修改自己会话的记忆')
      return
    }
    const body = bodyRecord(ctx.body)
    const columns: string[] = []
    const values: unknown[] = []
    const put = (column: string, value: unknown): void => {
      columns.push(column)
      values.push(value)
    }
    const content = reqStr(body, 'content', 'text')
    if (content !== undefined && content.trim() !== '') put('content', content)
    const importance = reqNum(body, 'importance')
    if (importance !== undefined) put('importance', Math.min(5, Math.max(1, Math.round(importance))))
    const category = reqStr(body, 'category', 'type')
    if (category !== undefined && ['profile', 'relationship', 'fact', 'detail', 'value', 'thought'].includes(category)) put('category', category)
    if (Array.isArray(body['tags'])) put('tags', JSON.stringify((body['tags'] as unknown[]).map((t) => String(t))))
    const validUntil = reqStr(body, 'validUntil')
    if (validUntil !== undefined) put('valid_until', validUntil === '' ? null : validUntil)
    if (columns.length > 0) {
      d.storage.prepare(`UPDATE memories SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...values, row.id)
    }
    const updated = memoryRow(d, row.id)
    json(ctx.res, 200, { data: { memory: updated === undefined ? memoryView(row) : memoryView(updated) } })
  })

  // 软删除（淡忘池）
  r.del('/api/memories/:id', 'required', (ctx) => {
    const row = memoryRow(d, ctx.params['id'] ?? '')
    if (row === undefined) {
      err(ctx.res, 404, 'not_found', '记忆不存在')
      return
    }
    if (!senderAllowed(ctx, row.sender)) {
      err(ctx.res, 403, 'forbidden', '只能整理自己会话的记忆')
      return
    }
    const now = nowIso()
    d.storage.prepare("UPDATE memories SET deleted_at = ?, deleted_reason = ? WHERE id = ? AND deleted_at IS NULL").run(now, '控制台手动淡忘', row.id)
    const updated = memoryRow(d, row.id)
    json(ctx.res, 200, { data: { memory: updated === undefined ? memoryView(row) : memoryView(updated) } })
  })

  // §记忆检查器 —— explain 台账：这条记忆从哪来、什么时候、被谁取代、为什么被召回
  r.get('/api/memories/:id/explain', 'required', (ctx) => {
    const id = ctx.params['id'] ?? ''
    const botId = queryStr(ctx, 'botId') ?? ''
    if (id === '' || botId === '') {
      err(ctx.res, 400, 'bad_request', '缺少记忆 id 或 botId')
      return
    }
    const explain = d.memory.explain(botId, id)
    if (explain === null) {
      err(ctx.res, 404, 'not_found', '记忆不存在')
      return
    }
    json(ctx.res, 200, { data: explain })
  })

  r.post('/api/memories/:id/restore', 'required', (ctx) => {
    const row = memoryRow(d, ctx.params['id'] ?? '')
    if (row === undefined) {
      err(ctx.res, 404, 'not_found', '记忆不存在')
      return
    }
    if (!senderAllowed(ctx, row.sender)) {
      err(ctx.res, 403, 'forbidden', '只能恢复自己会话的记忆')
      return
    }
    const status = d.memory.restoreMemory(row.id, row.bot_id)
    if (status === 'not_found') {
      err(ctx.res, 404, 'not_found', '记忆不存在')
      return
    }
    const updated = memoryRow(d, row.id)
    json(ctx.res, 200, { data: { memory: updated === undefined ? memoryView(row) : memoryView(updated), status } })
  })

  r.post('/api/memories/consolidate', 'required', async (ctx) => {
    const body = bodyRecord(ctx.body)
    const botId = reqStr(body, 'botId') ?? ''
    const bot = loadBot(d, botId)
    if (bot === null) {
      err(ctx.res, 400, 'bad_request', '机器人不存在')
      return
    }
    const sender = resolveSender(ctx, reqStr(body, 'sender', 'contactId'))
    const dryRun = reqBool(body, 'dryRun') === true
    if (dryRun) {
      // 预览：只统计规模，不调用模型
      const active = d.storage.prepare(
        'SELECT COUNT(*) AS c FROM memories WHERE bot_id = ? AND sender = ? AND deleted_at IS NULL AND consolidated = 0',
      ).get(botId, sender) as { c: number }
      json(ctx.res, 200, {
        data: {
          dryRun: true,
          pending: active.c,
          note: active.c < 10 ? `当前活跃记忆 ${String(active.c)} 条，少于 10 条，暂不需要整理。` : `预览模式：活跃记忆 ${String(active.c)} 条，确认后将由 AI 整理（最近 5 条受硬保护）。`,
        },
      })
      return
    }
    const result = await d.memory.runConsolidation(botId, sender)
    json(ctx.res, 200, { data: { dryRun: false, ...result } })
  })

  // ---- 日记 ----

  r.get('/api/diaries', 'required', (ctx) => {
    const botId = queryStr(ctx, 'botId') ?? ''
    const rows = d.storage.prepare('SELECT * FROM diaries WHERE bot_id = ? ORDER BY date DESC LIMIT 200').all(botId) as unknown as DiaryRow[]
    json(ctx.res, 200, { data: { diaries: rows.map(diaryView) } })
  })

  r.get('/api/diaries/:id', 'required', (ctx) => {
    const row = d.storage.prepare('SELECT * FROM diaries WHERE id = ?').get(ctx.params['id'] ?? '') as DiaryRow | undefined
    if (row === undefined) {
      err(ctx.res, 404, 'not_found', '日记不存在')
      return
    }
    json(ctx.res, 200, { data: { diary: diaryView(row) } })
  })

  r.del('/api/diaries/:id', 'required', (ctx) => {
    const row = d.storage.prepare('SELECT * FROM diaries WHERE id = ?').get(ctx.params['id'] ?? '') as DiaryRow | undefined
    if (row === undefined) {
      err(ctx.res, 404, 'not_found', '日记不存在')
      return
    }
    d.storage.prepare('DELETE FROM diaries WHERE id = ?').run(row.id)
    json(ctx.res, 200, { data: { diary: diaryView(row) } })
  })

  r.post('/api/diaries/write', 'required', async (ctx) => {
    const body = bodyRecord(ctx.body)
    const botId = reqStr(body, 'botId') ?? ''
    const bot = loadBot(d, botId)
    if (bot === null) {
      err(ctx.res, 400, 'bad_request', '机器人不存在')
      return
    }
    const date = nowIso().slice(0, 10)
    const existing = d.storage.prepare('SELECT * FROM diaries WHERE bot_id = ? AND date = ?').get(botId, date) as DiaryRow | undefined
    if (existing !== undefined) {
      json(ctx.res, 200, { data: { diary: diaryView(existing), alreadyWritten: true } })
      return
    }
    // 现场生成一篇今日日记（用角色语气；模型不可用时落一篇占位）
    const built = d.persona.buildPrompt({ botId, sender: '', channel: 'web', haystack: '', focusText: '写今天的日记' })
    let content = ''
    let mood = ''
    try {
      const res = await chatComplete(d.storage, [
        { role: 'system', content: `${built?.system ?? `你是「${bot.name}」。`}\n\n现在请以第一人称写一篇今天的日记：记录今天的心情与小事，300 字以内，只输出日记正文。` },
        { role: 'user', content: `今天是 ${date}。写一篇今天的日记。` },
      ], { temperature: 0.8, enableThinking: true, retries: 0 })
      content = res.content.trim()
      mood = '平静'
    } catch {
      content = `（${date}）今天没什么特别的事，安安静静地过了一天。`
    }
    if (content === '') content = `（${date}）今天有点无话可说。`
    const id = randomUUID()
    d.storage.prepare('INSERT INTO diaries (id, bot_id, date, content, mood, snapshot, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, botId, date, content, mood, '{}', nowIso(), nowIso())
    const row = d.storage.prepare('SELECT * FROM diaries WHERE id = ?').get(id) as DiaryRow | undefined
    if (row === undefined) {
      err(ctx.res, 500, 'internal', '日记写入失败')
      return
    }
    json(ctx.res, 200, { data: { diary: diaryView(row), alreadyWritten: false } })
  })

  // ---- 相册 ----

  r.get('/api/photos', 'required', (ctx) => {
    const botId = queryStr(ctx, 'botId') ?? ''
    const rows = d.storage.prepare('SELECT * FROM photos WHERE bot_id = ? ORDER BY created_at DESC LIMIT 500').all(botId) as unknown as PhotoRow[]
    json(ctx.res, 200, { data: { photos: rows.map(photoView) } })
  })

  r.post('/api/photos', 'required', (ctx) => {
    const botId = queryStr(ctx, 'botId') ?? ctx.fields['botId'] ?? ''
    const bot = loadBot(d, botId)
    if (bot === null) {
      err(ctx.res, 400, 'bad_request', '机器人不存在')
      return
    }
    const file = ctx.files.find((f) => f.field === 'file') ?? ctx.files[0]
    if (file === undefined || file.data.length === 0) {
      err(ctx.res, 400, 'bad_request', '缺少上传文件')
      return
    }
    const url = savePhotoFile(d, file.filename, file.data)
    const caption = ctx.fields['caption'] ?? ''
    const id = randomUUID()
    d.storage.prepare('INSERT INTO photos (id, bot_id, url, caption, tags, created_at) VALUES (?,?,?,?,?,?)')
      .run(id, botId, url, caption, '[]', nowIso())
    const row = d.storage.prepare('SELECT * FROM photos WHERE id = ?').get(id) as PhotoRow | undefined
    if (row === undefined) {
      err(ctx.res, 500, 'internal', '上传失败')
      return
    }
    json(ctx.res, 200, { data: { photo: photoView(row) } })
  })

  r.patch('/api/photos/:id', 'required', (ctx) => {
    const botId = queryStr(ctx, 'botId') ?? ''
    const row = d.storage.prepare('SELECT * FROM photos WHERE id = ? AND bot_id = ?').get(ctx.params['id'] ?? '', botId) as PhotoRow | undefined
    if (row === undefined) {
      err(ctx.res, 404, 'not_found', '照片不存在')
      return
    }
    const body = bodyRecord(ctx.body)
    const columns: string[] = []
    const values: unknown[] = []
    const caption = reqStr(body, 'caption', 'description')
    if (caption !== undefined) {
      columns.push('caption')
      values.push(caption)
    }
    if (typeof body['tags'] === 'string') {
      columns.push('tags')
      values.push(JSON.stringify(parseJsonArray(body['tags'])))
    } else if (Array.isArray(body['tags'])) {
      columns.push('tags')
      values.push(JSON.stringify((body['tags'] as unknown[]).map((t) => String(t))))
    }
    if (columns.length > 0) {
      d.storage.prepare(`UPDATE photos SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...values, row.id)
    }
    const updated = d.storage.prepare('SELECT * FROM photos WHERE id = ?').get(row.id) as PhotoRow | undefined
    json(ctx.res, 200, { data: { photo: updated === undefined ? photoView(row) : photoView(updated) } })
  })

  r.del('/api/photos/:id', 'required', (ctx) => {
    const botId = queryStr(ctx, 'botId') ?? ''
    const row = d.storage.prepare('SELECT * FROM photos WHERE id = ? AND bot_id = ?').get(ctx.params['id'] ?? '', botId) as PhotoRow | undefined
    if (row === undefined) {
      err(ctx.res, 404, 'not_found', '照片不存在')
      return
    }
    d.storage.prepare('DELETE FROM photos WHERE id = ?').run(row.id)
    json(ctx.res, 200, { data: { photo: photoView(row) } })
  })

  // ---- 定时消息 ----

  r.get('/api/scheduled-messages', 'required', (ctx) => {
    const botId = queryStr(ctx, 'botId') ?? ''
    const rows = d.storage.prepare('SELECT * FROM scheduled_messages WHERE bot_id = ? ORDER BY fire_at DESC LIMIT 500').all(botId) as unknown as ScheduledMessageRow[]
    json(ctx.res, 200, { data: { scheduledMessages: rows.map(scheduledView) } })
  })

  r.post('/api/scheduled-messages', 'required', (ctx) => {
    const body = bodyRecord(ctx.body)
    const botId = reqStr(body, 'botId') ?? ''
    const bot = loadBot(d, botId)
    if (bot === null) {
      err(ctx.res, 400, 'bad_request', '机器人不存在')
      return
    }
    const fireAtRaw = reqStr(body, 'fireAt', 'fire_at', 'scheduledAt') ?? ''
    const fireAt = new Date(fireAtRaw)
    if (fireAtRaw === '' || Number.isNaN(fireAt.getTime())) {
      err(ctx.res, 400, 'bad_request', 'fireAt 必须是合法时间')
      return
    }
    const prompt = reqStr(body, 'prompt', 'text', 'content') ?? ''
    const sender = resolveSender(ctx, reqStr(body, 'sender', 'contactId'))
    const id = randomUUID()
    d.storage.prepare(
      'INSERT INTO scheduled_messages (id, bot_id, sender, fire_at, tolerance, strictness, prompt, origin, status, channel, content, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      id, botId, sender, fireAt.toISOString(),
      reqNum(body, 'tolerance') ?? null,
      reqNum(body, 'strictness') ?? 3,
      prompt,
      reqStr(body, 'origin', 'source', 'createdBy') ?? 'console',
      'pending',
      reqStr(body, 'channel') ?? 'web',
      '', nowIso(),
    )
    const row = d.storage.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(id) as ScheduledMessageRow | undefined
    if (row === undefined) {
      err(ctx.res, 500, 'internal', '创建失败')
      return
    }
    json(ctx.res, 200, { data: { scheduledMessage: scheduledView(row) } })
  })

  r.patch('/api/scheduled-messages/:id', 'required', (ctx) => {
    const row = d.storage.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(ctx.params['id'] ?? '') as ScheduledMessageRow | undefined
    if (row === undefined) {
      err(ctx.res, 404, 'not_found', '定时消息不存在')
      return
    }
    if (!senderAllowed(ctx, row.sender)) {
      err(ctx.res, 403, 'forbidden', '只能修改自己会话的定时消息')
      return
    }
    const body = bodyRecord(ctx.body)
    const columns: string[] = []
    const values: unknown[] = []
    const fireAtRaw = reqStr(body, 'fireAt', 'fire_at')
    if (fireAtRaw !== undefined && fireAtRaw !== '') {
      const fireAt = new Date(fireAtRaw)
      if (!Number.isNaN(fireAt.getTime())) {
        columns.push('fire_at')
        values.push(fireAt.toISOString())
      }
    }
    const prompt = reqStr(body, 'prompt', 'text')
    if (prompt !== undefined) {
      columns.push('prompt')
      values.push(prompt)
    }
    const strictness = reqNum(body, 'strictness')
    if (strictness !== undefined) {
      columns.push('strictness')
      values.push(Math.min(3, Math.max(1, Math.round(strictness))))
    }
    const tolerance = reqNum(body, 'tolerance')
    if (tolerance !== undefined) {
      columns.push('tolerance')
      values.push(Math.round(tolerance))
    }
    const status = reqStr(body, 'status', 'state')
    if (status !== undefined && ['pending', 'cancelled'].includes(status)) {
      columns.push('status')
      values.push(status)
    }
    if (columns.length > 0) {
      d.storage.prepare(`UPDATE scheduled_messages SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...values, row.id)
    }
    const updated = d.storage.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(row.id) as ScheduledMessageRow | undefined
    json(ctx.res, 200, { data: { scheduledMessage: updated === undefined ? scheduledView(row) : scheduledView(updated) } })
  })

  r.del('/api/scheduled-messages/:id', 'required', (ctx) => {
    const row = d.storage.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(ctx.params['id'] ?? '') as ScheduledMessageRow | undefined
    if (row === undefined) {
      err(ctx.res, 404, 'not_found', '定时消息不存在')
      return
    }
    if (!senderAllowed(ctx, row.sender)) {
      err(ctx.res, 403, 'forbidden', '只能取消自己会话的定时消息')
      return
    }
    d.storage.prepare("UPDATE scheduled_messages SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(row.id)
    const updated = d.storage.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(row.id) as ScheduledMessageRow | undefined
    json(ctx.res, 200, { data: { scheduledMessage: updated === undefined ? scheduledView(row) : scheduledView(updated) } })
  })
}
