/**
 * 管理与运维端点：铁律、全局设置（AI 打码）、成长系统、插件清单、
 * Bilibili sidecar 代理、调试（系统提示词 / 审计）、活动统计、全局搜索、种子初始化。
 */
import { randomUUID } from 'node:crypto'
import type { AuditLogRow, BotRow, CharacterRow, ContactRow, MemoryRow, MessageRow, ScheduledMessageRow } from '@littly/storage'
import { invalidateAIConfigCache } from '@littly/llm'
import { parseChanges, parseProposalMeta } from '@littly/growth'
import {
  BiliSidecarError,
  biliAuthStatus,
  biliQrStart,
  biliQrStatus,
  biliRunCommand,
  getDisabledTools,
  toggleDisabledTool,
} from '@littly/tools'
import { json, err, bodyRecord, reqStr, reqNum, reqBool, type ApiRequest } from './http.ts'
import { maskSecret, isMaskedInput } from './mapping.ts'
import { isAdmin, ownSender, senderAllowed, loadBot, queryStr, nowIso } from './deps.ts'
import type { Deps, RegisterFn } from './deps.ts'

/** dsh 本地化文案 → 纯文本（string 或 {en, ...} 记录，取中文优先）。 */
function localizeText(text: string | { readonly en: string; readonly [locale: string]: string } | undefined): string | undefined {
  if (text === undefined) return undefined
  if (typeof text === 'string') return text
  const zh = text['zh-CN'] ?? text['zh'] ?? text['en']
  return typeof zh === 'string' ? zh : undefined
}

/** Bilibili sidecar 错误 → 统一信封（sidecar 不可达 = 502；业务错误码原样透传）。 */function biliFail(ctx: ApiRequest, error: unknown): void {
  if (error instanceof BiliSidecarError) {
    const status = error.status === 502 || error.status === 504 ? 502 : error.status >= 400 && error.status < 600 ? error.status : 502
    err(ctx.res, status, error.code, error.message)
    return
  }
  err(ctx.res, 502, 'bili_unavailable', `Bilibili sidecar 不可达：${error instanceof Error ? error.message : String(error)}`)
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

  // ---- 成长系统（§12）----

  r.get('/api/growth', 'required', (ctx) => {
    const botId = queryStr(ctx, 'botId') ?? ''
    if (botId === '') {
      err(ctx.res, 400, 'bad_request', '缺少 botId')
      return
    }
    const snap = d.growth.snapshot(botId)
    // 提案视图：同时给出控制台要的扁平字段与旧接口兼容字段
    const decorate = (p: (typeof snap.pendingProposals)[number]): Record<string, unknown> => {
      const meta = parseProposalMeta(p.evidence)
      const changes = parseChanges(p.changes)
      return {
        id: p.id,
        kind: 'growth',
        title: '成长提议',
        summary: meta.majorEvents ?? '',
        evidence: [...new Set(changes.flatMap((c) => c.evidenceIds))],
        payload: { changes },
        status: p.status,
        createdAt: p.created_at,
        // 兼容旧接口：结构化视图
        changesParsed: changes,
        adversarialParsed: meta.adversarial ?? null,
        majorEvents: meta.majorEvents ?? '',
        lifeStageNext: meta.lifeStageNext ?? '',
        trigger: meta.trigger ?? '',
        basedVersion: p.based_version,
        report: p.report,
        expiresAt: p.expires_at,
        decidedAt: p.decided_at,
      }
    }
    json(ctx.res, 200, {
      data: {
        profile: snap.profile
          ? {
              version: snap.profile.version,
              lifeStage: snap.profile.life_stage,
              createdAt: snap.profile.created_at,
              dimensions: snap.dimensionsParsed,
              summary: `当前版本 v${snap.profile.version}`,
              report: snap.profile.life_stage ? `生命阶段：${snap.profile.life_stage}` : '',
            }
          : null,
        dimensions: snap.dimensionsParsed,
        versions: snap.versions.map((v) => ({
          version: v.version,
          createdAt: v.created_at,
          summary: v.life_stage ? `生命阶段：${v.life_stage}` : '',
          author: v.derived_from ?? 'system',
        })),
        proposals: snap.pendingProposals.map(decorate),
        pendingProposals: snap.pendingProposals.map(decorate),
        history: snap.history.map(decorate),
        reviewWindowOpen: snap.reviewWindowOpen,
        nextReviewAt: snap.nextReviewAt,
        nextReviewText: snap.nextReviewText,
        // 控制台读的窗口视图
        window: { nextAt: snap.nextReviewAt, reason: snap.nextReviewText },
      },
    })
  })

  r.post('/api/growth', 'required', (ctx) => {
    void (async (): Promise<void> => {
      const body = bodyRecord(ctx.body)
      const action = reqStr(body, 'action') ?? ''
      const botId = reqStr(body, 'botId') ?? ''
      if (botId === '') {
        err(ctx.res, 400, 'bad_request', '缺少 botId')
        return
      }
      if (action === 'seed') {
        const profile = await d.growth.ensureProfile(botId)
        if (!profile) {
          err(ctx.res, 400, 'seed_failed', '生成失败：需要先绑定内容非空的角色卡')
          return
        }
        json(ctx.res, 200, { data: { profile } })
        return
      }
      if (action === 'evaluate') {
        const outcome = await d.growth.evaluate(botId, 'manual')
        json(ctx.res, 200, { data: { outcome } })
        return
      }
      if (action === 'repropose') {
        const { outcome, discarded } = await d.growth.repropose(botId)
        json(ctx.res, 200, { data: { outcome, discarded } })
        return
      }
      if (action === 'rollback') {
        const version = reqNum(body, 'version')
        if (version === undefined) {
          err(ctx.res, 400, 'bad_request', 'version 无效')
          return
        }
        const result = d.growth.rollback(botId, version)
        if (!result.ok) {
          err(ctx.res, 400, 'rollback_failed', result.error ?? '回滚失败')
          return
        }
        json(ctx.res, 200, { data: { profile: result.profile } })
        return
      }
      err(ctx.res, 400, 'bad_request', 'unknown action')
    })()
  })

  r.post('/api/growth/proposals/:id', 'required', (ctx) => {
    void (async (): Promise<void> => {
      const body = bodyRecord(ctx.body)
      const decision = reqStr(body, 'decision') ?? ''
      const result = await d.growth.decide(ctx.params['id'] ?? '', decision as never, body['changes'])
      if (!result.ok) {
        err(ctx.res, 400, 'growth_decide_failed', result.error ?? '处理失败')
        return
      }
      json(ctx.res, 200, { data: result })
    })()
  })

  // ---- 插件 / 技能 / MCP / 工具 ----

  r.get('/api/plugins', 'required', (ctx) => {
    void (async (): Promise<void> => {
      // dsh 插件：委托 dsh 原生 plugin-manager（不自造插件清单）
      let dsh: Array<Record<string, unknown>> = []
      try {
        const plugins = await d.pluginManager?.listPlugins() ?? []
        dsh = plugins.map((p) => ({
          name: p.moduleName,
          version: '',
          description: localizeText(p.meta?.description) ?? '',
          title: localizeText(p.meta?.title) ?? '',
          enabled: p.enabled,
        }))
      } catch (e) {
        dsh = []
        d.log('[plugins] dsh 插件清单读取失败: %s', e instanceof Error ? e.message : e)
      }

      // skills：dsh 原生 skill 注册表
      let skills: Array<Record<string, unknown>> = []
      try {
        const list = await d.skills?.list() ?? []
        skills = list.map((s) => ({
          name: s.name,
          description: s.description,
          source: s.provider,
        }))
      } catch (e) {
        skills = []
        d.log('[plugins] skills 清单读取失败: %s', e instanceof Error ? e.message : e)
      }

      // MCP：运行时管理器（DB 清单 + 连接态）
      const mcp = d.mcp.status().map((s) => ({
        name: s.config.name,
        transport: s.config.transport,
        command: s.config.command ?? '',
        args: s.config.args ?? [],
        url: s.config.url ?? '',
        status: s.state,
        tools: s.tools.length,
        enabled: s.config.enabled,
        error: s.error,
      }))

      // 工具：注册表全量 + 每个角色的启停状态
      const toolNames = d.hub.tools.collectTools().map((t) => t.function.name)
      const botIds = d.storage
        .prepare('SELECT id FROM bots')
        .all() as unknown as Array<{ id: string }>
      const enabledByBot = new Map<string, Set<string>>()
      for (const bot of botIds) {
        const disabled = getDisabledTools(d.storage, bot.id)
        enabledByBot.set(
          bot.id,
          new Set(toolNames.filter((n) => !disabled.has(n))),
        )
      }
      const tools = d.hub.tools.collectTools().map((t) => ({
        name: t.function.name,
        namespace: t.function.name.startsWith('mcp__') ? 'mcp' : 'builtin',
        source: t.function.name.startsWith('mcp__') ? 'mcp' : 'builtin',
        description: t.function.description,
        enabledBots: botIds.map((b) => b.id).filter((id) => enabledByBot.get(id)?.has(t.function.name)),
      }))

      // dsh 插件工具（社区插件 / MCP 服务器注册的）：模型这一轮能看到它们
      const dshTools = (d.hub.dshTools?.list() ?? []).map((t) => ({
        name: t.function.name,
        namespace: 'dsh',
        source: 'dsh-plugin',
        description: t.function.description,
        enabledBots: botIds.map((b) => b.id).filter((id) => enabledByBot.get(id)?.has(t.function.name)),
      }))

      json(ctx.res, 200, { data: { mcp, skills, tools: [...tools, ...dshTools], dsh } })
    })()
  })

  r.post('/api/plugins/mcp', 'required', (ctx) => {
    void (async (): Promise<void> => {
      const body = bodyRecord(ctx.body)
      const name = reqStr(body, 'name', 'serverName') ?? ''
      if (name === '') {
        err(ctx.res, 400, 'bad_request', '缺少服务器名')
        return
      }
      const transport = reqStr(body, 'transport', 'type') === 'streamable-http' ? 'streamable-http' : 'stdio'
      const args = Array.isArray(body['args']) ? (body['args'] as unknown[]).map((a) => String(a)) : []
      const result = await d.mcp.upsertServer({
        name,
        transport,
        ...(reqStr(body, 'command') ? { command: reqStr(body, 'command') as string } : {}),
        ...(args.length > 0 ? { args } : {}),
        ...(reqStr(body, 'url') ? { url: reqStr(body, 'url') as string } : {}),
        enabled: body['enabled'] !== false,
      })
      if (!result.ok) {
        err(ctx.res, 400, 'bad_request', result.error ?? '添加失败')
        return
      }
      json(ctx.res, 200, { data: { ok: true } })
    })()
  })

  r.del('/api/plugins/mcp/:name', 'required', (ctx) => {
    void (async (): Promise<void> => {
      const result = await d.mcp.removeServer(ctx.params['name'] ?? '')
      if (!result.ok) {
        err(ctx.res, 404, 'not_found', result.error ?? '服务器不存在')
        return
      }
      json(ctx.res, 200, { data: { ok: true } })
    })()
  })

  r.patch('/api/plugins/tools', 'required', (ctx) => {
    const body = bodyRecord(ctx.body)
    const toolName = reqStr(body, 'name', 'tool') ?? ''
    const botId = reqStr(body, 'botId') ?? ''
    const enabled = reqBool(body, 'enabled')
    if (toolName === '' || botId === '') {
      err(ctx.res, 400, 'bad_request', '缺少工具名或 botId')
      return
    }
    if (enabled === undefined) {
      err(ctx.res, 400, 'bad_request', '缺少 enabled')
      return
    }
    const bot = loadBot(d, botId)
    if (bot === null) {
      err(ctx.res, 400, 'bad_request', '机器人不存在')
      return
    }
    const known = d.hub.tools.collectTools().some((t) => t.function.name === toolName)
    if (!known) {
      err(ctx.res, 400, 'bad_request', '工具不存在')
      return
    }
    toggleDisabledTool(d.storage, botId, toolName, enabled)
    json(ctx.res, 200, { data: { ok: true, name: toolName, botId, enabled } })
  })

  // ---- Bilibili sidecar 代理 ----

  r.get('/api/bili/status', 'required', (ctx) => {
    void (async (): Promise<void> => {
      try {
        const envelope = await biliAuthStatus()
        const data = (typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : {}) as Record<string, unknown>
        const user = (typeof data['user'] === 'object' && data['user'] !== null ? data['user'] : {}) as Record<string, unknown>
        json(ctx.res, 200, {
          data: {
            logined: data['logged_in'] === true || data['logined'] === true,
            username: typeof user['uname'] === 'string' ? user['uname'] : typeof data['username'] === 'string' ? data['username'] : undefined,
            mid: user['mid'] !== undefined ? String(user['mid']) : undefined,
          },
        })
      } catch (e) {
        biliFail(ctx, e)
      }
    })()
  })

  r.post('/api/bili/qr/start', 'required', (ctx) => {
    void (async (): Promise<void> => {
      try {
        const body = await biliQrStart()
        json(ctx.res, 200, {
          data: {
            status: typeof body['state'] === 'string' ? body['state'] : 'pending',
            qrImage: typeof body['qr_image_base64'] === 'string' ? body['qr_image_base64'] : undefined,
            qrUrl: typeof body['qr_url'] === 'string' ? body['qr_url'] : undefined,
            sessionId: typeof body['session_id'] === 'string' ? body['session_id'] : undefined,
            message: typeof body['next'] === 'string' ? body['next'] : undefined,
          },
        })
      } catch (e) {
        biliFail(ctx, e)
      }
    })()
  })

  r.get('/api/bili/qr/status', 'required', (ctx) => {
    void (async (): Promise<void> => {
      const sessionId = queryStr(ctx, 'sessionId', 'session_id') ?? ''
      if (sessionId === '') {
        err(ctx.res, 400, 'bad_request', '缺少 sessionId')
        return
      }
      try {
        const body = await biliQrStatus(sessionId)
        json(ctx.res, 200, {
          data: {
            status: typeof body['state'] === 'string' ? body['state'] : 'unknown',
            qrImage: typeof body['qr_image_base64'] === 'string' ? body['qr_image_base64'] : undefined,
            message: typeof body['next'] === 'string' ? body['next'] : undefined,
          },
        })
      } catch (e) {
        biliFail(ctx, e)
      }
    })()
  })

  r.post('/api/bili/cmd', 'required', (ctx) => {
    void (async (): Promise<void> => {
      const body = bodyRecord(ctx.body)
      const argv = Array.isArray(body['argv']) ? (body['argv'] as unknown[]).map((a) => String(a)) : []
      if (argv.length === 0) {
        err(ctx.res, 400, 'bad_request', 'argv 不能为空')
        return
      }
      try {
        const r = await biliRunCommand(argv)
        json(ctx.res, 200, {
          data: {
            ok: r.result.ok !== false,
            exitCode: r.exitCode,
            dryRun: r.dryRun,
            output: typeof r.result.data === 'string' ? r.result.data : JSON.stringify(r.result.data ?? r.result.error ?? {}),
            error: r.result.error ?? null,
          },
        })
      } catch (e) {
        biliFail(ctx, e)
      }
    })()
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
