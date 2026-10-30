/**
 * SnowLuma 一键安装/配置内核。
 *
 * 目标（/tmp/snowluma-install-spec.md）：用户只需要「勾选 EULA → 开始安装 → 打开 noVNC 扫码」，
 * 后端负责 docker pull/run、生成并保存 VNC 密码、补丁 OneBot 监听地址、从日志提取 WebUI 临时密码、
 * 扫码登录后自动探测 WS 并写 bots 配置。
 *
 * 官方事实（Lead 实测）：
 * - 镜像 motricseven7/snowluma:v2.2.1；端口 6081 noVNC / 5099 WebUI / 3000 OneBot HTTP / 3001 OneBot WS；
 * - 必须参数：--cap-add=SYS_PTRACE --security-opt seccomp=unconfined --shm-size=1g --ulimit nofile=65536:1048576；
 * - 数据卷：/app/data、/app/.config、/app/.local/share；
 * - OneBot 默认监听 127.0.0.1:3001（容器内）→ 宿主机映射不可达，必须 patch 成 0.0.0.0 并 restart。
 *
 * 全部外部命令 spawn 无 shell + 超时；SnowLuma 由用户既有 Docker 运行（本插件代装/代启，但需显式 consent）。
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import type { LittlyStorage } from '@littly/storage'

export const SNOWLUMA_IMAGE = 'motricseven7/snowluma:v2.2.1'
export const SNOWLUMA_CONTAINER = 'littly-snowluma'

/** global_settings 键。 */
export const SNOWLUMA_KEYS = {
  consent: 'snowluma.install_consent',
  installedAt: 'snowluma.installed_at',
  digest: 'snowluma.digest',
  vncPassword: 'snowluma.vnc_password',
  webuiPassword: 'snowluma.webui_password',
  configReady: 'snowluma.config_ready',
  wsToken: 'snowluma.ws_token',
  configWarning: 'snowluma.config_warning',
  lastError: 'snowluma.last_error',
  pulled: 'snowluma.pulled',
  pulling: 'snowluma.pulling',
  pullProgress: 'snowluma.pull_progress',
  autoconfigured: 'snowluma.autoconfigured',
  startedAt: 'snowluma.started_at',
} as const

export type SnowlumaState =
  | 'not_installed' | 'pulling' | 'installed' | 'starting' | 'waiting_scan' | 'connected' | 'error'

export interface SnowlumaConfig {
  dockerBin: string
  image: string
  containerName: string
  /** 宿主持久目录：内含 data/ qq-config/ qq-data/ 三个 bind mount。 */
  dataDir: string
  webuiPort: number
  novncPort: number
  wsPort: number
  /** 等待 onebot.json 出现的上限（毫秒）；测试可调小。 */
  configWaitMs: number
  /** autoconfigure 等待 3001 可达的上限（毫秒），默认 180000。 */
  autoconfigureWaitMs?: number
  /** 测试注入：noVNC 可达性检查（默认 fetch http://127.0.0.1:<novnc>/vnc.html）。 */
  novncCheck?: (() => Promise<boolean>) | null
  /** 单条 docker 命令超时（毫秒）。 */
  timeoutMs: number
  /** 测试注入：替换全局 WebSocket（autoconfigure 探测用）。 */
  webSocketFactory?: ((url: string) => WebSocketLike) | null
}

/** 最小 WebSocket 结构面（与 channel-qq 的注入约定一致）。 */
export interface WebSocketLike {
  readyState: number
  close(): void
  send(data: string): void
  addEventListener(name: 'open' | 'close' | 'error' | 'message', handler: (event: { code?: number; reason?: string; data?: unknown; error?: unknown }) => void): void
}

export interface SnowlumaContainerInfo {
  exists: boolean
  running: boolean
  status: string
}

export interface SnowlumaStatus {
  state: SnowlumaState
  dockerOk: boolean
  image: { present: boolean; tag: string; digest?: string }
  container: SnowlumaContainerInfo
  ports: { novnc: number; webui: number; ws: number }
  novncUrl: string
  webuiUrl: string
  wsUrl: string
  vncPassword?: string
  webuiPassword?: string
  configReady: boolean
  configWarning?: string
  hasToken: boolean
  lastError: string
  logsTail: string
  consent: boolean
  pullProgress?: string
}

export interface SnowlumaLogsResult {
  logs: string
  vncPassword?: string
  webuiPassword?: string
  truncated: boolean
}

export interface SnowlumaQrInfo {
  novncUrl: string
  vncPassword?: string
  webuiUrl: string
  webuiPassword?: string
  steps: string[]
}

export interface SnowlumaAutoconfigureResult {
  ok: boolean
  waiting?: boolean
  selfId?: number
  nickname?: string
  error?: string
  written?: { bots: number; wsUrl: string; token?: boolean }
}

/** 服务错误（路由层映射 HTTP 状态）。 */
export class SnowlumaError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'SnowlumaError'
    this.code = code
    this.status = status
  }
}

/** 默认数据目录：LITTLY_DATA_DIR/snowluma。 */
export function defaultDataDir(): string {
  const root = (process.env['LITTLY_DATA_DIR'] ?? '').trim() || join(process.cwd(), 'data')
  return join(root, 'snowluma')
}

/** 12 位随机密码（VNC/WebUI 用；避免易混淆字符）。 */
export function randomPassword(length = 12): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i++) out += alphabet[bytes[i]! % alphabet.length]
  return out
}

/** 从容器日志提取 WebUI 一次性临时密码。 */
export function extractWebuiPassword(logs: string): string | undefined {
  if (logs === '') return undefined
  const patterns: RegExp[] = [
    /(?:initial\s+credentials)[^\n]{0,120}?password\s*[:：=]\s*([A-Za-z0-9_-]{4,64})/i,
    /(?:临时密码|初始密码|一次性密码)\s*[:：=]?\s*([A-Za-z0-9_-]{4,64})/i,
    /(?:initial\s+credentials|initial\s+password|temporary\s+password)[^\n]{0,80}?[:：=]\s*([A-Za-z0-9_-]{4,64})/i,
    /(?:webui|web\s*ui)[^\n]{0,80}?(?:password|密码)[^\n]{0,20}?[:：=]\s*([A-Za-z0-9_-]{4,64})/i,
    /(?:password|passwd|密码)\s*[:：=]\s*([A-Za-z0-9_-]{4,64})/i,
  ]
  for (const re of patterns) {
    const matched = re.exec(logs)?.[1]?.trim()
    if (matched !== undefined && matched !== '' && !/^(?:none|null|-+|\*+)$/i.test(matched)) return matched
  }
  return undefined
}

/** 脱敏：密码/令牌值替换为 ***。 */
export function maskSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text
  out = out.replace(/((?:VNC_PASSWD|password|passwd|密码|token|secret)\s*[:：=]\s*)(\S+)/giu, '$1***')
  out = out.replace(/(access_token=)[^&\s]+/giu, '$1***')
  for (const secret of secrets) if (secret !== '' && secret.length >= 4) out = out.split(secret).join('***')
  return out
}

/** 默认 onebot.json（文件迟迟不生成时兜底写一份）。 */
export function defaultOnebotConfig(input: { wsPort: number }): Record<string, unknown> {
  return {
    networks: {
      httpServers: [{ host: '0.0.0.0', port: input.wsPort - 1, enable: true }],
      wsServers: [{ host: '0.0.0.0', port: input.wsPort, enable: true }],
    },
  }
}

/**
 * 把 onebot 配置对象里的 networks.{httpServers,wsServers}[].host 从本机回环改成 0.0.0.0。
 * 只改 host，其余字段原样保留；已是 0.0.0.0 视为未改动（幂等）。
 */
export function patchOnebotObject(config: Record<string, unknown>): { changed: boolean; config: Record<string, unknown> } {
  let changed = false
  const networks = config['networks']
  if (networks === null || typeof networks !== 'object') return { changed, config }
  const networkObj = networks as Record<string, unknown>
  for (const key of ['httpServers', 'wsServers']) {
    const servers = networkObj[key]
    if (!Array.isArray(servers)) continue
    for (const server of servers) {
      if (server === null || typeof server !== 'object') continue
      const rec = server as Record<string, unknown>
      const host = rec['host']
      if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
        rec['host'] = '0.0.0.0'
        changed = true
      }
    }
  }
  return { changed, config }
}

/** 组装 docker run 参数（纯函数，测试直接断言）。 */
export function buildRunArgs(input: {
  containerName: string
  image: string
  dataDir: string
  webuiPort: number
  novncPort: number
  wsPort: number
  vncPassword: string
  uid: number
  gid: number
}): string[] {
  return [
    'run', '-d',
    '--name', input.containerName,
    '--restart', 'unless-stopped',
    '--cap-add=SYS_PTRACE',
    '--security-opt', 'seccomp=unconfined',
    '--shm-size=1g',
    '--ulimit', 'nofile=65536:1048576',
    '-e', 'SNOWLUMA_WEBUI_HOST=0.0.0.0',
    '-e', `SNOWLUMA_WEBUI_PORT=${input.webuiPort}`,
    '-e', `VNC_PASSWD=${input.vncPassword}`,
    '-e', `SNOWLUMA_UID=${input.uid}`,
    '-e', `SNOWLUMA_GID=${input.gid}`,
    '-e', 'SNOWLUMA_QQ_FLAGS=--disable-gpu --disable-software-rasterizer --disable-gpu-compositing',
    '-p', `127.0.0.1:${input.novncPort}:6081`,
    '-p', `127.0.0.1:${input.webuiPort}:5099`,
    '-p', `127.0.0.1:${input.wsPort}:3001`,
    '-v', `${join(input.dataDir, 'data')}:/app/data`,
    '-v', `${join(input.dataDir, 'qq-config')}:/app/.config`,
    '-v', `${join(input.dataDir, 'qq-data')}:/app/.local/share`,
    input.image,
  ]
}

interface DockerResult {
  ok: boolean
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
  spawnError?: string
}

function runDocker(bin: string, args: string[], timeoutMs: number): Promise<DockerResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    const finish = (result: DockerResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
    } catch (error) {
      resolve({ ok: false, code: -1, stdout: '', stderr: '', timedOut: false, spawnError: error instanceof Error ? error.message : String(error) })
      return
    }
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch { /* ignore */ }
    }, Math.max(1000, timeoutMs))
    child.stdout?.on('data', (d: Buffer) => { if (stdout.length < 256 * 1024) stdout += d.toString('utf8') })
    child.stderr?.on('data', (d: Buffer) => { if (stderr.length < 256 * 1024) stderr += d.toString('utf8') })
    child.on('error', (error) => finish({ ok: false, code: -1, stdout, stderr, timedOut, spawnError: error.message }))
    child.on('close', (code) => finish({ ok: code === 0, code: code ?? -1, stdout, stderr, timedOut }))
  })
}

function readJsonFile(file: string): Record<string, unknown> | null {
  try {
    const text = readFileSync(file, 'utf8')
    const parsed = JSON.parse(text) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** 服务接口。 */
export interface SnowlumaService {
  status(): Promise<SnowlumaStatus>
  install(input: { consent: boolean }): Promise<SnowlumaStatus>
  start(): Promise<SnowlumaStatus>
  stop(): Promise<SnowlumaStatus>
  logs(input?: { tail?: number }): Promise<SnowlumaLogsResult>
  qrInfo(): Promise<SnowlumaQrInfo>
  autoconfigure(): Promise<SnowlumaAutoconfigureResult>
  remove(input?: { keepData?: boolean }): Promise<SnowlumaStatus>
  /** 读取 onebot 配置里的 WS accessToken（登录后优先 onebot_<uin>.json）。 */
  readOnebotToken(): Promise<{ ok: boolean; token: string; source: string; warning?: string }>
  readonly containerName: string
  readonly image: string
  readonly dataDir: string
  readonly dockerBin: string
}

export function createSnowlumaService(storage: LittlyStorage, config: SnowlumaConfig): SnowlumaService {
  const dockerBin = config.dockerBin.trim() === '' ? "docker" : config.dockerBin.trim()
  const image = config.image.trim() === '' ? SNOWLUMA_IMAGE : config.image.trim()
  const containerName = config.containerName.trim() === '' ? SNOWLUMA_CONTAINER : config.containerName.trim()
  const dataDir = config.dataDir.trim() === '' ? defaultDataDir() : config.dataDir.trim()
  const webuiPort = config.webuiPort > 0 ? config.webuiPort : 5099
  const novncPort = config.novncPort > 0 ? config.novncPort : 6081
  const wsPort = config.wsPort > 0 ? config.wsPort : 3001
  const configWaitMs = Math.max(100, Math.round(config.configWaitMs) || 60_000)
  const autoWaitMs = Math.max(500, Math.round(config.autoconfigureWaitMs ?? 180_000))
  const timeoutMs = Math.max(1000, Math.round(config.timeoutMs) || 180_000)
  let pullTask: Promise<void> | null = null

  const get = (key: string): string => storage.getSetting(key) ?? ''
  const set = (key: string, value: string): void => storage.setSetting(key, value)
  const docker = (args: string[], timeout = timeoutMs): Promise<DockerResult> => runDocker(dockerBin, args, timeout)

  function setLastError(message: string): void { set(SNOWLUMA_KEYS.lastError, message.slice(0, 800)) }

  const dataPaths = {
    data: join(dataDir, 'data'),
    qqConfig: join(dataDir, 'qq-config'),
    qqData: join(dataDir, 'qq-data'),
  }
  const onebotDir = join(dataPaths.data, 'config')
  const onebotFile = join(onebotDir, 'onebot.json')

  function ensureDirs(): void {
    for (const path of [dataDir, dataPaths.data, dataPaths.qqConfig, dataPaths.qqData, onebotDir]) mkdirSync(path, { recursive: true })
  }

  async function detectDocker(): Promise<boolean> {
    const version = await docker(['version', '--format', '{{.Server.Version}}'], Math.min(20_000, timeoutMs))
    return version.ok
  }

  async function imagePresent(): Promise<boolean> {
    const inspect = await docker(['image', 'inspect', image], Math.min(30_000, timeoutMs))
    return inspect.ok
  }

  async function containerInfo(): Promise<SnowlumaContainerInfo> {
    const inspect = await docker(['inspect', '--format', '{{.State.Running}}|{{.State.Status}}', containerName], Math.min(30_000, timeoutMs))
    if (!inspect.ok) {
      if (!/no such (object|container)/i.test(inspect.stderr)) setLastError(`docker inspect 失败：${inspect.stderr.trim().slice(0, 300)}`)
      return { exists: false, running: false, status: '' }
    }
    const [runningText = '', statusText = ''] = inspect.stdout.trim().split('|')
    return { exists: true, running: runningText.trim() === 'true', status: statusText.trim() }
  }

  function vncPassword(): string {
    const existing = get(SNOWLUMA_KEYS.vncPassword)
    if (existing !== '') return existing
    const created = randomPassword(12)
    set(SNOWLUMA_KEYS.vncPassword, created)
    return created
  }

  function novncUrl(withPassword = true): string {
    const vnc = get(SNOWLUMA_KEYS.vncPassword)
    const base = `http://127.0.0.1:${novncPort}/vnc.html`
    return withPassword && vnc !== '' ? `${base}?autoconnect=1&password=${encodeURIComponent(vnc)}` : base
  }

  async function noVncReachable(): Promise<boolean> {
    if (config.novncCheck !== undefined && config.novncCheck !== null) {
      try { return await config.novncCheck() } catch { return false }
    }
    try {
      const res = await fetch(`http://127.0.0.1:${novncPort}/vnc.html`, { signal: AbortSignal.timeout(1500) })
      return res.ok
    } catch {
      return false
    }
  }

  async function tailLogs(lines = 20): Promise<string> {
    const result = await docker(['logs', '--tail', String(lines), containerName], Math.min(30_000, timeoutMs))
    const raw = `${result.stdout}${result.stderr}`
    const webui = get(SNOWLUMA_KEYS.webuiPassword) || extractWebuiPassword(raw) || ''
    return maskSecrets(raw, [get(SNOWLUMA_KEYS.vncPassword), webui].filter((x) => x !== ''))
  }

  /** 读 onebot 配置里的 WS token（登录后优先 onebot_<uin>.json）。 */
  async function readOnebotToken(): Promise<{ ok: boolean; token: string; source: string; warning?: string }> {
    ensureDirs()
    const deadline = Date.now() + configWaitMs
    while (!existsSync(onebotFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250))
    const files: string[] = []
    if (existsSync(onebotFile)) files.push(onebotFile)
    try {
      for (const name of readdirSync(onebotDir)) if (/^onebot_\d+\.json$/u.test(name)) files.push(join(onebotDir, name))
    } catch { /* ignore */ }
    // 优先 per-uin 配置（登录后生成：token 以它为准）
    const perUin = files.filter((f) => f !== onebotFile).sort()
    const ordered = [...perUin, ...files.filter((f) => f === onebotFile)]
    let token = ''
    let source = ''
    let hostWarning = ''
    for (const file of ordered) {
      const parsed = readJsonFile(file)
      if (parsed === null) continue
      const networks = parsed['networks'] as { wsServers?: Array<Record<string, unknown>> } | undefined
      const ws = networks?.wsServers?.[0]
      if (ws === undefined) continue
      const host = String(ws['host'] ?? '')
      if (host !== '0.0.0.0') hostWarning = `onebot 配置 ${file} 的 wsServers[0].host=${host}（期望 0.0.0.0，需人工检查）`
      const accessToken = String(ws['accessToken'] ?? '')
      if (accessToken !== '') {
        token = accessToken
        source = file
        break
      }
    }
    if (token !== '') {
      set(SNOWLUMA_KEYS.wsToken, token)
      set(SNOWLUMA_KEYS.configReady, '1')
    }
    if (hostWarning !== '') set(SNOWLUMA_KEYS.configWarning, hostWarning)
    else set(SNOWLUMA_KEYS.configWarning, '')
    const warning = hostWarning !== '' ? hostWarning : undefined
    return { ok: token !== '', token, source, ...(warning !== undefined ? { warning } : {}) }
  }

  async function probeWs(wsUrl: string, token: string, timeoutMs0 = 3000): Promise<{ ok: boolean; selfId?: number; nickname?: string; error?: string }> {
    const url = token !== '' ? `${wsUrl}${wsUrl.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}` : wsUrl
    return new Promise((resolve) => {
      let settled = false
      let socket: WebSocketLike | null = null
      const finish = (value: { ok: boolean; selfId?: number; nickname?: string; error?: string }): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try { socket?.close() } catch { /* ignore */ }
        resolve(value)
      }
      const timer = setTimeout(() => finish({ ok: false, error: `连接 OneBot WS 超时（${Math.round(timeoutMs0 / 1000)}s）：${wsUrl}（扫码登录后才监听）` }), timeoutMs0)
      try {
        if (config.webSocketFactory !== undefined && config.webSocketFactory !== null) socket = config.webSocketFactory(url)
        else {
          const ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket
          if (typeof ctor !== 'function') return finish({ ok: false, error: '当前 Node 运行时不提供 WebSocket（需要 Node 22+）' })
          socket = new ctor(url)
        }
      } catch (error) {
        return finish({ ok: false, error: `无法创建 WS 连接：${(error as Error)?.message ?? String(error)}` })
      }
      socket.addEventListener('open', () => {
        try { socket?.send(JSON.stringify({ action: 'get_login_info', params: {}, echo: 'snowluma-install-probe' })) } catch (error) {
          finish({ ok: false, error: `发送 get_login_info 失败：${(error as Error)?.message ?? String(error)}` })
        }
      })
      socket.addEventListener('message', (event) => {
        let payload: Record<string, unknown>
        try { payload = JSON.parse(String(event.data)) as Record<string, unknown> } catch { return }
        if (payload['echo'] !== 'snowluma-install-probe') return
        const data = payload['data']
        if (data !== null && typeof data === 'object') {
          const rec = data as Record<string, unknown>
          const selfId = typeof rec['user_id'] === 'number' ? rec['user_id'] : typeof rec['user_id'] === 'string' ? Number(rec['user_id']) : undefined
          finish({ ok: true, ...(selfId !== undefined && Number.isFinite(selfId) ? { selfId } : {}), ...(typeof rec['nickname'] === 'string' ? { nickname: rec['nickname'] } : {}) })
        } else finish({ ok: false, error: 'get_login_info 返回空数据' })
      })
      socket.addEventListener('error', () => finish({ ok: false, error: `无法连接 OneBot WS：${wsUrl}（扫码登录后才会监听）` }))
      socket.addEventListener('close', () => finish({ ok: false, error: `OneBot WS 连接被关闭：${wsUrl}` }))
    })
  }

  async function status(): Promise<SnowlumaStatus> {
    const dockerOk = await detectDocker()
    const present = dockerOk ? await imagePresent() : false
    const container = dockerOk ? await containerInfo() : { exists: false, running: false, status: '' }
    const consent = get(SNOWLUMA_KEYS.consent) === '1'
    const pulling = get(SNOWLUMA_KEYS.pulling) === '1' || pullTask !== null
    const configReady = get(SNOWLUMA_KEYS.configReady) === '1'
    const hasToken = get(SNOWLUMA_KEYS.wsToken) !== ''
    let state: SnowlumaState
    if (!dockerOk) state = 'error'
    else if (pulling) state = 'pulling'
    else if (!present && !container.exists) state = 'not_installed'
    else if (!container.running) state = 'installed'
    else {
      const novnc = await noVncReachable()
      if (!novnc) state = 'starting'
      else {
        const probe = await probeWs(`ws://127.0.0.1:${wsPort}`, get(SNOWLUMA_KEYS.wsToken), 2500)
        state = probe.ok ? 'connected' : 'waiting_scan'
      }
    }
    if (state === 'error' && get(SNOWLUMA_KEYS.lastError) === '') setLastError(`docker 不可用（${dockerBin}）`)
    const webuiPassword = get(SNOWLUMA_KEYS.webuiPassword)
    return {
      state,
      dockerOk,
      image: { present, tag: image, ...(get(SNOWLUMA_KEYS.digest) !== '' ? { digest: get(SNOWLUMA_KEYS.digest) } : {}) },
      container,
      ports: { novnc: novncPort, webui: webuiPort, ws: wsPort },
      novncUrl: novncUrl(true),
      webuiUrl: `http://127.0.0.1:${webuiPort}`,
      wsUrl: `ws://127.0.0.1:${wsPort}`,
      ...(get(SNOWLUMA_KEYS.vncPassword) !== '' ? { vncPassword: get(SNOWLUMA_KEYS.vncPassword) } : {}),
      ...(webuiPassword !== '' ? { webuiPassword } : {}),
      configReady,
      ...(get(SNOWLUMA_KEYS.configWarning) !== '' ? { configWarning: get(SNOWLUMA_KEYS.configWarning) } : {}),
      hasToken,
      lastError: get(SNOWLUMA_KEYS.lastError),
      logsTail: container.running ? await tailLogs(20) : '',
      consent,
      ...(get(SNOWLUMA_KEYS.pullProgress) !== '' ? { pullProgress: get(SNOWLUMA_KEYS.pullProgress) } : {}),
    }
  }

  function startPull(): void {
    if (pullTask !== null) return
    set(SNOWLUMA_KEYS.pulling, '1')
    set(SNOWLUMA_KEYS.pullProgress, '')
    pullTask = (async () => {
      const result = await docker(['pull', image], Math.max(timeoutMs, 30 * 60_000))
      if (!result.ok) {
        setLastError(`docker pull 失败：${(result.stderr || result.stdout).trim().slice(0, 500) || `exit=${result.code}`}`)
        set(SNOWLUMA_KEYS.pulling, '0'); set(SNOWLUMA_KEYS.pullProgress, '')
        return
      }
      set(SNOWLUMA_KEYS.pulled, '1')
      set(SNOWLUMA_KEYS.installedAt, new Date().toISOString())
      set(SNOWLUMA_KEYS.pulling, '0')
      set(SNOWLUMA_KEYS.lastError, '')
      set(SNOWLUMA_KEYS.pullProgress, '完成')
    })().catch((error: unknown) => {
      setLastError(`docker pull 异常：${(error as Error)?.message ?? String(error)}`)
      set(SNOWLUMA_KEYS.pulling, '0')
    }).finally(() => { pullTask = null })
  }

  async function install(input: { consent: boolean }): Promise<SnowlumaStatus> {
    if (input.consent !== true) {
      throw new SnowlumaError('consent_required', 'SnowLuma 是第三方非商业自托管软件（EULA 对自动化部署有要求）。安装前请勾选同意。', 400)
    }
    set(SNOWLUMA_KEYS.consent, '1')
    const dockerOk = await detectDocker()
    if (!dockerOk) {
      setLastError(`docker 不可用（${dockerBin}）：请先安装/启动 Docker Desktop 并确保有权限。`)
      throw new SnowlumaError('docker_unavailable', `docker 不可用（${dockerBin}）`, 502)
    }
    if (!(await imagePresent())) startPull()
    return status()
  }

  async function start(): Promise<SnowlumaStatus> {
    if (get(SNOWLUMA_KEYS.consent) !== '1') {
      throw new SnowlumaError('consent_required', '尚未同意 SnowLuma EULA：请先勾选同意后再启动。', 400)
    }
    const dockerOk = await detectDocker()
    if (!dockerOk) {
      setLastError(`docker 不可用（${dockerBin}）`)
      throw new SnowlumaError('docker_unavailable', `docker 不可用（${dockerBin}）`, 502)
    }
    if (!(await imagePresent())) {
      setLastError(`镜像不存在（${image}）：请先安装（docker pull）`)
      throw new SnowlumaError('image_missing', `镜像不存在（${image}）：请先点「一键安装」拉取镜像。`, 400)
    }
    ensureDirs()
    const password = vncPassword()
    const info = await containerInfo()
    if (info.exists) {
      const started = await docker(['start', containerName])
      if (!started.ok) {
        const reason = `docker start 失败：${(started.stderr || started.stdout).trim().slice(0, 400)}`
        setLastError(reason)
        throw new SnowlumaError('docker_failed', reason, 502)
      }
    } else {
      const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
      const gid = typeof process.getgid === 'function' ? process.getgid() : 1000
      const args = buildRunArgs({ containerName, image, dataDir, webuiPort, novncPort, wsPort, vncPassword: password, uid, gid })
      const ran = await docker(args)
      if (!ran.ok) {
        const reason = `docker run 失败：${(ran.stderr || ran.stdout).trim().slice(0, 400)}`
        setLastError(reason)
        throw new SnowlumaError('docker_failed', reason, 502)
      }
    }
    set(SNOWLUMA_KEYS.startedAt, String(Date.now()))
    setLastError('')
    // 首启即生成 onebot.json（host 已是 0.0.0.0）：只需读 token，不改配置/不重启。
    const token = await readOnebotToken()
    if (!token.ok) set(SNOWLUMA_KEYS.pullProgress, get(SNOWLUMA_KEYS.pullProgress))
    return status()
  }

  async function stop(): Promise<SnowlumaStatus> {
    const info = await containerInfo()
    if (!info.exists) throw new SnowlumaError('container_missing', 'SnowLuma 容器不存在（尚未安装/启动）。', 400)
    const stopped = await docker(['stop', containerName], Math.min(120_000, timeoutMs))
    if (!stopped.ok) {
      const reason = `docker stop 失败：${(stopped.stderr || stopped.stdout).trim().slice(0, 400)}`
      setLastError(reason)
      throw new SnowlumaError('docker_failed', reason, 502)
    }
    set(SNOWLUMA_KEYS.autoconfigured, '0')
    setLastError('')
    return status()
  }

  async function logs(input: { tail?: number } = {}): Promise<SnowlumaLogsResult> {
    const tail = Math.min(2000, Math.max(1, Math.round(input.tail ?? 200)))
    const result = await docker(['logs', '--tail', String(tail), containerName], Math.min(60_000, timeoutMs))
    const raw = `${result.stdout}${result.stderr}`
    if (!result.ok && /no such (object|container)/i.test(result.stderr)) {
      throw new SnowlumaError('container_missing', 'SnowLuma 容器不存在（尚未安装/启动），没有日志。', 400)
    }
    if (!result.ok && result.code !== 0) {
      const reason = `docker logs 失败：${result.stderr.trim().slice(0, 400)}`
      setLastError(reason)
      throw new SnowlumaError('docker_failed', reason, 502)
    }
    const vnc = get(SNOWLUMA_KEYS.vncPassword)
    const extracted = extractWebuiPassword(raw)
    const storedWebui = get(SNOWLUMA_KEYS.webuiPassword)
    const webui = storedWebui !== '' ? storedWebui : extracted ?? ''
    if (storedWebui === '' && extracted !== undefined) set(SNOWLUMA_KEYS.webuiPassword, extracted)
    return {
      logs: maskSecrets(raw, [vnc, webui].filter((x) => x !== '')).slice(0, 128 * 1024),
      ...(vnc !== '' ? { vncPassword: vnc } : {}),
      ...(webui !== '' ? { webuiPassword: webui } : {}),
      truncated: raw.length > 128 * 1024,
    }
  }

  async function qrInfo(): Promise<SnowlumaQrInfo> {
    const vnc = get(SNOWLUMA_KEYS.vncPassword)
    const webui = get(SNOWLUMA_KEYS.webuiPassword)
    return {
      novncUrl: novncUrl(true),
      ...(vnc !== '' ? { vncPassword: vnc } : {}),
      webuiUrl: `http://127.0.0.1:${webuiPort}`,
      ...(webui !== '' ? { webuiPassword: webui } : {}),
      steps: [
        '打开远程桌面（noVNC）链接（已带密码自动登录）。',
        '远程桌面里 QQ 会自动启动，用手机 QQ 扫码登录。',
        '扫码后 OneBot 3001 端口才会开始监听；状态会从「等待扫码」变为「已扫码」。',
        '点击「自动接线」：后端读取 onebot 配置里的 accessToken 并写入 QQ 渠道，即可聊天。',
      ],
    }
  }

  async function autoconfigure(): Promise<SnowlumaAutoconfigureResult> {
    const info = await containerInfo()
    if (!info.running) return { ok: false, error: 'SnowLuma 容器未运行：请先启动并完成扫码登录。' }
    const tokenRead = await readOnebotToken()
    if (!tokenRead.ok) {
      return { ok: false, waiting: true, error: '还没读到 OneBot accessToken（配置未生成或容器未启动完成）' }
    }
    const wsUrl = `ws://127.0.0.1:${wsPort}`
    // 扫码登录后 3001 才会监听：最多等 180s，期间返回 waiting_login。
    const deadline = Date.now() + autoWaitMs
    let lastError = ''
    let probe: { ok: boolean; selfId?: number; nickname?: string; error?: string } = { ok: false }
    while (Date.now() < deadline) {
      probe = await probeWs(wsUrl, tokenRead.token, 2500)
      if (probe.ok) break
      lastError = probe.error ?? 'WS 探测失败'
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    if (!probe.ok) return { ok: false, waiting: true, error: `等待 QQ 扫码登录中：${lastError}` }
    const bots = storage.prepare('SELECT id, snowluma_ws_url, snowluma_token FROM bots ORDER BY created_at ASC').all() as unknown as Array<{ id: string; snowluma_ws_url: string; snowluma_token: string }>
    if (bots.length === 0) return { ok: false, error: '没有可配置的 bot（先创建/播种角色）。' }
    for (const bot of bots) {
      storage
        .prepare('UPDATE bots SET snowluma_ws_url = ?, snowluma_token = ?, snowluma_enabled = 1 WHERE id = ?')
        .run(wsUrl, tokenRead.token, bot.id)
    }
    set(SNOWLUMA_KEYS.autoconfigured, '1')
    setLastError('')
    return {
      ok: true,
      ...(probe.selfId !== undefined ? { selfId: probe.selfId } : {}),
      ...(probe.nickname !== undefined ? { nickname: probe.nickname } : {}),
      written: { bots: bots.length, wsUrl, token: true },
    }
  }

  async function remove(input: { keepData?: boolean } = {}): Promise<SnowlumaStatus> {
    const keepData = input.keepData !== false
    const info = await containerInfo()
    if (info.exists) {
      const removed = await docker(['rm', '-f', containerName], Math.min(120_000, timeoutMs))
      if (!removed.ok) {
        const reason = `docker rm -f 失败：${(removed.stderr || removed.stdout).trim().slice(0, 400)}`
        setLastError(reason)
        throw new SnowlumaError('docker_failed', reason, 502)
      }
    }
    if (!keepData) {
      try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
    set(SNOWLUMA_KEYS.autoconfigured, '0')
    set(SNOWLUMA_KEYS.configReady, '0')
    set(SNOWLUMA_KEYS.wsToken, '')
    set(SNOWLUMA_KEYS.startedAt, '')
    set(SNOWLUMA_KEYS.lastError, '')
    if (!keepData) {
      set(SNOWLUMA_KEYS.vncPassword, '')
      set(SNOWLUMA_KEYS.webuiPassword, '')
    }
    return status()
  }

  return {
    status, install, start, stop, logs, qrInfo, autoconfigure, remove, readOnebotToken,
    containerName, image, dataDir, dockerBin,
  }
}

/** 供默认配置推导宿主 uid/gid（与 buildRunArgs 一致）。 */
export function hostIds(): { uid: number; gid: number } {
  try {
    const info = userInfo()
    return { uid: info.uid, gid: info.gid }
  } catch {
    return { uid: 1000, gid: 1000 }
  }
}
