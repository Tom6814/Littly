/**
 * 工具执行器 + 注册表（旧 builtin/executor.ts 的移植基线，渠道专属动作经
 * ChannelBridge 由渠道插件提供）。结果为 JSON 字符串回喂模型；产物单独返回。
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { downloadsDir, memeIdsForBot, type LittlyStorage, type MemoryRow, type PhotoRow } from '@littly/storage'
import { chatComplete, generateImage, webSearch } from '@littly/llm'
import type { LittlyMemory } from '@littly/memory'
import { ALL_TOOLS, type ToolDef } from './defs.ts'

export { extractTextToolCall, type TextToolCall, type TextToolParseResult } from './text-call.ts'
export { ALL_TOOLS, toolByName, type ToolDef } from './defs.ts'

export interface ToolExecCtx {
  botId: string
  sender: string
  botName: string
  channelId?: string | undefined
}

export interface ToolArtifact {
  type: 'image' | 'file'
  base64?: string
  url?: string
  filename?: string
  mimeType?: string
}

export interface ToolExecResult {
  name: string
  ok: boolean
  result: string
  artifact?: ToolArtifact | undefined
}

/** 渠道桥：渠道插件注册发送能力；未注册的渠道工具返回明确错误。 */
export interface ChannelBridge {
  sendText(channel: string, botId: string, sender: string, text: string): Promise<{ ok: boolean; sent?: number | undefined; error?: string | undefined }>
  sendPhoto(channel: string, botId: string, sender: string, photoUrl: string, caption?: string): Promise<{ ok: boolean; error?: string | undefined }>
  callAction(channel: string, botId: string, action: string, params: Record<string, unknown>): Promise<Record<string, unknown> | null>
  photoPublicUrl(url: string): string
  startCall(botId: string, sender: string, reason: string, topic?: string): Promise<{ ok: boolean }>
}

export interface LittlyToolRegistry {
  collectTools(): ToolDef[]
  dispatch(name: string, args: Record<string, unknown>, ctx: ToolExecCtx): Promise<ToolExecResult>
  registerChannelTool(def: ToolDef, exec: (args: Record<string, unknown>, ctx: ToolExecCtx) => Promise<{ result: string; artifact?: ToolArtifact }>): void
}

/** Asia/Shanghai 日期键 yyyy-mm-dd（日记按上海自然日）。 */
function shanghaiDateKey(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
  return parts
}

/** SQL LIKE 转义（用户输入里的 % / _ / \ 按字面量匹配）。 */
function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (match) => `\\${match}`)}%`
}

function parsePhotoTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) return parsed.map((tag) => String(tag)).filter((tag) => tag !== '')
  } catch {
    // 老数据可能是逗号分隔
  }
  return raw.split(/[,，]/).map((tag) => tag.trim()).filter((tag) => tag !== '')
}

/** 工具侧照片视图：只暴露模型选图/回忆需要的字段，meme 是选图凭证。 */
function photoToolView(row: PhotoRow, meme: string): Record<string, unknown> {
  return {
    id: row.id,
    meme,
    url: row.url,
    caption: row.caption,
    tags: parsePhotoTags(row.tags),
    sha256: row.sha256,
    mime: row.mime,
    category: row.category,
    semanticStatus: row.semantic_status,
    semanticAt: row.semantic_at,
    semanticError: row.semantic_error,
    createdAt: row.created_at,
  }
}

/** `meme:<hex>` / 裸 hex → 小写裸串；格式不合法直接返回空串。 */
function normalizeMeme(raw: string): string {
  const value = raw.trim().replace(/^meme:/i, '').trim().toLowerCase()
  return /^[0-9a-z-]{1,64}$/.test(value) ? value : ''
}

class Registry implements LittlyToolRegistry {
  private readonly extra = new Map<string, { def: ToolDef; exec: (args: Record<string, unknown>, ctx: ToolExecCtx) => Promise<{ result: string; artifact?: ToolArtifact }> }>()
  constructor(
    private readonly storage: LittlyStorage,
    private readonly memory: LittlyMemory,
    private readonly bridge: ChannelBridge,
    // B11 起文件路径统一由 @littly/storage 的 downloadsDir() 决定，cwd 参数保留以兼容装配签名。
    _cwd: string,
  ) {}

  collectTools(): ToolDef[] {
    const builtin = ALL_TOOLS.filter((t) => !['send_qq_face', 'set_qq_profile', 'set_qq_avatar', 'post_qzone'].includes(t.function.name))
    const extras: ToolDef[] = []
    for (const e of this.extra.values()) extras.push(e.def)
    return [...builtin, ...extras]
  }

  registerChannelTool(def: ToolDef, exec: (args: Record<string, unknown>, ctx: ToolExecCtx) => Promise<{ result: string; artifact?: ToolArtifact }>): void {
    this.extra.set(def.function.name, { def, exec })
  }

  private all<T>(sql: string, ...params: unknown[]): T[] {
    return this.storage.prepare(sql).all(...params) as T[]
  }

  private get<T>(sql: string, ...params: unknown[]): T | null {
    return (this.storage.prepare(sql).get(...params) as T | undefined) ?? null
  }

  private audit(ctx: ToolExecCtx, name: string, ok: boolean, detail: unknown): void {
    try {
      this.storage.prepare('INSERT INTO audit_logs (id, bot_id, category, action, detail, created_at) VALUES (?,?,?,?,?,?)').run(
        randomUUID(), ctx.botId, 'tool_call', name, JSON.stringify({ ok, detail: typeof detail === 'string' ? detail.slice(0, 300) : detail }), new Date().toISOString(),
      )
    } catch { /* ignore */ }
  }

  async dispatch(name: string, args: Record<string, unknown>, ctx: ToolExecCtx): Promise<ToolExecResult> {
    try {
      const r = await this.execute(name, args, ctx)
      this.audit(ctx, name, true, args)
      return { name, ok: true, result: JSON.stringify(r.result ?? r), ...(r.artifact ? { artifact: r.artifact } : {}) }
    } catch (err) {
      this.audit(ctx, name, false, String(err))
      return { name, ok: false, result: JSON.stringify({ error: String(err) }) }
    }
  }

  private async execute(name: string, args: Record<string, unknown>, ctx: ToolExecCtx): Promise<{ result: unknown; artifact?: ToolArtifact }> {
    const s = (k: string): string => String(args[k] ?? '')
    switch (name) {
      case 'remember': {
        const items = (args.items as Array<{
          category?: string
          content: string
          importance?: number
          expiresAt?: string
          idempotencyKey?: string
          ifSha256?: string
        }> | undefined) ?? []
        const out: Array<{ id: string; dupSkipped: boolean; idempotentReplay?: boolean; drift?: unknown }> = []
        for (const item of items) {
          // B14：expiresAt→valid_until、idempotencyKey/ifSha256 都在记忆层接线，
          // 这里把模型给的可选字段原样透传。
          const r = await this.memory.remember(ctx.botId, ctx.sender, item)
          out.push(r)
        }
        return {
          result: {
            remembered: out.filter((x) => !x.dupSkipped).length,
            dupSkipped: out.filter((x) => x.dupSkipped).length,
            idempotentReplay: out.filter((x) => x.idempotentReplay === true).length,
            drifted: out.filter((x) => x.drift !== undefined).length,
            ids: out.map((x) => x.id),
          },
        }
      }
      case 'schedule_message': {
        const fireAt = new Date(s('fireAt'))
        if (Number.isNaN(fireAt.getTime())) throw new Error('fireAt 非法')
        const id = randomUUID()
        this.storage.prepare(
          'INSERT INTO scheduled_messages (id, bot_id, sender, fire_at, tolerance, strictness, prompt, origin, status, channel, content, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        ).run(id, ctx.botId, ctx.sender, fireAt.toISOString(), args.tolerance as number | null, Number(args.strictness) || (args.origin === 'promise' ? 1 : 3), s('prompt'), s('origin') || 'proactive', 'pending', ctx.channelId ?? '', '', new Date().toISOString())
        return { result: { ok: true, id } }
      }
      case 'cancel_schedule': {
        const r = this.storage.prepare("UPDATE scheduled_messages SET status='cancelled' WHERE id = ? AND bot_id = ? AND status = 'pending'").run(s('id'), ctx.botId)
        return { result: { ok: r.changes > 0 } }
      }
      case 'lookup_contact': {
        const contact = s('sender')
          ? this.get<Record<string, unknown>>('SELECT * FROM contacts WHERE bot_id = ? AND sender = ?', ctx.botId, s('sender'))
          : this.get<Record<string, unknown>>('SELECT * FROM contacts WHERE bot_id = ? AND name = ?', ctx.botId, s('name'))
        if (!contact) return { result: { found: false } }
        const sender = String(contact.sender)
        const memories = this.all<MemoryRow>('SELECT * FROM memories WHERE bot_id = ? AND sender = ? AND deleted_at IS NULL ORDER BY importance DESC, created_at DESC LIMIT 50', ctx.botId, sender)
        const relations = this.all<Record<string, unknown>>('SELECT * FROM contact_relations WHERE bot_id = ? AND (from_sender = ? OR to_sender = ?)', ctx.botId, sender, sender)
        return { result: { contact, memories, relations } }
      }
      case 'upsert_contact': {
        const sender = s('sender')
        if (!sender) throw new Error('sender 必填')
        const existing = this.get<{ id: string }>('SELECT id FROM contacts WHERE bot_id = ? AND sender = ?', ctx.botId, sender)
        const now = new Date().toISOString()
        if (existing) {
          this.storage.prepare('UPDATE contacts SET name = COALESCE(NULLIF(?, \'\'), name), brief = COALESCE(NULLIF(?, \'\'), brief), profile = COALESCE(NULLIF(?, \'\'), profile), external_id = COALESCE(NULLIF(?, \'\'), external_id), updated_at = ? WHERE id = ?')
            .run(s('name'), s('brief'), s('profile'), s('externalId'), now, existing.id)
          return { result: { ok: true, updated: true } }
        }
        const id = randomUUID()
        this.storage.prepare('INSERT INTO contacts (id, bot_id, sender, name, brief, profile, external_id, channel, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(id, ctx.botId, sender, s('name') || sender, s('brief'), s('profile'), s('externalId'), ctx.channelId ?? 'web', now, now)
        return { result: { ok: true, created: true } }
      }
      case 'upsert_relation': {
        const existing = this.get<{ id: string }>('SELECT id FROM contact_relations WHERE bot_id = ? AND from_sender = ? AND to_sender = ?', ctx.botId, s('fromSender'), s('toSender'))
        if (existing) {
          this.storage.prepare('UPDATE contact_relations SET relation = ?, note = ? WHERE id = ?').run(s('relation'), s('note'), existing.id)
        } else {
          this.storage.prepare('INSERT INTO contact_relations (id, bot_id, from_sender, to_sender, relation, note, created_at) VALUES (?,?,?,?,?,?,?)')
            .run(randomUUID(), ctx.botId, s('fromSender'), s('toSender'), s('relation'), s('note'), new Date().toISOString())
        }
        return { result: { ok: true } }
      }
      case 'set_owner': {
        const sender = s('sender')
        if (!sender) throw new Error('sender 必填')
        const locked = this.get<{ sender: string }>('SELECT sender FROM contacts WHERE bot_id = ? AND is_owner = 1', ctx.botId)
        if (locked && locked.sender !== sender) throw new Error('already_locked')
        // 确保 contact 存在再认定
        this.storage.prepare("INSERT INTO contacts (id, bot_id, sender, name, is_owner, created_at, updated_at) SELECT ?, ?, ?, ?, 1, ?, ? WHERE NOT EXISTS (SELECT 1 FROM contacts WHERE bot_id = ? AND sender = ?)")
          .run(randomUUID(), ctx.botId, sender, sender, new Date().toISOString(), new Date().toISOString(), ctx.botId, sender)
        this.storage.prepare('UPDATE contacts SET is_owner = 1, updated_at = ? WHERE bot_id = ? AND sender = ?').run(new Date().toISOString(), ctx.botId, sender)
        return { result: { ok: true } }
      }
      case 'block_contact': {
        const r = this.storage.prepare('UPDATE contacts SET blocked = 1, metadata = json_set(COALESCE(metadata, \'{}\'), \'$.blockedReason\', ?), updated_at = ? WHERE bot_id = ? AND sender = ?')
          .run(s('reason'), new Date().toISOString(), ctx.botId, ctx.sender)
        if (r.changes === 0) throw new Error('contact not found')
        return { result: { ok: true } }
      }
      case 'web_search': {
        const results = await webSearch(this.storage, s('query'), Number(args.num) || 5)
        return { result: { ok: true, results } }
      }
      case 'write_doc': {
        const dir = join(downloadsDir(), 'docs')
        mkdirSync(dir, { recursive: true })
        const filename = s('filename').replace(/[^\w.-]/g, '_') || `${Date.now()}.md`
        writeFileSync(join(dir, filename), s('content'), 'utf8')
        return { result: { ok: true, filename, url: `/api/photos/file/docs/${filename}` }, artifact: { type: 'file', filename, url: `/api/photos/file/docs/${filename}`, mimeType: 'text/markdown' } }
      }
      case 'gen_image': {
        const img = await generateImage(this.storage, s('prompt'), { negativePrompt: s('negativePrompt'), size: s('size') })
        const dir = join(downloadsDir(), 'photos')
        mkdirSync(dir, { recursive: true })
        const filename = `${Date.now()}.png`
        let url: string
        if (img.base64) {
          writeFileSync(join(dir, filename), Buffer.from(img.base64, 'base64'))
          url = `/api/photos/file/photos/${filename}`
        } else {
          url = img.url ?? ''
        }
        // 收进相册
        this.storage.prepare('INSERT INTO photos (id, bot_id, url, caption, tags, created_at) VALUES (?,?,?,?,?,?)')
          .run(randomUUID(), ctx.botId, url, s('prompt').slice(0, 200), '[]', new Date().toISOString())
        return { result: { ok: true, url }, artifact: { type: 'image', url, mimeType: 'image/png' } }
      }
      case 'consolidate_memories': {
        // 与旧行为一致：忽略模型入参（schema 声明 operations 但执行器以系统整理为准）
        const r = await this.memory.runConsolidation(ctx.botId, ctx.sender)
        return { result: { ok: true, ...r } }
      }
      case 'recall': {
        const r = this.memory.recall(ctx.botId, ctx.sender, s('query'), Number(args.daysBack) || 90)
        return { result: { ok: true, ...r } }
      }
      case 'restore_memory': {
        const st = this.memory.restoreMemory(s('id'), ctx.botId)
        if (st !== 'ok') throw new Error(st)
        return { result: { ok: true } }
      }
      case 'write_diary': {
        // B15：原实现是桩（只查有没有写过、什么都不写）。现在真写：
        // 取今天的对话 + 角色卡摘要 → chatComplete 生成第一人称日记 → 落 diaries（一天一篇）。
        const now = new Date()
        const date = shanghaiDateKey(now)
        const existing = this.get<{ id: string; content: string }>('SELECT id, content FROM diaries WHERE bot_id = ? AND date = ?', ctx.botId, date)
        if (existing) {
          return { result: { ok: true, alreadyWritten: true, date, diary: existing.content } }
        }
        const dayStart = `${date}T00:00:00+08:00`
        const botRow = this.get<{ name: string; system_prompt: string; character_id: string | null }>(
          'SELECT name, system_prompt, character_id FROM bots WHERE id = ?', ctx.botId,
        )
        if (!botRow) return { result: { ok: false, error: '角色不存在' } }
        const character = botRow.character_id
          ? this.get<{ name: string; data: string }>('SELECT name, data FROM characters WHERE id = ?', botRow.character_id)
          : null
        let personaHint = botRow.name
        if (character) {
          let cardText = ''
          try {
            const parsed = JSON.parse(character.data) as Record<string, unknown>
            const data = (parsed['data'] ?? parsed) as Record<string, unknown>
            cardText = [data['description'], data['personality']].filter((x) => typeof x === 'string').join('；')
          } catch {
            cardText = character.data.slice(0, 300)
          }
          personaHint = `${character.name}${cardText ? `（${cardText}）` : ''}`
        } else if (botRow.system_prompt.trim()) {
          personaHint = `${botRow.name}（${botRow.system_prompt.trim().slice(0, 300)}）`
        }
        const msgs = this.all<{ role: string; content: string; created_at: string }>(
          "SELECT role, content, created_at FROM messages WHERE bot_id = ? AND sender = ? AND created_at >= ? AND role IN ('user','assistant') ORDER BY created_at ASC LIMIT 80",
          ctx.botId, ctx.sender, dayStart,
        )
        if (msgs.length === 0) {
          return { result: { ok: false, date, error: '今天还没有对话，写不出日记（先聊几句）' } }
        }
        const transcript = msgs
          .map((m) => `${m.role === 'user' ? '对方' : '我'}：${m.content.slice(0, 200)}`)
          .join('\n')
        const generated = await chatComplete(this.storage, [
          {
            role: 'system',
            content: `你是「${personaHint}」，一个有血有肉的真实角色。现在深夜独处，写今天的私密日记（第一人称，只用你自己的口吻）。\n要求：像深夜随手写的私密日记——口语、碎片、不修饰；记具体的事和当时的感觉，不写道理不写总结；允许只写两三行；情绪不平摊；不要提到「AI」「模型」「提示词」，不要分点、不用 markdown。`,
          },
          { role: 'user', content: `今天的对话记录：\n${transcript}\n\n请写今天的日记。` },
        ], { temperature: 0.85, enableThinking: false, maxTokens: 600 })
        const content = generated.content.trim()
        if (content === '') return { result: { ok: false, date, error: '模型没有产出日记内容' } }
        const id = randomUUID()
        const nowIso = now.toISOString()
        this.storage.prepare(
          'INSERT INTO diaries (id, bot_id, date, content, mood, snapshot, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
        ).run(id, ctx.botId, date, content, '', '{}', nowIso, nowIso)
        return { result: { ok: true, alreadyWritten: false, date, diary: content } }
      }
      case 'go_to_sleep': {
        const until = args.sleepUntil ? new Date(s('sleepUntil')) : new Date(Date.now() + 8 * 3600_000)
        this.storage.prepare('UPDATE bots SET sleep_until = ? WHERE id = ?').run(until.toISOString(), ctx.botId)
        return { result: { ok: true, sleepUntil: until.toISOString() } }
      }
      case 'view_album': {
        const memes = memeIdsForBot(this.storage, ctx.botId)
        const id = s('id')
        if (id !== '') {
          const row = this.get<PhotoRow>('SELECT * FROM photos WHERE bot_id = ? AND id = ?', ctx.botId, id)
          return { result: { ok: true, photos: row === null ? [] : [photoToolView(row, memes.get(row.id) ?? '')] } }
        }
        const where = ['bot_id = ?']
        const params: unknown[] = [ctx.botId]
        const tag = s('tag').trim()
        if (tag !== '') {
          where.push("tags LIKE ? ESCAPE '\\'")
          params.push(likePattern(tag))
        }
        const query = s('query').trim()
        if (query !== '') {
          where.push("(caption LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\')")
          const pattern = likePattern(query)
          params.push(pattern, pattern, pattern)
        }
        const category = s('category').trim()
        if (category !== '') {
          where.push("category LIKE ? ESCAPE '\\'")
          params.push(likePattern(category))
        }
        const requested = Number(args.limit)
        const limit = Math.min(100, Math.max(1, Number.isFinite(requested) && requested > 0 ? Math.trunc(requested) : 20))
        const rows = this.all<PhotoRow>(
          `SELECT * FROM photos WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
          ...params, limit,
        )
        return { result: { ok: true, photos: rows.map((row) => photoToolView(row, memes.get(row.id) ?? '')) } }
      }
      case 'tag_photo': {
        const id = s('id')
        const columns: string[] = []
        const values: unknown[] = []
        const caption = s('caption')
        if (caption !== '') {
          columns.push('caption')
          values.push(caption)
        }
        if (Array.isArray(args.tags)) {
          const tags = (args.tags as unknown[]).map((tag) => String(tag).trim()).filter((tag) => tag !== '')
          columns.push('tags')
          values.push(JSON.stringify(tags))
        }
        const category = s('category')
        if (category !== '') {
          columns.push('category')
          values.push(category)
        }
        if (columns.length === 0) throw new Error('没有要修改的字段：caption / tags / category 至少给一个')
        const r = this.storage
          .prepare(`UPDATE photos SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE id = ? AND bot_id = ?`)
          .run(...values, id, ctx.botId)
        if (r.changes === 0) throw new Error('照片不存在；先调用 view_album 拿准确 id')
        return { result: { ok: true } }
      }
      case 'delete_photo': {
        this.storage.prepare('DELETE FROM photos WHERE id = ? AND bot_id = ?').run(s('id'), ctx.botId)
        return { result: { ok: true } }
      }
      case 'send_photo': {
        const memes = memeIdsForBot(this.storage, ctx.botId)
        const memeRaw = s('meme')
        const idRaw = s('id')
        if (memeRaw === '' && idRaw === '') {
          throw new Error('需要提供 meme：先调用 view_album 查看相册、拿准确的 meme id，禁止编造')
        }
        let photo: PhotoRow | null = null
        if (memeRaw !== '') {
          const meme = normalizeMeme(memeRaw)
          if (meme === '') throw new Error('meme 格式不对：应为 "meme:<hex>" 或裸 hex，先用 view_album 获取')
          photo = this.all<PhotoRow>('SELECT * FROM photos WHERE bot_id = ?', ctx.botId)
            .find((row) => memes.get(row.id) === meme) ?? null
          if (photo === null) {
            throw new Error(`相册里没有 meme「${meme}」。请先调用 view_album 查看可用照片并拿准确的 meme id，禁止编造`)
          }
        } else {
          photo = this.get<PhotoRow>('SELECT * FROM photos WHERE id = ? AND bot_id = ?', idRaw, ctx.botId)
          if (photo === null) throw new Error('照片不存在；先调用 view_album 查看可用照片和 meme id')
        }
        const r = await this.bridge.sendPhoto(ctx.channelId ?? 'web', ctx.botId, ctx.sender, this.bridge.photoPublicUrl(photo.url), s('caption'))
        if (!r.ok) throw new Error(r.error ?? '发送失败')
        return { result: { ok: true, photo: photoToolView(photo, memes.get(photo.id) ?? '') } }
      }
      case 'send_message': {
        const r = await this.bridge.sendText(s('channel'), ctx.botId, s('target') || ctx.sender, s('text'))
        if (!r.ok) throw new Error(r.error ?? '发送失败')
        return { result: { ok: true, sent: r.sent } }
      }
      case 'start_call': {
        const r = await this.bridge.startCall(ctx.botId, ctx.sender, s('reason'), s('topic'))
        return { result: r }
      }
      default: {
        const extra = this.extra.get(name)
        if (extra) return extra.exec(args, ctx)
        throw new Error('unknown tool')
      }
    }
  }
}

export function createToolRegistry(
  storage: LittlyStorage,
  memory: LittlyMemory,
  bridge: ChannelBridge,
  cwd: string,
): LittlyToolRegistry {
  return new Registry(storage, memory, bridge, cwd)
}

export * from './enabled.ts'
