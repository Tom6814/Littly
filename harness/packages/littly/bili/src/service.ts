/**
 * B 站服务内核 —— `bili`（bilibili-cli）CLI 壳 + 允许清单 / 写护栏 / 限频 / 审计 +
 * 智能认证（status / 浏览器 Cookie 提取 / 扫码登录 / 登出）。
 *
 * 设计约束（/tmp/bili-spec.md §1.1/§1.2）：
 * - 模型只给 argv；所有护栏在这里（模型绕不过去）。
 * - 允许清单固定为 bilibili-cli v0.6.2 的 Commands（以 `bili --help` 为准）：
 *   读 status/whoami/video/user/user-videos/search/hot/rank/feed/my-dynamics/
 *   favorites/following/watch-later/history/audio；写 like/coin/triple/unfollow/
 *   dynamic-post/dynamic-delete。
 * - 写命令默认 dry-run：需 `bili.allow_writes='1'` 且显式 dryRun:false 才真执行。
 * - `audio` 是「下载」类：同样受写开关约束；禁 `-o/--output`，固定输出到
 *   `${LITTLY_DATA_DIR}/downloads/bili`。
 * - 子进程 env：`OUTPUT=json` + `NO_COLOR=1` + `HOME`（= bili CLI 的 HOME，决定它读写
 *   哪个 credential.json）；`BILI_CLI_HOME` 被解释为 CLI 的 HOME（CLI 本身不支持该 env）。
 * - 信封：`{ok, schema_version, data}` / `{ok:false, error:{code,message}}`；
 *   **`bili status` 未登录时退出码 1 但 JSON 合法** → 成功判定必须看 ok 而不是 exit code。
 * - 限频：读 30/h、写（含 audio）5/h，按 bot 统计 audit_logs；每次调用写审计（argv 脱敏）。
 * - 凭证永不回传/不写日志；错误信息里出现凭证值一律替换为 ***。
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import {
  credentialInfo,
  credentialSecrets,
  defaultCredentialPath,
  deleteCredential,
  readCredential,
  resolveBiliHome,
  writeCredential,
  type BiliCookieJar,
  type CredentialInfo,
} from './credential.ts'
import {
  qrGenerate,
  qrPollOnce,
  QrSessionStore,
  QR_EXPIRES_IN_MS,
  type FetchLike,
  type QrSession,
} from './qr.ts'

/** 只读命令（自由执行）。 */
export const BILI_READ_COMMANDS: ReadonlySet<string> = new Set([
  'status',
  'whoami',
  'video',
  'user',
  'user-videos',
  'search',
  'hot',
  'rank',
  'feed',
  'my-dynamics',
  'favorites',
  'following',
  'watch-later',
  'history',
  'audio',
])

/** 写命令（默认 dry-run；写开关打开且显式 dryRun:false 才真执行）。 */
export const BILI_WRITE_COMMANDS: ReadonlySet<string> = new Set([
  'like',
  'coin',
  'triple',
  'unfollow',
  'dynamic-post',
  'dynamic-delete',
])

/** 需要写开关的命令（写命令 + audio 下载）。 */
export const BILI_GATED_COMMANDS: ReadonlySet<string> = new Set([...BILI_WRITE_COMMANDS, 'audio'])

/** 禁止的参数：文件读写 / 自定义输出目录 / 破坏 JSON 信封的 YAML。 */
export const BILI_BLOCKED_FLAGS: ReadonlySet<string> = new Set(['-o', '--output', '--from-file', '--input', '-i', '--yaml'])

/** 执行前需要自动补 `--yes`（否则非 TTY 下 click.confirm 会 EOF 失败）的写命令。 */
const CONFIRM_WRITE_COMMANDS: ReadonlySet<string> = new Set(['unfollow', 'dynamic-delete'])

/** 每小时限频（按 bot 统计 audit_logs）。 */
export const BILI_READ_LIMIT_PER_HOUR = 30
export const BILI_WRITE_LIMIT_PER_HOUR = 5

/** global_settings 键。 */
export const BILI_KEYS = {
  allowWrites: 'bili.allow_writes',
  lastProbe: 'bili.last_probe',
} as const

/** 下载目录子路径（相对 LITTLY_DATA_DIR）。 */
const DOWNLOAD_SUBDIR = join('downloads', 'bili')
const HOUR_MS = 60 * 60 * 1000

// --- 依赖的最小结构面（避免 @littly/bili 依赖 @littly/storage 的类型/装配） ---

/** storage.prepare() 返回语句的最小面。 */
export interface BiliStatementLike {
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  run(...params: unknown[]): unknown
}

/** 业务存储的最小面（getSetting/setSetting/audit 查询）。 */
export interface BiliStorageLike {
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
  prepare(sql: string): BiliStatementLike
}

/** 服务配置。 */
export interface BiliServiceConfig {
  /** bili 可执行文件（默认 `bili`；测试注入 fake bin）。 */
  bin: string
  /** 单次命令超时（毫秒）。 */
  timeoutMs: number
  /** bili CLI 的 HOME（默认 BILI_CLI_HOME / 当前用户 HOME）。 */
  homeDir?: string | undefined
  /** 直接指定 credential.json 路径（测试用）。 */
  credentialPath?: string | undefined
  /** passport 源（测试 mock）。 */
  passportBaseUrl?: string | undefined
  /** fetch 实现（测试 mock）。 */
  fetchImpl?: FetchLike | undefined
  /** 二维码 TTL（毫秒）。 */
  qrExpiresInMs?: number | undefined
}

/** 统一错误信息（中文可读 + 原始片段便于判断）。 */
export interface BiliErrorInfo {
  code: string
  message: string
  raw?: string
}

/** 归一化后的 B 站用户（只暴露账号展示字段，无 Cookie）。 */
export interface BiliUser {
  id: string
  mid: string
  name: string
  username: string
  uname: string
  level: number
  coins: number
  sign: string
  vip: { status: number; type: number; label: string }
  avatarUrl: string
}

/** 状态（控制台 / 工具共用）。 */
export interface BiliStatus {
  authenticated: boolean
  user: BiliUser | null
  credential: CredentialInfo
  allowWrites: boolean
  bin: string
  error?: BiliErrorInfo
}

/** 命令行执行结果。 */
export interface BiliRunResult {
  ok: boolean
  dryRun: boolean
  exitCode: number
  command: string
  argv: string[]
  data?: unknown
  error?: BiliErrorInfo
  note?: string
  /** audio 命令的落盘目录（只在实际执行/预演时给出，便于前端提示）。 */
  outputDir?: string
}

/** 扫码开始结果。 */
export interface BiliQrStartResult {
  sessionId: string
  qrDataUrl: string
  link: string
  expiresInMs: number
}

/** 扫码轮询结果（控制台）。 */
export interface BiliQrPollResult {
  status: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'error'
  message?: string
  user?: BiliUser | null
  expiresInMs?: number
}

/** 浏览器提取结果。 */
export interface BiliBrowserExtractResult {
  ok: boolean
  status: BiliStatus
  hint?: string
  error?: string
}

/** lastProbe 记录。 */
export interface BiliProbeInfo {
  ok: boolean
  error: string
  at: string
}

/** 对外服务面。 */
export interface BiliService {
  status(): Promise<BiliStatus>
  browserExtract(): Promise<BiliBrowserExtractResult>
  qrStart(): Promise<BiliQrStartResult>
  qrPoll(sessionId: string): Promise<BiliQrPollResult>
  logout(): Promise<{ ok: boolean; cleared: boolean }>
  settings(input: { allowWrites?: boolean }): { ok: boolean; allowWrites: boolean }
  binOk(): Promise<boolean>
  lastProbe(): BiliProbeInfo | null
  run(argv: string[], opts?: { botId?: string; dryRun?: boolean }): Promise<BiliRunResult>
}

/** 子进程执行原语结果。 */
interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  spawnError?: string
}

/** 信封解析结果。 */
interface EnvelopeResult {
  ok: boolean
  exitCode: number
  data?: unknown
  error?: BiliErrorInfo
}

/** 从 stdout 稳健提取第一个 JSON 对象（CLI 可能夹带日志行）。 */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
  const text = raw.trim()
  if (text === '') return null
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    // 继续走括号平衡扫描
  }
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1)) as unknown
          return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/** 错误文本 → 统一错误码（未登录/限频/风控/未找到/其它）。 */
export function mapBiliError(rawText: string, codeHint?: string): BiliErrorInfo {
  const raw = rawText.trim().slice(0, 800)
  const lower = raw.toLowerCase()
  const hint = (codeHint ?? '').toLowerCase()
  const withRaw = (out: Omit<BiliErrorInfo, 'raw'>): BiliErrorInfo => ({ ...out, ...(raw !== '' ? { raw } : {}) })
  if (
    hint.includes('not_authenticated') ||
    hint.includes('permission_denied') ||
    lower.includes('not_authenticated') ||
    lower.includes('未登录') ||
    lower.includes('-101') ||
    lower.includes('账号未登录') ||
    /\b401\b/.test(raw)
  ) {
    return withRaw({
      code: 'not_authenticated',
      message: `B 站未登录或登录已失效：请在控制台登录（扫码 / 提取浏览器 Cookie）。原始信息：${raw || '(空)'}`,
    })
  }
  if (hint.includes('rate_limited') || /\b429\b/.test(raw) || lower.includes('too many requests')) {
    return withRaw({ code: 'rate_limited', message: `B 站接口限频，请稍后再试。原始信息：${raw || '(空)'}` })
  }
  if (
    hint.includes('risk_control') ||
    /\b-352\b|\b-412\b|\b-403\b|\b412\b/.test(raw) ||
    lower.includes('risk_control') ||
    lower.includes('风控') ||
    lower.includes('请求被拦截')
  ) {
    return withRaw({
      code: 'risk_control',
      message: `B 站风控拦截（常见于请求过快 / 账号新 / 环境异常）：请停手稍后再试，不要换参数绕过。原始信息：${raw || '(空)'}`,
    })
  }
  if (/\b-404\b/.test(raw) || hint.includes('not_found') || lower.includes('不存在')) {
    return withRaw({ code: 'not_found', message: `B 站接口未找到目标（视频/用户可能已删除）。原始信息：${raw || '(空)'}` })
  }
  if (hint.includes('network_error') || lower.includes('timeout') || lower.includes('timed out') || lower.includes('network')) {
    return withRaw({ code: 'network_error', message: `B 站网络请求失败（可能是网络/代理问题）。原始信息：${raw || '(空)'}` })
  }
  if (hint !== '') {
    return withRaw({ code: hint, message: `B 站命令失败（${hint}）：${raw || '(无输出)'}` })
  }
  return withRaw({ code: 'bili_api_error', message: `B 站命令失败：${raw || '(无输出)'}` })
}

/** 把文本里出现的凭证值替换成 ***（错误/审计都过这一层）。 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret.trim() === '' || secret.length < 8) continue
    if (out.includes(secret)) out = out.split(secret).join('***')
  }
  return out
}

/** 审计/错误里的 argv 脱敏 + 截断。 */
export function sanitizeArgv(argv: readonly string[], secrets: readonly string[]): string[] {
  return argv.map((arg) => {
    const out = redactSecrets(arg, secrets)
    return out.length > 120 ? `${out.slice(0, 117)}…` : out
  })
}

/** 把 CLI 的 `data.user` 归一化成 BiliUser（缺字段给安全默认值）。 */
export function normalizeBiliUser(data: unknown): BiliUser | null {
  if (data === null || typeof data !== 'object') return null
  const rec = data as Record<string, unknown>
  const rawUser = rec['user']
  const user = rawUser !== null && typeof rawUser === 'object' ? (rawUser as Record<string, unknown>) : rec
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')
  const num = (v: unknown): number => {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    const n = Number(str(v))
    return Number.isFinite(n) ? n : 0
  }
  const id = str(user['id']) || str(user['mid']) || str(user['uid']) || str(user['dedeuserid'])
  const name = str(user['name']) || str(user['uname']) || str(user['username'])
  if (id === '' && name === '') return null
  const rawVip = user['vip']
  const vipRec = rawVip !== null && typeof rawVip === 'object' ? (rawVip as Record<string, unknown>) : {}
  const vipStatus = num(vipRec['status'])
  const vipType = num(vipRec['type'])
  const labelRec = vipRec['label']
  const labelText =
    labelRec !== null && typeof labelRec === 'object' ? str((labelRec as Record<string, unknown>)['text']) : ''
  const vipLabel = labelText !== '' ? labelText : vipStatus === 1 ? (vipType === 2 ? '大会员' : '小会员') : ''
  return {
    id,
    mid: id,
    name,
    username: name,
    uname: name,
    level: num(user['level']),
    coins: num(user['coins']),
    sign: str(user['sign']),
    vip: { status: vipStatus, type: vipType, label: vipLabel },
    avatarUrl: str(user['face']) || str(user['avatar']),
  }
}

/** 把 CLI 信封里的 error 归一化成 BiliErrorInfo（含 code 提示；凭证值先脱敏）。 */
function errorFromEnvelope(error: unknown, secrets: readonly string[]): BiliErrorInfo {
  if (typeof error === 'string') return mapBiliError(redactSecrets(error, secrets))
  if (error !== null && typeof error === 'object') {
    const rec = error as Record<string, unknown>
    const code = typeof rec['code'] === 'string' ? rec['code'] : ''
    const message = typeof rec['message'] === 'string' ? redactSecrets(rec['message'], secrets) : ''
    const text = [code, message].filter(x => x !== '').join(': ')
    return mapBiliError(text !== '' ? text : redactSecrets(JSON.stringify(error).slice(0, 500), secrets), code)
  }
  return mapBiliError('')
}

/** 启动子进程（无 shell，stdin 关闭防 TTY 交互挂死）。 */
function execBili(
  bin: string,
  argv: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<ExecResult> {
  return new Promise((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let child: ReturnType<typeof spawn>
    const finish = (result: ExecResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(result)
    }
    try {
      child = spawn(bin, argv, { env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolvePromise({ exitCode: -1, stdout: '', stderr: '', timedOut: false, spawnError: error instanceof Error ? error.message : String(error) })
      return
    }
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore
      }
    }, Math.max(1000, timeoutMs))
    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < 1024 * 1024) stdout += d.toString('utf8')
    })
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < 1024 * 1024) stderr += d.toString('utf8')
    })
    child.on('error', (error) => {
      finish({ exitCode: -1, stdout, stderr, timedOut, spawnError: error.message })
    })
    child.on('close', (code) => {
      finish({ exitCode: code ?? -1, stdout, stderr, timedOut })
    })
  })
}

/** 建 B 站服务。 */
export function createBiliService(storage: BiliStorageLike, config: BiliServiceConfig): BiliService {
  const bin = config.bin.trim() === '' ? 'bili' : config.bin.trim()
  const timeoutMs = Math.max(1000, Math.round(config.timeoutMs) || 60_000)
  const homeDir = resolveBiliHome(config.homeDir)
  const credentialPath = config.credentialPath ?? defaultCredentialPath(homeDir)
  const sessions = new QrSessionStore(config.qrExpiresInMs ?? QR_EXPIRES_IN_MS)
  const fetchImpl = config.fetchImpl
  const passportBaseUrl = config.passportBaseUrl
  let binCache: { at: number; ok: boolean } | null = null

  const allowWrites = (): boolean => storage.getSetting(BILI_KEYS.allowWrites) === '1'

  const recordProbe = (ok: boolean, error: string): void => {
    try {
      storage.setSetting(BILI_KEYS.lastProbe, JSON.stringify({ ok, error, at: new Date().toISOString() }))
    } catch {
      // 设置写失败不影响主流程
    }
  }

  const lastProbe = (): BiliProbeInfo | null => {
    const raw = storage.getSetting(BILI_KEYS.lastProbe) ?? ''
    if (raw === '') return null
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      return {
        ok: parsed['ok'] === true,
        error: typeof parsed['error'] === 'string' ? parsed['error'] : '',
        at: typeof parsed['at'] === 'string' ? parsed['at'] : '',
      }
    } catch {
      return null
    }
  }

  /** 子进程 env：OUTPUT/NO_COLOR + HOME（CLI 的凭证目录由 HOME 决定）。 */
  const childEnv = (): NodeJS.ProcessEnv => ({
    ...process.env,
    OUTPUT: 'json',
    NO_COLOR: '1',
    HOME: homeDir,
    BILI_CLI_HOME: homeDir,
  })

  const currentSecrets = (): string[] => credentialSecrets(readCredential(credentialPath))

  /** 执行一次 CLI 并解析 JSON 信封（不审计、不限频；status/登录/探测内部用）。 */
  async function execEnvelope(argv: string[], overrideTimeoutMs?: number): Promise<EnvelopeResult> {
    const result = await execBili(bin, argv, childEnv(), overrideTimeoutMs ?? timeoutMs)
    const secrets = currentSecrets()
    if (result.spawnError !== undefined) {
      return {
        ok: false,
        exitCode: result.exitCode,
        error: { code: 'bili_bin_unavailable', message: `bilibili-cli 不可用（${bin}）：${result.spawnError}（安装：pip install bilibili-cli）` },
      }
    }
    if (result.timedOut) {
      return {
        ok: false,
        exitCode: result.exitCode,
        error: { code: 'bili_timeout', message: `B 站命令超时（${Math.round((overrideTimeoutMs ?? timeoutMs) / 1000)}s）：${sanitizeArgv(argv, secrets).join(' ')}` },
      }
    }
    const stdout = result.stdout.trim()
    const stderr = result.stderr.trim()
    const envelope = extractJsonObject(stdout)
    // 关键：`bili status` 未登录时退出码 1 但 JSON 合法 → 先看信封。
    if (envelope !== null) {
      const okField = envelope['ok']
      if (okField === false || (okField === undefined && envelope['error'] !== undefined)) {
        return { ok: false, exitCode: result.exitCode, error: errorFromEnvelope(envelope['error'], secrets) }
      }
      if (okField === true) return { ok: true, exitCode: result.exitCode, data: envelope['data'] ?? null }
      if (envelope['data'] !== undefined) return { ok: true, exitCode: result.exitCode, data: envelope['data'] }
      return { ok: true, exitCode: result.exitCode, data: envelope }
    }
    const rawText = redactSecrets((stderr !== '' ? stderr : stdout).slice(0, 800), secrets)
    if (result.exitCode !== 0) {
      return { ok: false, exitCode: result.exitCode, error: mapBiliError(rawText) }
    }
    return {
      ok: false,
      exitCode: result.exitCode,
      error: { code: 'bili_parse_failed', message: `bili 输出不是合法 JSON（未拿到信封）：${rawText || '(无输出)'}` },
    }
  }

  /** 由 status 信封生成 BiliStatus（不做额外 spawn）。 */
  function statusFromEnvelope(envelope: EnvelopeResult): BiliStatus {
    const base = { credential: credentialInfo(credentialPath), allowWrites: allowWrites(), bin }
    if (envelope.ok) {
      const user = normalizeBiliUser(envelope.data)
      if (user !== null) return { authenticated: true, user, ...base }
      return { authenticated: true, user: null, ...base }
    }
    const error = envelope.error ?? { code: 'bili_api_error', message: 'B 站状态检查失败' }
    return { authenticated: false, user: null, error, ...base }
  }

  async function status(): Promise<BiliStatus> {
    const envelope = await execEnvelope(['status'])
    const result = statusFromEnvelope(envelope)
    if (result.authenticated) recordProbe(true, '')
    else if (result.error !== undefined && result.error.code !== 'not_authenticated') recordProbe(false, result.error.message)
    return result
  }

  /** 浏览器 Cookie 提取：先删 credential.json，再让 CLI 自己从本机浏览器提取并保存。 */
  async function browserExtract(): Promise<BiliBrowserExtractResult> {
    deleteCredential(credentialPath)
    const envelope = await execEnvelope(['status'], Math.max(timeoutMs, 90_000))
    const next = statusFromEnvelope(envelope)
    if (next.authenticated) {
      recordProbe(true, '')
      return { ok: true, status: next }
    }
    const reason = next.error?.message ?? '浏览器里没有可用的 B 站登录态'
    recordProbe(false, reason)
    return {
      ok: false,
      status: next,
      hint: '自动提取只对「运行本服务的机器上的浏览器」有效（需要本机登录过 bilibili 且浏览器 Cookie 数据库可读）。容器/服务器部署请改用扫码登录。',
      error: reason,
    }
  }

  /** 开始扫码：passport generate → 零依赖 QR PNG。 */
  async function qrStart(): Promise<BiliQrStartResult> {
    const gen = await qrGenerate({
      ...(passportBaseUrl !== undefined ? { passportBaseUrl } : {}),
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
      timeoutMs: Math.min(timeoutMs, 20_000),
    })
    const session = sessions.create(gen)
    return {
      sessionId: session.sessionId,
      qrDataUrl: session.qrDataUrl,
      link: session.link,
      expiresInMs: session.expiresAt - session.createdAt,
    }
  }

  /** 轮询扫码状态；确认后写 credential.json 并跑 `bili status --json` 复核。 */
  async function qrPoll(sessionId: string): Promise<BiliQrPollResult> {
    const session: QrSession | null = sessions.get(sessionId)
    if (session === null) {
      return { status: 'expired', message: '登录会话不存在或已过期，请重新获取二维码。' }
    }
    if (Date.now() > session.expiresAt) {
      sessions.remove(sessionId)
      return { status: 'expired', message: '二维码已过期，请重新获取。' }
    }
    const polled = await qrPollOnce(session.qrcodeKey, {
      ...(passportBaseUrl !== undefined ? { passportBaseUrl } : {}),
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
      timeoutMs: Math.min(timeoutMs, 20_000),
    })
    if (polled.status !== 'confirmed') {
      if (polled.status === 'expired') sessions.remove(sessionId)
      return {
        status: polled.status,
        ...(polled.message !== undefined ? { message: polled.message } : {}),
        expiresInMs: Math.max(0, session.expiresAt - Date.now()),
      }
    }
    const jar: BiliCookieJar = polled.cookies ?? {
      sessdata: '',
      bili_jct: '',
      dedeuserid: '',
      buvid3: '',
      buvid4: '',
      ac_time_value: '',
    }
    writeCredential(credentialPath, jar)
    sessions.remove(sessionId)
    // 复核：CLI 读同一份 credential.json。
    const verifyEnvelope = await execEnvelope(['status'])
    const verified = statusFromEnvelope(verifyEnvelope)
    if (verified.authenticated) {
      recordProbe(true, '')
      return { status: 'confirmed', user: verified.user }
    }
    recordProbe(false, verified.error?.message ?? '扫码后复核失败')
    return {
      status: 'confirmed',
      user: null,
      message: `扫码凭证已写入，但 bili status 复核失败：${verified.error?.message ?? '未知原因'}（可稍后重试或改用浏览器 Cookie 提取）`,
    }
  }

  /** 登出：删 credential.json（CLI 的 logout 只删本地凭证，这里双保险）。 */
  async function logout(): Promise<{ ok: boolean; cleared: boolean }> {
    const cleared = deleteCredential(credentialPath)
    try {
      await execBili(bin, ['logout'], childEnv(), Math.min(timeoutMs, 15_000))
    } catch {
      // CLI 不可用也视为已清理
    }
    return { ok: true, cleared }
  }

  /** 写开关（PUT /api/bili/settings）。 */
  function settings(input: { allowWrites?: boolean }): { ok: boolean; allowWrites: boolean } {
    if (typeof input.allowWrites === 'boolean') {
      storage.setSetting(BILI_KEYS.allowWrites, input.allowWrites ? '1' : '0')
    }
    return { ok: true, allowWrites: allowWrites() }
  }

  /** `bili --version` 是否可用（60s 缓存）。 */
  async function binOk(): Promise<boolean> {
    if (binCache !== null && Date.now() - binCache.at < 60_000) return binCache.ok
    const result = await execBili(bin, ['--version'], { ...process.env }, Math.min(15_000, timeoutMs))
    const ok = result.spawnError === undefined && !result.timedOut && result.exitCode === 0
    binCache = { at: Date.now(), ok }
    return ok
  }

  /** audio 的落盘目录（固定，不可被 argv 覆盖）。 */
  const downloadDir = (): string => resolve(process.env['LITTLY_DATA_DIR'] ?? 'data', DOWNLOAD_SUBDIR)

  /** 限频检查：按 bot 统计最近 1h 的 audit_logs。 */
  function rateLimited(botId: string, kind: 'read' | 'write'): BiliErrorInfo | null {
    const since = new Date(Date.now() - HOUR_MS).toISOString()
    const writeActions = [...BILI_GATED_COMMANDS].map(c => `bili_${c}`)
    const placeholders = writeActions.map(() => '?').join(',')
    try {
      const totalRow = storage
        .prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE bot_id = ? AND category = 'tool_call' AND action LIKE 'bili\\_%' ESCAPE '\\' AND created_at >= ?")
        .get(botId, since) as { c: number } | undefined
      const total = totalRow?.c ?? 0
      const writeRow = storage
        .prepare(
          `SELECT COUNT(*) AS c FROM audit_logs WHERE bot_id = ? AND category = 'tool_call' AND created_at >= ? AND action IN (${placeholders})`,
        )
        .get(botId, since, ...writeActions) as { c: number } | undefined
      const writes = writeRow?.c ?? 0
      const reads = Math.max(0, total - writes)
      if (kind === 'read' && reads >= BILI_READ_LIMIT_PER_HOUR) {
        return { code: 'rate_limited', message: `B 站读操作限频：每小时最多 ${BILI_READ_LIMIT_PER_HOUR} 次，请稍后再试。` }
      }
      if (kind === 'write' && writes >= BILI_WRITE_LIMIT_PER_HOUR) {
        return { code: 'rate_limited', message: `B 站写操作限频：每小时最多 ${BILI_WRITE_LIMIT_PER_HOUR} 次，请稍后再试。` }
      }
      return null
    } catch {
      return null // 统计失败 fail-open
    }
  }

  /** 写审计（失败不阻断调用）。 */
  function audit(botId: string, command: string, detail: Record<string, unknown>): void {
    try {
      const secrets = currentSecrets()
      const safeDetail = redactSecrets(JSON.stringify(detail), secrets).slice(0, 4000)
      storage
        .prepare('INSERT INTO audit_logs (id, bot_id, category, action, detail, created_at) VALUES (?,?,?,?,?,?)')
        .run(randomUUID(), botId, 'tool_call', `bili_${command}`, safeDetail, new Date().toISOString())
    } catch {
      // 审计失败不阻断
    }
  }

  /** 参数校验；通过返回 null。 */
  function validate(argv: string[]): BiliErrorInfo | null {
    if (!Array.isArray(argv) || argv.length === 0) {
      return { code: 'bad_request', message: 'argv 不能为空：请给出 B 站子命令，例如 ["hot"] / ["video","BV1xx411c7mD","--subtitle"]。' }
    }
    if (argv.length > 32) return { code: 'bad_request', message: 'argv 过长（最多 32 项）。' }
    const cleaned = argv.slice()
    const command = cleaned[0] ?? ''
    if (command.trim() === '') return { code: 'bad_request', message: 'argv[0] 不能为空。' }
    for (const arg of cleaned) {
      if (arg.trim() === '' && arg !== '--') return { code: 'bad_request', message: 'argv 不允许空字符串项。' }
      if (arg.length > 2000) return { code: 'bad_request', message: '参数过长（单参数最多 2000 字符）。' }
    }
    if (!BILI_READ_COMMANDS.has(command) && !BILI_WRITE_COMMANDS.has(command)) {
      return {
        code: 'command_not_allowed',
        message: `B 站子命令「${command}」不在允许清单内（读：${[...BILI_READ_COMMANDS].join('/')}；写：${[...BILI_WRITE_COMMANDS].join('/')}）。`,
      }
    }
    for (const arg of cleaned) {
      if (BILI_BLOCKED_FLAGS.has(arg)) {
        return {
          code: 'flag_not_allowed',
          message: `不允许的参数 ${arg}：B 站接入禁文件读写与自定义输出目录（audio 固定输出到服务端 downloads/bili）。`,
        }
      }
    }
    return null
  }

  /** 模型/控制台命令执行主入口。 */
  async function run(argv: string[], opts: { botId?: string; dryRun?: boolean } = {}): Promise<BiliRunResult> {
    const raw = Array.isArray(argv) ? argv.slice() : []
    const invalid = validate(raw)
    if (invalid !== null) {
      return { ok: false, dryRun: false, exitCode: -1, command: raw[0] ?? '', argv: raw, error: invalid }
    }
    const command = raw[0] ?? ''
    const isGated = BILI_GATED_COMMANDS.has(command)
    const isAudio = command === 'audio'
    const botId = (opts.botId ?? '').trim() || 'console'
    const writeEnabled = allowWrites()

    if (isGated) {
      // 默认预演：写开关关闭或没显式 dryRun:false → 不执行。
      const effectiveDryRun = !writeEnabled || opts.dryRun !== false
      if (effectiveDryRun) {
        const note = isAudio
          ? writeEnabled
            ? `audio 是下载类操作：默认预演，未真正下载（要执行请显式传 dryRun:false）。输出目录：${downloadDir()}`
            : `audio 是下载类操作：默认预演，未真正下载（需要管理员在控制台打开「允许写操作」）。输出目录：${downloadDir()}`
          : writeEnabled
            ? '写操作默认预演，未真正执行（要执行请显式传 dryRun:false）。'
            : '写操作默认预演，未真正执行（需要管理员在控制台打开「允许写操作」）。'
        audit(botId, command, {
          argv: sanitizeArgv(raw, currentSecrets()), ok: true, exitCode: 0, dryRun: true, kind: isAudio ? 'audio' : 'write',
        })
        return {
          ok: true,
          dryRun: true,
          exitCode: 0,
          command,
          argv: raw,
          note,
          ...(isAudio ? { outputDir: downloadDir() } : {}),
        }
      }
    }

    const limited = rateLimited(botId, isGated ? 'write' : 'read')
    if (limited !== null) {
      return { ok: false, dryRun: false, exitCode: -1, command, argv: raw, error: limited }
    }

    const execArgv = [...raw]
    // audio 固定输出目录（用户传的 -o/--output 已在 validate 拦掉）。
    if (isAudio) execArgv.push('-o', downloadDir())
    if (CONFIRM_WRITE_COMMANDS.has(command)) execArgv.push('--yes')

    const envelope = await execEnvelope(execArgv)
    const secrets = currentSecrets()
    audit(botId, command, {
      argv: sanitizeArgv(raw, secrets),
      ok: envelope.ok,
      exitCode: envelope.exitCode,
      dryRun: false,
      kind: isGated ? (isAudio ? 'audio' : 'write') : 'read',
      ...(envelope.ok ? {} : { errorCode: envelope.error?.code ?? '', error: (envelope.error?.raw ?? envelope.error?.message ?? '').slice(0, 300) }),
    })
    return {
      ok: envelope.ok,
      dryRun: false,
      exitCode: envelope.exitCode,
      command,
      argv: raw,
      ...(isAudio ? { outputDir: downloadDir() } : {}),
      ...(envelope.ok ? { data: envelope.data ?? null } : (envelope.error !== undefined ? { error: envelope.error } : {})),
    }
  }

  return { status, browserExtract, qrStart, qrPoll, logout, settings, binOk, lastProbe, run }
}
