/**
 * 聊天端点：直接对话 / 缓冲窗口 / 重生成 / 编辑 / 消息读写 / 会话列表 / SSE 流。
 * 鉴权修复（旧 §18.1 #2/#3/#4）：消息与会话按登录用户裁剪 sender，
 * 消息写操作一律要求登录；管理员保留任意 sender 的 power-user 能力。
 */
import type { MessageRow } from '@littly/storage'
import { json, err, bodyRecord, reqStr, reqNum, fire, type ApiRequest } from './http.ts'
import { messageView, parseJsonObject } from './mapping.ts'
import { ensureSeed } from './seed.ts'
import { isAdmin, resolveSender, senderAllowed, ownSender, queryStr, nowIso, loadBot, botOwnedBy, requireRowBotAccess } from './deps.ts'
import { listPendingCalls, consumePendingCall, signCallToken, CALL_TOKEN_TTL_MS } from '@littly/voice-call'
import { ensureSecret } from './auth.ts'
import { handleWechatWebhook } from '@littly/channel-wechat-ilink'
import type { Deps, RegisterFn } from './deps.ts'

function messageRowById(d: Deps, id: string): MessageRow | undefined {
  return d.storage.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined
}

/** 最近 limit 条可见消息（升序返回；软删行剔除）。 */
function visibleRows(d: Deps, botId: string, sender: string | null, limit: number): MessageRow[] {
  const safeLimit = Math.min(2000, Math.max(1, limit))
  const rows = (
    sender !== null
      ? d.storage.prepare(
        'SELECT * FROM messages WHERE bot_id = ? AND sender = ? ORDER BY created_at DESC, id DESC LIMIT ?',
      ).all(botId, sender, safeLimit)
      : d.storage.prepare(
        'SELECT * FROM messages WHERE bot_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
      ).all(botId, safeLimit)
  ) as unknown as MessageRow[]
  return rows.filter((m) => parseJsonObject(m.meta)['deleted'] !== true).reverse()
}

/** 取该会话给定时刻起的落库消息（chat 响应用）。 */
function rowsSince(d: Deps, botId: string, sender: string, sinceIso: string): MessageRow[] {
  return d.storage.prepare(
    'SELECT * FROM messages WHERE bot_id = ? AND sender = ? AND created_at >= ? ORDER BY created_at ASC, id ASC',
  ).all(botId, sender, sinceIso) as unknown as MessageRow[]
}

/** 软删除：meta.deleted 标记（messages 表无 deleted_at 列，保留可恢复语义）。 */
function softDeleteRow(d: Deps, row: MessageRow): void {
  const meta = parseJsonObject(row.meta)
  meta['deleted'] = true
  meta['deletedAt'] = nowIso()
  d.storage.prepare('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(meta), row.id)
}

/** 运行一轮并把结果映射为前端消息数组。 */
async function runAndRespond(d: Deps, ctx: ApiRequest, botId: string, sender: string, text: string, channelId: string): Promise<void> {
  const since = nowIso()
  const response = await d.hub.runTurn({ botId, sender, text, channelId })
  const rows = rowsSince(d, botId, sender, since)
  json(ctx.res, 200, {
    data: {
      messages: rows.map(messageView),
      reply: response.reply,
      toolCalls: response.toolCalls,
      thinkingLength: response.thinkingLength,
      silent: response.reply === '' && rows.length === 0,
    },
  })
}

export const registerChatRoutes: RegisterFn = (r, d) => {
  // B3：内容域归属守卫 —— 带 botId 的请求要求 admin 或该 bot 的 owner。
  r.botGuard = (ctx, botId) => botOwnedBy(ctx, d, botId)
  // ---- 直接对话 ----

  r.post('/api/chat', 'required', async (ctx) => {
    const body = bodyRecord(ctx.body)
    // 首启播种（照旧仓 ensureSeed）：空库时先给一个可用的 bot，
    // 免得新装好的人第一句话就撞「机器人不存在」。
    const seed = ensureSeed(d)
    const requestedBotId = reqStr(body, 'botId') ?? ''
    const botId = requestedBotId === '' ? (seed.botId ?? '') : requestedBotId
    const text = reqStr(body, 'text', 'content', 'message') ?? ''
    const requested = reqStr(body, 'sender', 'senderId')
    const bot = d.persona.loadBot(botId)
    if (bot === null) {
      err(ctx.res, 400, 'bad_request', '机器人不存在')
      return
    }
    if (text.trim() === '') {
      err(ctx.res, 400, 'bad_request', '消息内容不能为空')
      return
    }
    const sender = resolveSender(ctx, requested)
    if (!senderAllowed(ctx, sender)) {
      err(ctx.res, 403, 'forbidden', '只能操作自己的会话')
      return
    }
    await runAndRespond(d, ctx, botId, sender, text, 'web')
  })

  // ---- 缓冲窗口 ----

  r.post('/api/chat/buffer', 'required', (ctx) => {
    const body = bodyRecord(ctx.body)
    const seed = ensureSeed(d)
    const requestedBotId = reqStr(body, 'botId') ?? ''
    const botId = requestedBotId === '' ? (seed.botId ?? '') : requestedBotId
    const text = reqStr(body, 'text', 'content') ?? ''
    const requested = reqStr(body, 'sender', 'senderId')
    const bot = d.persona.loadBot(botId)
    if (bot === null) {
      err(ctx.res, 400, 'bad_request', '机器人不存在')
      return
    }
    if (text.trim() === '') {
      err(ctx.res, 400, 'bad_request', '消息内容不能为空')
      return
    }
    const sender = resolveSender(ctx, requested)
    const result = d.hub.enqueueBufferedMessage({ botId, sender, text, channelId: 'web' })
    const status = d.hub.bufferStatus(botId, sender)
    json(ctx.res, 200, { data: { fireAt: result.fireAt, buffered: status.buffered, count: status.count, messageId: result.messageId } })
  })

  r.get('/api/chat/buffer', 'required', (ctx) => {
    const seed = ensureSeed(d)
    const requestedBotId = queryStr(ctx, 'botId') ?? ''
    const botId = requestedBotId === '' ? (seed.botId ?? '') : requestedBotId
    const requested = queryStr(ctx, 'sender')
    if (botId === '') {
      err(ctx.res, 400, 'bad_request', '缺少 botId 参数')
      return
    }
    if (requested === undefined && !isAdmin(ctx)) {
      err(ctx.res, 400, 'bad_request', '缺少 sender 参数')
      return
    }
    const sender = resolveSender(ctx, requested)
    const status = d.hub.bufferStatus(botId, sender)
    json(ctx.res, 200, { data: { fireAt: status.fireAt, buffered: status.buffered, count: status.count } })
  })

  r.post('/api/chat/buffer/flush', 'required', async (ctx) => {
    const body = bodyRecord(ctx.body)
    const seed = ensureSeed(d)
    const requestedBotId = reqStr(body, 'botId') ?? ''
    const botId = requestedBotId === '' ? (seed.botId ?? '') : requestedBotId
    const requested = reqStr(body, 'sender', 'senderId')
    const bot = d.persona.loadBot(botId)
    if (bot === null) {
      err(ctx.res, 400, 'bad_request', '机器人不存在')
      return
    }
    const sender = resolveSender(ctx, requested)
    const waitMs = reqNum(body, 'waitMs') ?? 90000
    const since = nowIso()
    const result = await d.hub.flushBuffered(botId, sender, { waitMs: Math.min(120000, Math.max(0, waitMs)) })
    const rows = result.flushed ? rowsSince(d, botId, sender, since) : []
    json(ctx.res, 200, {
      data: {
        flushed: result.flushed,
        messages: rows.map(messageView),
        reply: result.response?.reply ?? '',
      },
    })
  })

  // ---- 重生成 / 编辑 ----

  r.post('/api/chat/regenerate', 'required', async (ctx) => {
    const body = bodyRecord(ctx.body)
    const botId = reqStr(body, 'botId') ?? ''
    const sender = resolveSender(ctx, reqStr(body, 'sender', 'senderId'))
    const bot = d.persona.loadBot(botId)
    if (bot === null) {
      err(ctx.res, 400, 'bad_request', '机器人不存在')
      return
    }
    const rows = d.storage.prepare(
      'SELECT * FROM messages WHERE bot_id = ? AND sender = ? ORDER BY created_at DESC, id DESC LIMIT 50',
    ).all(botId, sender) as unknown as MessageRow[]
    const lastUser = rows.find((m) => m.role === 'user')
    if (lastUser === undefined) {
      err(ctx.res, 400, 'bad_request', '没有可重生的用户消息')
      return
    }
    // 从最后一条用户消息（含）起物理删除，再以原文重跑（runTurn 会重新落库用户消息）
    const cutoff = new Date(lastUser.created_at).getTime()
    for (const m of rows) {
      if (new Date(m.created_at).getTime() >= cutoff) {
        d.storage.prepare('DELETE FROM messages WHERE id = ?').run(m.id)
      }
    }
    await runAndRespond(d, ctx, botId, sender, lastUser.content, lastUser.channel_id || 'web')
  })

  r.post('/api/chat/edit', 'required', async (ctx) => {
    const body = bodyRecord(ctx.body)
    const botId = reqStr(body, 'botId') ?? ''
    const messageId = reqStr(body, 'messageId') ?? ''
    const text = reqStr(body, 'text', 'content') ?? ''
    const requested = reqStr(body, 'sender', 'senderId')
    const bot = d.persona.loadBot(botId)
    if (bot === null) {
      err(ctx.res, 400, 'bad_request', '机器人不存在')
      return
    }
    if (text.trim() === '') {
      err(ctx.res, 400, 'bad_request', '消息内容不能为空')
      return
    }
    const target = messageRowById(d, messageId)
    if (target === undefined || target.bot_id !== botId) {
      err(ctx.res, 404, 'not_found', '消息不存在')
      return
    }
    if (!senderAllowed(ctx, target.sender) || (requested !== undefined && requested !== '' && !senderAllowed(ctx, requested))) {
      err(ctx.res, 403, 'forbidden', '只能编辑自己的会话')
      return
    }
    // 删除从该条消息（含）起的所有后续消息，再以新文本重跑
    const cutoff = new Date(target.created_at).getTime()
    const conversation = d.storage.prepare(
      'SELECT * FROM messages WHERE bot_id = ? AND sender = ? ORDER BY created_at ASC, id ASC',
    ).all(botId, target.sender) as unknown as MessageRow[]
    for (const m of conversation) {
      if (new Date(m.created_at).getTime() >= cutoff) {
        d.storage.prepare('DELETE FROM messages WHERE id = ?').run(m.id)
      }
    }
    await runAndRespond(d, ctx, botId, target.sender, text, target.channel_id || 'web')
  })

  // ---- 消息 ----

  r.get('/api/messages', 'required', (ctx) => {
    const botId = queryStr(ctx, 'botId')
    if (botId === undefined) {
      err(ctx.res, 400, 'bad_request', '缺少 botId 参数')
      return
    }
    const limitRaw = ctx.query.get('limit')
    const limit = limitRaw !== null && limitRaw !== '' && Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 200
    const requested = queryStr(ctx, 'sender')
    // 管理员不传 sender → 全部会话；普通用户恒定裁剪到自己的 sender
    const scoped = isAdmin(ctx) ? (requested === undefined ? null : resolveSender(ctx, requested)) : ownSender(ctx)
    json(ctx.res, 200, { data: { messages: visibleRows(d, botId, scoped, limit).map(messageView) } })
  })

  r.del('/api/messages/:id', 'required', (ctx) => {
    const row = messageRowById(d, ctx.params['id'] ?? '')
    if (row === undefined) {
      err(ctx.res, 404, 'not_found', '消息不存在')
      return
    }
    if (!requireRowBotAccess(ctx, d, row.bot_id)) return
    if (!senderAllowed(ctx, row.sender)) {
      err(ctx.res, 403, 'forbidden', '只能删除自己会话中的消息')
      return
    }
    softDeleteRow(d, row)
    json(ctx.res, 200, { data: { message: messageView(row) } })
  })

  r.post('/api/messages/:id/restore', 'required', (ctx) => {
    const row = messageRowById(d, ctx.params['id'] ?? '')
    if (row === undefined) {
      err(ctx.res, 404, 'not_found', '消息不存在')
      return
    }
    if (!requireRowBotAccess(ctx, d, row.bot_id)) return
    if (!senderAllowed(ctx, row.sender)) {
      err(ctx.res, 403, 'forbidden', '只能恢复自己会话中的消息')
      return
    }
    const meta = parseJsonObject(row.meta)
    delete meta['deleted']
    delete meta['deletedAt']
    d.storage.prepare('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(meta), row.id)
    const updated = messageRowById(d, row.id)
    json(ctx.res, 200, { data: { message: updated === undefined ? messageView(row) : messageView(updated) } })
  })

  // ---- 会话列表 ----

  r.get('/api/conversations', 'required', (ctx) => {
    const botId = queryStr(ctx, 'botId')
    if (botId === undefined) {
      err(ctx.res, 400, 'bad_request', '缺少 botId 参数')
      return
    }
    const scoped = isAdmin(ctx) ? null : ownSender(ctx)
    const recent = d.storage.prepare(
      'SELECT * FROM messages WHERE bot_id = ? ORDER BY created_at DESC, id DESC LIMIT 500',
    ).all(botId) as unknown as MessageRow[]
    const contacts = d.persona.loadContacts(botId)
    const nameBySender = new Map<string, string>()
    for (const c of contacts) nameBySender.set(c.sender, c.name || c.sender)
    const grouped = new Map<string, MessageRow[]>()
    for (const m of recent) {
      if (parseJsonObject(m.meta)['deleted'] === true) continue
      if (scoped !== null && m.sender !== scoped) continue
      const list = grouped.get(m.sender)
      if (list === undefined) grouped.set(m.sender, [m])
      else if (list[0] !== undefined) list.unshift(m)
    }
    const conversations: Array<Record<string, unknown>> = []
    for (const [sender, rows] of grouped) {
      const last = rows[rows.length - 1]
      if (last === undefined) continue
      conversations.push({
        sender,
        name: nameBySender.get(sender) ?? sender,
        isOwner: contacts.some((c) => c.sender === sender && c.is_owner === 1),
        messageCount: rows.length,
        lastMessage: messageView(last),
        lastAt: last.created_at,
      })
    }
    conversations.sort((a, b) => String(b['lastAt'] ?? '').localeCompare(String(a['lastAt'] ?? '')))
    json(ctx.res, 200, { data: { conversations } })
  })

  // ---- 微信桥接 Webhook（HMAC 验签 / challenge / reply_async / 幂等）----

  r.post('/api/wechat/inbound', 'public', (ctx) => {
    fire(ctx, (async (): Promise<void> => {
      const rawBody = ctx.rawBody ?? (typeof ctx.body === 'string' ? ctx.body : JSON.stringify(ctx.body ?? {}))
      const timestamp = ctx.req.headers['x-timestamp']
      const signature = ctx.req.headers['x-signature']
      const result = await handleWechatWebhook(
        rawBody,
        { timestamp: typeof timestamp === 'string' ? timestamp : null, signature: typeof signature === 'string' ? signature : null },
        { storage: d.storage, hub: d.hub, log: d.log },
      )
      json(ctx.res, result.status, result.body)
    })())
  })

  // ---- 来电请求（AI 主动来电：控制台轮询取件）----

  r.get('/api/call/requests', 'required', (ctx) => {
    const botId = queryStr(ctx, 'botId') ?? ''
    if (botId === '') {
      err(ctx.res, 400, 'bad_request', '缺少 botId')
      return
    }
    // §B3 内容域越权修复：普通用户只看得见自己作为接听方的来电，admin 可看全部。
    const calls = listPendingCalls(botId).filter((c) => isAdmin(ctx) || c.sender === ownSender(ctx))
    json(ctx.res, 200, { data: { calls: calls.map((c) => ({ id: c.id, botId: c.botId, sender: c.sender, reason: c.reason, topic: c.topic, createdAt: c.createdAt })) } })
  })

  /**
   * B2：签发 `/call` WebSocket 短时令牌。
   * 浏览器先（带 httpOnly 会话 cookie）调本端点拿 token，再用
   * `wss://host/call?token=<token>` 连接；WS 服务端只令牌里的 botId/sender 为准。
   * 普通用户只能以自己的 sender 拨号；admin 可为他人签发（与 resolveSender 语义一致）。
   */
  r.post('/api/call/token', 'required', (ctx) => {
    const body = bodyRecord(ctx.body)
    const botId = reqStr(body, 'botId') ?? ''
    const sender = resolveSender(ctx, reqStr(body, 'sender'))
    if (botId === '' || sender === '') {
      err(ctx.res, 400, 'bad_request', '缺少 botId/sender')
      return
    }
    if (loadBot(d, botId) === null) {
      err(ctx.res, 400, 'bad_request', '机器人不存在')
      return
    }
    const token = signCallToken(ensureSecret(d.storage), { botId, sender, userId: ownSender(ctx) })
    json(ctx.res, 200, { data: { token, expiresInMs: CALL_TOKEN_TTL_MS } })
  })

  r.post('/api/call/requests/:id/accept', 'required', (ctx) => {
    const call = consumePendingCall(ctx.params['id'] ?? '')
    if (!call) {
      err(ctx.res, 404, 'not_found', '来电请求不存在或已过期')
      return
    }
    // §B3：接到不属于自己的来电 → 403（来电列表已按 sender 裁剪，这里防直接猜 id）。
    if (!isAdmin(ctx) && call.sender !== ownSender(ctx)) {
      err(ctx.res, 403, 'forbidden', '无权接听他人的来电')
      return
    }
    json(ctx.res, 200, { data: { call } })
  })

  // ---- SSE 流 ----

  r.get('/api/stream', 'required', (ctx) => {
    const botId = queryStr(ctx, 'botId')
    if (botId === undefined) {
      err(ctx.res, 400, 'bad_request', '缺少 botId 参数')
      return
    }
    const sender = resolveSender(ctx, queryStr(ctx, 'sender'))
    const res = ctx.res
    const req = ctx.req
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write('retry: 3000\n\n')

    const sinceIso = nowIso()
    const sentIds = new Set<string>()
    let lastBufferKey = ''
    let closed = false
    const sendEvent = (event: string, data: unknown): void => {
      if (closed) return
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    const poll = (): void => {
      if (closed) return
      try {
        const fresh = d.storage.prepare(
          'SELECT * FROM messages WHERE bot_id = ? AND sender = ? AND created_at >= ? ORDER BY created_at ASC, id ASC',
        ).all(botId, sender, sinceIso) as unknown as MessageRow[]
        for (const row of fresh) {
          if (sentIds.has(row.id)) continue
          if (parseJsonObject(row.meta)['deleted'] === true) continue
          sentIds.add(row.id)
          sendEvent('message', messageView(row))
        }
        const status = d.hub.bufferStatus(botId, sender)
        const key = `${status.buffered ? '1' : '0'}:${status.fireAt ?? ''}:${String(status.count)}`
        if (key !== lastBufferKey) {
          lastBufferKey = key
          sendEvent('buffer', { buffered: status.buffered, fireAt: status.fireAt, count: status.count })
        }
      } catch {
        // 单次轮询失败不终止流
      }
    }

    const close = (): void => {
      if (closed) return
      closed = true
      clearInterval(pollTimer)
      clearInterval(heartbeatTimer)
      offEvent()
      res.end()
    }
    // 订阅 hub 的对话过程事件（工具阶段 / 思考态 / 沉默终止态）——真正推，不靠轮询
    const offEvent = d.hub.onEvent((ev) => {
      if (closed) return
      if (ev.botId !== botId || ev.sender !== sender) return
      if (ev.type === 'agent-status') {
        sendEvent('agent-status', { status: ev.status ?? '' })
        return
      }
      sendEvent('tool-call', {
        id: ev.id ?? ev.name ?? '',
        name: ev.name ?? '',
        status: ev.status ?? 'running',
      })
    })

    const pollTimer = setInterval(poll, 2000)
    const heartbeatTimer = setInterval(() => {
      if (closed) return
      res.write(': ping\n\n')
    }, 15000)
    req.on('close', close)
    req.on('error', close)
    res.on('close', close)
    poll()
  })
}
