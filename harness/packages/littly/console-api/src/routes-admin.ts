/**
 * 管理与运维端点：铁律、全局设置（AI 打码）、成长系统、插件清单、
 * 调试（系统提示词 / 审计）、活动统计、全局搜索、种子初始化。
 */
import { randomUUID } from 'node:crypto'
import type { AuditLogRow, BotRow, CharacterRow, ContactRow, MemoryRow, MessageRow, ScheduledMessageRow } from '@littly/storage'
import { invalidateAIConfigCache } from '@littly/llm'
import { parseChanges, parseProposalMeta } from '@littly/growth'
import { getDisabledTools, toggleDisabledTool } from '@littly/tools'
import { json, err, bodyRecord, reqStr, reqNum, reqBool, fire } from './http.ts'
import { maskSecret, isMaskedInput, hasMaskPlaceholder } from './mapping.ts'
import { ensureSeed } from './seed.ts'
import { isAdmin, ownSender, senderAllowed, loadBot, queryStr, nowIso, botOwnedBy, requireBotAccess } from './deps.ts'
import type { Deps, RegisterFn } from './deps.ts'

/** 安装失败时给出「为什么 + 怎么办」，不要只丢一个 failed。 */
function installFailureMessage(spec: string, result: {
  stage: string
  application: string
  error?: { code?: string; incompatible?: Array<{ name?: string; version?: string; runtimeVersion?: string }> }
}): string {
  const code = result.error?.code ?? 'unknown'
  const base = `安装 ${spec} 未完成（阶段 ${result.stage}）：`
  if (code === 'already-installed') {
    return `${base} 这个插件已经装过了。换版本请先卸载再装，或用 CLI 更新：dsh plugin --profile chat update ${spec}`
  }
  if (code === 'incompatible-version') {
    const cmds = (result.error?.incompatible ?? [])
      .map((i) => `dsh plugin --profile chat allow-version ${i.name}@${i.version} --dsh-version ${i.runtimeVersion} --accept-risk`)
    return `${base} 它要求的 dsh 版本与当前运行时不兼容。确认风险后可执行：${cmds.join('；')}`
  }
  if (code === 'invalid-spec') {
    return `${base} 安装源不合法。用 npm 包名（如 dsh-case）或 github:owner/repo。`
  }
  if (code === 'not-bundle') {
    return `${base} 装上了，但它没有声明 dsh.bundle.patch —— 不会成为插件层，只是普通依赖。`
  }
  return `${base} ${code}`
}

/** dsh 本地化文案 → 纯文本（string 或 {en, ...} 记录，取中文优先）。 */
function localizeText(text: string | { readonly en: string; readonly [locale: string]: string } | undefined): string | undefined {
  if (text === undefined) return undefined
  if (typeof text === 'string') return text
  const zh = text['zh-CN'] ?? text['zh'] ?? text['en']
  return typeof zh === 'string' ? zh : undefined
}

/**
 * B1 安全修复：MCP 服务器端点（原 `/api/plugins/mcp` POST/DELETE 仅 required、命令由请求方
 * 自由给 → 任意登录用户可启一个任意 stdio 子进程）改为：
 * - 仅管理员可增删；
 * - stdio 的 command 只允许白名单里的可执行文件（basename 匹配）；
 * - command / args 拒绝 shell 元字符（防拼接注入）；
 * - 解释器的 eval 类参数（-e/--eval/-c/--command）一律拒绝；
 * - 每次改动写审计（audit_logs，category=tool_call，action=mcp_upsert/mcp_remove）。
 */
const MCP_SAFE_COMMANDS = new Set(['npx', 'node', 'uvx', 'python3', 'python', 'deno', 'bun', 'bunx', 'true'])
const SHELL_META_RE = /[;&|`$<>()[\]{}*?!~#\n\r\t'"\\]/
const INTERPRETER_MARKERS = new Set(['node', 'deno', 'bun', 'bunx', 'npx', 'python', 'python3'])
const EVAL_FLAGS = new Set(['-e', '--eval', '-c', '--command', '-p', '--print', '--shell', '--input-type'])

const MCP_ENV_KEY_RE = /^[A-Za-z0-9_]{1,64}$/
const MCP_HEADER_KEY_RE = /^[A-Za-z0-9-]{1,64}$/

/** 校验 env（stdio 会话环境变量）：键名规则 + 值必须是字符串且不含 NUL。 */
export function validateMcpEnv(env: Record<string, unknown> | undefined): string | null {
  if (env === undefined) return null
  if (env === null || typeof env !== 'object' || Array.isArray(env)) return 'env 必须是对象（KEY: VALUE）'
  for (const [key, value] of Object.entries(env)) {
    if (!MCP_ENV_KEY_RE.test(key)) return `env 键名不合法（${key}）：只允许字母数字下划线，1-64 位`
    if (typeof value !== 'string') return `env[${key}] 的值必须是字符串`
    if (value.includes('\u0000')) return `env[${key}] 的值包含 NUL 字符`
    if (value.length > 16_384) return `env[${key}] 的值过长（>16KB）`
  }
  return null
}

/** 校验 headers（streamable-http 请求头）：名称规则 + 值必须是字符串且不含 NUL/换行。 */
export function validateMcpHeaders(headers: Record<string, unknown> | undefined): string | null {
  if (headers === undefined) return null
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) return 'headers 必须是对象（名称: 值）'
  for (const [key, value] of Object.entries(headers)) {
    if (!MCP_HEADER_KEY_RE.test(key)) return `headers 名称不合法（${key}）：只允许字母数字连字符，1-64 位`
    if (typeof value !== 'string') return `headers[${key}] 的值必须是字符串`
    if (value.includes('\u0000') || /[\r\n]/.test(value)) return `headers[${key}] 的值包含 NUL 或换行`
    if (value.length > 16_384) return `headers[${key}] 的值过长（>16KB）`
  }
  return null
}

/** 校验一次 MCP 服务器配置；通过返回 null，否则返回中文原因。 */
export function validateMcpServer(input: {
  name: string
  transport: 'stdio' | 'streamable-http'
  command?: string | undefined
  args: string[]
  url?: string | undefined
  env?: Record<string, unknown> | undefined
  headers?: Record<string, unknown> | undefined
  /** 同名已登记服务器的原配置（更新时用：命令未变可放行）。 */
  existing?: { command?: string | undefined } | undefined
}): string | null {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(input.name)) return '服务器名只允许字母数字下划线连字符，1-32 位'
  if (input.transport === 'stdio') {
    if (input.command === undefined || input.command === '') return 'stdio 传输必须给出 command'
    if (SHELL_META_RE.test(input.command)) return '命令包含 shell 元字符'
    const base = input.command.split(/[/\\]/).pop() ?? ''
    const unchanged = input.existing?.command !== undefined && input.existing.command === input.command
    if (!MCP_SAFE_COMMANDS.has(base) && !unchanged) {
      return `不允许的命令（${base}）：只允许以 ${[...MCP_SAFE_COMMANDS].join(' / ')} 启动；已登记服务器保持原命令时可直接更新`
    }
    const interpreter = INTERPRETER_MARKERS.has(base)
    for (const arg of input.args) {
      if (SHELL_META_RE.test(arg)) return '参数包含 shell 元字符'
      if (interpreter && EVAL_FLAGS.has(arg)) return `不允许的启动参数（${arg}）：解释器的 eval 类参数可执行任意代码`
    }
  } else {
    if (input.url === undefined || input.url === '') return 'streamable-http 传输必须给出 url'
    let parsed: URL
    try {
      parsed = new URL(input.url)
    } catch {
      return 'url 不合法'
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'url 只支持 http/https'
    if (parsed.username !== '' || parsed.password !== '') return 'url 不允许携带凭据'
  }
  // Cursor 格式支持 env（stdio）/ headers（http）；两者都允许但按传输取用，多余字段保留。
  const envError = validateMcpEnv(input.env)
  if (envError !== null) return envError
  const headersError = validateMcpHeaders(input.headers)
  if (headersError !== null) return headersError
  return null
}

/** MCP 配置变更审计（失败不阻断请求）。 */
export function auditMcpChange(d: Deps, action: 'mcp_upsert' | 'mcp_remove' | 'mcp_import' | 'mcp_test', detail: Record<string, unknown>): void {
  try {
    d.storage
      .prepare('INSERT INTO audit_logs (id, bot_id, category, action, detail, created_at) VALUES (?,?,?,?,?,?)')
      .run(randomUUID(), '', 'tool_call', action, JSON.stringify(detail), new Date().toISOString())
  } catch (e) {
    d.log('[mcp] 审计写入失败: %s', e instanceof Error ? e.message : e)
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
    // 密钥字段：纯打码串 = 保持原值；混入打码占位符 = 输入被污染（粘贴到占位符后面），必须报错。
    if (key.endsWith('api_key') && isMaskedInput(value)) return
    if (key.endsWith('api_key') && hasMaskPlaceholder(value)) {
      throw new Error('密钥里含有打码占位符（••••），请清空输入框后重新粘贴完整密钥')
    }
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

// 播种逻辑在 seed.ts（ensureSeed）—— 旧仓 src/internal/config/seed.ts 的移植，
// 由 /api/bots 与聊天路由自动调用；这里只保留手动触发的管理端点。

export const registerAdminRoutes: RegisterFn = (r, d) => {
  // B3：内容域归属守卫 —— 带 botId 的请求要求 admin 或该 bot 的 owner。
  r.botGuard = (ctx, botId) => botOwnedBy(ctx, d, botId)
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
    try {
      applyAiSettings(d, body)
    } catch (e) {
      err(ctx.res, 400, 'bad_request', e instanceof Error ? e.message : String(e))
      return
    }
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
        // B10：价值禁区（不可被成长改写的人格边界；空数组 = 未设置）
        valueExclusions: d.growth.getValueExclusions(botId),
        nextReviewAt: snap.nextReviewAt,
        nextReviewText: snap.nextReviewText,
        // 控制台读的窗口视图
        window: { nextAt: snap.nextReviewAt, reason: snap.nextReviewText },
      },
    })
  })

  r.post('/api/growth', 'required', (ctx) => {
    fire(ctx, (async (): Promise<void> => {
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
    })())
  })

  /**
   * B10：设置/清除当前生效成长档案的「价值禁区」。
   * 提案评审（创建 + 审批）都会硬校验 changes 不得触碰禁区；空列表 = 明确 no-op。
   * 写域内新增端点，前端可在 /her/growth 页接入。
   */
  r.put('/api/growth/value-exclusions', 'required', (ctx) => {
    const body = bodyRecord(ctx.body)
    const botId = reqStr(body, 'botId') ?? ''
    if (botId === '') {
      err(ctx.res, 400, 'bad_request', '缺少 botId')
      return
    }
    if (!requireBotAccess(ctx, d, botId)) return
    const exclusions = Array.isArray(body['exclusions']) ? body['exclusions'] : (Array.isArray(body['valueExclusions']) ? body['valueExclusions'] : undefined)
    const result = d.growth.setValueExclusions(botId, exclusions ?? [])
    if (!result.ok) {
      err(ctx.res, 400, 'bad_request', result.error)
      return
    }
    json(ctx.res, 200, { data: { botId, valueExclusions: result.valueExclusions } })
  })

  r.post('/api/growth/proposals/:id', 'required', (ctx) => {
    fire(ctx, (async (): Promise<void> => {
      const body = bodyRecord(ctx.body)
      const decision = reqStr(body, 'decision') ?? ''
      const result = await d.growth.decide(ctx.params['id'] ?? '', decision as never, body['changes'])
      if (!result.ok) {
        err(ctx.res, 400, 'growth_decide_failed', result.error ?? '处理失败')
        return
      }
      json(ctx.res, 200, { data: result })
    })())
  })

  // ---- 插件 / 技能 / MCP / 工具 ----

  r.get('/api/plugins', 'required', (ctx) => {
    fire(ctx, (async (): Promise<void> => {
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

      // dsh 原生插件清单（已装、启停状态）与可安装 bundle
      let installed: Array<Record<string, unknown>> = []
      let bundles: Array<Record<string, unknown>> = []
      try {
        const plugins = await d.pluginManager?.listPlugins() ?? []
        installed = plugins.map((p) => ({
          id: p.entryId,
          name: p.moduleName,
          title: localizeText(p.meta?.title) ?? p.moduleName,
          description: localizeText(p.meta?.description) ?? '',
          enabled: p.enabled,
          phase: p.fiberPhase,
        }))
      } catch (e) {
        d.log('[plugins] 已装插件清单读取失败: %s', e instanceof Error ? e.message : e)
      }
      try {
        const list = await d.pluginManager?.listBundles() ?? []
        bundles = list.map((b) => ({
          name: b.name,
          official: b.official,
          availability: b.availability,
          installTarget: b.installTarget?.spec ?? '',
          version: b.installTarget?.version ?? '',
        }))
      } catch (e) {
        d.log('[plugins] bundle 清单读取失败: %s', e instanceof Error ? e.message : e)
      }

      json(ctx.res, 200, {
        data: {
          mcp,
          skills,
          tools: [...tools, ...dshTools],
          dsh,
          installed,
          bundles,
          // skill 是随插件来的：告诉面板每个技能属于哪个插件
          skillSources: skills.map((s) => ({ name: s.name, provider: s.provider, description: s.description })),
        },
      })
    })())
  })

  // ---- 插件安装 / 卸载 / 启停（走 dsh 原生 pluginManager，语义与官方面板一致）----

  r.post('/api/plugins/install', 'admin', (ctx) => {
    fire(ctx, (async (): Promise<void> => {
      const body = bodyRecord(ctx.body)
      const spec = reqStr(body, 'spec', 'name', 'package')?.trim() ?? ''
      if (spec === '') {
        err(ctx.res, 400, 'bad_request', '请填写插件包名或来源（如 dsh-case / github:owner/repo）')
        return
      }
      if (spec.startsWith('-')) {
        err(ctx.res, 400, 'bad_request', '安装源不能以 - 开头')
        return
      }
      const manager = d.pluginManager
      if (!manager) {
        err(ctx.res, 501, 'plugin_manager_unavailable', '当前 profile 没有插件管理器（dsh plugin-manager 未启用）')
        return
      }
      try {
        const result = await manager.installBundle(spec, { enabled: true })
        json(ctx.res, 200, {
          data: {
            ok: result.application === 'applied',
            result,
            // 插件是启动期装配的：新装的插件需要重启 harness 才会加载
            restartRequired: true,
            message: result.application === 'applied'
              ? `已安装 ${spec}，重启 harness 后生效`
              : installFailureMessage(spec, result),
          },
        })
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        err(ctx.res, 400, 'install_failed', message)
      }
    })())
  })

  r.post('/api/plugins/remove', 'admin', (ctx) => {
    fire(ctx, (async (): Promise<void> => {
      const body = bodyRecord(ctx.body)
      const name = reqStr(body, 'name') ?? ''
      if (name === '') {
        err(ctx.res, 400, 'bad_request', '缺少插件名')
        return
      }
      const manager = d.pluginManager
      if (!manager) {
        err(ctx.res, 501, 'plugin_manager_unavailable', '当前 profile 没有插件管理器')
        return
      }
      try {
        const result = await manager.removeBundle(name)
        json(ctx.res, 200, { data: { ok: result.application === 'applied', result, restartRequired: true } })
      } catch (e) {
        err(ctx.res, 400, 'remove_failed', e instanceof Error ? e.message : String(e))
      }
    })())
  })

  r.post('/api/plugins/enable', 'admin', (ctx) => {
    fire(ctx, (async (): Promise<void> => {
      const body = bodyRecord(ctx.body)
      const id = reqStr(body, 'id') ?? ''
      const name = reqStr(body, 'name') ?? ''
      const enabled = reqBool(body, 'enabled')
      if (enabled === undefined) {
        err(ctx.res, 400, 'bad_request', '缺少 enabled')
        return
      }
      const manager = d.pluginManager
      if (!manager) {
        err(ctx.res, 501, 'plugin_manager_unavailable', '当前 profile 没有插件管理器')
        return
      }
      try {
        const result = id !== ''
          ? await manager.setPluginEnabled(id as never, enabled)
          : await manager.setBundleEnabled(name, enabled)
        json(ctx.res, 200, { data: { ok: result.application === 'applied', result, restartRequired: true } })
      } catch (e) {
        err(ctx.res, 400, 'enable_failed', e instanceof Error ? e.message : String(e))
      }
    })())
  })

  r.post('/api/plugins/mcp', 'admin', (ctx) => {
    fire(ctx, (async (): Promise<void> => {
      const body = bodyRecord(ctx.body)
      const name = reqStr(body, 'name', 'serverName') ?? ''
      if (name === '') {
        err(ctx.res, 400, 'bad_request', '缺少服务器名')
        return
      }
      const transport = reqStr(body, 'transport', 'type') === 'streamable-http' ? 'streamable-http' : 'stdio'
      const args = Array.isArray(body['args']) ? (body['args'] as unknown[]).map((a) => String(a)) : []
      const command = reqStr(body, 'command')
      const url = reqStr(body, 'url')
      const existing = d.mcp.listConfigs().find((c) => c.name === name)
      const reject = validateMcpServer({ name, transport, command, args, url, existing })
      if (reject !== null) {
        auditMcpChange(d, 'mcp_upsert', { name, transport, command: command ?? '', rejected: reject, user: ctx.user?.username ?? '' })
        err(ctx.res, 400, 'bad_request', reject)
        return
      }
      const result = await d.mcp.upsertServer({
        name,
        transport,
        ...(command ? { command } : {}),
        ...(args.length > 0 ? { args } : {}),
        ...(url ? { url } : {}),
        enabled: body['enabled'] !== false,
      })
      auditMcpChange(d, 'mcp_upsert', {
        name, transport, command: command ?? '', url: url ?? '', args, ok: result.ok, error: result.error ?? '',
        user: ctx.user?.username ?? '',
      })
      if (!result.ok) {
        err(ctx.res, 400, 'bad_request', result.error ?? '添加失败')
        return
      }
      json(ctx.res, 200, { data: { ok: true } })
    })())
  })

  r.del('/api/plugins/mcp/:name', 'admin', (ctx) => {
    fire(ctx, (async (): Promise<void> => {
      const name = ctx.params['name'] ?? ''
      const result = await d.mcp.removeServer(name)
      auditMcpChange(d, 'mcp_remove', { name, ok: result.ok, error: result.error ?? '', user: ctx.user?.username ?? '' })
      if (!result.ok) {
        err(ctx.res, 404, 'not_found', result.error ?? '服务器不存在')
        return
      }
      json(ctx.res, 200, { data: { ok: true } })
    })())
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
    const result = ensureSeed(d)
    const rows = d.storage.prepare('SELECT * FROM bots ORDER BY created_at ASC').all() as unknown as BotRow[]
    json(ctx.res, 200, { data: { ...result, bots: rows.map((row) => ({ id: row.id, name: row.name })) } })
  })
}
