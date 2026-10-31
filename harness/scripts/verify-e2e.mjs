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
 *  - /api/bili/*：bilibili-cli 接入（status / cmd 参数校验 / settings 写开关 / qr 会话），不依赖外网
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
// 已有 admin 凭据时直接登录（容器/共享库场景）；否则注册。
const username = process.env.LITTLY_E2E_USER ?? `e2e_${Date.now()}`
const password = process.env.LITTLY_E2E_PASS ?? 'e2e-pass-123'
let reg = await api('/api/auth/login', { method: 'POST', body: { username, password } })
const registered = reg.status !== 200
if (registered) {
  reg = await api('/api/auth/register', { method: 'POST', body: { username, password } })
}
ok(reg.status === 200, `${registered ? '注册' : '登录'}成功（${reg.status}）`)
ok(jar.size > 0, '拿到会话 cookie')
const sess = await api('/api/auth/session')
ok(sess.status === 200 && sess.json?.data?.user?.username === username, '会话可回读')

// 装/卸插件等是管理员操作：把本测试账号在库里提为管理员
// （会话里的角色是每次请求实时读库的 —— 见 auth.ts userFromRequest）
// 库路径来源（按优先级）：
//  1) 服务进程启动时写的运行期自述 <tmp>/littly-runtime-<PORT>.json（storage 插件写入，最可靠）
//  2) argv[3] / LITTLY_DB_FILE / 相对路径 data/littly.db
{
  let runtimeDb = ''
  try {
    const { readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { LittlyStorage } = await import('../packages/littly/storage/src/index.ts')
    const info = JSON.parse(readFileSync(join(tmpdir(), `littly-runtime-${port}.json`), 'utf8'))
    if (typeof info?.dbFile === 'string' && info.dbFile !== '') runtimeDb = info.dbFile
  } catch {
    // 自述文件不存在（旧版服务）→ 走兜底候选
  }
  const { LittlyStorage } = await import('../packages/littly/storage/src/index.ts')
  const candidates = [runtimeDb, process.argv[3], process.env.LITTLY_DB_FILE, 'data/littly.db'].filter(
    (x) => typeof x === 'string' && x !== '',
  )
  let elevated = false
  let hitPath = ''
  for (const dbFile of candidates) {
    try {
      const store = new LittlyStorage({ logger: { info: () => {} } }, { file: dbFile })
      store.prepare("UPDATE users SET role = 'admin' WHERE username = ?").run(username)
      store.close()
      elevated = true
      hitPath = dbFile
      break
    } catch {
      // 换下一个候选
    }
  }
  ok(elevated, `本地提权为 admin（候选 ${candidates.length} 个${elevated ? `，命中 ${hitPath}` : ''}）`)
  if (!elevated) {
    console.log('  （提示：用 `node scripts/verify-e2e.mjs <port> <业务库路径>` 或 LITTLY_DB_FILE=<路径> 重跑）')
  }
}

console.log('== 插件清单（真实数据）==')
const plugins = await api('/api/plugins')
ok(plugins.status === 200, `/api/plugins 200（${plugins.status}）`)
const pdata = plugins.json?.data ?? {}
const toolNames = (pdata.tools ?? []).map((t) => t.name)
ok(toolNames.includes('remember'), 'Littly 内置工具在清单里')
ok(toolNames.includes('bili'), 'bili 元工具在清单里')
ok(toolNames.includes('x'), 'x 元工具在清单里（@littly/x 已装配）')
ok(toolNames.includes('mail'), 'mail 元工具在清单里（@littly/mail 已装配）')
ok(toolNames.includes('memory_search') && toolNames.includes('memory_write'), 'memory_* 工具在清单里（vault 已装配）')
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
const botIdQ = Array.isArray(botListQ) ? botListQ[0]?.id : undefined
const charsQ = await api('/api/characters')
const charList = charsQ.json?.data?.characters ?? []
ok(Array.isArray(charList) && charList.length > 0, `至少有 1 张角色卡（实际 ${charList.length ?? 0}）`)
const rulesQ = await api('/api/persona-rules')
const rulesText = rulesQ.json?.data?.content ?? rulesQ.json?.data?.rulesText ?? ''
ok(typeof rulesText === 'string' && rulesText.includes('严格反 NTR'), '铁律是完整版（含「严格反 NTR」，不是概括版）')
ok(typeof rulesText === 'string' && rulesText.includes('记忆静默铁律'), '铁律含「记忆静默铁律」核心条')

console.log('== 直接跟 bot 聊天（不需要先建联系人）==')
// 用户反馈：网页端聊天页说「先在「联系人」中创建一位联系人」，不能直接跟 bot 聊。
// 根因是聊天页把会话对象绑死在「联系人列表第一个」—— 全新库里一个联系人都没有。
// 旧仓是拿登录用户的 id 当会话对象。这条断言锁住「用登录用户身份就能直接聊」。
if (botIdQ) {
  const myId = sess.json?.data?.user?.id ?? ''
  const probe = `e2e-chat-probe-${Date.now()}`
  const chatRes = await api('/api/chat', {
    method: 'POST',
    body: { botId: botIdQ, sender: myId, text: probe },
  })
  // 没配模型时会在模型那一层失败（文案清楚）；配了模型时会成功回复。
  // 但两种情况下都不该是「机器人不存在」「缺少联系人」这类错误。
  const chatErr = chatRes.json?.error?.message ?? ''
  ok(!chatErr.includes('机器人不存在') && !chatErr.includes('联系人'), `直接聊天没被会话对象挡住（${chatErr || '成功'}）`)
  const hist = await api(`/api/messages?botId=${encodeURIComponent(botIdQ)}&sender=${encodeURIComponent(myId)}`)
  const texts = (hist.json?.data?.messages ?? []).map((m) => m.text ?? m.content ?? '')
  ok(texts.includes(probe), '以登录用户身份发的消息进了历史')
  // 联系人身份关联：web 首聊后联系人应关联到登录用户（user_id=用户id、name=username，不是 UUID）
  // 重新生成：先删「最后一条用户消息及其后」再重跑 → 旧 id 必须消失、总数不增（不重复显示）
  const beforeMsgs = hist.json?.data?.messages ?? []
  const beforeIds = beforeMsgs.map((m) => m.id)
  const regen = await api('/api/chat/regenerate', { method: 'POST', body: { botId: botIdQ, sender: myId } })
  const hist2 = await api(`/api/messages?botId=${encodeURIComponent(botIdQ)}&sender=${encodeURIComponent(myId)}`)
  const afterMsgs = hist2.json?.data?.messages ?? []
  ok(!afterMsgs.some((m) => beforeIds.includes(m.id)), `重新生成后旧消息 id 已被删除（不重复显示；regen=${regen.status}）`)
  ok(afterMsgs.length <= beforeMsgs.length + 1, `重新生成后 messages 总数不增（前 ${beforeMsgs.length} / 后 ${afterMsgs.length}）`)
  const contacts = await api(`/api/contacts?botId=${encodeURIComponent(botIdQ)}`)
  const mine = (contacts.json?.data?.contacts ?? []).find((c) => c.id === myId)
  ok(contacts.status === 200 && mine?.userId === myId, 'web 首聊后联系人 user_id 关联到登录用户（不再是无关联新联系人）')
  ok(mine?.name === username && mine?.name !== myId, '联系人 name = username（不是用户 UUID/邮箱）')

  // 记忆 vault：迁移一条旧 memories → 档案/9 域/检索
  console.log('== 记忆 vault（档案 / 9 域 / 检索）==')
  try {
    const { readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { LittlyStorage } = await import('../packages/littly/storage/src/index.ts')
    let memDbFile = process.env.LITTLY_DB_FILE ?? 'data/littly.db'
    try {
      const info = JSON.parse(readFileSync(join(tmpdir(), `littly-runtime-${port}.json`), 'utf8'))
      if (typeof info?.dbFile === 'string' && info.dbFile !== '') memDbFile = info.dbFile
    } catch { /* fallback */ }
    const store = new LittlyStorage({ logger: { info: () => {} } }, { file: memDbFile })
    const memId = `e2e-mem-${Date.now()}`
    store.prepare('INSERT OR REPLACE INTO memories (id, bot_id, contact_id, sender, category, content, importance, event_time, event_time_raw, recorded_at, provenance, volatility, tags, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(memId, botIdQ, myId, myId, 'fact', 'e2e 记忆锚点：最近在准备考研（记忆 vault 验收）', 3, new Date().toISOString(), '', new Date().toISOString(), 'user-stated', 'stable', '[]', new Date().toISOString())
    store.close()
  } catch {
    // 容器里库可能在别的卷：迁移断言降级为端点可用性
  }
  const memMigrate = await api('/api/memory/migrate', { method: 'POST', body: { botId: botIdQ } })
  ok(memMigrate.status === 200, `/api/memory/migrate 200（${memMigrate.status}）`)
  const memProfile = await api(`/api/memory/profile?botId=${encodeURIComponent(botIdQ)}&contactId=${encodeURIComponent(myId)}`)
  ok(memProfile.status === 200 && typeof memProfile.json?.data?.profile === 'string', `/api/memory/profile 200 返回 Markdown 档案（${memProfile.status}）`)
  const memDomains = await api(`/api/memory/domains?botId=${encodeURIComponent(botIdQ)}&contactId=${encodeURIComponent(myId)}`)
  ok(memDomains.status === 200 && memDomains.json?.data?.domains?.length === 9, 'memory domains 返回 9 域')
  const memSearch = await api(`/api/memory/search?botId=${encodeURIComponent(botIdQ)}&contactId=${encodeURIComponent(myId)}&q=${encodeURIComponent('考研')}`)
  ok(memSearch.status === 200 && Array.isArray(memSearch.json?.data?.results), `/api/memory/search 200（${memSearch.status}）`)
  ok((memSearch.json?.data?.count ?? 0) >= 1, 'memory search 命中迁移条目（含时间标签）')
} else {
  console.log('  （跳过：库里没有 bot）')
}

console.log('== 渠道配置（QQ 个人号 / SnowLuma）==')
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

console.log('== X（Twitter）接入 ==')
const xStatus = await api('/api/x/status')
ok(xStatus.status === 200, `/api/x/status 200（${xStatus.status}）`)
const xStatusData = xStatus.json?.data ?? {}
ok(typeof xStatusData.binOk === 'boolean', 'X status 带 binOk（二进制可用性与最近错误分开）')
ok(typeof xStatusData.configured === 'boolean' && typeof xStatusData.allowWrites === 'boolean', 'X status 含 configured/allowWrites')
const xBadCmd = await api('/api/x/cmd', { method: 'POST', body: { argv: ['not-a-real-command'] } })
ok(xBadCmd.status === 400, `未知 X 子命令经 /api/x/cmd → 400（实际 ${xBadCmd.status}）`)

console.log('== QQ 渠道（SnowLuma + 官方 QQBot，@littly/channel-qq）==')
const qqStatus = await api('/api/qq/status')
ok(qqStatus.status === 200, `/api/qq/status 200（${qqStatus.status}）`)
const qqData = qqStatus.json?.data ?? {}
ok(typeof qqData.snowluma?.enabled === 'boolean' && typeof qqData.qqbot?.enabled === 'boolean', 'QQ status 含双渠道（snowluma/qqbot）enabled')
ok(typeof qqData.snowluma?.configured === 'boolean' && typeof qqData.qqbot?.configured === 'boolean', 'QQ status 含双渠道 configured')

console.log('== 邮箱（@littly/mail）==')
const mailStatus = await api('/api/mail/status')
ok(mailStatus.status === 200 && typeof mailStatus.json?.data?.configured === 'boolean', `/api/mail/status 200（${mailStatus.status}）`)
ok(JSON.stringify(mailStatus.json ?? {}).includes('password=') === false, 'mail status 不含密码字段')

console.log('== MCP 管理页（Cursor 格式）==')
const mcpServers = await api('/api/mcp/servers')
ok(mcpServers.status === 200 && Array.isArray(mcpServers.json?.data?.servers), `/api/mcp/servers 200（${mcpServers.status}）`)
const mcpImport = await api('/api/mcp/import', { method: 'POST', body: { mcpServers: { 'e2e-mcp': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'] } } } })
ok(mcpImport.status === 200 && Array.isArray(mcpImport.json?.data?.added), 'Cursor 格式 import 200（返回 added/updated/errors）')
const mcpExported = await api('/api/mcp/export')
ok(mcpExported.status === 200 && mcpExported.json?.data?.mcpServers?.['e2e-mcp']?.command === 'npx', 'export 返回 Cursor 格式（含刚导入的服务器）')
const mcpListed = await api('/api/mcp/servers')
ok((mcpListed.json?.data?.servers ?? []).some((s) => s.name === 'e2e-mcp' && Array.isArray(s.envKeys)), 'servers 列表含导入项（env/header 只回键名）')
const mcpTools = await api('/api/mcp/tools')
ok(mcpTools.status === 200 && Array.isArray(mcpTools.json?.data?.tools), '/api/mcp/tools 200')
const mcpDeleted = await api('/api/mcp/servers/e2e-mcp', { method: 'DELETE' })
ok(mcpDeleted.status === 200, 'DELETE 清理导入项')

console.log('== SnowLuma 一键安装（@littly/snowluma）==')
const snowStatus = await api('/api/snowluma/status')
ok(snowStatus.status === 200, `/api/snowluma/status 200（${snowStatus.status}）`)
const snowData = snowStatus.json?.data ?? {}
ok(typeof snowData.state === 'string' && typeof snowData.dockerOk === 'boolean', 'snowluma status 含 state/dockerOk')
ok(snowData.vncPassword === undefined && snowData.webuiPassword === undefined, '非 admin 的 status 不返回明文密码')

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

console.log('== bilibili 接入（bilibili-cli 壳，不走外网）==')
const bili = await api('/api/bili/status')
ok(bili.status === 200, `GET /api/bili/status 200（实际 ${bili.status}）`)
const biliData = bili.json?.data ?? {}
ok(typeof biliData.authenticated === 'boolean', 'status：authenticated 布尔字段')
ok(typeof biliData.binOk === 'boolean', 'status：binOk（bilibili-cli 是否安装）')
ok(typeof biliData.allowWrites === 'boolean', 'status：allowWrites（写操作开关）')
ok(biliData.user === null || typeof biliData.user === 'object', 'status：user 为对象或 null（未登录不报错）')

const biliBadCmd = await api('/api/bili/cmd', { method: 'POST', body: { argv: ['rm', '-rf', '/'] } })
ok(biliBadCmd.status === 400, `cmd 未知命令 → 400（实际 ${biliBadCmd.status}）`)
ok(biliBadCmd.json?.error?.code === 'command_not_allowed', 'cmd 未知命令错误码 command_not_allowed')
const biliEmpty = await api('/api/bili/cmd', { method: 'POST', body: { argv: [] } })
ok(biliEmpty.status === 400, `cmd 空 argv → 400（实际 ${biliEmpty.status}）`)

const biliSettingsOn = await api('/api/bili/settings', { method: 'PUT', body: { allowWrites: true } })
ok(biliSettingsOn.status === 200 && biliSettingsOn.json?.data?.allowWrites === true, 'PUT /api/bili/settings 打开写开关')
const biliStatus2 = await api('/api/bili/status')
ok(biliStatus2.json?.data?.allowWrites === true, 'status 反映 allowWrites=true')
await api('/api/bili/settings', { method: 'PUT', body: { allowWrites: false } })
const biliStatus3 = await api('/api/bili/status')
ok(biliStatus3.json?.data?.allowWrites === false, '写开关可关回（默认关）')

const biliQrNoSession = await api('/api/bili/qr/status')
ok(biliQrNoSession.status === 400, `qr/status 缺 sessionId → 400（实际 ${biliQrNoSession.status}）`)
const biliQrBad = await api('/api/bili/qr/status?sessionId=not-a-real-session')
ok(biliQrBad.status === 200 && biliQrBad.json?.data?.status === 'expired', 'qr/status 未知 session → expired（不依赖外网）')

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
const anonQq = await api('/api/qq/status')
ok(anonQq.status === 401, `未登录 /api/qq/status → 401（${anonQq.status}）`)
const anonSnow = await api('/api/snowluma/status')
ok(anonSnow.status === 401, `未登录 /api/snowluma/status → 401（${anonSnow.status}）`)
const anonMcp = await api('/api/mcp/servers')
ok(anonMcp.status === 401, `未登录 /api/mcp/servers → 401（${anonMcp.status}）`)
const anonMail = await api('/api/mail/status')
ok(anonMail.status === 401, `未登录 /api/mail/status → 401（${anonMail.status}）`)
const anonVault = await api('/api/memory/profile?botId=x&contactId=y')
ok(anonVault.status === 401, `未登录 /api/memory/profile → 401（${anonVault.status}）`)
for (const [k, v] of saved) jar.set(k, v)

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
