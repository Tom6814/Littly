#!/usr/bin/env node
/**
 * X（Twitter）接入行为验证。
 * 运行：node scripts/verify-x.mjs
 *
 * 全程使用 **fake bin**（自写 node 脚本，输出 JSON 信封/非 0 退出/错误码），
 * 不联网、不需要真实 X 账号。覆盖：
 *  - 允许清单：读命令放行、写命令默认 dry-run、未知命令/空 argv/危险参数拦截
 *  - allow_writes 开关：打开后仍需显式 dryRun:false 才真执行
 *  - 限频：读 30/h、写 5/h（按 bot 统计 audit_logs）
 *  - 审计：每次调用落 audit_logs（category=tool_call，action=x_<cmd>，含 argv/dryRun/exit）
 *  - JSON 信封解析 + **exit code 0 但 ok:false** 的错误判定（twitter-cli 实测行为）
 *  - 401/403 → not_authenticated、429 → rate_limited、226 → login_incomplete 映射
 *  - 凭据：cookie 串解析、登录 whoami 取 username、子进程注入 token/proxy/OUTPUT=json、
 *    token 不回传 status / 不写日志
 *  - 工具注册：`x` 工具注册进 hub 工具表，执行结果 JSON 字符串
 */
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LittlyStorage } from '../packages/littly/storage/src/index.ts'
import {
  createXService,
  parseXCookie,
  extractJsonObject,
  mapXError,
  sanitizeArgv,
  X_READ_COMMANDS,
  X_WRITE_COMMANDS,
  X_READ_LIMIT_PER_HOUR,
  X_WRITE_LIMIT_PER_HOUR,
} from '../packages/littly/x/src/service.ts'
import { registerXTool, X_TOOL } from '../packages/littly/x/src/tool.ts'

let pass = 0
let fail = 0
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? `（${detail}）` : ''}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? `（${detail}）` : ''}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'littly-x-'))
const storage = new LittlyStorage({ logger: { info: () => {} } }, { file: join(dir, 'x.db') })
storage.setSetting('platform.secret', 'x-test-secret')
const nowIso = new Date().toISOString()
storage.prepare("INSERT INTO bots (id, name, created_at) VALUES ('bot-x','小璃',?)").run(nowIso)

// ---------- fake twitter bin ----------
const fakeBin = join(dir, 'fake-twitter.mjs')
const invocationLog = join(dir, 'invocations.jsonl')
writeFileSync(invocationLog, '')
writeFileSync(fakeBin, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
const mode = process.env.FAKE_X_MODE ?? 'ok'
appendFileSync(${JSON.stringify(invocationLog)}, JSON.stringify({
  argv: args,
  authToken: process.env.TWITTER_AUTH_TOKEN ?? '',
  ct0: process.env.TWITTER_CT0 ?? '',
  proxy: process.env.TWITTER_PROXY ?? '',
  output: process.env.OUTPUT ?? '',
}) + '\\n')
const cmd = args[0]
const emit = (obj) => { process.stdout.write(JSON.stringify(obj)) ; process.exit(0) }
if (mode === 'garbage') { process.stdout.write('this is not json'); process.exit(0) }
if (mode === 'crash') { process.stderr.write('boom: server exploded'); process.exit(1) }
if (mode === 'hang') { setTimeout(() => process.exit(0), 5000); }
else {
  if (cmd === '--version') { process.stdout.write('twitter, version 0.8.5'); process.exit(0) }
  if (mode === '401') emit({ ok: false, schema_version: '1', error: { code: 'api_error', message: 'HTTP 401: Unauthorized' } })
  if (mode === '429') emit({ ok: false, schema_version: '1', error: { code: 'api_error', message: 'HTTP 429: Too Many Requests' } })
  if (mode === '226') emit({ ok: false, schema_version: '1', error: { code: 'api_error', message: 'HTTP 226: IM used' } })
  if (mode === 'timeout') emit({ ok: false, schema_version: '1', error: { code: 'api_error', message: 'HTTP 0: Connection timed out' } })
  if (cmd === 'whoami') emit({ ok: true, schema_version: '1', data: { username: 'littly_bot', id: '42' } })
  if (cmd === 'status') emit({ ok: true, schema_version: '1', data: { authenticated: true, username: 'littly_bot' } })
  emit({ ok: true, schema_version: '1', data: { argv: args, tweets: [{ id: '1', text: 'hello' }] } })
}
`)
chmodSync(fakeBin, 0o755)
const invocations = () => readFileSync(invocationLog, 'utf8').trim().split('\n').filter((l) => l !== '').map((l) => JSON.parse(l))
const resetInvocations = () => writeFileSync(invocationLog, '')

const cfg = { bin: fakeBin, timeoutMs: 5000 }
const x = createXService(storage, cfg)

console.log('== 纯函数 ==')
{
  const cookie = 'auth_token=AAA111; ct0=BBB222; other=1'
  const parsed = parseXCookie(cookie)
  ok(parsed.authToken === 'AAA111' && parsed.ct0 === 'BBB222', 'cookie 串解析 auth_token / ct0')
  const encoded = parseXCookie(`auth_token=${encodeURIComponent('a%20b')}; ct0=x`)
  ok(encoded.authToken === 'a%20b', 'cookie 值 URL 解码')
  ok(parseXCookie('nothing=1').authToken === '', '缺 auth_token → 空串')
  ok(extractJsonObject('{"ok":true,"data":1}')?.['ok'] === true, '纯 JSON 信封解析')
  ok(extractJsonObject('log line\n{"ok":false,"error":{"code":"x"}}')?.['ok'] === false, '夹带日志行也能提取 JSON')
  ok(extractJsonObject('no json here') === null, '无 JSON → null')
  ok(extractJsonObject('{"s":"含 } 的字符串","n":1}')?.['n'] === 1, '字符串内花括号不计深度')
  ok(mapXError('HTTP 401: Unauthorized').code === 'not_authenticated', '401 → not_authenticated')
  ok(mapXError('HTTP 403: Forbidden').code === 'not_authenticated', '403（含 hint）→ not_authenticated')
  ok(mapXError('HTTP 429: Too Many Requests').code === 'rate_limited', '429 → rate_limited')
  ok(mapXError('HTTP 226: IM used').code === 'login_incomplete', '226 → login_incomplete')
  const generic = mapXError('api_error: HTTP 0: Connection timed out')
  ok(generic.code === 'x_api_error' && generic.message.includes('Connection timed out'), '其它错误保留原始信息（便于判断要代理）')
  const redacted = sanitizeArgv(['search', 'SECRET-TOKEN'], ['SECRET-TOKEN'])
  ok(redacted[1] === '***' && !redacted.join(' ').includes('SECRET-TOKEN'), '审计 argv 脱敏 token')
  ok(X_READ_COMMANDS.has('feed') && X_WRITE_COMMANDS.has('post'), '命令清单：feed 读 / post 写')
  ok(X_WRITE_COMMANDS.has('favorite') && !X_READ_COMMANDS.has('favorite'), 'favorite 是写操作（favorites 才是读）')
  ok(X_READ_LIMIT_PER_HOUR === 30 && X_WRITE_LIMIT_PER_HOUR === 5, '限频常量 30/h 读、5/h 写')
}

console.log('== 凭据与登录 ==')
{
  const st = x.status()
  ok(st.configured === false && st.username === '' && st.allowWrites === false, '初始未配置 / 无 username / 写开关关')
  ok(st.bin === fakeBin, 'status 暴露 bin 路径')
  const login = await x.login({ cookie: 'auth_token=TOK-1; ct0=CT0-1' })
  ok(login.ok === true && login.status.configured === true, 'cookie 登录成功（whoami 验证通过）')
  ok(login.status.username === 'littly_bot', 'login 从 whoami 取到 username')
  ok(login.status.loggedInAt !== '', 'login 记录 loggedInAt')
  const statusJson = JSON.stringify(x.status())
  ok(!statusJson.includes('TOK-1') && !statusJson.includes('CT0-1'), 'status 不回传 token/ct0')
  const st2 = x.status()
  ok(st2.configured === true && st2.username === 'littly_bot', '登录后 status 持久化为已配置')

  resetInvocations()
  await x.run(['feed'], { botId: 'bot-x' })
  const childEnv = invocations()[0]
  ok(childEnv.authToken === 'TOK-1' && childEnv.ct0 === 'CT0-1', '子进程注入 TWITTER_AUTH_TOKEN / TWITTER_CT0')
  ok(childEnv.output === 'json', '子进程注入 OUTPUT=json')

  x.settings({ proxy: 'http://127.0.0.1:7890' })
  resetInvocations()
  await x.run(['status'], { botId: 'bot-x' })
  ok(invocations()[0].proxy === 'http://127.0.0.1:7890', 'x.proxy 真的传成 TWITTER_PROXY（直连需要有代理）')
  ok(x.status().hasProxy === true, 'status.hasProxy = true（不回传代理地址）')
}

console.log('== 允许清单与写操作护栏 ==')
{
  const unknown = await x.run(['rm', '-rf'], { botId: 'bot-x' })
  ok(unknown.ok === false && unknown.error?.code === 'command_not_allowed', '未知命令 → command_not_allowed')
  const empty = await x.run([], { botId: 'bot-x' })
  ok(empty.ok === false && empty.error?.code === 'bad_request', '空 argv → bad_request')
  const blank = await x.run(['feed', ''], { botId: 'bot-x' })
  ok(blank.ok === false && blank.error?.code === 'bad_request', '空字符串参数 → bad_request')
  for (const flag of ['-o', '--output', '--input', '--image', '-i']) {
    const blocked = await x.run(['post', flag, 'x'], { botId: 'bot-x' })
    ok(blocked.ok === false && blocked.error?.code === 'flag_not_allowed', `危险参数 ${flag} 被拦截`)
  }

  resetInvocations()
  const preview = await x.run(['post', '今天天气真好'], { botId: 'bot-x' })
  ok(preview.ok === true && preview.dryRun === true, '写命令默认 dry-run（未开开关）')
  ok((preview.note ?? '').includes('预演'), 'dry-run 返回可读 note')
  ok(invocations().length === 0, 'dry-run 不执行子进程')

  x.settings({ allowWrites: true })
  resetInvocations()
  const preview2 = await x.run(['post', '真的想发'], { botId: 'bot-x' })
  ok(preview2.dryRun === true && invocations().length === 0, '开关打开但未显式 dryRun:false → 仍预演')
  const real = await x.run(['post', '真的想发'], { botId: 'bot-x', dryRun: false })
  ok(real.ok === true && real.dryRun === false, '开关打开 + dryRun:false → 真执行')
  ok(invocations().length === 1 && invocations()[0].argv[0] === 'post', '真执行确实 spawn 了 post 命令')
}

console.log('== JSON 信封 / 错误映射（exit 0 也可能失败）==')
{
  process.env.FAKE_X_MODE = '401'
  const r401 = await x.run(['feed'], { botId: 'bot-x' })
  ok(r401.ok === false && r401.error?.code === 'not_authenticated', '401 错误（exit 0）→ not_authenticated')
  ok((r401.error?.message ?? '').includes('原始信息'), '401 错误信息保留原始文本')
  process.env.FAKE_X_MODE = '429'
  const r429 = await x.run(['feed'], { botId: 'bot-x' })
  ok(r429.ok === false && r429.error?.code === 'rate_limited', '429（exit 0）→ rate_limited')
  process.env.FAKE_X_MODE = '226'
  const r226 = await x.run(['post', 'x'], { botId: 'bot-x', dryRun: false })
  ok(r226.error?.code === 'login_incomplete', '226 → login_incomplete')
  process.env.FAKE_X_MODE = 'timeout'
  const rTimeout = await x.run(['feed'], { botId: 'bot-x' })
  ok(rTimeout.ok === false && rTimeout.error?.code === 'x_api_error', '网络超时（exit 0 且 ok:false）→ x_api_error')
  ok((rTimeout.error?.raw ?? '').includes('Connection timed out'), '超时错误保留原始信息（提示需要代理）')
  process.env.FAKE_X_MODE = 'garbage'
  const rGarbage = await x.run(['feed'], { botId: 'bot-x' })
  ok(rGarbage.ok === false && rGarbage.error?.code === 'x_parse_failed', '非 JSON 输出 → x_parse_failed')
  process.env.FAKE_X_MODE = 'crash'
  const rCrash = await x.run(['feed'], { botId: 'bot-x' })
  ok(rCrash.ok === false && rCrash.error?.code === 'x_api_error' && (rCrash.error?.raw ?? '').includes('boom'), '非 0 退出 → x_api_error 且带 stderr')
  process.env.FAKE_X_MODE = 'ok'
}

console.log('== 审计 ==')
{
  const rows = storage.prepare("SELECT action, detail FROM audit_logs WHERE bot_id = 'bot-x' AND category = 'tool_call' ORDER BY created_at").all()
  const actions = rows.map((r) => r.action)
  ok(actions.includes('x_feed'), '读命令审计 action = x_feed')
  ok(actions.includes('x_post'), '写命令审计 action = x_post')
  const postDetail = JSON.parse(rows.find((r) => r.action === 'x_post').detail)
  ok(Array.isArray(postDetail.argv) && postDetail.argv[0] === 'post', '审计 detail 含 argv')
  ok(postDetail.dryRun === true, '审计记录 dryRun 标记')
  ok(typeof postDetail.exitCode === 'number', '审计记录 exitCode')
  ok(JSON.stringify(rows).includes('TOK-1') === false, '审计里不出现明文 token')
}

console.log('== 限频（读 30/h、写 5/h）==')
{
  const readBot = 'bot-rate-read'
  for (let i = 0; i < X_READ_LIMIT_PER_HOUR; i++) {
    const r = await x.run(['feed'], { botId: readBot })
    if (!r.ok) { ok(false, `第 ${i + 1} 次读调用应通过（${r.error?.code}）`); break }
  }
  const blockedRead = await x.run(['feed'], { botId: readBot })
  ok(blockedRead.ok === false && blockedRead.error?.code === 'rate_limited', `读超过 ${X_READ_LIMIT_PER_HOUR}/h → rate_limited`)
  ok((blockedRead.error?.message ?? '').includes('每小时'), '限频错误信息可读（中文）')

  const writeBot = 'bot-rate-write'
  for (let i = 0; i < X_WRITE_LIMIT_PER_HOUR; i++) {
    const r = await x.run(['post', `第${i}条`], { botId: writeBot, dryRun: false })
    if (!r.ok) { ok(false, `第 ${i + 1} 次写调用应通过（${r.error?.code}）`); break }
  }
  const blockedWrite = await x.run(['post', '超限'], { botId: writeBot, dryRun: false })
  ok(blockedWrite.ok === false && blockedWrite.error?.code === 'rate_limited', `写超过 ${X_WRITE_LIMIT_PER_HOUR}/h → rate_limited`)
  ok(blockedWrite.dryRun === false, '被限频的写操作不是 dry-run 语义')
}

console.log('== probe / binOk / 登出 ==')
{
  process.env.FAKE_X_MODE = 'ok'
  const probeOk = await x.probe()
  ok(probeOk.ok === true && probeOk.username === 'littly_bot', 'probe 成功并返回 username')
  ok(x.lastProbe()?.ok === true, 'probe 结果落 lastProbe')
  process.env.FAKE_X_MODE = 'timeout'
  const probeFail = await x.probe()
  ok(probeFail.ok === false && (probeFail.error ?? '').includes('Connection timed out'), 'probe 失败保留原始错误')
  ok(x.lastProbe()?.ok === false && (x.lastProbe()?.error ?? '') !== '', 'lastProbe 记录最近一次失败原因')
  process.env.FAKE_X_MODE = 'ok'

  ok((await x.binOk()) === true, 'binOk：fake bin 可用（--version 成功）')
  const noBin = createXService(storage, { bin: join(dir, 'no-such-bin'), timeoutMs: 3000 })
  ok((await noBin.binOk()) === false, 'binOk：二进制不存在 → false')
  const binMissing = await noBin.run(['feed'], { botId: 'bot-x' })
  ok(binMissing.ok === false && binMissing.error?.code === 'x_bin_unavailable', '二进制不存在 → x_bin_unavailable')

  const logout = x.logout()
  ok(logout.configured === false && logout.username === '' && logout.loggedInAt === '', '登出清空凭据')
  ok(logout.allowWrites === true && logout.hasProxy === true, '登出保留写开关与代理设置')
  const afterLogout = await x.run(['feed'], { botId: 'bot-x' })
  ok(afterLogout.ok === false && afterLogout.error?.code === 'not_authenticated', '登出后调用命令 → not_authenticated')
}

console.log('== 登录失败保留凭据 / 工具注册 ==')
{
  process.env.FAKE_X_MODE = '401'
  const badLogin = await x.login({ authToken: 'TOK-2', ct0: 'CT0-2' })
  ok(badLogin.ok === false && (badLogin.error ?? '') !== '', '登录验证失败 → 中文错误')
  ok(badLogin.status.configured === true, '登录失败仍保留已存凭据')
  process.env.FAKE_X_MODE = 'ok'

  // 工具注册：fake hub 捕获 registerChannelTool
  const registered = []
  const fakeHub = { tools: { registerChannelTool: (def, exec) => { registered.push({ def, exec }) } } }
  registerXTool(fakeHub, x)
  ok(registered.length === 1 && registered[0].def.function.name === 'x', 'x 工具注册进 hub（名称 = x）')
  ok(X_TOOL.function.parameters.required.includes('argv'), '工具 schema：argv 必填')
  const toolResult = await registered[0].exec({ argv: ['feed'] }, { botId: 'bot-x', sender: 'u1' })
  const parsedTool = JSON.parse(toolResult.result)
  ok(parsedTool.ok === true && Array.isArray(parsedTool.data.tweets), '工具执行返回 JSON 字符串（data.tweets）')
  const toolDry = await registered[0].exec({ argv: ['post', 'hi'] }, { botId: 'bot-x', sender: 'u1' })
  ok(JSON.parse(toolDry.result).dryRun === true, '工具写命令默认预演')
}

process.env.FAKE_X_MODE = 'ok'
storage.close()
rmSync(dir, { recursive: true, force: true })
console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
