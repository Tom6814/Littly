/**
 * MCP 管理页后端（Cursor 格式）。
 *
 * 与旧 `/api/plugins/mcp*` 的差异：支持 Cursor 格式的 env/headers、批量导入/导出、
 * 单服务器测试连接与工具列表。旧端点保留兼容（改动仍写审计）。
 *
 * 安全：
 * - 复用 routes-admin 的 validateMcpServer（命令白名单/无 shell 元字符/禁 eval 参数/url 无凭据），
 *   并扩展 env/headers 键名校验（值不回传前端）。
 * - env/headers 值只进配置，不出现在 list/servers 响应；导出端点仅 admin 才含真实值。
 * - 导入/测试/增删改都写 audit_logs（action=mcp_*，detail 不含 env/headers 值）。
 */
import { json, err, bodyRecord, reqStr, reqBool } from './http.ts'
import type { RegisterFn } from './deps.ts'
import { validateMcpServer, auditMcpChange } from './routes-admin.ts'
import type { McpServerConfig } from '@littly/mcp'

/** Cursor 配置里的单个服务器条目。 */
export interface CursorServerEntry {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  enabled?: boolean
}

/** 提取 Cursor 格式的服务器表：`{mcpServers:{...}}` / 裸 `{name:entry}` / 单条目。 */
export function extractCursorServers(body: unknown): { servers: Record<string, CursorServerEntry> } | { error: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { error: '请求体不是 Cursor 配置对象' }
  const rec = body as Record<string, unknown>
  const inner = rec['mcpServers']
  if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
    return { servers: inner as Record<string, CursorServerEntry> }
  }
  // 单条目：{name:'x', command|url:...}
  if (typeof rec['name'] === 'string' && (typeof rec['command'] === 'string' || typeof rec['url'] === 'string')) {
    return { servers: { [rec['name'] as string]: rec as CursorServerEntry } }
  }
  // 裸 map：所有 value 都是对象
  const entries = Object.entries(rec)
  if (entries.length > 0 && entries.every(([, value]) => value !== null && typeof value === 'object' && !Array.isArray(value))) {
    return { servers: rec as Record<string, CursorServerEntry> }
  }
  return { error: '缺少 mcpServers（Cursor 格式：{"mcpServers":{"名称":{...}}}）' }
}

/** Cursor 单条目 → 内部配置（缺 command/url 报错）。 */
export function cursorEntryToConfig(name: string, entry: CursorServerEntry): { config?: McpServerConfig; error?: string } {
  const command = typeof entry.command === 'string' ? entry.command : ''
  const url = typeof entry.url === 'string' ? entry.url : ''
  if (command === '' && url === '') return { error: '条目必须有 command（stdio）或 url（streamable-http）' }
  const args = Array.isArray(entry.args) ? entry.args.map((a) => String(a)) : []
  const env = entry.env !== null && typeof entry.env === 'object' && !Array.isArray(entry.env) ? entry.env as Record<string, string> : undefined
  const headers = entry.headers !== null && typeof entry.headers === 'object' && !Array.isArray(entry.headers) ? entry.headers as Record<string, string> : undefined
  const config: McpServerConfig = {
    name,
    transport: command !== '' ? 'stdio' : 'streamable-http',
    ...(command !== '' ? { command } : {}),
    ...(command !== '' && args.length > 0 ? { args } : {}),
    ...(command !== '' && env !== undefined ? { env } : {}),
    ...(url !== '' ? { url } : {}),
    ...(url !== '' && headers !== undefined ? { headers } : {}),
    enabled: entry.enabled !== false,
  }
  return { config }
}

/** 内部配置 → Cursor 单条目（含真实 env/headers；仅 admin 导出用）。 */
export function configToCursorEntry(config: McpServerConfig): CursorServerEntry {
  const entry: CursorServerEntry = {}
  if (config.transport === 'stdio') {
    if (config.command !== undefined) entry.command = config.command
    if (config.args !== undefined && config.args.length > 0) entry.args = [...config.args]
    if (config.env !== undefined && Object.keys(config.env).length > 0) entry.env = { ...config.env }
  } else {
    if (config.url !== undefined) entry.url = config.url
    if (config.headers !== undefined && Object.keys(config.headers).length > 0) entry.headers = { ...config.headers }
  }
  if (config.enabled === false) entry.enabled = false
  return entry
}

/** 列表视图：env/headers 只给键名（不回值）。 */
export function serverListView(config: McpServerConfig, status: { enabled: boolean; connected: boolean; toolCount: number; lastError?: string }): Record<string, unknown> {
  return {
    name: config.name,
    transport: config.transport,
    ...(config.command !== undefined ? { command: config.command } : {}),
    ...(config.args !== undefined ? { args: [...config.args] } : {}),
    ...(config.url !== undefined ? { url: config.url } : {}),
    enabled: config.enabled,
    envKeys: Object.keys(config.env ?? {}),
    headerKeys: Object.keys(config.headers ?? {}),
    connected: status.connected,
    toolCount: status.toolCount,
    ...(status.lastError !== undefined ? { lastError: clipError(status.lastError) } : {}),
  }
}

/** 记录 MCP 审计时的安全 detail（不含 env/headers 值）。 */
function safeDetail(config: McpServerConfig): Record<string, unknown> {
  return {
    name: config.name,
    transport: config.transport,
    envKeys: Object.keys(config.env ?? {}).length,
    headerKeys: Object.keys(config.headers ?? {}).length,
  }
}

/** 错误文本截断：http MCP 服务器失败时可能回整页 HTML，列表里只留可读短摘要。 */
function clipError(message: string | undefined): string {
  const text = String(message ?? '').replace(/\s+/g, ' ').trim()
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}

export const registerMcpRoutes: RegisterFn = (r, d) => {
  r.get('/api/mcp/servers', 'required', (ctx) => {
    const servers = d.mcp.listConfigs().map((config) => serverListView(config, d.mcp.statusOf(config.name)))
    json(ctx.res, 200, { data: { servers } })
  })

  r.post('/api/mcp/servers', 'admin', async (ctx) => {
    const body = bodyRecord(ctx.body)
    const name = reqStr(body, 'name') ?? ''
    const transport = reqStr(body, 'transport') === 'streamable-http' ? 'streamable-http' : 'stdio'
    const command = reqStr(body, 'command')
    const url = reqStr(body, 'url')
    const args = Array.isArray(body['args']) ? (body['args'] as unknown[]).map((a) => String(a)) : []
    const env = body['env'] !== null && typeof body['env'] === 'object' && !Array.isArray(body['env']) ? body['env'] as Record<string, string> : undefined
    const headers = body['headers'] !== null && typeof body['headers'] === 'object' && !Array.isArray(body['headers']) ? body['headers'] as Record<string, string> : undefined
    const enabled = reqBool(body, 'enabled')
    const reject = validateMcpServer({ name, transport, ...(command !== undefined ? { command } : {}), args, ...(url !== undefined ? { url } : {}), ...(env !== undefined ? { env } : {}), ...(headers !== undefined ? { headers } : {}) })
    if (reject !== null) { err(ctx.res, 400, 'bad_mcp_server', reject); return }
    const config: McpServerConfig = {
      name,
      transport,
      ...(command !== undefined ? { command } : {}),
      ...(args.length > 0 ? { args } : {}),
      ...(env !== undefined ? { env } : {}),
      ...(url !== undefined ? { url } : {}),
      ...(headers !== undefined ? { headers } : {}),
      enabled: enabled !== false,
    }
    const result = await d.mcp.upsertServer(config)
    auditMcpChange(d, 'mcp_upsert', { ...safeDetail(config), ok: result.ok, error: result.error ?? '', user: ctx.user?.username ?? '', via: 'routes-mcp' })
    if (!result.ok) { err(ctx.res, 400, 'bad_mcp_server', result.error ?? '保存失败'); return }
    json(ctx.res, 200, { data: { ok: true, server: serverListView(config, d.mcp.statusOf(name)) } })
  })

  r.patch('/api/mcp/servers/:name', 'admin', async (ctx) => {
    const name = ctx.params['name'] ?? ''
    const existing = d.mcp.listConfigs().find((c) => c.name === name)
    if (existing === undefined) { err(ctx.res, 404, 'not_found', '服务器不存在'); return }
    const body = bodyRecord(ctx.body)
    const command = reqStr(body, 'command') ?? existing.command
    const url = reqStr(body, 'url') ?? existing.url
    const transport = (command !== undefined && command !== '') || existing.transport === 'stdio'
      ? 'stdio' : 'streamable-http'
    const args = Array.isArray(body['args']) ? (body['args'] as unknown[]).map((a) => String(a)) : (existing.args ?? [])
    const envIn = body['env']
    const headersIn = body['headers']
    // 局部更新语义：env/headers 显式传对象则整体替换；传 null/缺省保留原值。
    const env = envIn !== null && typeof envIn === 'object' && !Array.isArray(envIn)
      ? envIn as Record<string, string>
      : existing.env
    const headers = headersIn !== null && typeof headersIn === 'object' && !Array.isArray(headersIn)
      ? headersIn as Record<string, string>
      : existing.headers
    const enabled = reqBool(body, 'enabled') ?? existing.enabled
    const reject = validateMcpServer({ name, transport, ...(command !== undefined ? { command } : {}), args, ...(url !== undefined ? { url } : {}), ...(env !== undefined ? { env } : {}), ...(headers !== undefined ? { headers } : {}), existing: { command: existing.command } })
    if (reject !== null) { err(ctx.res, 400, 'bad_mcp_server', reject); return }
    const config: McpServerConfig = {
      name,
      transport,
      ...(command !== undefined ? { command } : {}),
      ...(args.length > 0 ? { args } : {}),
      ...(env !== undefined && Object.keys(env).length > 0 ? { env } : {}),
      ...(url !== undefined ? { url } : {}),
      ...(headers !== undefined && Object.keys(headers).length > 0 ? { headers } : {}),
      enabled,
    }
    const result = await d.mcp.upsertServer(config)
    auditMcpChange(d, 'mcp_upsert', { ...safeDetail(config), ok: result.ok, error: result.error ?? '', user: ctx.user?.username ?? '', via: 'routes-mcp-patch' })
    if (!result.ok) { err(ctx.res, 400, 'bad_mcp_server', result.error ?? '保存失败'); return }
    json(ctx.res, 200, { data: { ok: true, server: serverListView(config, d.mcp.statusOf(name)) } })
  })

  r.del('/api/mcp/servers/:name', 'admin', async (ctx) => {
    const name = ctx.params['name'] ?? ''
    const result = await d.mcp.removeServer(name)
    auditMcpChange(d, 'mcp_remove', { name, ok: result.ok, error: result.error ?? '', user: ctx.user?.username ?? '', via: 'routes-mcp' })
    if (!result.ok) { err(ctx.res, 404, 'not_found', result.error ?? '服务器不存在'); return }
    json(ctx.res, 200, { data: { ok: true, removed: name } })
  })

  r.post('/api/mcp/import', 'admin', async (ctx) => {
    const extracted = extractCursorServers(ctx.body)
    if ('error' in extracted) { err(ctx.res, 400, 'bad_cursor_config', extracted.error); return }
    const existingNames = new Set(d.mcp.listConfigs().map((c) => c.name))
    const added: string[] = []
    const updated: string[] = []
    const errors: Array<{ name: string; error: string }> = []
    for (const [name, entry] of Object.entries(extracted.servers)) {
      const converted = cursorEntryToConfig(name, entry)
      if (converted.config === undefined) { errors.push({ name, error: converted.error ?? '条目格式不对' }); continue }
      const config = converted.config
      const existing = d.mcp.listConfigs().find((c) => c.name === name)
      const reject = validateMcpServer({ name: config.name, transport: config.transport, ...(config.command !== undefined ? { command: config.command } : {}), args: config.args ?? [], ...(config.url !== undefined ? { url: config.url } : {}), ...(config.env !== undefined ? { env: config.env } : {}), ...(config.headers !== undefined ? { headers: config.headers } : {}), existing: { command: existing?.command } })
      if (reject !== null) { errors.push({ name, error: reject }); continue }
      const result = await d.mcp.upsertServer(config)
      if (!result.ok) { errors.push({ name, error: result.error ?? '保存失败' }); continue }
      if (existingNames.has(name)) updated.push(name)
      else added.push(name)
    }
    auditMcpChange(d, 'mcp_import', { added: added.length, updated: updated.length, errors: errors.length, names: [...added, ...updated], user: ctx.user?.username ?? '' })
    json(ctx.res, 200, { data: { added, updated, errors } })
  })

  r.get('/api/mcp/export', 'admin', (ctx) => {
    const mcpServers: Record<string, CursorServerEntry> = {}
    for (const config of d.mcp.listConfigs()) mcpServers[config.name] = configToCursorEntry(config)
    json(ctx.res, 200, { data: { mcpServers } })
  })

  r.post('/api/mcp/servers/:name/test', 'admin', async (ctx) => {
    const name = ctx.params['name'] ?? ''
    const result = await d.mcp.testServer(name)
    auditMcpChange(d, 'mcp_test', { name, ok: result.ok, toolCount: result.toolCount, error: (result.error ?? '').slice(0, 300), user: ctx.user?.username ?? '' })
    json(ctx.res, 200, { data: result })
  })

  r.get('/api/mcp/tools', 'required', (ctx) => {
    const enabledNames = new Set(d.mcp.listConfigs().filter((c) => c.enabled).map((c) => c.name))
    const defs = d.hub.tools.collectTools()
    const tools = defs
      .filter((def) => def.function.name.startsWith('mcp__'))
      .map((def) => {
        const rest = def.function.name.slice('mcp__'.length)
        const index = rest.indexOf('__')
        const server = index >= 0 ? rest.slice(0, index) : rest
        const rawName = index >= 0 ? rest.slice(index + 2) : ''
        return { server, name: rawName, description: def.function.description ?? '' }
      })
      .filter((tool) => enabledNames.has(tool.server))
    json(ctx.res, 200, { data: { tools, count: tools.length } })
  })
}
