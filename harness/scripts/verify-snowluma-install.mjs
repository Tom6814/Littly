#!/usr/bin/env node
/**
 * SnowLuma 一键安装/配置行为验证。
 * 运行：node scripts/verify-snowluma-install.mjs
 *
 * 全程 fake docker（SNOWLUMA_DOCKER_BIN 指向自写 node 脚本，按 argv 模拟
 * pull/run/inspect/start/stop/restart/logs/rm）+ 注入 fake WebSocket / noVNC 检查，
 * 不联网、不需要 Docker/SnowLuma。覆盖：
 *  - EULA consent 拦截
 *  - parse 状态机（not_installed/pulling/installed/waiting_scan/connected/error）
 *  - docker run 参数（SYS_PTRACE/seccomp/shm/ulimit/VNC_PASSWD/uid/gid/端口只绑 127.0.0.1/三卷）
 *  - readOnebotToken（onebot.json + 登录后 onebot_<uin>.json 优先；host 校验只告警不改；token 不回传）
 *  - noVNC 免密链接、qrInfo、日志提取 WebUI 临时密码 + 脱敏
 *  - autoconfigure：等待 3001（waiting_login）→ 探测 get_login_info → 写 bots.snowluma_*
 *  - stop / remove（保留或删除数据）
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LittlyStorage } from '../packages/littly/storage/src/index.ts'
import {
  createSnowlumaService, SnowlumaError, randomPassword, extractWebuiPassword, maskSecrets,
  buildRunArgs, defaultDataDir, SNOWLUMA_CONTAINER, SNOWLUMA_IMAGE,
} from '../packages/littly/snowluma/src/service.ts'

let pass = 0
let fail = 0
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? `（${detail}）` : ''}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? `（${detail}）` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const dir = mkdtempSync(join(tmpdir(), 'littly-snowluma-'))
const stateFile = join(dir, 'fake-docker-state.json')
writeFileSync(stateFile, JSON.stringify({ pulled: false, container: { exists: false, running: false, status: '' }, runArgs: [], restarts: 0 }))
const readState = () => JSON.parse(readFileSync(stateFile, 'utf8'))
const writeState = (s) => writeFileSync(stateFile, JSON.stringify(s))

// ---------- fake docker ----------
const fakeDocker = join(dir, 'fake-docker.mjs')
writeFileSync(fakeDocker, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
const stateFile = ${JSON.stringify(stateFile)}
const argv = process.argv.slice(2)
const read = () => JSON.parse(readFileSync(stateFile, 'utf8'))
const write = (s) => writeFileSync(stateFile, JSON.stringify(s))
const state = read()
const failMode = process.env.FAKE_DOCKER_FAIL ?? ''
const fail = (msg) => { process.stderr.write(msg + '\\n'); process.exit(1) }
const cmd = argv[0]
const emit = (text) => { process.stdout.write(text + '\\n'); process.exit(0) }
if (cmd === 'version') {
  if (failMode === 'version') fail('Cannot connect to the Docker daemon')
  emit('29.5.2')
}
if (cmd === 'image' && argv[1] === 'inspect') {
  if (state.pulled) emit('{"Id":"sha256:deadbeef"}')
  fail('Error response from daemon: No such image: ' + argv[argv.length - 1])
}
if (cmd === 'inspect') {
  if (!state.container.exists) fail('Error: No such object: ' + argv[argv.length - 1])
  emit(state.container.running + '|' + state.container.status)
}
if (cmd === 'pull') {
  if (failMode === 'pull') fail('Error response from daemon: pull access denied')
  write({ ...state, pulled: true })
  process.stdout.write('Pulling from motricseven7/snowluma\\n')
  setTimeout(() => process.exit(0), 250)
}
if (cmd === 'run') {
  const args = argv.slice(1)
  write({ ...state, container: { exists: true, running: true, status: 'running' }, runArgs: args })
  emit('container-id-abc')
}
if (cmd === 'start') {
  write({ ...state, container: { exists: true, running: true, status: 'running' } })
  emit('started')
}
if (cmd === 'stop') {
  write({ ...state, container: { exists: true, running: false, status: 'exited' } })
  emit('stopped')
}
if (cmd === 'restart') {
  write({ ...state, restarts: state.restarts + 1 })
  emit('restarted')
}
if (cmd === 'logs') {
  process.stdout.write('[supervisor] initial credentials: user=admin password=TmpPass12345\\n')
  process.stdout.write('[vnc] websocket started 6081\\n')
  process.stdout.write('[qq] waiting for scan login\\n')
  process.exit(0)
}
if (cmd === 'rm') {
  write({ ...state, container: { exists: false, running: false, status: '' } })
  emit('removed')
}
fail('unsupported fake docker command: ' + argv.join(' '))
`)
chmodSync(fakeDocker, 0o755)

// ---------- fake WebSocket（autoconfigure 探测）----------
let wsMode = 'fail' // 'fail' | 'ok'
class FakeWs {
  constructor() {
    this.readyState = 0
    this.listeners = new Map()
    setTimeout(() => {
      if (wsMode === 'ok') { this.readyState = 1; this.fire('open', {}) }
      else this.fire('error', { error: new Error('ECONNREFUSED') })
    }, 0)
  }
  addEventListener(name, handler) {
    if (!this.listeners.has(name)) this.listeners.set(name, [])
    this.listeners.get(name).push(handler)
  }
  fire(name, event) { for (const h of [...(this.listeners.get(name) ?? [])]) h(event) }
  send(raw) {
    const frame = JSON.parse(raw)
    setTimeout(() => this.fire('message', { data: JSON.stringify({ status: 'ok', retcode: 0, echo: frame.echo, data: { user_id: 10001, nickname: '小璃' } }) }), 0)
  }
  close() { this.readyState = 3; this.fire('close', {}) }
}
const webSocketFactory = () => new FakeWs()

const makeService = (overrides = {}) => {
  const storage = new LittlyStorage({ logger: { info: () => {} } }, { file: join(dir, `snow-${Math.random().toString(36).slice(2)}.db`) })
  storage.setSetting('platform.secret', 'snow-test-secret')
  storage.prepare("INSERT INTO bots (id, name, created_at) VALUES ('b1','小璃',?)").run(new Date().toISOString())
  const service = createSnowlumaService(storage, {
    dockerBin: fakeDocker,
    image: SNOWLUMA_IMAGE,
    containerName: SNOWLUMA_CONTAINER,
    dataDir: join(dir, 'mount'),
    webuiPort: 5099,
    novncPort: 6081,
    wsPort: 3001,
    configWaitMs: 400,
    autoconfigureWaitMs: 800,
    timeoutMs: 5000,
    webSocketFactory: overrides.webSocketFactory ?? webSocketFactory,
    novncCheck: async () => true,
  })
  return { storage, service }
}

/** 预置 onebot 配置（模拟官方镜像首启生成，host 已是 0.0.0.0）。 */
function seedOnebotConfig(mount, input = {}) {
  const configDir = join(mount, 'data', 'config')
  mkdirSync(configDir, { recursive: true })
  const onebot = {
    networks: {
      httpServers: [{ host: '0.0.0.0', port: 3000, accessToken: 'http-token-AAA' }],
      wsServers: [{ host: input.wsHost ?? '0.0.0.0', port: 3001, accessToken: input.wsToken ?? 'ws-token-BBB' }],
    },
    messageFormat: 'array',
  }
  writeFileSync(join(configDir, 'onebot.json'), JSON.stringify(onebot))
  return configDir
}

console.log('== 纯函数 ==')
{
  const pw = randomPassword(12)
  ok(pw.length === 12 && /^[A-Za-z0-9]+$/.test(pw), '随机密码 12 位字母数字')
  ok(randomPassword(12) !== randomPassword(12), '两次生成不同')
  ok(defaultDataDir().endsWith('/snowluma'), 'defaultDataDir 以 /snowluma 结尾')
  ok(extractWebuiPassword('initial credentials: user=admin password=TmpPass123') === 'TmpPass123', '日志提取 initial credentials 临时密码')
  ok(extractWebuiPassword('临时密码：Abc12345') === 'Abc12345', '日志提取中文「临时密码」')
  ok(extractWebuiPassword('no password here') === undefined, '无密码 → undefined')
  const raw = 'password=TmpPass123 token=abc123 正常日志'
  const masked = maskSecrets(raw, ['TmpPass123'])
  ok(!masked.includes('TmpPass123') && !masked.includes('abc123') && masked.includes('正常日志'), '日志脱敏 password/token 值')
  const args = buildRunArgs({ containerName: 'littly-snowluma', image: SNOWLUMA_IMAGE, dataDir: '/tmp/mount', webuiPort: 5099, novncPort: 6081, wsPort: 3001, vncPassword: 'Pw1234567890', uid: 501, gid: 20 })
  const joined = args.join(' ')
  ok(joined.includes('--cap-add=SYS_PTRACE'), 'run 参数含 SYS_PTRACE')
  ok(joined.includes('seccomp=unconfined'), 'run 参数含 seccomp=unconfined')
  ok(joined.includes('--shm-size=1g'), 'run 参数含 shm-size=1g')
  ok(joined.includes('nofile=65536:1048576'), 'run 参数含 ulimit nofile')
  ok(joined.includes('VNC_PASSWD=Pw1234567890'), 'run 参数含 VNC_PASSWD')
  ok(joined.includes('SNOWLUMA_UID=501') && joined.includes('SNOWLUMA_GID=20'), 'run 参数含宿主 uid/gid')
  ok(joined.includes('SNOWLUMA_WEBUI_HOST=0.0.0.0') && joined.includes('SNOWLUMA_WEBUI_PORT=5099'), 'run 参数含 WebUI env')
  ok(joined.includes('SNOWLUMA_QQ_FLAGS=--disable-gpu'), 'run 参数含 QQ flags')
  ok(joined.includes('127.0.0.1:6081:6081') && joined.includes('127.0.0.1:5099:5099') && joined.includes('127.0.0.1:3001:3001'), '端口只绑 127.0.0.1（6081/5099/3001）')
  ok(joined.includes('/tmp/mount/data:/app/data') && joined.includes('/tmp/mount/qq-config:/app/.config') && joined.includes('/tmp/mount/qq-data:/app/.local/share'), '三块 bind mount')
  ok(args.at(-1) === SNOWLUMA_IMAGE, '镜像在参数末尾')
}

console.log('== install / pull 状态机 ==')
{
  const { storage, service } = makeService()
  let consentError = null
  try { await service.install({ consent: false }) } catch (error) { consentError = error }
  ok(consentError instanceof SnowlumaError && consentError.code === 'consent_required' && consentError.status === 400, 'install 无 consent → consent_required 400')
  const installing = await service.install({ consent: true })
  ok(['pulling', 'installed'].includes(installing.state), `install(consent) 返回 pulling/installed（${installing.state}）`)
  ok(installing.consent === true, 'status.consent=true')
  let st = await service.status()
  for (let i = 0; i < 40 && st.state === 'pulling'; i++) { await sleep(100); st = await service.status() }
  ok(st.state === 'installed' && st.image.present === true, 'pull 完成 → installed & image.present')
  ok(st.dockerOk === true, 'status.dockerOk=true')
  ok(st.image.tag === SNOWLUMA_IMAGE, 'status.image.tag 是官方镜像')
  storage.close()
}

console.log('== start / docker run 参数 / noVNC / 配置读取 ==')
let shared
{
  // 新 mount + 预置 onebot.json（模拟官方镜像首启）
  const mount = join(dir, 'mount2')
  seedOnebotConfig(mount)
  shared = makeService()
  // 用独立 storage 的 service 指向 mount2
  const { storage } = shared
  const service = createSnowlumaService(storage, {
    dockerBin: fakeDocker, image: SNOWLUMA_IMAGE, containerName: SNOWLUMA_CONTAINER, dataDir: mount,
    webuiPort: 5099, novncPort: 6081, wsPort: 3001, configWaitMs: 400, autoconfigureWaitMs: 800, timeoutMs: 5000,
    webSocketFactory, novncCheck: async () => true,
  })
  ok((await service.start().catch((e) => e)) instanceof SnowlumaError, 'start 未同意 EULA → consent_required')
  await service.install({ consent: true })
  let st = await service.status()
  for (let i = 0; i < 40 && st.state === 'pulling'; i++) { await sleep(100); st = await service.status() }
  const started = await service.start()
  ok(started.container.running === true, 'start 后容器 running')
  ok(['starting', 'waiting_scan'].includes(started.state), `start 后状态 starting/waiting_scan（${started.state}）`)
  const state = readState()
  ok(state.runArgs.length > 0, 'fake docker 收到 run 参数')
  ok(state.runArgs.join(' ').includes('SYS_PTRACE'), 'run 参数含 SYS_PTRACE')
  ok(state.runArgs.includes('127.0.0.1:3001:3001'), 'run 参数含 3001 映射')
  const vncArg = state.runArgs.find((a) => a.startsWith('VNC_PASSWD='))
  ok(vncArg !== undefined && vncArg.length === 'VNC_PASSWD='.length + 12, 'VNC_PASSWD 12 位')
  ok(state.restarts === 0, '不改 host/不重启（restarts=0）')
  ok(started.configReady === true && started.hasToken === true, 'configReady/hasToken=true（读到 onebot.json token）')
  ok(started.novncUrl.includes('autoconnect=1') && started.novncUrl.includes('password='), 'noVNC 免密链接带 autoconnect+password')
  ok(typeof started.vncPassword === 'string' && started.vncPassword.length === 12, 'status.vncPassword 12 位')
  ok(started.configWarning === undefined, 'host=0.0.0.0 无告警')
  // 日志提取 WebUI 临时密码
  const logs = await service.logs({ tail: 50 })
  ok(logs.webuiPassword === 'TmpPass12345', '日志提取 WebUI 临时密码')
  ok(!logs.logs.includes('TmpPass12345'), '日志正文已遮罩 WebUI 密码')
  ok(logs.logs.includes('正常日志') === false && logs.logs.includes('supervisor'), '日志正文保留')
  st = await service.status()
  ok(st.webuiPassword === 'TmpPass12345', 'status 带已提取的 webuiPassword')
  // qrInfo
  const qr = await service.qrInfo()
  ok(qr.novncUrl.startsWith('http://127.0.0.1:6081/vnc.html'), 'qrInfo.novncUrl')
  ok(qr.webuiUrl === 'http://127.0.0.1:5099', 'qrInfo.webuiUrl')
  ok(qr.novncUrl.includes('autoconnect=1'), 'qrInfo noVNC 免密')
  ok(qr.steps.length === 4, 'qrInfo 4 步')
  shared.storage = storage
  shared.service = service
  shared.mount = mount
}

console.log('== readOnebotToken：per-uin 优先 / host 告警 / token 不回传 ==')
{
  const { service, mount } = shared
  const token1 = await service.readOnebotToken()
  ok(token1.ok === true && token1.token === 'ws-token-BBB', '读 onebot.json 的 ws accessToken')
  ok(token1.source.endsWith('onebot.json'), 'source=onebot.json')
  // 登录后生成 onebot_<uin>.json（token 以它为准）
  const configDir = join(mount, 'data', 'config')
  writeFileSync(join(configDir, 'onebot_12345.json'), JSON.stringify({ networks: { wsServers: [{ host: '0.0.0.0', port: 3001, accessToken: 'per-uin-TOKEN' }] } }))
  const token2 = await service.readOnebotToken()
  ok(token2.token === 'per-uin-TOKEN' && token2.source.includes('onebot_12345.json'), '登录后 onebot_<uin>.json 优先')
  const status2 = await service.status()
  ok(JSON.stringify(status2).includes('per-uin-TOKEN') === false && JSON.stringify(status2).includes('ws-token-BBB') === false, 'status 不回传 token 明文')
  // host 不是 0.0.0.0 → 只告警不改文件（先移除 per-uin 正常配置，避免优先命中）
  rmSync(join(configDir, 'onebot_12345.json'), { force: true })
  const before = readFileSync(join(configDir, 'onebot.json'), 'utf8')
  const badDir = join(mount, 'data', 'config')
  const cfgPath = join(badDir, 'onebot_99999.json')
  writeFileSync(cfgPath, JSON.stringify({ networks: { wsServers: [{ host: '127.0.0.1', port: 3001, accessToken: 'bad-host-token' }] } }))
  const token3 = await service.readOnebotToken()
  ok(token3.token === 'bad-host-token', 'host 非 0.0.0.0 仍能读 token')
  ok(typeof token3.warning === 'string' && token3.warning.includes('127.0.0.1'), 'host 非 0.0.0.0 → 告警（不自动改）')
  ok(readFileSync(join(badDir, 'onebot_99999.json'), 'utf8').includes('127.0.0.1'), '配置文件未被修改')
  ok(readFileSync(join(badDir, 'onebot.json'), 'utf8') === before, 'onebot.json 内容未被修改')
  // 清理坏配置，恢复登录后的 per-uin 配置（后续 autoconfigure 用它）
  rmSync(join(badDir, 'onebot_99999.json'), { force: true })
  writeFileSync(join(configDir, 'onebot_12345.json'), JSON.stringify({ networks: { wsServers: [{ host: '0.0.0.0', port: 3001, accessToken: 'per-uin-TOKEN' }] } }))
}

console.log('== autoconfigure（连接探测 → 写 bots）==')
{
  const { service, storage } = shared
  wsMode = 'fail'
  const waiting = await service.autoconfigure()
  ok(waiting.ok === false && waiting.waiting === true, '3001 不可达 → waiting_login（不报错崩）')
  ok((waiting.error ?? '').includes('扫码'), 'waiting 错误提示扫码登录')
  wsMode = 'ok'
  const auto = await service.autoconfigure()
  ok(auto.ok === true && auto.selfId === 10001 && auto.nickname === '小璃', 'WS 探测成功 → selfId/nickname')
  ok(auto.written?.bots === 1 && auto.written.wsUrl === 'ws://127.0.0.1:3001', '写 1 个 bot 的 wsUrl')
  const row = storage.prepare("SELECT snowluma_enabled, snowluma_ws_url, snowluma_token FROM bots WHERE id='b1'").get()
  ok(row.snowluma_enabled === 1 && row.snowluma_ws_url === 'ws://127.0.0.1:3001', 'bots.snowluma_enabled/ws_url 已写')
  ok(row.snowluma_token === 'per-uin-TOKEN', 'bots.snowluma_token = 配置里的 accessToken')
  const st = await service.status()
  ok(st.state === 'connected', 'status → connected（3001 可达 + get_login_info 成功）')
}

console.log('== stop / remove ==')
{
  const { service, storage, mount } = shared
  const stopped = await service.stop()
  ok(stopped.container.running === false, 'stop 后 running=false')
  ok(stopped.state === 'installed', 'stop 后 state=installed')
  const removed = await service.remove({ keepData: true })
  ok(removed.container.exists === false, 'remove(keepData:true) 删除容器')
  ok(existsSync(mount), 'remove(keepData:true) 保留数据目录')
  ok((storage.getSetting('snowluma.ws_token') ?? '') === '', 'remove 清空 ws_token')
  rmSync(mount, { recursive: true, force: true })
  const removed2 = await service.remove({ keepData: false })
  ok(removed2.container.exists === false && existsSync(mount) === false, 'remove(keepData:false) 删除数据目录')
  storage.close()
}

console.log('== docker 不可用 ==')
{
  const storage = new LittlyStorage({ logger: { info: () => {} } }, { file: join(dir, 'nosuch.db') })
  storage.prepare("INSERT INTO bots (id, name, created_at) VALUES ('b1','小璃',?)").run(new Date().toISOString())
  const service = createSnowlumaService(storage, {
    dockerBin: join(dir, 'no-such-docker'), image: SNOWLUMA_IMAGE, containerName: SNOWLUMA_CONTAINER,
    dataDir: join(dir, 'mount9'), webuiPort: 5099, novncPort: 6081, wsPort: 3001,
    configWaitMs: 200, autoconfigureWaitMs: 500, timeoutMs: 2000, webSocketFactory, novncCheck: async () => false,
  })
  const st = await service.status()
  ok(st.dockerOk === false && st.state === 'error', 'docker 不可用 → state=error')
  ok((st.lastError ?? '').length > 0, 'error 带可读 lastError')
  let err = null
  try { await service.install({ consent: true }) } catch (error) { err = error }
  ok(err instanceof SnowlumaError && err.code === 'docker_unavailable' && err.status === 502, 'install 时 docker 不可用 → 502')
  storage.close()
}

rmSync(dir, { recursive: true, force: true })
console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
