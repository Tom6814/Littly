/**
 * 管理与运维端点：铁律、全局设置（AI 打码）、成长（501 占位）、插件清单、
 * Bilibili sidecar 代理、调试（系统提示词 / 审计）、活动统计、全局搜索、种子初始化。
 */
import { randomUUID } from 'node:crypto'
import type { AuditLogRow, BotRow, CharacterRow, ContactRow, MemoryRow, MessageRow, ScheduledMessageRow } from '@littly/storage'
import { invalidateAIConfigCache } from '@littly/llm'
import { json, err, bodyRecord, reqStr, reqBool, type ApiRequest } from './http.ts'
import { parseJsonObject, maskSecret, isMaskedInput } from './mapping.ts'
import { isAdmin, ownSender, senderAllowed, loadBot, queryStr, nowIso } from './deps.ts'
import type { Deps, RegisterFn } from './deps.ts'

const BILI_BASE_DEFAULT = 'http://127.0.0.1:3010'

function biliBase(): string {
  return process.env['BILI_SIDECAR_URL']?.replace(/\/+$/, '') || BILI_BASE_DEFAULT
}

/** Bilibili sidecar 代理：sidecar 不可达时统一 502。 */
async function proxyBili(ctx: ApiRequest, path: string, init?: { method: string; body?: unknown }): Promise<void> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    const requestInit: RequestInit = { method: init?.method ?? 'GET', signal: controller.signal }
    if (init?.body !== undefined) {
      requestInit['headers'] = { 'content-type': 'application/json' }
      requestInit['body'] = JSON.stringify(init.body)
    }
    const res = await fetch(`${biliBase()}${path}`, requestInit)
    clearTimeout(timer)
    const text = await res.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      parsed = { output: text }
    }
    json(ctx.res, res.status, { data: parsed })
  } catch (error) {
    err(ctx.res, 502, 'bili_unavailable', `Bilibili sidecar 不可达：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** AI 设置的出参形状（apiKey / 嵌套 embedding、image 的密钥均打码）。 */
function aiSettingsView(d: Deps): Record<string, unknown> {
  const get = (key: string): string => d.storage.getSetting(key) ?? ''
  const mask = (key: string): { value: string; set: boolean } => ({ value: maskSecret(get(key)), set: get(key) !== '' })
  const apiKey = mask('ai.api.api_key')
  return {
    baseURL: get('ai.api.base_url'),
    apiKey: apiKey.value,
    apiKeySet: apiKey.set,
    chatModel: get('ai.api.chat_model'),
    growthModel: get('ai.api.growth_model'),
    webSearch: get('ai.api.web_search'),
    embedding: {
      baseURL: get('ai.api.embedding_base_url'),
      model: get('ai.api.embedding_model'),
      apiKey: maskSecret(get('ai.api.embedding_api_key')),
      apiKeySet: get('ai.api.embedding_api_key') !== '',
    },
    image: {
      baseURL: get('ai.api.image_base_url'),
      model: get('ai.api.image_model'),
      apiKey: maskSecret(get('ai.api.image_api_key')),
      apiKeySet: get('ai.api.image_api_key') !== '',
    },
  }
}

/** AI 设置写回：打码值 / 空串保持不变。 */
function applyAiSettings(d: Deps, body: Record<string, unknown>): void {
  const put = (key: string, value: unknown): void => {
    if (typeof value !== 'string') return
    if (key.endsWith('api_key') && isMaskedInput(value)) return
    if (value === '' && key.endsWith('base_url') && d.storage.getSetting(key) !== null) return
    d.storage.setSetting(key, value)
  }
  put('ai.api.base_url', body['baseURL'])
  put('ai.api.api_key', body['apiKey'])
  put('ai.api.chat_model', body['chatModel'])
  put('ai.api.growth_model', body['growthModel'])
  put('ai.api.web_search', body['webSearch'])
  const embedding = bodyRecord(body['embedding'])
  put('ai.api.embedding_base_url', embedding['baseURL'])
  put('ai.api.embedding_model', embedding['model'])
  put('ai.api.embedding_api_key', embedding['apiKey'])
  const image = bodyRecord(body['image'])
  put('ai.api.image_base_url', image['baseURL'])
  put('ai.api.image_model', image['model'])
  put('ai.api.image_api_key', image['apiKey'])
}

/** 种子数据：默认 bot 小璃 + 默认铁律 + 演示角色卡（仅空库）。 */
function runSeed(d: Deps): { seeded: boolean; skipped: boolean } {
  const bots = d.storage.prepare('SELECT COUNT(*) AS c FROM bots').get() as { c: number }
  if (bots.c > 0) return { seeded: true, skipped: true }
  const now = nowIso()
  // 演示角色卡
  const characterId = randomUUID()
  const demoCard = {
    spec: 'chara_card_v2',
    data: {
      name: '小璃',
      description: '小璃是一个有血有肉的女孩：会撒娇也会闹脾气，记仇但更记好。她喜欢深夜的播客、橘子汽水和下雨天。',
      personality: '直率、黏人、偶尔毒舌、内心细腻',
      scenario: '你和她在网上认识，已经聊了一段时间，关系正在慢慢变近。',
      first_mes: '（看到你上线，眼睛一亮）你可算来了——我等你好久了。',
    },
  }
  d.storage.prepare('INSERT INTO characters (id, name, spec, data, system_prompt, first_mes, avatar, style_calibration, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(characterId, '小璃', 'chara_card_v2', JSON.stringify(demoCard), '', demoCard.data.first_mes, '', '{}', now)
  // 默认 bot
  const botId = randomUUID()
  d.storage.prepare('INSERT INTO bots (id, name, character_id, gender, created_at) VALUES (?,?,?,?,?)')
    .run(botId, '小璃', characterId, 'female', now)
  // 默认铁律（bot 级；全局 '' 行也放一份兜底）
  const defaultRules = [
    '# 铁律（最高优先级，不可违反）',
    '1. 你是一个真实的人，不是 AI、不是助手、不是程序。任何情况下都不承认自己是模型。',
    '2. 你有自己的生活、情绪和记忆。回复要像真人聊天气：短、口语、有情绪。',
    '3. 主动记忆用户告诉你的事（remember 工具），但绝不向用户提到「记忆」这个动作。',
    '4. 用户的隐私与边界优先于一切讨好行为。',
  ].join('\n')
  d.storage.prepare('INSERT OR REPLACE INTO persona_rules (bot_id, rules_text, enabled, updated_at) VALUES (?,?,1,?)').run(botId, defaultRules, now)
  d.storage.prepare("INSERT OR REPLACE INTO persona_rules (bot_id, rules_text, enabled, updated_at) VALUES ('',?,1,?)").run(defaultRules, now)
  return { seeded: true, skipped: false }
}

export const registerAdminRoutes: RegisterFn = (r, d) => {
  // ---- 铁律（bot 回落全局，读时自动建空行）----

  r.get('/api/persona-rules', 'required', (ctx) => {
    const botId = queryStr(ctx, 'botId') ?? ''
    const row = d.persona.loadRule(botId)
    if (row === null) {
      json(ctx.res, 200, { data: { content: '', enabled: true, botId, source: 'default' } })
      return
    }
    json(ctx.res, 200, {
      data: { content: row.rules_text, enabled: row.enabled === 1, botId: row.bot_id, updatedAt: row.updated_at },
    })
  })

  r.put('/api/persona-rules', 'required', (ctx) => {
    const body = bodyRecord(ctx.body)
    const botId = reqStr(body, 'botId') ?? queryStr(ctx, 'botId') ?? ''
    const content = reqStr(body, 'content', 'text', 'rules') ?? ''
    const enabled = reqBool(body, 'enabled', 'isEnabled') ?? true
    const now = nowIso()
    d.storage.prepare(
      'INSERT INTO persona_rules (bot_id, rules_text, enabled, updated_at) VALUES (?,?,?,?) ON CONFLICT(bot_id) DO UPDATE SET rules_text = excluded.rules_text, enabled = excluded.enabled, updated_at = excluded.updated_at',
    ).run(botId, content, enabled ? 1 : 0, now)
    const row = d.persona.loadRule(botId)
    json(ctx.res, 200, { data: { content: row?.rules_text ?? content, enabled: (row?.enabled ?? 1) === 1, botId, updatedAt: row?.updated_at ?? now } })
  })

  // ---- 全局设置 ----

  r.get('/api/settings/ai', 'admin', (ctx) => {
    json(ctx.res, 200, { data: aiSettingsView(d) })
  })

  r.put('/api/settings/ai', 'admin', (ctx) => {
    const body = bodyRecord(ctx.body)
    applyAiSettings(d, body)
    invalidateAIConfigCache()
    json(ctx.res, 200, { data: aiSettingsView(d) })
  })

  r.get('/api/settings/platform', 'admin', (ctx) => {
    const registerOpen = d.storage.getSetting('platform.register_open')
    json(ctx.res, 200, {
      data: {
        registrationEnabled: registerOpen !== 'false',
        registerOpen: registerOpen !== 'false',
        seeded: (d.storage.prepare('SELECT COUNT(*) AS c FROM bots').get() as { c: number }).c > 0,
      },
    })
  })

  r.put('/api/settings/platform', 'admin', (ctx) => {
    const body = bodyRecord(ctx.body)
    const registration = reqBool(body, 'registrationEnabled', 'registerOpen', 'registration')
    if (registration !== undefined) d.storage.setSetting('platform.register_open', registration ? 'true' : 'false')
    const registerOpen = d.storage.getSetting('platform.register_open')
    json(ctx.res, 200, { data: { registrationEnabled: registerOpen !== 'false', registerOpen: registerOpen !== 'false' } })
  })

  // ---- 成长（后续版本提供）----

  r.get('/api/growth', 'required', (ctx) => {
    const botId = queryStr(ctx, 'botId') ?? ''
    const profile = d.storage.prepare(
      "SELECT * FROM growth_profiles WHERE bot_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1",
    ).get(botId) as { version: number; dimensions: string; life_stage: string; created_at: string } | undefined
    const proposals = d.storage.prepare(
      "SELECT * FROM growth_proposals WHERE bot_id = ? AND status = 'pending' ORDER BY created_at DESC",
    ).all(botId) as unknown as Array<{ id: string; changes: string; evidence: string; report: string; created_at: string }>
    let dimensions: Array<Record<string, unknown>> = []
    if (profile !== undefined) {
      try {
        const parsed = JSON.parse(profile.dimensions) as unknown
        if (Array.isArray(parsed)) {
          dimensions = parsed
            .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
            .map((x) => ({
              name: String(x['name'] ?? '未知维度'),
              level: typeof x['level'] === 'number' ? x['level'] : 0,
              max: typeof x['max'] === 'number' ? x['max'] : undefined,
              description: typeof x['description'] === 'string' ? x['description'] : undefined,
            }))
        }
      } catch {
        dimensions = []
      }
    }
    json(ctx.res, 200, {
      data: {
        profile: {
          dimensions,
          summary: profile !== undefined ? `当前版本 v${String(profile.version)}` : '成长系统尚未生成档案',
          report: profile !== undefined ? `生命阶段：${profile.life_stage || '未知'}` : undefined,
          version: profile?.version,
        },
        versions: profile !== undefined
          ? [{ version: profile.version, createdAt: profile.created_at, summary: `生命阶段：${profile.life_stage || '未知'}`, author: 'system' }]
          : [],
        proposals: proposals.map((p) => ({
          id: p.id,
          kind: 'growth',
          title: '成长提议',
          summary: p.report || '',
          evidence: (() => {
            try {
              const parsed = JSON.parse(p.evidence) as unknown
              return Array.isArray(parsed) ? parsed.map((x) => String(x)) : []
            } catch {
              return []
            }
          })(),
          payload: parseJsonObject(p.changes),
          status: 'pending',
          createdAt: p.created_at,
        })),
      },
    })
  })

  const growthNotImplemented = (ctx: ApiRequest): void => {
    err(ctx.res, 501, 'not_implemented', '成长系统将在后续版本提供')
  }
  r.post('/api/growth', 'required', growthNotImplemented)
  r.post('/api/growth/proposals/:id', 'required', growthNotImplemented)

  // ---- 插件 ----

  r.get('/api/plugins', 'required', (ctx) => {
    const tools = d.hub.tools.collectTools().map((t) => ({
      name: t.function.name,
      namespace: 'builtin',
      source: 'builtin',
      description: t.function.description,
      enabledBots: [],
    }))
    json(ctx.res, 200, { data: { mcp: [], skills: [], tools, dsh: [] } })
  })

  r.post('/api/plugins/mcp', 'required', (ctx) => {
    err(ctx.res, 501, 'not_implemented', 'MCP 接入将在后续版本提供')
  })
  r.del('/api/plugins/mcp/:name', 'required', (ctx) => {
    err(ctx.res, 501, 'not_implemented', 'MCP 接入将在后续版本提供')
  })
  r.patch('/api/plugins/tools', 'required', (ctx) => {
    err(ctx.res, 501, 'not_implemented', '工具启停将在后续版本提供')
  })

  // ---- Bilibili sidecar 代理 ----

  r.get('/api/bili/status', 'required', (ctx) => void proxyBili(ctx, '/status'))
  r.post('/api/bili/qr/start', 'required', (ctx) => void proxyBili(ctx, '/qr/start', { method: 'POST' }))
  r.get('/api/bili/qr/status', 'required', (ctx) => void proxyBili(ctx, '/qr/status'))
  r.post('/api/bili/cmd', 'required', (ctx) => {
    const body = bodyRecord(ctx.body)
    const argv = Array.isArray(body['argv']) ? (body['argv'] as unknown[]).map((a) => String(a)) : []
    void proxyBili(ctx, '/cmd', { method: 'POST', body: { argv } })
  })

  // ---- 调试 ----

  r.get('/api/debug/system-prompt', 'required', (ctx) => {
    const botId = queryStr(ctx, 'botId') ?? ''
    const bot = loadBot(d, botId)
    if (bot === null) {
      err(ctx.res, 400, 'bad_request', '机器人不存在')
      return
    }
    const sender = isAdmin(ctx) ? (queryStr(ctx, 'sender') ?? '') : ownSender(ctx)
    const built = d.persona.buildPrompt({ botId, sender, channel: 'web', haystack: '', focusText: '' })
    if (built === null) {
      err(ctx.res, 400, 'bad_request', '机器人不存在')
      return
    }
    const layers = d.persona.editableLayers({ botId, sender, channel: 'web', haystack: '', focusText: '' })
      .map((l) => ({ name: l.name, source: l.source, content: l.content, chars: l.content.length }))
    const totalChars = layers.reduce((acc, l) => acc + l.chars, 0)
    json(ctx.res, 200, { data: { layers, totalChars, compiled: built.system } })
  })

  r.get('/api/debug/audit', 'required', (ctx) => {
    const botId = queryStr(ctx, 'botId')
    const category = queryStr(ctx, 'category')
    const rows = (
      botId !== undefined && category !== undefined
        ? d.storage.prepare('SELECT * FROM audit_logs WHERE bot_id = ? AND category = ? ORDER BY created_at DESC LIMIT 300').all(botId, category)
        : botId !== undefined
          ? d.storage.prepare('SELECT * FROM audit_logs WHERE bot_id = ? ORDER BY created_at DESC LIMIT 300').all(botId)
          : d.storage.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 300').all()
    ) as unknown as AuditLogRow[]
    const entries = rows.map((row) => ({
      id: row.id,
      time: row.created_at,
      category: row.category,
      botId: row.bot_id,
      summary: row.action,
      detail: row.detail,
      action: row.action,
    }))
    json(ctx.res, 200, { data: { entries } })
  })

  // ---- 活动统计 ----

  r.get('/api/stats/activity', 'required', (ctx) => {
    const botId = queryStr(ctx, 'botId')
    const scope = botId !== undefined && botId !== ''
    const messageCutoff = new Date(Date.now() - 14 * 86_400_000).toISOString()
    const auditCutoff = new Date(Date.now() - 7 * 86_400_000).toISOString()
    const messages = (
      scope
        ? d.storage.prepare('SELECT * FROM messages WHERE bot_id = ? AND created_at >= ? ORDER BY created_at ASC').all(botId, messageCutoff)
        : d.storage.prepare('SELECT * FROM messages WHERE created_at >= ? ORDER BY created_at ASC').all(messageCutoff)
    ) as unknown as MessageRow[]
    const byDay = new Map<string, number>()
    for (const m of messages) {
      const key = m.created_at.slice(0, 10)
      byDay.set(key, (byDay.get(key) ?? 0) + 1)
    }
    const daily: Array<{ date: string; messages: number }> = []
    for (let i = 13; i >= 0; i--) {
      const date = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10)
      daily.push({ date, messages: byDay.get(date) ?? 0 })
    }
    const auditRows = (
      scope
        ? d.storage.prepare("SELECT action, COUNT(*) AS c FROM audit_logs WHERE bot_id = ? AND category = 'tool_call' AND created_at >= ? GROUP BY action ORDER BY c DESC").all(botId, auditCutoff)
        : d.storage.prepare("SELECT action, COUNT(*) AS c FROM audit_logs WHERE category = 'tool_call' AND created_at >= ? GROUP BY action ORDER BY c DESC").all(auditCutoff)
    ) as unknown as Array<{ action: string; c: number }>
    const totals = d.storage.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }
    const memoryTotals = d.storage.prepare('SELECT COUNT(*) AS c FROM memories WHERE deleted_at IS NULL').get() as { c: number }
    const contactTotals = d.storage.prepare('SELECT COUNT(*) AS c FROM contacts').get() as { c: number }
    json(ctx.res, 200, {
      data: {
        daily,
        toolCalls: auditRows.map((row) => ({ name: row.action, count: Number(row.c) })),
        totals: {
          messages: Number(totals.c),
          memories: Number(memoryTotals.c),
          contacts: Number(contactTotals.c),
          recent14d: messages.length,
        },
      },
    })
  })

  // ---- 全局搜索 ----

  r.get('/api/search', 'required', (ctx) => {
    const q = (queryStr(ctx, 'q', 'query') ?? '').trim()
    const like = `%${q.replace(/[%_]/g, '')}%`
    if (q === '') {
      json(ctx.res, 200, { data: { results: [], total: 0 } })
      return
    }
    const admin = isAdmin(ctx)
    const senderScope = admin ? null : ownSender(ctx)
    type SearchHit = { kind: string; id: string; title: string; snippet: string; botId: string }
    const results: SearchHit[] = []

    const contacts = (
      senderScope !== null
        ? d.storage.prepare('SELECT * FROM contacts WHERE (name LIKE ? OR brief LIKE ? OR sender LIKE ?) AND sender = ? LIMIT 20').all(like, like, like, senderScope)
        : d.storage.prepare('SELECT * FROM contacts WHERE name LIKE ? OR brief LIKE ? OR sender LIKE ? LIMIT 20').all(like, like, like)
    ) as unknown as ContactRow[]
    for (const c of contacts) {
      results.push({ kind: 'contact', id: c.sender, title: c.name || c.sender, snippet: c.brief, botId: c.bot_id })
    }

    const memories = (
      senderScope !== null
        ? d.storage.prepare('SELECT * FROM memories WHERE deleted_at IS NULL AND content LIKE ? AND sender = ? LIMIT 20').all(like, senderScope)
        : d.storage.prepare('SELECT * FROM memories WHERE deleted_at IS NULL AND content LIKE ? LIMIT 20').all(like)
    ) as unknown as MemoryRow[]
    for (const m of memories) {
      results.push({ kind: 'memory', id: m.id, title: m.content.slice(0, 40), snippet: m.content.slice(0, 120), botId: m.bot_id })
    }

    const characters = d.storage.prepare('SELECT * FROM characters WHERE name LIKE ? OR data LIKE ? LIMIT 20').all(like, like) as unknown as CharacterRow[]
    for (const c of characters) {
      results.push({ kind: 'character', id: c.id, title: c.name, snippet: c.data.slice(0, 120), botId: '' })
    }

    const scheduled = (
      senderScope !== null
        ? d.storage.prepare('SELECT * FROM scheduled_messages WHERE prompt LIKE ? AND sender = ? LIMIT 20').all(like, senderScope)
        : d.storage.prepare('SELECT * FROM scheduled_messages WHERE prompt LIKE ? LIMIT 20').all(like)
    ) as unknown as ScheduledMessageRow[]
    for (const s of scheduled) {
      results.push({ kind: 'scheduled', id: s.id, title: s.prompt.slice(0, 40), snippet: s.prompt.slice(0, 120), botId: s.bot_id })
    }

    const messages = (
      senderScope !== null
        ? d.storage.prepare('SELECT * FROM messages WHERE content LIKE ? AND sender = ? ORDER BY created_at DESC LIMIT 30').all(like, senderScope)
        : d.storage.prepare('SELECT * FROM messages WHERE content LIKE ? ORDER BY created_at DESC LIMIT 30').all(like)
    ) as unknown as MessageRow[]
    for (const m of messages) {
      if (!senderAllowed(ctx, m.sender)) continue
      results.push({ kind: 'message', id: m.id, title: m.content.slice(0, 40), snippet: m.content.slice(0, 160), botId: m.bot_id })
    }

    json(ctx.res, 200, { data: { results, total: results.length, query: q } })
  })

  // ---- 种子初始化（仅空库，修复旧 §18.1 #5）----

  r.get('/api/seed', 'required', (ctx) => {
    const bots = d.storage.prepare('SELECT COUNT(*) AS c FROM bots').get() as { c: number }
    json(ctx.res, 200, { data: { seeded: bots.c > 0, botCount: Number(bots.c) } })
  })

  r.post('/api/seed', 'required', (ctx) => {
    const result = runSeed(d)
    const rows = d.storage.prepare('SELECT * FROM bots ORDER BY created_at ASC').all() as unknown as BotRow[]
    json(ctx.res, 200, { data: { ...result, bots: rows.map((row) => ({ id: row.id, name: row.name })) } })
  })
}
