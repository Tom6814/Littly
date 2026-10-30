#!/usr/bin/env node
/**
 * Bilibili 接入行为验证（@littly/bili + bilibili-cli 壳 + 扫码认证）。
 * 运行：node scripts/verify-bili.mjs
 *
 * 全程**不联网、不需要真实 B 站账号**：
 *  - fake `bili`（自写 node 脚本，按 FAKE_BILI_MODE 输出 JSON 信封 / 非 0 退出 / 垃圾输出），
 *    并记录子进程 argv 与关键 env；
 *  - 本地 mock passport HTTP 服务，复刻扫码 generate/poll 契约（含 Set-Cookie）。
 *
 * 覆盖（≥60 断言）：
 *  - 允许清单 / 空 argv / 危险参数（-o/--output/--from-file/--input/--yaml）
 *  - 写命令默认 dry-run；`bili.allow_writes` 打开 + 显式 dryRun:false 才真执行
 *  - audio 下载：受写开关约束、固定输出目录、禁 -o
 *  - unfollow/dynamic-delete 自动补 --yes（非 TTY 下 CLI 的 click.confirm 会 EOF）
 *  - JSON 信封解析（exit 1 但 JSON 合法 = 未登录）、错误码映射、超时/二进制缺失
 *  - 智能认证：status / 浏览器 Cookie 提取 / 扫码 generate+poll 三态+确认 /
 *    credential schema + 0600 + buvid 合并 / 登出
 *  - 限频（读 30/h、写 5/h）、审计（action/argv/dryRun/脱敏）、token 不打印
 *  - 工具注册（`bili` 元工具）与旧 MCP 收敛门
 */
import { createServer } from 'node:http'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LittlyStorage } from '../packages/littly/storage/src/index.ts'
import {
  BILI_BLOCKED_FLAGS,
  BILI_READ_COMMANDS,
  BILI_READ_LIMIT_PER_HOUR,
  BILI_WRITE_COMMANDS,
  BILI_WRITE_LIMIT_PER_HOUR,
  createBiliService,
  extractJsonObject,
  mapBiliError,
  normalizeBiliUser,
  redactSecrets,
  sanitizeArgv,
} from '../packages/littly/bili/src/service.ts'
import { registerBiliTool, BILI_TOOL } from '../packages/littly/bili/src/tool.ts'
import { qrGenerate, qrPollOnce, QrSessionStore } from '../packages/littly/bili/src/qr.ts'
import {
  cookieJarFrom,
  credentialInfo,
  defaultCredentialPath,
  readCredential,
  writeCredential,
} from '../packages/littly/bili/src/credential.ts'
import { apply as applyBili, CONVERGE_REASON } from '../packages/littly/bili/src/index.ts'

let pass = 0
let fail = 0
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? `（${detail}）` : ''}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? `（${detail}）` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const dir = mkdtempSync(join(tmpdir(), 'littly-bili-'))
const cliHome = join(dir, 'cli-home')
const credentialPath = defaultCredentialPath(cliHome)
const invocationLog = join(dir, 'invocations.jsonl')
writeFileSync(invocationLog, '')
const storage = new LittlyStorage({ logger: { info: () => {} } }, { file: join(dir, 'bili.db') })
storage.setSetting('platform.secret', 'bili-test-secret')
const nowIso = new Date().toISOString()
storage.prepare("INSERT INTO bots (id, name, created_at) VALUES ('bot-bili','小璃',?)").run(nowIso)

// ---------- fake bili bin ----------
const fakeBin = join(dir, 'fake-bili.mjs')
writeFileSync(fakeBin, `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
const args = process.argv.slice(2)
const mode = process.env.FAKE_BILI_MODE ?? 'ok'
appendFileSync(${JSON.stringify(invocationLog)}, JSON.stringify({
  argv: args,
  output: process.env.OUTPUT ?? '',
  noColor: process.env.NO_COLOR ?? '',
  home: process.env.HOME ?? '',
  cliHome: process.env.BILI_CLI_HOME ?? '',
}) + '\\n')
const emit = (obj, code = 0) => { process.stdout.write(JSON.stringify(obj)); process.exit(code) }
const AUTH = { authenticated: true, user: {
  id: '3546953329674695', name: '银色的whale', username: '银色的whale',
  level: 6, coins: 12, sign: 'Just a whale.',
  vip: { status: 1, type: 2, label: { text: '大会员' } },
} }
if (args[0] === '--version') { process.stdout.write('bili, version 0.6.2\\n'); process.exit(0) }
if (args[0] === 'logout') { process.stdout.write('已注销\\n'); process.exit(0) }
if (mode === 'garbage') { process.stdout.write('this is not json'); process.exit(0) }
if (mode === 'crash') { process.stderr.write('boom: upstream exploded'); process.exit(3) }
if (mode === 'hang') { setTimeout(() => process.exit(0), 30000); }
else if (mode === 'unauth') {
  emit({ ok: false, schema_version: '1', error: { code: 'not_authenticated', message: '未登录。使用 bili login 登录。' } }, 1)
} else if (mode === 'risk') {
  emit({ ok: false, schema_version: '1', error: { code: 'api_error', message: '-352 风控校验失败' } }, 1)
} else if (mode === 'leak') {
  const secret = process.env.FAKE_BILI_SECRET ?? 'SESSDATA-SECRET-123'
  emit({ ok: false, schema_version: '1', error: { code: 'api_error', message: 'cookie invalid: ' + secret } }, 1)
} else if (mode === 'browser') {
  const cred = process.env.FAKE_BILI_CRED
  if (args[0] === 'status' && cred) {
    mkdirSync(dirname(cred), { recursive: true })
    writeFileSync(cred, JSON.stringify({ sessdata: 'SESSDATA-FROM-BROWSER', bili_jct: 'JCT-FROM-BROWSER', ac_time_value: 'AC-1', buvid3: 'B3-BROWSER', buvid4: 'B4-BROWSER', dedeuserid: '3546953329674695', saved_at: Math.floor(Date.now() / 1000) }))
  }
  emit({ ok: true, schema_version: '1', data: AUTH })
} else if (mode === 'unauth-browser') {
  emit({ ok: false, schema_version: '1', error: { code: 'not_authenticated', message: '未登录。请扫码。' } }, 1)
} else if (args[0] === 'status' || args[0] === 'whoami') {
  emit({ ok: true, schema_version: '1', data: AUTH })
} else {
  emit({ ok: true, schema_version: '1', data: { echoed: args } })
}
`)
chmodSync(fakeBin, 0o755)

const invocations = () => readFileSync(invocationLog, 'utf8').trim().split('\n').filter((l) => l !== '').map((l) => JSON.parse(l))
const resetInvocations = () => writeFileSync(invocationLog, '')
const setMode = (mode) => { process.env.FAKE_BILI_MODE = mode }
setMode('ok')
process.env.FAKE_BILI_CRED = credentialPath

// ---------- mock passport ----------
const passport = { pollMode: 'wait', generateMode: 'ok', hits: { generate: 0, poll: 0 } }
const mock = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const send = (status, obj, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(obj))
  }
  if (url.pathname === '/x/passport-login/web/qrcode/generate') {
    passport.hits.generate++
    if (passport.generateMode === 'fail') return send(500, { code: -500, message: 'server down' })
    return send(200, { code: 0, message: '0', data: { url: 'https://passport.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=KEY-abc&navhide=1', qrcode_key: 'KEY-abc' } })
  }
  if (url.pathname === '/x/passport-login/web/qrcode/poll') {
    passport.hits.poll++
    const mode = passport.pollMode
    if (mode === 'wait') return send(200, { code: 0, data: { code: 86101, message: '' } })
    if (mode === 'scaned') return send(200, { code: 0, data: { code: 86090, message: '' } })
    if (mode === 'expired') return send(200, { code: 0, data: { code: 86038, message: '二维码已失效' } })
    if (mode === 'error') return send(200, { code: -400, message: 'bad request' })
    if (mode === 'ok') {
      const cookies = [
        'SESSDATA=SESSDATA-FROM-QR%2C123; Path=/; Domain=.bilibili.com; HttpOnly',
        'bili_jct=JCT-FROM-QR; Path=/',
        'DedeUserID=3546953329674695; Path=/',
        'buvid3=B3-FROM-QR; Path=/',
        'buvid4=B4-FROM-QR; Path=/',
      ]
      return send(200, {
        code: 0,
        data: {
          code: 0,
          message: '0',
          url: 'https://passport.biligame.com/crossDomain?DedeUserID=3546953329674695&SESSDATA=SESSDATA-FROM-QR%2C123&bili_jct=JCT-FROM-QR',
          refresh_token: 'RT-FROM-QR',
        },
      }, { 'set-cookie': cookies })
    }
    if (mode === 'nocookie') return send(200, { code: 0, data: { code: 0, url: '' } })
    return send(200, { code: 0, data: { code: 9999 } })
  }
  return send(404, { code: -404, message: 'not found' })
})
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
const passportBaseUrl = `http://127.0.0.1:${mock.address().port}`

const cfg = { bin: fakeBin, timeoutMs: 5000, homeDir: cliHome, credentialPath, passportBaseUrl }
const bili = createBiliService(storage, cfg)

console.log('== 纯函数 / 常量 ==')
{
  ok(extractJsonObject('{"ok":true,"data":1}')?.['ok'] === true, '纯 JSON 信封解析')
  ok(extractJsonObject('log line\n{"ok":false,"error":{"code":"x"}}')?.['ok'] === false, '夹带日志行也能提取 JSON')
  ok(extractJsonObject('no json here') === null, '无 JSON → null')
  ok(extractJsonObject('{"s":"含 } 的字符串","n":1}')?.['n'] === 1, '字符串内花括号不计深度')
  ok(mapBiliError('not_authenticated: 未登录').code === 'not_authenticated', 'not_authenticated 映射')
  ok(mapBiliError('HTTP 401: Unauthorized').code === 'not_authenticated', '401 → not_authenticated')
  ok(mapBiliError('HTTP 429: Too Many Requests').code === 'rate_limited', '429 → rate_limited')
  ok(mapBiliError('-352 风控校验失败').code === 'risk_control', '风控文案 → risk_control')
  ok(mapBiliError('HTTP -412 请求被拦截').code === 'risk_control', '-412 → risk_control')
  ok(mapBiliError('Connection timed out').code === 'network_error', '超时文案 → network_error')
  const generic = mapBiliError('something odd')
  ok(generic.code === 'bili_api_error' && generic.message.includes('something odd'), '其它错误保留原始信息')
  ok(sanitizeArgv(['search', 'A'.repeat(200)], []).at(-1).endsWith('…'), '审计 argv 超长截断')
  ok(redactSecrets('cookie=SESSDATA-SECRET-123 ok', ['SESSDATA-SECRET-123']) === 'cookie=*** ok', '凭证值脱敏')
  const user = normalizeBiliUser({ authenticated: true, user: { id: '1', name: 'n', level: 6, vip: { status: 1, type: 2, label: { text: '大会员' } } } })
  ok(user?.level === 6 && user?.vip.label === '大会员', 'normalizeBiliUser：等级 + VIP 标签')
  ok(BILI_READ_COMMANDS.has('hot') && BILI_READ_COMMANDS.has('video') && BILI_READ_COMMANDS.has('audio'), '允许清单：hot/video/audio 是读命令')
  ok(BILI_WRITE_COMMANDS.has('like') && BILI_WRITE_COMMANDS.has('dynamic-post') && BILI_WRITE_COMMANDS.has('unfollow'), '允许清单：like/dynamic-post/unfollow 是写命令')
  ok(!BILI_READ_COMMANDS.has('comment') && !BILI_READ_COMMANDS.has('dm'), '不在允许清单的命令被排除（comment/dm）')
  ok(BILI_BLOCKED_FLAGS.has('-o') && BILI_BLOCKED_FLAGS.has('--from-file') && BILI_BLOCKED_FLAGS.has('--yaml'), '危险参数清单：-o/--from-file/--yaml')
  ok(BILI_READ_LIMIT_PER_HOUR === 30 && BILI_WRITE_LIMIT_PER_HOUR === 5, '限频常量 30/h 读、5/h 写')
}

console.log('== fake bin 执行与 env 注入 ==')
{
  setMode('ok')
  const inv0 = invocations().length
  const status = await bili.status()
  ok(status.authenticated === true && status.user?.name === '银色的whale', 'status()：已登录且取到账号名')
  ok(status.user?.mid === '3546953329674695' && status.user?.level === 6, 'status()：mid / level 归一化')
  ok(status.user?.vip.label === '大会员', 'status()：VIP 标签归一化')
  ok(status.credential.present === false, 'status()：fake bin 不写凭证 → credential.present=false')
  ok(status.allowWrites === false, 'status()：写开关默认关')
  const first = invocations()[inv0]
  ok(first?.output === 'json', '子进程注入 OUTPUT=json')
  ok(first?.noColor === '1', '子进程注入 NO_COLOR=1')
  ok(first?.home === cliHome, '子进程 HOME = BILI_CLI_HOME（决定凭证目录）')
  ok(first?.cliHome === cliHome, '子进程 BILI_CLI_HOME 透传')

  resetInvocations()
  const hot = await bili.run(['hot'], { botId: 'bot-bili' })
  ok(hot.ok === true && hot.dryRun === false, '只读命令执行成功')
  ok(Array.isArray(hot.data?.echoed) && hot.data.echoed[0] === 'hot', 'argv 原样传给 CLI')
  ok(invocations()[0]?.argv[0] === 'hot', '子进程 argv[0]=hot')

  resetInvocations()
  const video = await bili.run(['video', 'BV1xx411c7mD', '--subtitle'], { botId: 'bot-bili' })
  ok(video.ok === true && invocations()[0]?.argv.includes('--subtitle'), 'video --subtitle 参数透传')

  ok((await bili.run([], { botId: 'bot-bili' })).error?.code === 'bad_request', '空 argv → bad_request')
  ok((await bili.run(['hot', ''], { botId: 'bot-bili' })).error?.code === 'bad_request', '空字符串参数 → bad_request')
  ok((await bili.run(['rm', '-rf'], { botId: 'bot-bili' })).error?.code === 'command_not_allowed', '未知命令 → command_not_allowed')
  for (const flag of ['-o', '--output', '--from-file', '--input', '-i', '--yaml']) {
    const blocked = await bili.run(['hot', flag, 'x'], { botId: 'bot-bili' })
    ok(blocked.ok === false && blocked.error?.code === 'flag_not_allowed', `危险参数 ${flag} 被拦截`)
  }
}

console.log('== 信封 / 错误映射 / 超时 ==')
{
  setMode('unauth')
  const st = await bili.status()
  ok(st.authenticated === false && st.user === null, '未登录 status()：authenticated=false（不抛错）')
  ok(st.error?.code === 'not_authenticated', 'exit 1 但 JSON 合法 → 识别 not_authenticated')
  const runUnauth = await bili.run(['hot'], { botId: 'bot-bili' })
  ok(runUnauth.ok === false && runUnauth.error?.code === 'not_authenticated', '未登录执行命令 → not_authenticated')

  setMode('risk')
  const risk = await bili.run(['hot'], { botId: 'bot-bili' })
  ok(risk.ok === false && risk.error?.code === 'risk_control', '风控错误 → risk_control')

  setMode('garbage')
  ok((await bili.run(['hot'], { botId: 'bot-bili' })).error?.code === 'bili_parse_failed', '非 JSON 输出 → bili_parse_failed')

  setMode('crash')
  const crash = await bili.run(['hot'], { botId: 'bot-bili' })
  ok(crash.ok === false && (crash.error?.raw ?? '').includes('boom'), '非 0 退出 → 保留 stderr 原文')

  setMode('hang')
  const hangSvc = createBiliService(storage, { ...cfg, timeoutMs: 1200 })
  const hang = await hangSvc.run(['hot'], { botId: 'bot-bili' })
  ok(hang.ok === false && hang.error?.code === 'bili_timeout', '超时 → bili_timeout')

  const missing = createBiliService(storage, { ...cfg, bin: join(dir, 'no-such-bili') })
  ok((await missing.binOk()) === false, 'binOk：二进制不存在 → false')
  ok((await missing.run(['hot'], { botId: 'bot-bili' })).error?.code === 'bili_bin_unavailable', '二进制不存在 → bili_bin_unavailable')
  ok((await bili.binOk()) === true, 'binOk：fake bin 可用')
  setMode('ok')
}

console.log('== 写护栏（默认 dry-run / 开关 / --yes）==')
{
  setMode('ok')
  resetInvocations()
  const dry = await bili.run(['like', 'BV1xx411c7mD'], { botId: 'bot-bili' })
  ok(dry.ok === true && dry.dryRun === true, '写命令默认 dry-run（开关关）')
  ok((dry.note ?? '').includes('预演'), 'dry-run 返回可读 note')
  ok(invocations().length === 0, 'dry-run 不执行子进程')

  const settingsResult = bili.settings({ allowWrites: true })
  ok(settingsResult.ok === true && settingsResult.allowWrites === true, 'settings() 同步返回 {ok, allowWrites}')
  const preview2 = await bili.run(['like', 'BV1xx411c7mD'], { botId: 'bot-bili' })
  ok(preview2.dryRun === true && invocations().length === 0, '开关打开但未显式 dryRun:false → 仍预演')

  resetInvocations()
  const real = await bili.run(['like', 'BV1xx411c7mD'], { botId: 'bot-bili', dryRun: false })
  ok(real.ok === true && real.dryRun === false, '开关打开 + dryRun:false → 真执行')
  ok(invocations()[0]?.argv[0] === 'like', '真执行 spawn 了 like')

  resetInvocations()
  await bili.run(['unfollow', '12345'], { botId: 'bot-bili', dryRun: false })
  ok(invocations()[0]?.argv.includes('--yes'), 'unfollow 执行时自动补 --yes（非 TTY 防挂起）')
  resetInvocations()
  await bili.run(['dynamic-delete', '987654321'], { botId: 'bot-bili', dryRun: false })
  ok(invocations()[0]?.argv.includes('--yes'), 'dynamic-delete 执行时自动补 --yes', JSON.stringify(invocations()[0]?.argv ?? null))
}

console.log('== audio（下载类）护栏 ==')
{
  setMode('ok')
  bili.settings({ allowWrites: false })
  resetInvocations()
  const audioDry = await bili.run(['audio', 'BV1xx411c7mD'], { botId: 'bot-audio' })
  ok(audioDry.dryRun === true && invocations().length === 0, 'audio 开关关 → 预演不下载')
  ok((audioDry.outputDir ?? '').includes('downloads/bili'), 'audio 预演给出固定输出目录')
  ok((audioDry.note ?? '').includes('下载'), 'audio 预演 note 说明下载类')

  bili.settings({ allowWrites: true })
  resetInvocations()
  const audioReal = await bili.run(['audio', 'BV1xx411c7mD'], { botId: 'bot-audio', dryRun: false })
  const audioArgv = invocations()[0]?.argv ?? []
  ok(audioReal.ok === true && audioReal.dryRun === false, 'audio 开关开 + dryRun:false → 执行')
  ok(audioArgv.includes('-o') && (audioArgv.at(-1) ?? '').includes('downloads/bili'), 'audio 固定 -o 输出目录（不可被 argv 覆盖）')
  ok((await bili.run(['audio', 'BV1x', '-o', '/tmp/x'], { botId: 'bot-audio' })).error?.code === 'flag_not_allowed', 'audio 传 -o → flag_not_allowed')
  bili.settings({ allowWrites: false })
}

console.log('== 审计 ==')
{
  const rows = storage.prepare("SELECT action, detail FROM audit_logs WHERE bot_id = 'bot-bili' AND category = 'tool_call' ORDER BY created_at").all()
  const actions = rows.map((r) => r.action)
  ok(actions.includes('bili_hot'), '读命令审计 action=bili_hot')
  ok(actions.includes('bili_like'), '写命令审计 action=bili_like')
  const audioAudit = storage.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'bili_audio' AND category = 'tool_call'").get()
  ok((audioAudit?.c ?? 0) >= 1, 'audio 审计 action=bili_audio')
  const dryRow = rows.find((r) => r.action === 'bili_like')
  const detail = JSON.parse(dryRow.detail)
  ok(Array.isArray(detail.argv) && detail.argv[0] === 'like', '审计 detail 含 argv')
  ok(typeof detail.dryRun === 'boolean' && detail.dryRun === true, '审计记录 dryRun 标记（预演那条）')
  ok(typeof detail.exitCode === 'number', '审计记录 exitCode')
  ok(rows.some((r) => r.action === 'bili_like' && JSON.parse(r.detail).dryRun === false), '真执行那条 dryRun=false')
}

console.log('== 浏览器 Cookie 提取 / 登出 ==')
{
  setMode('browser')
  const extract = await bili.browserExtract()
  ok(extract.ok === true && extract.status.authenticated === true, '浏览器提取成功（CLI 写凭证并登录）')
  ok(existsSync(credentialPath), '提取后 credential.json 存在')
  const cred = readCredential(credentialPath)
  ok(cred?.sessdata === 'SESSDATA-FROM-BROWSER', '提取到的凭证可读（sessdata）')
  ok(cred?.buvid3 === 'B3-BROWSER', '提取到的 buvid3 保留')

  // 先写一份旧凭证，验证 browserExtract 会先删再提取（失败路径时文件应不存在）
  writeCredential(credentialPath, { sessdata: 'STALE-SESS', bili_jct: 'STALE-JCT' })
  setMode('unauth-browser')
  const failed = await bili.browserExtract()
  ok(failed.ok === false && failed.status.authenticated === false, '浏览器不可用 → ok=false（不抛错）')
  ok(!existsSync(credentialPath), '提取失败路径：旧凭证已被删除')
  ok((failed.hint ?? '').includes('扫码'), '失败提示引导改用扫码登录')

  setMode('ok')
  const logout = await bili.logout()
  ok(logout.ok === true && logout.cleared === false, '登出：无凭证时 cleared=false')
  writeCredential(credentialPath, { sessdata: 'TO-CLEAR-SESS', bili_jct: 'TO-CLEAR-JCT' })
  const logout2 = await bili.logout()
  ok(logout2.cleared === true && !existsSync(credentialPath), '登出：有凭证时清除')
}

console.log('== 扫码登录（mock passport）==')
{
  passport.pollMode = 'wait'
  const gen = await qrGenerate({ passportBaseUrl })
  ok(gen.qrcodeKey === 'KEY-abc', 'generate：拿到 qrcode_key')
  ok(gen.link.startsWith('https://passport.bilibili.com/'), 'generate：登录 URL')
  ok(gen.qrDataUrl.startsWith('data:image/png;base64,'), 'generate：QR PNG data URL')
  const png = Buffer.from(gen.qrDataUrl.split(',')[1], 'base64')
  ok(png.length > 100 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47, 'QR data URL 是可解码 PNG')

  passport.generateMode = 'fail'
  let genErr = null
  try { await qrGenerate({ passportBaseUrl }) } catch (e) { genErr = e }
  ok(genErr !== null && String(genErr.message).includes('HTTP 500'), 'generate 失败给出可读错误')
  passport.generateMode = 'ok'

  passport.pollMode = 'wait'
  ok((await qrPollOnce('KEY-abc', { passportBaseUrl })).status === 'wait', 'poll：86101 → wait')
  passport.pollMode = 'scaned'
  ok((await qrPollOnce('KEY-abc', { passportBaseUrl })).status === 'scaned', 'poll：86090 → scaned')
  passport.pollMode = 'expired'
  ok((await qrPollOnce('KEY-abc', { passportBaseUrl })).status === 'expired', 'poll：86038 → expired')
  passport.pollMode = 'error'
  ok((await qrPollOnce('KEY-abc', { passportBaseUrl })).status === 'error', 'poll：passport code!==0 → error')
  passport.pollMode = 'nocookie'
  const nocookie = await qrPollOnce('KEY-abc', { passportBaseUrl })
  ok(nocookie.status === 'error' && (nocookie.message ?? '').includes('SESSDATA'), 'poll：确认但无 SESSDATA → error 提示')
  passport.pollMode = 'ok'
  const confirmed = await qrPollOnce('KEY-abc', { passportBaseUrl })
  ok(confirmed.status === 'confirmed' && confirmed.cookies?.sessdata === 'SESSDATA-FROM-QR%2C123', 'poll：确认并解析 Set-Cookie（值保持原样）')
  ok(confirmed.cookies?.bili_jct === 'JCT-FROM-QR' && confirmed.cookies?.dedeuserid === '3546953329674695', 'poll：解析 bili_jct / DedeUserID')
  ok(confirmed.cookies?.ac_time_value === 'RT-FROM-QR', 'poll：refresh_token → ac_time_value')

  const jar = cookieJarFrom([], 'https://passport.biligame.com/crossDomain?DedeUserID=9&SESSDATA=SD&bili_jct=JC')
  ok(jar.sessdata === 'SD' && jar.bili_jct === 'JC' && jar.dedeuserid === '9', 'Set-Cookie 缺失时从跳转 URL 兜底')

  const store = new QrSessionStore(180_000)
  const s1 = store.create({ qrcodeKey: 'K', link: 'L', qrDataUrl: 'D' }, 1000)
  ok(s1.expiresAt === 181_000, '会话 TTL：expiresAt = createdAt + 180s')
  store.create({ qrcodeKey: 'K2', link: 'L', qrDataUrl: 'D' }, 200_000)
  ok(store.size() === 1, '会话存储：新建时清理过期会话')
}

console.log('== 扫码 → 写 credential.json → 复核 ==')
{
  // 先放一份旧凭证：buvid 合并 + ac_time_value 继承走的是“新值优先”
  writeCredential(credentialPath, { sessdata: 'OLD', bili_jct: 'OLDJCT', buvid3: 'OLD-B3', buvid4: 'OLD-B4' })
  passport.pollMode = 'ok'
  setMode('ok')
  const start = await bili.qrStart()
  ok(start.sessionId.length > 8, 'qrStart：返回 sessionId')
  ok(start.qrDataUrl.startsWith('data:image/png;base64,'), 'qrStart：返回 PNG data URL')
  ok(start.expiresInMs === 180_000, 'qrStart：expiresInMs=180000')
  ok((await bili.qrPoll('no-such-session')).status === 'expired', 'qrPoll：未知 session → expired')

  passport.pollMode = 'wait'
  const waitPoll = await bili.qrPoll(start.sessionId)
  ok(waitPoll.status === 'wait', 'qrPoll：wait')
  passport.pollMode = 'scaned'
  ok((await bili.qrPoll(start.sessionId)).status === 'scaned', 'qrPoll：scaned')
  passport.pollMode = 'expired'
  const expiredPoll = await bili.qrPoll(start.sessionId)
  ok(expiredPoll.status === 'expired' && (expiredPoll.message ?? '') !== '', 'qrPoll：expired + 可读提示')

  // 重新开始一次并确认
  passport.pollMode = 'ok'
  const start2 = await bili.qrStart()
  const confirmedPoll = await bili.qrPoll(start2.sessionId)
  ok(confirmedPoll.status === 'confirmed', 'qrPoll：confirm')
  ok(confirmedPoll.user?.name === '银色的whale', 'qrPoll：confirm 后复核出账号名（bili status）')
  ok(existsSync(credentialPath), 'confirm 后 credential.json 已写入')

  const cred = readCredential(credentialPath)
  const keys = cred === null ? [] : Object.keys(cred).sort()
  ok(JSON.stringify(keys) === JSON.stringify(['ac_time_value', 'bili_jct', 'buvid3', 'buvid4', 'dedeuserid', 'saved_at', 'sessdata']), 'credential schema：7 个字段与 CLI 一致')
  ok(cred?.sessdata === 'SESSDATA-FROM-QR%2C123', 'credential：sessdata 来自 Set-Cookie')
  ok(cred?.bili_jct === 'JCT-FROM-QR' && cred?.dedeuserid === '3546953329674695', 'credential：bili_jct / dedeuserid')
  ok(cred?.buvid3 === 'B3-FROM-QR' && cred?.buvid4 === 'B4-FROM-QR', 'credential：buvid3/4 写入')
  ok(cred?.ac_time_value === 'RT-FROM-QR', 'credential：ac_time_value=refresh_token')
  ok(typeof cred?.saved_at === 'number' && Math.abs(cred.saved_at - Math.floor(Date.now() / 1000)) < 30, 'credential：saved_at 是 Unix 秒')
  const mode = statSync(credentialPath).mode & 0o777
  ok(mode === 0o600, 'credential 权限 0600', `mode=${mode.toString(8)}`)
  ok(credentialInfo(credentialPath).present === true && credentialInfo(credentialPath).hasBuvid === true, 'credentialInfo：present/hasBuvid')
  ok((await bili.status()).authenticated === true, '写凭证后 status 复核可登录')

  // 扫码会话只能确认一次（确认后从 store 移除）
  ok((await bili.qrPoll(start2.sessionId)).status === 'expired', '确认后同一 session 不再可用')
}

console.log('== 权限 / 限频 ==')
{
  setMode('ok')
  const readBot = 'bot-rate-read'
  let blockedAt = -1
  for (let i = 0; i < BILI_READ_LIMIT_PER_HOUR + 2; i++) {
    const r = await bili.run(['hot'], { botId: readBot })
    if (!r.ok && r.error?.code === 'rate_limited') { blockedAt = i; break }
  }
  ok(blockedAt === BILI_READ_LIMIT_PER_HOUR, `读超过 ${BILI_READ_LIMIT_PER_HOUR}/h → rate_limited（第 ${blockedAt + 1} 次被拒）`)

  bili.settings({ allowWrites: true })
  // 清掉写开关造成的读统计影响：新 bot
  const writeBot = 'bot-rate-write'
  let writeBlockedAt = -1
  for (let i = 0; i < BILI_WRITE_LIMIT_PER_HOUR + 2; i++) {
    const r = await bili.run(['like', 'BV1x'], { botId: writeBot, dryRun: false })
    if (!r.ok && r.error?.code === 'rate_limited') { writeBlockedAt = i; break }
  }
  ok(writeBlockedAt === BILI_WRITE_LIMIT_PER_HOUR, `写超过 ${BILI_WRITE_LIMIT_PER_HOUR}/h → rate_limited（第 ${writeBlockedAt + 1} 次被拒）`)
  const limitedMsg = await bili.run(['like', 'BV1x'], { botId: writeBot, dryRun: false })
  ok((limitedMsg.error?.message ?? '').includes('每小时'), '限频错误信息可读（中文）')
  bili.settings({ allowWrites: false })
}

console.log('== 凭证不打印 / 审计脱敏 ==')
{
  writeCredential(credentialPath, { sessdata: 'SESSDATA-SECRET-123456', bili_jct: 'JCT-SECRET-123456' })
  setMode('leak')
  process.env.FAKE_BILI_SECRET = 'SESSDATA-SECRET-123456'
  const leak = await bili.run(['hot'], { botId: 'bot-leak' })
  ok(leak.ok === false, '泄密模式：命令失败')
  ok(!JSON.stringify(leak).includes('SESSDATA-SECRET-123456'), '错误结果不包含 SESSDATA 原文')
  ok((leak.error?.message ?? '').includes('***'), '错误信息里凭证被替换为 ***')
  const stLeak = await bili.status()
  ok(!JSON.stringify(stLeak).includes('SESSDATA-SECRET-123456'), 'status 不回传 SESSDATA')
  const auditRows = storage.prepare("SELECT detail FROM audit_logs WHERE bot_id = 'bot-leak'").all()
  ok(!JSON.stringify(auditRows).includes('SESSDATA-SECRET-123456'), '审计详情不含 SESSDATA')
  const probe = storage.getSetting('bili.last_probe') ?? ''
  ok(!probe.includes('SESSDATA-SECRET-123456'), 'lastProbe 不含 SESSDATA')
  delete process.env.FAKE_BILI_SECRET
  setMode('ok')
}

console.log('== 工具注册 / 旧 MCP 收敛门 / 插件装配 ==')
{
  const registered = []
  const fakeHub = { tools: { registerChannelTool: (def, exec) => { registered.push({ def, exec }) } } }
  registerBiliTool(fakeHub, bili)
  ok(registered.length === 1 && registered[0].def.function.name === 'bili', 'bili 工具注册进 hub（名称 = bili）')
  ok(BILI_TOOL.function.parameters.required.includes('argv'), '工具 schema：argv 必填')
  ok(BILI_TOOL.function.description.includes('dryRun'), '工具描述写明写操作 dryRun 语义')
  ok(BILI_TOOL.function.description.includes('audio'), '工具描述包含 audio 能力')
  const toolRead = await registered[0].exec({ argv: ['hot'] }, { botId: 'bot-bili', sender: 'u1' })
  const parsed = JSON.parse(toolRead.result)
  ok(parsed.ok === true && parsed.dryRun === false, '工具执行返回 JSON 字符串（读）')
  const toolDry = await registered[0].exec({ argv: ['like', 'BV1x'] }, { botId: 'bot-bili', sender: 'u1' })
  ok(JSON.parse(toolDry.result).dryRun === true, '工具写命令默认预演')

  const handlers = {}
  const provided = {}
  let injected = 0
  const fakeCtx = {
    logger: { info: () => {} },
    littlyStorage: storage,
    provide: (key, value) => { provided[key] = value },
    inject: (_names, cb) => { injected++; cb({ littlyHub: fakeHub, logger: { info: () => {} } }) },
    on: (event, handler) => { handlers[event] = handler },
  }
  process.env.BILI_BIN = fakeBin
  applyBili(fakeCtx, {})
  ok(typeof provided['littlyBili'] === 'object' && provided['littlyBili'] !== null, '插件装配：提供 littlyBili 服务')
  ok(injected === 1, '插件装配：ctx.inject 等 littlyHub 就绪')
  ok(typeof handlers['tools/pre-execute'] === 'function', '插件装配：注册 tools/pre-execute 收敛门')
  const nextAllow = async () => ({ kind: 'allow' })
  const denied = await handlers['tools/pre-execute']({ name: 'mcp__bili__video_view' }, nextAllow)
  ok(denied.kind === 'deny' && denied.reason === CONVERGE_REASON, '旧 mcp__bili__* 工具被拒（指向元工具）')
  const allowedBili = await handlers['tools/pre-execute']({ name: 'bili' }, nextAllow)
  ok(allowedBili.kind === 'allow', 'bili 元工具放行')
  const allowedOther = await handlers['tools/pre-execute']({ name: 'remember' }, nextAllow)
  ok(allowedOther.kind === 'allow', '其它工具不受影响')
  delete process.env.BILI_BIN

  const ctxNoConverge = { logger: { info: () => {} }, littlyStorage: storage, provide: () => {}, inject: () => {}, on: (e, h) => { ctxNoConverge._h = h }, _h: undefined }
  applyBili(ctxNoConverge, { converge: false })
  ok(ctxNoConverge._h === undefined, 'converge=false 时不注册拦截')
}

mock.close()
storage.close()
rmSync(dir, { recursive: true, force: true })
console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
