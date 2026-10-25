#!/usr/bin/env node
/**
 * 端到端验收：真启动 harness，真注册登录，真调 API。
 * 运行：node scripts/verify-e2e.mjs [port]
 *
 * 覆盖：
 *  - 启动健康（/api 200）
 *  - 注册 + 登录拿会话 cookie
 *  - /api/plugins：Littly 内置工具 + dsh 插件工具（case_convert）+ skills + dsh 插件清单
 *  - /api/growth：档案快照
 *  - /api/call/requests：来电列表
 *  - POST /api/plugins/mcp：加 MCP 服务器 → 出现在清单里
 *  - DELETE /api/plugins/mcp/:name：删掉
 *  - PATCH /api/plugins/tools：按角色停用工具 → 清单里的 enabledBots 变化
 *  - /api/bili/status：sidecar 不可达时返回 502 而不是崩
 */
const port = process.argv[2] || '3471'
const base = `http://127.0.0.1:${port}`

let pass = 0
let fail = 0
const ok = (cond, name) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.error(`  ✗ ${name}`) }
}

const jar = new Map()
const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')

async function api(path, init = {}) {
  const headers = { ...(init.headers ?? {}) }
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  const ck = cookieHeader()
  if (ck) headers['cookie'] = ck
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    redirect: 'manual',
  })
  const setCookie = res.headers.getSetCookie?.() ?? []
  for (const c of setCookie) {
    const [pair] = c.split(';')
    const idx = pair.indexOf('=')
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim())
  }
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = { raw: text } }
  return { status: res.status, json, text }
}

console.log('== 健康 ==')
const health = await api('/api')
ok(health.status === 200, `/api 200（实际 ${health.status}）`)

console.log('== 注册 + 登录 ==')
const username = `e2e_${Date.now()}`
let reg = await api('/api/auth/register', { method: 'POST', body: { username, password: 'e2e-pass-123' } })
if (reg.status !== 200) {
  reg = await api('/api/auth/login', { method: 'POST', body: { username, password: 'e2e-pass-123' } })
}
ok(reg.status === 200, `注册/登录成功（${reg.status}）`)
ok(jar.size > 0, '拿到会话 cookie')
const sess = await api('/api/auth/session')
ok(sess.status === 200 && sess.json?.data?.user?.username === username, '会话可回读')

console.log('== 插件清单（真实数据）==')
const plugins = await api('/api/plugins')
ok(plugins.status === 200, `/api/plugins 200（${plugins.status}）`)
const pdata = plugins.json?.data ?? {}
const toolNames = (pdata.tools ?? []).map((t) => t.name)
ok(toolNames.includes('remember'), 'Littly 内置工具在清单里')
ok(toolNames.includes('bili'), 'bili 元工具在清单里')
ok(toolNames.includes('case_convert'), '★ dsh 社区插件工具 case_convert 可见（Littly↔dsh 桥）')
const caseTool = (pdata.tools ?? []).find((t) => t.name === 'case_convert')
ok(typeof caseTool?.description === 'string' && caseTool.description.length > 0, 'dsh 工具描述透传')
ok(Array.isArray(pdata.dsh) && pdata.dsh.length > 0, `dsh 插件清单非空（${(pdata.dsh ?? []).length}）`)
ok(Array.isArray(pdata.skills), 'skills 字段存在')
ok(Array.isArray(pdata.mcp), 'mcp 字段存在')

console.log('== 成长档案 ==')
const growth = await api('/api/growth?botId=none')
ok(growth.status === 200, `/api/growth 200（${growth.status}）`)
ok(growth.json?.data?.window !== undefined, '成长窗口字段存在（评审时间可见）')

console.log('== 来电请求 ==')
const calls = await api('/api/call/requests?botId=none')
ok(calls.status === 200, `/api/call/requests 200（${calls.status}）`)
ok(Array.isArray(calls.json?.data?.calls), 'calls 数组存在')

console.log('== MCP 服务器增删 ==')
const add = await api('/api/plugins/mcp', { method: 'POST', body: { name: 'e2e-demo', transport: 'stdio', command: 'true', args: [] } })
ok(add.status === 200, `加 MCP 服务器 200（${add.status}）`)
const list1 = await api('/api/plugins')
const demo = (list1.json?.data?.mcp ?? []).find((s) => s.name === 'e2e-demo')
ok(demo !== undefined, 'MCP 服务器出现在清单里')
ok(demo?.transport === 'stdio', '传输类型正确')
const del = await api('/api/plugins/mcp/e2e-demo', { method: 'DELETE' })
ok(del.status === 200, `删 MCP 服务器 200（${del.status}）`)
const list2 = await api('/api/plugins')
ok(!(list2.json?.data?.mcp ?? []).some((s) => s.name === 'e2e-demo'), '删除后不再出现在清单里')

console.log('== 工具按角色启停 ==')
const bots = await api('/api/bots')
const botList = bots.json?.data?.bots ?? bots.json?.data ?? []
const botId = Array.isArray(botList) ? botList[0]?.id : undefined
if (!botId) {
  console.log('  （跳过：库里还没有 bot，停用断言需要先建角色）')
} else {
  const before = (await api('/api/plugins')).json?.data?.tools?.find((t) => t.name === 'gen_image')?.enabledBots ?? []
  const off = await api('/api/plugins/tools', { method: 'PATCH', body: { name: 'gen_image', botId, enabled: false } })
  ok(off.status === 200, `停用工具 200（${off.status}）`)
  const after = (await api('/api/plugins')).json?.data?.tools?.find((t) => t.name === 'gen_image')?.enabledBots ?? []
  ok(!after.includes(botId), '停用后该角色不在 enabledBots 里')
  await api('/api/plugins/tools', { method: 'PATCH', body: { name: 'gen_image', botId, enabled: true } })
  const restored = (await api('/api/plugins')).json?.data?.tools?.find((t) => t.name === 'gen_image')?.enabledBots ?? []
  ok(restored.includes(botId), '恢复后重新出现在 enabledBots 里')
}

console.log('== bili sidecar 不可达时的降级 ==')
const bili = await api('/api/bili/status')
ok(bili.status === 502 || bili.status === 200, `bili 端点不崩（${bili.status}）`)
if (bili.status === 502) {
  ok(bili.json?.error?.code === 'bili_unavailable' || bili.json?.error?.code === 'unavailable', '错误信封统一')
}

console.log('== 未登录访问受保护端点 ==')
const saved = new Map(jar)
jar.clear()
const anon = await api('/api/plugins')
ok(anon.status === 401, `未登录 /api/plugins → 401（${anon.status}）`)
ok(anon.json?.error?.code === 'unauthorized', '未登录错误码统一')
for (const [k, v] of saved) jar.set(k, v)

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
