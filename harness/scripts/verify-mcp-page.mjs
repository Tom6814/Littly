#!/usr/bin/env node
/**
 * MCP 管理页后端行为验证（Cursor 格式）。
 * 运行：node scripts/verify-mcp-page.mjs
 *
 * 用「假 Router + 假 LittlyMcpManager + 真 SQLite 审计」直接驱动 routes-mcp 的 handler，
 * 不联网、不 spawn MCP 子进程。覆盖：
 *  - Cursor 格式 import / export 往返（含 env/headers 真实值，仅 admin）
 *  - GET servers 只回 env/header 键名（值不外泄）
 *  - 单条 CRUD + enabled 切换 + PATCH 局部更新
 *  - 非法输入拒绝（名字/命令/shell 元字符/eval 参数/url/env 键/header 换行）
 *  - test 成功列工具 / 失败可读错误
 *  - 导入部分成功（errors 不影响 added/updated）
 *  - 审计写入（mcp_import/mcp_test/mcp_upsert/mcp_remove，detail 不含 env 值）
 *  - 旧 /api/plugins/mcp 路由仍注册（不回归）
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LittlyStorage } from '../packages/littly/storage/src/index.ts'
import {
  registerMcpRoutes, extractCursorServers, cursorEntryToConfig, configToCursorEntry, serverListView,
} from '../packages/littly/console-api/src/routes-mcp.ts'
import { validateMcpServer, validateMcpEnv, validateMcpHeaders, registerAdminRoutes } from '../packages/littly/console-api/src/routes-admin.ts'

let pass = 0
let fail = 0
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? `（${detail}）` : ''}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? `（${detail}）` : ''}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'littly-mcp-page-'))
const storage = new LittlyStorage({ logger: { info: () => {} } }, { file: join(dir, 'mcp.db') })
storage.setSetting('platform.secret', 'mcp-test-secret')

// ---------- 假 Router / 假 mcp 管理器 ----------
class FakeRouter {
  routes = []
  add(method, path, auth, handler) { this.routes.push({ method, path, auth, handler }) }
  get(p, a, h) { this.add('GET', p, a, h) }
  post(p, a, h) { this.add('POST', p, a, h) }
  patch(p, a, h) { this.add('PATCH', p, a, h) }
  put(p, a, h) { this.add('PUT', p, a, h) }
  del(p, a, h) { this.add('DELETE', p, a, h) }
}
const fakeRes = () => ({
  statusCode: 0, headers: {}, body: '',
  writeHead(code, headers) { this.statusCode = code; this.headers = headers ?? {} },
  end(body) { this.body = String(body ?? '') },
})
const matchPath = (pattern, actual) => {
  const a = pattern.split('/').filter(Boolean)
  const b = actual.split('/').filter(Boolean)
  if (a.length !== b.length) return null
  const params = {}
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i])
    else if (a[i] !== b[i]) return null
  }
  return params
}
async function call(router, method, path, { body, user = { username: 'admin', role: 'admin' }, query = '' } = {}) {
  const route = router.routes.find((rt) => rt.method === method && matchPath(rt.path, path) !== null)
  if (route === undefined) return { status: 404, json: null, route: null }
  const params = matchPath(route.path, path) ?? {}
  const res = fakeRes()
  await route.handler({ req: {}, res, url: new URL(`http://x${path}`), method, params, query: new URLSearchParams(query), body, fields: {}, files: [], user })
  let parsed = null
  try { parsed = res.body ? JSON.parse(res.body) : null } catch { parsed = { raw: res.body } }
  return { status: res.statusCode, json: parsed, route }
}

const configs = new Map()
const connected = new Set()
const fakeMcp = {
  listConfigs: () => [...configs.values()],
  statusOf: (name) => {
    const cfg = configs.get(name)
    return { enabled: cfg?.enabled === true, connected: connected.has(name), toolCount: connected.has(name) ? 2 : 0 }
  },
  status: () => [...configs.values()].map((config) => ({ config, state: connected.has(config.name) ? 'connected' : 'disconnected', tools: [] })),
  upsertServer: async (cfg) => {
    const existed = configs.has(cfg.name)
    configs.set(cfg.name, cfg)
    if (cfg.enabled) connected.add(cfg.name)
    else connected.delete(cfg.name)
    return { ok: true, existed }
  },
  removeServer: async (name) => {
    if (!configs.has(name)) return { ok: false, error: '服务器不存在' }
    configs.delete(name); connected.delete(name)
    return { ok: true }
  },
  testServer: async (name) => {
    const cfg = configs.get(name)
    if (cfg === undefined) return { ok: false, tools: [], toolCount: 0, error: '服务器不存在' }
    if (cfg.command === 'false') return { ok: false, tools: [], toolCount: 0, error: '连接失败：spawn ENOENT' }
    connected.add(name)
    return { ok: true, tools: [{ name: 'echo', description: '回显' }, { name: 'lookup' }], toolCount: 2 }
  },
  connect: async () => ({ ok: true }),
  disconnect: async () => {},
  disconnectAll: async () => {},
}
const fakeDef = (name, description) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties: {} } } })
const fakeHub = { tools: { collectTools: () => [fakeDef('mcp__alpha__echo', '回显'), fakeDef('mcp__beta__lookup', '查询'), fakeDef('bili', 'B站')] } }
const deps = { storage, mcp: fakeMcp, hub: fakeHub, log: () => {} }
const router = new FakeRouter()
registerMcpRoutes(router, deps)

console.log('== Cursor 格式解析 / 校验纯函数 ==')
{
  const wrapped = extractCursorServers({ mcpServers: { a: { command: 'npx', args: ['-y', 'pkg'] } } })
  ok('servers' in wrapped && wrapped.servers.a.command === 'npx', '解析 {mcpServers:{...}}')
  const bare = extractCursorServers({ a: { url: 'https://x/mcp' } })
  ok('servers' in bare && bare.servers.a.url === 'https://x/mcp', '解析裸 mcpServers 对象')
  const single = extractCursorServers({ name: 'solo', command: 'node' })
  ok('servers' in single && single.servers.solo.command === 'node', '解析单条目')
  ok('error' in extractCursorServers('nope'), '非对象 → 错误')
  ok('error' in extractCursorServers({ random: 1 }), '无服务器条目 → 错误')
  const stdio = cursorEntryToConfig('s', { command: 'npx', args: ['-y', 'pkg'], env: { TOKEN: 't' } }).config
  ok(stdio?.transport === 'stdio' && stdio.command === 'npx' && stdio.env.TOKEN === 't', 'Cursor stdio → 内部配置（含 env）')
  const http = cursorEntryToConfig('h', { url: 'https://x/mcp', headers: { Authorization: 'Bearer t' } }).config
  ok(http?.transport === 'streamable-http' && http.headers.Authorization === 'Bearer t', 'Cursor http → 内部配置（含 headers）')
  ok(cursorEntryToConfig('bad', {}).error?.includes('command'), '条目缺 command/url → 可读错误')
  const back = configToCursorEntry(stdio)
  ok(back.command === 'npx' && back.env?.TOKEN === 't', '内部配置 → Cursor 条目（env 真值）')
  ok(configToCursorEntry(http).url === 'https://x/mcp', '内部配置 → Cursor 条目（url）')
  const view = serverListView(stdio, { enabled: true, connected: false, toolCount: 0 })
  ok(Array.isArray(view.envKeys) && view.envKeys[0] === 'TOKEN' && view.env === undefined, '列表视图只给 env 键名')
  // 校验规则
  ok(validateMcpServer({ name: 'ok', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'] }) === null, '旧参数形状仍通过（不回归）')
  ok(validateMcpServer({ name: 'bad name', transport: 'stdio', command: 'npx', args: [] }) !== null, '非法名字拒绝')
  ok(validateMcpServer({ name: 'x', transport: 'stdio', command: 'rm', args: [] }) !== null, '非白名单命令拒绝（rm）')
  ok(validateMcpServer({ name: 'x', transport: 'stdio', command: 'node', args: ['-e', 'x'] }) !== null, '解释器 eval 参数拒绝')
  ok(validateMcpServer({ name: 'x', transport: 'stdio', command: 'npx', args: ['a;b'] }) !== null, '参数 shell 元字符拒绝')
  ok(validateMcpServer({ name: 'x', transport: 'streamable-http', url: 'ftp://x' }) !== null, '非 http(s) url 拒绝')
  ok(validateMcpServer({ name: 'x', transport: 'streamable-http', url: 'https://u:p@x/mcp' }) !== null, 'url 携带凭据拒绝')
  ok(validateMcpEnv({ 'BAD-KEY': 'x' }) !== null, 'env 键名非法拒绝（含连字符）')
  ok(validateMcpEnv({ OK: 1 }) !== null, 'env 值非字符串拒绝')
  ok(validateMcpEnv({ OK: 'a\u0000b' }) !== null, 'env 值含 NUL 拒绝')
  ok(validateMcpHeaders({ 'Bad Header': 'x' }) !== null, 'headers 名称非法拒绝')
  ok(validateMcpHeaders({ OK: 'a\nb' }) !== null, 'headers 值含换行拒绝')
  ok(validateMcpEnv({ TOKEN: 'secret-token' }) === null, '合法 env 通过')
}

console.log('== POST /api/mcp/servers（单个 upsert）==')
{
  const stdio = await call(router, 'POST', '/api/mcp/servers', { body: { name: 'alpha', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { TOKEN: 'secret-token' } } })
  ok(stdio.status === 200 && stdio.json?.data?.ok === true, 'POST stdio 服务器 200')
  ok(stdio.json?.data?.server?.envKeys?.join(',') === 'TOKEN', '响应只回 env 键名')
  ok(JSON.stringify(stdio.json).includes('secret-token') === false, '响应不含 env 值')
  const http = await call(router, 'POST', '/api/mcp/servers', { body: { name: 'beta', transport: 'streamable-http', url: 'https://x/mcp', headers: { Authorization: 'Bearer abc' } } })
  ok(http.status === 200 && http.json?.data?.server?.headerKeys?.join(',') === 'Authorization', 'POST http 服务器（headers 键名）')
  const bad = await call(router, 'POST', '/api/mcp/servers', { body: { name: 'gamma', transport: 'stdio', command: 'rm', args: [] } })
  ok(bad.status === 400 && bad.json?.error?.code === 'bad_mcp_server', '非法命令 → 400 bad_mcp_server')
  const badEnv = await call(router, 'POST', '/api/mcp/servers', { body: { name: 'delta', transport: 'stdio', command: 'npx', args: [], env: { 'BAD-KEY': 'x' } } })
  ok(badEnv.status === 400, '非法 env 键 → 400')
  ok(configs.size === 2, '非法请求没有落库（2 个合法服务器）')
}

console.log('== GET /api/mcp/servers（键名不回值 / 状态）==')
{
  const list = await call(router, 'GET', '/api/mcp/servers')
  ok(list.status === 200 && list.json?.data?.servers?.length === 2, 'GET servers 200 且 2 个')
  ok(JSON.stringify(list.json).includes('secret-token') === false && JSON.stringify(list.json).includes('Bearer abc') === false, '列表不含 env/headers 值')
  const alpha = list.json.data.servers.find((s) => s.name === 'alpha')
  ok(alpha.enabled === true && alpha.envKeys[0] === 'TOKEN' && Array.isArray(alpha.headerKeys), 'alpha 含 enabled/envKeys/headerKeys')
  ok(alpha.connected === true && alpha.toolCount === 2, 'alpha 状态 connected/toolCount（来自 manager.statusOf）')
}

console.log('== PATCH / DELETE ==')
{
  const patched = await call(router, 'PATCH', '/api/mcp/servers/alpha', { body: { enabled: false, args: ['-y', 'pkg', '--verbose'] } })
  ok(patched.status === 200 && patched.json?.data?.server?.enabled === false, 'PATCH enabled=false')
  ok(patched.json?.data?.server?.args?.includes('--verbose') === true, 'PATCH 局部更新 args')
  ok(patched.json?.data?.server?.envKeys?.[0] === 'TOKEN', 'PATCH 未传 env 时保留原 env')
  const keepCommand = await call(router, 'PATCH', '/api/mcp/servers/alpha', { body: { command: 'npx' } })
  ok(keepCommand.status === 200, 'PATCH 保持原命令可放行（白名单 unchanged 语义）')
  const missing = await call(router, 'PATCH', '/api/mcp/servers/nope', { body: { enabled: true } })
  ok(missing.status === 404, 'PATCH 不存在 → 404')
  const removed = await call(router, 'DELETE', '/api/mcp/servers/beta')
  ok(removed.status === 200 && removed.json?.data?.removed === 'beta', 'DELETE 服务器')
  ok(configs.has('beta') === false, 'DELETE 后不在配置里')
  const rmMissing = await call(router, 'DELETE', '/api/mcp/servers/beta')
  ok(rmMissing.status === 404, 'DELETE 不存在 → 404')
}

console.log('== POST /api/mcp/import（Cursor 批量，部分失败）==')
{
  const before = configs.size
  const imported = await call(router, 'POST', '/api/mcp/import', {
    body: { mcpServers: {
      alpha: { command: 'npx', args: ['-y', 'pkg'], env: { TOKEN: 'secret-token' } }, // 已存在 → updated
      gamma: { command: 'node', args: ['server.js'], env: { API_KEY: 'k-123' } }, // 新增
      delta: { url: 'https://x/mcp', headers: { Authorization: 'Bearer abc' } }, // 新增
      badcmd: { command: 'rm', args: ['-rf'] }, // 失败
    } },
  })
  ok(imported.status === 200, 'import 200')
  ok(imported.json?.data?.added?.sort().join(',') === 'delta,gamma', 'import added 正确')
  ok(imported.json?.data?.updated?.join(',') === 'alpha', 'import updated 正确')
  ok(imported.json?.data?.errors?.length === 1 && imported.json.data.errors[0].name === 'badcmd', 'import 部分失败进入 errors')
  ok(configs.size === before + 2, 'import 合法条目落库（非法条目不落库）')
  ok(JSON.stringify(imported.json).includes('k-123') === false, 'import 响应不含 env 值')
  const single = await call(router, 'POST', '/api/mcp/import', { body: { name: 'solo', command: 'true' } })
  ok(single.status === 200 && single.json?.data?.added?.includes('solo'), 'import 接受单条目')
  const badBody = await call(router, 'POST', '/api/mcp/import', { body: 'nope' })
  ok(badBody.status === 400 && badBody.json?.error?.code === 'bad_cursor_config', 'import 非法格式 → 400')
}

console.log('== GET /api/mcp/export（Cursor 格式，含真实值）==')
{
  const exported = await call(router, 'GET', '/api/mcp/export')
  ok(exported.status === 200 && typeof exported.json?.data?.mcpServers === 'object', 'export 200 + mcpServers')
  const alpha = exported.json.data.mcpServers.alpha
  ok(alpha.command === 'npx' && alpha.env?.TOKEN === 'secret-token', 'export 含 stdio command/env 真实值（admin）')
  const delta = exported.json.data.mcpServers.delta
  ok(delta.url === 'https://x/mcp' && delta.headers?.Authorization === 'Bearer abc', 'export 含 http url/headers 真实值')
  ok(exported.json.data.mcpServers.solo.command === 'true', 'export 含后加单条目')
  // 往返：export → import 到空管理器
  const saved = new Map(configs)
  configs.clear(); connected.clear()
  const round = await call(router, 'POST', '/api/mcp/import', { body: { mcpServers: exported.json.data.mcpServers } })
  ok(round.json?.data?.added?.length === saved.size, 'export → import 往返全部 added')
  ok(JSON.stringify([...configs.values()].find((c) => c.name === 'alpha')).includes('secret-token'), '往返后 env 值保留')
}

console.log('== POST /api/mcp/servers/:name/test ==')
{
  const success = await call(router, 'POST', '/api/mcp/servers/alpha/test')
  ok(success.status === 200 && success.json?.data?.ok === true, 'test 成功 ok=true')
  ok(success.json?.data?.toolCount === 2 && success.json?.data?.tools[0].name === 'echo', 'test 返回工具列表')
  ok(success.json?.data?.tools[1].description === undefined, '无描述工具不带 description')
  const notFound = await call(router, 'POST', '/api/mcp/servers/nope/test')
  ok(notFound.status === 200 && notFound.json?.data?.ok === false && notFound.json?.data?.error?.includes('不存在'), 'test 不存在 → ok:false + 可读错误')
  configs.set('broken', { name: 'broken', transport: 'stdio', command: 'false', args: [], enabled: true })
  const failed = await call(router, 'POST', '/api/mcp/servers/broken/test')
  ok(failed.json?.data?.ok === false && failed.json?.data?.error?.includes('连接失败'), 'test 连接失败 → 可读错误')
}

console.log('== GET /api/mcp/tools（聚合启用服务器）==')
{
  await call(router, 'PATCH', '/api/mcp/servers/alpha', { body: { enabled: true } })
  const tools = await call(router, 'GET', '/api/mcp/tools')
  ok(tools.status === 200 && tools.json?.data?.count >= 1, 'tools 200 且聚合到工具')
  const echo = tools.json.data.tools.find((t) => t.name === 'echo')
  ok(echo?.server === 'alpha' && echo?.description === '回显', 'tools 含 server/name/description')
  ok(tools.json.data.tools.some((t) => t.server === 'bili') === false, '非 mcp__ 工具不混入')
  // 禁用 alpha 后不再聚合它的工具
  await call(router, 'PATCH', '/api/mcp/servers/alpha', { body: { enabled: false } })
  const tools2 = await call(router, 'GET', '/api/mcp/tools')
  ok(tools2.json.data.tools.some((t) => t.server === 'alpha') === false, '禁用服务器的工具不聚合')
}

console.log('== 审计 ==')
{
  const rows = storage.prepare("SELECT action, detail FROM audit_logs WHERE category = 'tool_call'").all()
  const actions = rows.map((r) => r.action)
  ok(actions.includes('mcp_upsert'), '审计 mcp_upsert')
  ok(actions.includes('mcp_import'), '审计 mcp_import')
  ok(actions.includes('mcp_test'), '审计 mcp_test')
  ok(actions.includes('mcp_remove'), '审计 mcp_remove')
  const importDetail = rows.find((r) => r.action === 'mcp_import')?.detail ?? ''
  ok(importDetail.includes('"added":2') || /added":2/.test(importDetail), 'mcp_import detail 记 added 数')
  ok(JSON.stringify(rows).includes('secret-token') === false && JSON.stringify(rows).includes('k-123') === false, '审计 detail 不含 env 值')
}

console.log('== 鉴权声明 / 旧端点兼容 ==')
{
  const getServers = router.routes.find((r) => r.method === 'GET' && r.path === '/api/mcp/servers')
  ok(getServers.auth === 'required', 'GET /api/mcp/servers 声明 required')
  for (const [method, path] of [['POST', '/api/mcp/servers'], ['PATCH', '/api/mcp/servers/:name'], ['DELETE', '/api/mcp/servers/:name'], ['POST', '/api/mcp/import'], ['GET', '/api/mcp/export'], ['POST', '/api/mcp/servers/:name/test']]) {
    ok(router.routes.some((r) => r.method === method && r.path === path && r.auth === 'admin'), `${method} ${path} 声明 admin`)
  }
  ok(router.routes.some((r) => r.method === 'GET' && r.path === '/api/mcp/tools' && r.auth === 'required'), 'GET /api/mcp/tools 声明 required')
  // 旧 /api/plugins/mcp* 仍注册（不回归）
  const legacyRouter = new FakeRouter()
  const noop = () => {}
  const legacyDeps = new Proxy({}, { get: () => noop })
  registerAdminRoutes(legacyRouter, legacyDeps)
  ok(legacyRouter.routes.some((r) => r.method === 'POST' && r.path === '/api/plugins/mcp'), '旧 POST /api/plugins/mcp 仍注册')
  ok(legacyRouter.routes.some((r) => r.method === 'DELETE' && r.path === '/api/plugins/mcp/:name'), '旧 DELETE /api/plugins/mcp/:name 仍注册')
  const oldShape = legacyRouter.routes.find((r) => r.method === 'POST' && r.path === '/api/plugins/mcp')
  ok(oldShape.auth === 'admin', '旧端点仍是 admin（B1 安全修复不回归）')
}

storage.close()
rmSync(dir, { recursive: true, force: true })
console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
