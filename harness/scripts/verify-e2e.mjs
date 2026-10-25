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
// 容器验收时会用 LITTLY_E2E_USER 指向一个**预先建好的管理员**账号
// （容器里的库在别的进程/别的卷上，测试脚本没法直接提权 ——
//  「首个注册用户即 admin」那条只在库里没用户时成立）。
const username = process.env.LITTLY_E2E_USER ?? `e2e_${Date.now()}`
const password = process.env.LITTLY_E2E_PASS ?? 'e2e-pass-123'
let reg = await api('/api/auth/register', { method: 'POST', body: { username, password } })
if (reg.status !== 200) {
  reg = await api('/api/auth/login', { method: 'POST', body: { username, password } })
}
ok(reg.status === 200, `注册/登录成功（${reg.status}）`)
ok(jar.size > 0, '拿到会话 cookie')
const sess = await api('/api/auth/session')
ok(sess.status === 200 && sess.json?.data?.user?.username === username, '会话可回读')

// 装/卸插件是管理员操作：把本测试账号在库里提为管理员
// （会话里的角色是每次请求实时读库的 —— 见 auth.ts userFromRequest）
{
  const { LittlyStorage } = await import('../packages/littly/storage/src/index.ts')
  const dbFile = process.env.LITTLY_DB_FILE ?? 'data/littly.db'
  try {
    const store = new LittlyStorage({ logger: { info: () => {} } }, { file: dbFile })
    store.prepare("UPDATE users SET role = 'admin' WHERE username = ?").run(username)
    store.close()
  } catch (e) {
    // 提不了权不算失败 —— 管理类断言会自己给出可读的错误
    console.log(`  （跳过本地提权：${dbFile} 不可直接访问，${e instanceof Error ? e.message : String(e)}）`)
  }
}

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

console.log('== dsh 插件管理 ==')
const pl = await api('/api/plugins')
const pld = pl.json?.data ?? {}
ok(Array.isArray(pld.installed), '已装插件清单存在')
ok(pld.installed.length > 0, `已装插件非空（${(pld.installed ?? []).length}）`)
ok(pld.installed.some((p) => String(p.name).includes('dsh-case')), '社区插件 dsh-case 在已装列表里')
ok(Array.isArray(pld.bundles), '可安装 bundle 清单存在')
ok((pld.bundles ?? []).some((b) => String(b.name).includes('dsh-case')), 'dsh-case 也在可安装清单里')
const emptySpec = await api('/api/plugins/install', { method: 'POST', body: { spec: '' } })
ok(emptySpec.status === 400, `空安装源 → 400（实际 ${emptySpec.status}）`)
const dashSpec = await api('/api/plugins/install', { method: 'POST', body: { spec: '--dangerous' } })
ok(dashSpec.status === 400, `以 - 开头的安装源 → 400（实际 ${dashSpec.status}）`)

console.log('== 首启播种（开箱可用）==')
// 空库时第一次访问控制台就该拿到 bot + 角色卡 + 铁律 —— 旧仓 ensureSeed 的行为。
// 全新 Docker 部署如果这里是空的，聊天页就没有对象。
const botsQ = await api('/api/bots')
const botListQ = botsQ.json?.data?.bots ?? botsQ.json?.data ?? []
ok(Array.isArray(botListQ) && botListQ.length > 0, `至少有 1 个 bot（实际 ${botListQ.length ?? 0}）`)
const charsQ = await api('/api/characters')
const charList = charsQ.json?.data?.characters ?? []
ok(Array.isArray(charList) && charList.length > 0, `至少有 1 张角色卡（实际 ${charList.length ?? 0}）`)
const rulesQ = await api('/api/persona-rules')
const rulesText = rulesQ.json?.data?.content ?? rulesQ.json?.data?.rulesText ?? ''
ok(typeof rulesText === 'string' && rulesText.includes('严格反 NTR'), '铁律是完整版（含「严格反 NTR」，不是概括版）')
ok(typeof rulesText === 'string' && rulesText.includes('记忆静默铁律'), '铁律含「记忆静默铁律」核心条')

console.log('== 渠道配置（QQ 个人号 / SnowLuma）==')
const botIdQ = Array.isArray(botListQ) ? botListQ[0]?.id : undefined
if (botIdQ) {
  const putCh = await api(`/api/bots/${botIdQ}/channels`, {
    method: 'PUT',
    body: { channels: { snowluma: { enabled: true, wsUrl: 'ws://127.0.0.1:3001', token: 'e2e-token', account: 'e2e-acct' } } },
  })
  ok(putCh.status === 200, `写 QQ 个人号配置 200（${putCh.status}）`)
  const backCh = await api(`/api/bots/${botIdQ}/channels`)
  const snow = backCh.json?.data?.channels?.snowluma ?? {}
  ok(snow.enabled === true, 'enabled 存住')
  ok(snow.wsUrl === 'ws://127.0.0.1:3001', 'wsUrl 存住')
  ok(snow.account === 'e2e-acct', 'account 存住')
  ok(snow.hasToken === true, 'token 存住（读回打码）')
  ok(snow.token !== 'e2e-token', 'token 读回是打码的')
  ok(!('qqp' in (backCh.json?.data?.channels ?? {})), '没有幽灵 qqp 分组')
  // 复位，别污染配置
  await api(`/api/bots/${botIdQ}/channels`, {
    method: 'PUT',
    body: { channels: { snowluma: { enabled: false, wsUrl: '', token: '', account: '' } } },
  })
} else {
  console.log('  （跳过：库里没有 bot）')
}

console.log('== 账号绑定闭环 ==')
const bindCode = await api('/api/bind/qqp/code', { method: 'POST', body: {} })
ok(bindCode.status === 200, `QQ 个人号发码 200（${bindCode.status}）`)
ok(/^[A-Z0-9]{6}$/.test(bindCode.json?.data?.code ?? ''), `码是 6 位（${bindCode.json?.data?.code}）`)
ok((bindCode.json?.data?.instruction ?? '').includes('绑定'), '带操作说明')
const tgCode = await api('/api/bind/tg/code', { method: 'POST', body: {} })
ok(tgCode.json?.data?.kind === 'tg_deeplink', 'Telegram 走 deep-link nonce')
const badCh = await api('/api/bind/nope/code', { method: 'POST', body: {} })
ok(badCh.status === 400, `不支持的渠道 → 400（${badCh.status}）`)
const bindStatus = await api('/api/bind/status')
ok(bindStatus.status === 200, '绑定状态 200')
ok(Array.isArray(bindStatus.json?.data?.identities), 'identities 数组存在')

console.log('== 成长档案 ==')
const growth = await api('/api/growth?botId=none')
ok(growth.status === 200, `/api/growth 200（${growth.status}）`)
ok(growth.json?.data?.window !== undefined, '成长窗口字段存在（评审时间可见）')

console.log('== 来电请求 ==')
const calls = await api('/api/call/requests?botId=none')
ok(calls.status === 200, `/api/call/requests 200（${calls.status}）`)
ok(Array.isArray(calls.json?.data?.calls), 'calls 数组存在')

console.log('== 微信桥接 Webhook ==')
// challenge 回显（不需要签名）
const chal = await api('/api/wechat/inbound', {
  method: 'POST',
  body: { type: 'url_verification', challenge: 'echo-me' },
})
ok(chal.status === 200, `challenge 回显 200（${chal.status}）`)
ok(chal.json?.challenge === 'echo-me', 'challenge 原样回显')
// 正常消息但没有配置 bot → 明确错误，不是 500
const noBot = await api('/api/wechat/inbound', {
  method: 'POST',
  body: { type: 'message', id: 'e1', from_user_id: 'wxid-x@im.wechat', content: 'hi' },
})
ok(noBot.status >= 400 && noBot.status < 500, `无匹配 bot → 4xx（实际 ${noBot.status}）`)

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
// 建一个角色用于启停断言：先走 API（管理员），不行就直接写库
// （测试库里第一个注册的用户才是管理员，这里注册的是第 N 个）
const { LittlyStorage } = await import('../packages/littly/storage/src/index.ts')
const dbFile = process.env.LITTLY_DB_FILE ?? 'data/littly.db'
const store = new LittlyStorage({ logger: { info: () => {} } }, { file: dbFile })
let botId = undefined
try {
  const created = await api('/api/bots', { method: 'POST', body: { name: `e2e_bot_${Date.now()}` } })
  botId = created.json?.data?.bot?.id ?? created.json?.data?.bot?.botId
} catch {
  botId = undefined
}
if (!botId) {
  const existing = store.prepare('SELECT id FROM bots LIMIT 1').get()
  botId = existing?.id
  if (!botId) {
    const id = `e2e-bot-${Date.now()}`
    store.prepare('INSERT INTO bots (id, name, created_at) VALUES (?,?,?)').run(id, 'e2e-bot', new Date().toISOString())
    botId = id
  }
}
store.close()
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

console.log('== 控制台静态托管 ==')
const home = await fetch(`${base}/`, { headers: { cookie: cookieHeader() } })
const homeType = home.headers.get('content-type') ?? ''
const homeBody = await home.text()
if (home.status === 200 && homeType.includes('text/html')) {
  ok(true, 'GET / 返回控制台首页')
  ok(homeBody.includes('<!doctype html>'), '首页是 HTML')
  const spa = await fetch(`${base}/console/bili`, { headers: { cookie: cookieHeader() } })
  ok(spa.status === 200, 'SPA 路由回 index.html')
  const trav = await fetch(`${base}/%2e%2e/package.json`, { headers: { cookie: cookieHeader() } })
  const travBody = await trav.text()
  ok(!travBody.includes('"dependencies"'), '越界请求不会泄漏真实文件')
} else {
  console.log('  （跳过：本次启动未提供 console/dist）')
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
