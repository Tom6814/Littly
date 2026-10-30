/**
 * X（Twitter）服务内核 —— 凭据管理 / 命令执行 / 护栏。
 *
 * 设计约束（/tmp/x-spec.md §1 + Lead 实测补充）：
 * - 认证：`TWITTER_AUTH_TOKEN` + `TWITTER_CT0` 环境变量（子进程注入），凭据存 DB；
 *   **绝不回传前端 / 不写日志**（status 只给 hasXxx 布尔与 username）。
 * - `OUTPUT=json` 时 stdout 是 JSON 信封，数据在 `.data`；**错误时退出码也可能是 0**，
 *   所以成功判定必须解析 `ok`/`error`，不能只看 exit code（Lead 实测）。
 * - 代理：`x.proxy` → 子进程 `TWITTER_PROXY`（本机直连 x.com 会 timeout，需要代理）。
 * - 护栏：读命令自由、写命令默认 dry-run（allow_writes='1' 且 dryRun!==false 才真跑）、
 *   禁文件读写/图片参数、读 30 次/h 写 5 次/h（按 bot 统计 audit_logs）、每次调用审计。
 * - spawn 无 shell；超时杀进程；错误信息保留原始文本便于用户判断要开代理。
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { LittlyStorage } from '@littly/storage'

/** 只读命令（自由执行）。 */
export const X_READ_COMMANDS: ReadonlySet<string> = new Set([
  'status', 'whoami', 'feed', 'bookmarks', 'favorites', 'search', 'tweet', 'show',
  'user', 'user-posts', 'likes', 'followers', 'following', 'list', 'article',
])

/** 写命令（默认 dry-run；开关打开且显式 dryRun:false 才真执行）。 */
export const X_WRITE_COMMANDS: ReadonlySet<string> = new Set([
  'post', 'reply', 'quote', 'delete', 'like', 'unlike', 'retweet', 'unretweet',
  'bookmark', 'unbookmark', 'favorite', 'unfavorite', 'follow', 'unfollow',
])

/** 禁止的文件读写 / 图片参数（本条限制为纯文本；也不允许写/读本地文件）。 */
export const X_BLOCKED_FLAGS: ReadonlySet<string> = new Set(['-o', '--output', '--input', '--image', '-i'])

/** 每小时限频（按 bot 统计 audit_logs）。 */
export const X_READ_LIMIT_PER_HOUR = 30
export const X_WRITE_LIMIT_PER_HOUR = 5

/** global_settings 键（凭据/开关；不含 token 的日志输出）。 */
export const X_KEYS = {
  authToken: 'x.auth_token',
  ct0: 'x.ct0',
  proxy: 'x.proxy',
  username: 'x.username',
  loggedInAt: 'x.logged_in_at',
  allowWrites: 'x.allow_writes',
  lastProbe: 'x.last_probe',
} as const

const HOUR_MS = 60 * 60 * 1000

export interface XServiceConfig {
  /** twitter-cli 可执行文件（默认 twitter；测试可注入 fake bin）。 */
  bin: string
  /** 单次命令超时（毫秒）。 */
  timeoutMs: number
}

export interface XErrorInfo {
  code: string
  /** 中文可读说明（含原始错误片段，便于用户判断是否要开代理）。 */
  message: string
  /** 原始错误文本（截断）。 */
  raw?: string
}

export interface XStatus {
  /** 两项凭据都已配置。 */
  configured: boolean
  username: string
  loggedInAt: string
  allowWrites: boolean
  bin: string
  /** 是否配置了代理（不回传代理地址本身，避免泄露内网信息）。 */
  hasProxy: boolean
}

export interface XRunResult {
  ok: boolean
  /** 是否是「只预演、未真执行」。 */
  dryRun: boolean
  exitCode: number
  /** 命令名（argv[0]）。 */
  command: string
  argv: string[]
  data?: unknown
  error?: XErrorInfo
  /** dry-run 时给模型/控制台看的说明。 */
  note?: string
}

export interface XLoginInput {
  cookie?: string | undefined
  authToken?: string | undefined
  ct0?: string | undefined
  proxy?: string | undefined
}

export interface XProbeResult {
  ok: boolean
  username?: string
  error?: string
}

/** 从浏览器 cookie 串里解析 auth_token / ct0。 */
export function parseXCookie(raw: string): { authToken: string; ct0: string } {
  let authToken = ''
  let ct0 = ''
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const name = part.slice(0, idx).trim()
    const value = (() => {
      const v = part.slice(idx + 1).trim()
      try {
        return decodeURIComponent(v)
      } catch {
        return v
      }
    })()
    if (name === 'auth_token') authToken = value
    else if (name === 'ct0') ct0 = value
  }
  return { authToken, ct0 }
}

/** 从 stdout 里稳健提取第一个 JSON 对象（CLI 可能夹带日志行）。 */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
  const text = raw.trim()
  if (text === '') return null
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    // 继续走平衡扫描
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
          return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/** 错误文本 → 统一错误码（401/403/429/226 映射）。 */
export function mapXError(rawText: string, codeHint?: string): XErrorInfo {
  const raw = rawText.trim().slice(0, 800)
  const lower = raw.toLowerCase()
  const hint = (codeHint ?? '').toLowerCase()
  if (hint.includes('not_authenticated') || hint.includes('unauthorized') || /\b401\b|\b403\b/.test(raw) || lower.includes('unauthorized') || lower.includes('not authenticated') || lower.includes('not_authenticated')) {
    return { code: 'not_authenticated', message: `X 登录已失效或未登录，请在控制台重新登录。原始信息：${raw || '(空)'}`, ...(raw !== '' ? { raw } : {}) }
  }
  if (hint.includes('rate_limited') || /\b429\b/.test(raw) || lower.includes('rate limit') || lower.includes('too many requests')) {
    return { code: 'rate_limited', message: `X 接口限频，请稍后再试。原始信息：${raw || '(空)'}`, ...(raw !== '' ? { raw } : {}) }
  }
  if (/\b226\b/.test(raw) || hint.includes('login_incomplete')) {
    return { code: 'login_incomplete', message: `当前 X 凭据不完整（写操作通常需要完整 cookie；只填两个 token 可能被拒）。原始信息：${raw || '(空)'}`, ...(raw !== '' ? { raw } : {}) }
  }
  return { code: 'x_api_error', message: `X 接口调用失败：${raw || '(无输出)'}`, ...(raw !== '' ? { raw } : {}) }
}

/** 端口化的 X 服务（console-api / 工具共用）。 */
export interface XService {
  status(): XStatus
  login(input: XLoginInput): Promise<{ ok: boolean; status: XStatus; error?: string }>
  logout(): XStatus
  settings(input: { allowWrites?: boolean; proxy?: string }): XStatus
  probe(): Promise<XProbeResult>
  /** `twitter --version` 是否可用（60s 缓存）。 */
  binOk(): Promise<boolean>
  lastProbe(): { ok: boolean; error: string; at: string } | null
  run(argv: string[], opts?: { botId?: string; dryRun?: boolean }): Promise<XRunResult>
}

/** 内部执行原语结果。 */
interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  spawnError?: string
}

function execX(bin: string, argv: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    const finish = (result: ExecResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, argv, { env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ exitCode: -1, stdout: '', stderr: '', timedOut: false, spawnError: error instanceof Error ? error.message : String(error) })
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
      if (stdout.length < 512 * 1024) stdout += d.toString('utf8')
    })
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < 512 * 1024) stderr += d.toString('utf8')
    })
    child.on('error', (error) => {
      finish({ exitCode: -1, stdout, stderr, timedOut, spawnError: error.message })
    })
    child.on('close', (code) => {
      finish({ exitCode: code ?? -1, stdout, stderr, timedOut })
    })
  })
}

/** 审计 detail 脱敏：token/ct0 出现即替换，单值截断。 */
export function sanitizeArgv(argv: readonly string[], secrets: readonly string[]): string[] {
  return argv.map((arg) => {
    let out = arg
    for (const secret of secrets) {
      if (secret !== '' && out.includes(secret)) out = out.split(secret).join('***')
    }
    return out.length > 120 ? `${out.slice(0, 117)}…` : out
  })
}

/** 建 X 服务。 */
export function createXService(storage: LittlyStorage, config: XServiceConfig): XService {
  const bin = config.bin.trim() === '' ? 'twitter' : config.bin.trim()
  const timeoutMs = Math.max(1000, Math.round(config.timeoutMs) || 60000)
  let binCache: { at: number; ok: boolean } | null = null
  let loginProbeUsernameCache: string | null = null

  const get = (key: string): string => storage.getSetting(key) ?? ''
  const set = (key: string, value: string): void => {
    storage.setSetting(key, value)
  }
  const del = (key: string): void => {
    try {
      storage.prepare('DELETE FROM global_settings WHERE key = ?').run(key)
    } catch {
      // ignore
    }
  }

  const credentials = (): { authToken: string; ct0: string; proxy: string } => {
    const authToken = get(X_KEYS.authToken) || (process.env['TWITTER_AUTH_TOKEN'] ?? '')
    const ct0 = get(X_KEYS.ct0) || (process.env['TWITTER_CT0'] ?? '')
    const proxy = get(X_KEYS.proxy) || (process.env['TWITTER_PROXY'] ?? '')
    return { authToken, ct0, proxy }
  }

  const status = (): XStatus => {
    const { authToken, ct0, proxy } = credentials()
    return {
      configured: authToken !== '' && ct0 !== '',
      username: get(X_KEYS.username),
      loggedInAt: get(X_KEYS.loggedInAt),
      allowWrites: get(X_KEYS.allowWrites) === '1',
      bin,
      hasProxy: proxy !== '',
    }
  }

  const lastProbe = (): { ok: boolean; error: string; at: string } | null => {
    const raw = get(X_KEYS.lastProbe)
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

  const recordProbe = (ok: boolean, error: string): void => {
    set(X_KEYS.lastProbe, JSON.stringify({ ok, error, at: new Date().toISOString() }))
  }

  const env = (): NodeJS.ProcessEnv => {
    const { authToken, ct0, proxy } = credentials()
    const out: NodeJS.ProcessEnv = {
      ...process.env,
      OUTPUT: 'json',
      NO_COLOR: '1',
    }
    if (authToken !== '') out['TWITTER_AUTH_TOKEN'] = authToken
    if (ct0 !== '') out['TWITTER_CT0'] = ct0
    if (proxy !== '') out['TWITTER_PROXY'] = proxy
    return out
  }

  /** 底层执行一次 CLI 并解析 JSON 信封；不审计、不限频（登录/probe 的内部步骤用）。 */
  async function execEnvelope(argv: string[]): Promise<{ ok: boolean; exitCode: number; data?: unknown; error?: XErrorInfo }> {
    const result = await execX(bin, argv, env(), timeoutMs)
    if (result.spawnError !== undefined) {
      return { ok: false, exitCode: result.exitCode, error: { code: 'x_bin_unavailable', message: `twitter-cli 不可用（${bin}）：${result.spawnError}` } }
    }
    if (result.timedOut) {
      return { ok: false, exitCode: result.exitCode, error: { code: 'x_timeout', message: `X 命令超时（${Math.round(timeoutMs / 1000)}s；直连 x.com 需要代理，请配置 proxy 或检查网络）` } }
    }
    const stdout = result.stdout.trim()
    const stderr = result.stderr.trim()
    const envelope = extractJsonObject(stdout)
    // 关键：错误时 exit code 也可能是 0 —— 必须看信封 ok/error。
    if (envelope !== null) {
      const okField = envelope['ok']
      const errorField = envelope['error']
      if (okField === false || (okField === undefined && errorField !== undefined && errorField !== null)) {
        const hint = (() => {
          if (typeof errorField === 'string') return errorField
          if (errorField !== null && typeof errorField === 'object') {
            const rec = errorField as Record<string, unknown>
            const code = typeof rec['code'] === 'string' ? rec['code'] : ''
            const message = typeof rec['message'] === 'string' ? rec['message'] : ''
            return [code, message].filter((x) => x !== '').join(': ')
          }
          return ''
        })()
        return { ok: false, exitCode: result.exitCode, error: mapXError(hint !== '' ? hint : stdout, typeof (errorField as Record<string, unknown> | null)?.['code'] === 'string' ? String((errorField as Record<string, unknown>)['code']) : undefined) }
      }
      if (okField === true) {
        return { ok: true, exitCode: result.exitCode, data: envelope['data'] ?? null }
      }
      // 没有 ok 字段：有 data 视为成功
      if (envelope['data'] !== undefined) return { ok: true, exitCode: result.exitCode, data: envelope['data'] }
      return { ok: true, exitCode: result.exitCode, data: envelope }
    }
    if (result.exitCode !== 0) {
      const raw = stderr !== '' ? stderr : stdout
      return { ok: false, exitCode: result.exitCode, error: mapXError(raw) }
    }
    const raw = stdout !== '' ? stdout : stderr
    return { ok: false, exitCode: result.exitCode, error: { code: 'x_parse_failed', message: `X 输出不是合法 JSON：${raw.slice(0, 300)}` } }
  }

  /** 从 whoami/status 的 data 里尽力取 username。 */
  function pickUsername(data: unknown): string {
    if (data === null || typeof data !== 'object') return ''
    const rec = data as Record<string, unknown>
    const candidates = [rec['username'], rec['screen_name'], rec['handle']]
    const user = rec['user']
    if (user !== null && typeof user === 'object') {
      const u = user as Record<string, unknown>
      candidates.push(u['username'], u['screen_name'], u['handle'])
    }
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim() !== '') return c.trim()
    }
    return ''
  }

  /** 限频检查：按 bot 统计最近 1h 的 audit_logs。 */
  function rateLimited(botId: string, kind: 'read' | 'write'): XErrorInfo | null {
    const since = new Date(Date.now() - HOUR_MS).toISOString()
    try {
      const totalRow = storage
        .prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE bot_id = ? AND category = 'tool_call' AND action LIKE 'x\\_%' ESCAPE '\\' AND created_at >= ?")
        .get(botId, since) as { c: number } | undefined
      const total = totalRow?.c ?? 0
      const writeActions = [...X_WRITE_COMMANDS].map((c) => `x_${c}`)
      const writeRow = storage
        .prepare(`SELECT COUNT(*) AS c FROM audit_logs WHERE bot_id = ? AND category = 'tool_call' AND created_at >= ? AND action IN (${writeActions.map(() => '?').join(',')})`)
        .get(botId, since, ...writeActions) as { c: number } | undefined
      const writes = writeRow?.c ?? 0
      const reads = Math.max(0, total - writes)
      if (kind === 'read' && reads >= X_READ_LIMIT_PER_HOUR) {
        return { code: 'rate_limited', message: `X 读操作限频：每小时最多 ${X_READ_LIMIT_PER_HOUR} 次，请稍后再试。` }
      }
      if (kind === 'write' && writes >= X_WRITE_LIMIT_PER_HOUR) {
        return { code: 'rate_limited', message: `X 写操作限频：每小时最多 ${X_WRITE_LIMIT_PER_HOUR} 次，请稍后再试。` }
      }
      return null
    } catch {
      return null // 统计失败 fail-open（不因审计表问题阻断调用）
    }
  }

  /** 写审计（失败不阻断调用）。 */
  function audit(botId: string, command: string, detail: Record<string, unknown>): void {
    try {
      storage
        .prepare('INSERT INTO audit_logs (id, bot_id, category, action, detail, created_at) VALUES (?,?,?,?,?,?)')
        .run(randomUUID(), botId, 'tool_call', `x_${command}`, JSON.stringify(detail).slice(0, 4000), new Date().toISOString())
    } catch {
      // 审计失败不阻断
    }
  }

  /** 参数校验；通过返回 null，否则返回错误。 */
  function validate(argv: string[]): XErrorInfo | null {
    if (!Array.isArray(argv) || argv.length === 0) {
      return { code: 'bad_request', message: 'argv 不能为空：请给出 X 子命令，例如 ["feed"] / ["search","#keyword"]。' }
    }
    if (argv.length > 32) return { code: 'bad_request', message: 'argv 过长（最多 32 项）。' }
    const cleaned = argv.map((a) => String(a))
    if (cleaned.some((a) => a.trim() === '')) return { code: 'bad_request', message: 'argv 不允许空字符串项。' }
    const command = cleaned[0] ?? ''
    if (!X_READ_COMMANDS.has(command) && !X_WRITE_COMMANDS.has(command)) {
      return { code: 'command_not_allowed', message: `X 子命令「${command}」不在允许清单内（读：${[...X_READ_COMMANDS].join('/')}；写：${[...X_WRITE_COMMANDS].join('/')}）。` }
    }
    for (const arg of cleaned) {
      if (X_BLOCKED_FLAGS.has(arg)) {
        return { code: 'flag_not_allowed', message: `不允许的参数 ${arg}：X 接入只支持纯文本，禁止文件读写/图片参数。` }
      }
      if (arg.length > 2000) return { code: 'bad_request', message: '参数过长。' }
    }
    return null
  }

  async function login(input: XLoginInput): Promise<{ ok: boolean; status: XStatus; error?: string }> {
    let authToken = (input.authToken ?? '').trim()
    let ct0 = (input.ct0 ?? '').trim()
    if (input.cookie !== undefined && input.cookie.trim() !== '') {
      const parsed = parseXCookie(input.cookie)
      if (parsed.authToken === '' || parsed.ct0 === '') {
        return { ok: false, status: status(), error: 'cookie 里没有同时找到 auth_token 与 ct0，请粘贴完整的 X cookie（或分别填写两个 token）。' }
      }
      authToken = parsed.authToken
      ct0 = parsed.ct0
    }
    if (authToken === '' || ct0 === '') {
      return { ok: false, status: status(), error: '需要 auth_token 与 ct0（或一条包含两者的完整 cookie）。' }
    }
    set(X_KEYS.authToken, authToken)
    set(X_KEYS.ct0, ct0)
    if (input.proxy !== undefined) set(X_KEYS.proxy, input.proxy.trim())
    // 立即验证一次（whoami）取 username；失败保留凭据并返回可读错误。
    const probe = await execEnvelope(['whoami'])
    if (!probe.ok) {
      const message = probe.error?.message ?? 'X 验证失败'
      recordProbe(false, message)
      return { ok: false, status: status(), error: message }
    }
    const username = pickUsername(probe.data)
    if (username !== '') {
      loginProbeUsernameCache = username
      set(X_KEYS.username, username)
    }
    set(X_KEYS.loggedInAt, new Date().toISOString())
    recordProbe(true, '')
    return { ok: true, status: status() }
  }

  function logout(): XStatus {
    del(X_KEYS.authToken)
    del(X_KEYS.ct0)
    del(X_KEYS.username)
    del(X_KEYS.loggedInAt)
    loginProbeUsernameCache = null
    return status()
  }

  function settings(input: { allowWrites?: boolean; proxy?: string }): XStatus {
    if (typeof input.allowWrites === 'boolean') set(X_KEYS.allowWrites, input.allowWrites ? '1' : '0')
    if (typeof input.proxy === 'string') set(X_KEYS.proxy, input.proxy.trim())
    return status()
  }

  async function probe(): Promise<XProbeResult> {
    const signedIn = status().configured
    if (!signedIn) {
      recordProbe(false, 'X 未配置凭据')
      return { ok: false, error: 'X 未配置凭据（先登录）' }
    }
    const result = await execEnvelope(['status'])
    if (!result.ok) {
      const message = result.error?.message ?? 'X 状态检查失败'
      recordProbe(false, message)
      return { ok: false, error: message }
    }
    const username = pickUsername(result.data) || loginProbeUsernameCache || get(X_KEYS.username)
    recordProbe(true, '')
    return { ok: true, ...(username !== '' ? { username } : {}) }
  }

  async function binOk(): Promise<boolean> {
    if (binCache !== null && Date.now() - binCache.at < 60_000) return binCache.ok
    const result = await execX(bin, ['--version'], { ...process.env }, Math.min(15_000, timeoutMs))
    const ok = result.spawnError === undefined && !result.timedOut && result.exitCode === 0
    binCache = { at: Date.now(), ok }
    return ok
  }

  async function run(argv: string[], opts: { botId?: string; dryRun?: boolean } = {}): Promise<XRunResult> {
    const raw = Array.isArray(argv) ? argv.map((a) => String(a)) : []
    const invalid = validate(raw)
    if (invalid !== null) {
      return { ok: false, dryRun: false, exitCode: -1, command: raw[0] ?? '', argv: raw, error: invalid }
    }
    const command = raw[0] ?? ''
    const isWrite = X_WRITE_COMMANDS.has(command)
    const botId = (opts.botId ?? '').trim() || 'console'
    const { authToken, ct0 } = credentials()
    // 未配置凭据时不 spawn（避免拿空环境打真实接口）：直接返回可读错误。
    if (authToken === '' || ct0 === '') {
      return {
        ok: false,
        dryRun: false,
        exitCode: -1,
        command,
        argv: raw,
        error: { code: 'not_authenticated', message: 'X 未登录或凭据缺失：请先在控制台绑定 X 账号（cookie 或 auth_token + ct0）。' },
      }
    }

    if (isWrite) {
      const allowWrites = get(X_KEYS.allowWrites) === '1'
      // 默认预演：只有开关打开 + 显式 dryRun:false 才真执行。
      const effectiveDryRun = !allowWrites || opts.dryRun !== false
      if (effectiveDryRun) {
        audit(botId, command, {
          argv: sanitizeArgv(raw, [authToken, ct0]), ok: true, exitCode: 0, dryRun: true, kind: 'write',
        })
        return {
          ok: true,
          dryRun: true,
          exitCode: 0,
          command,
          argv: raw,
          note: allowWrites
            ? '写操作默认预演，未真正执行（要执行请显式传 dryRun:false）。'
            : '写操作默认预演，未真正执行（需要管理员在控制台打开「允许写操作」）。',
        }
      }
    }

    // 限频（写预演也已在上面返回，不重复计数；真执行与读操作统一走这里）
    const limited = rateLimited(botId, isWrite ? 'write' : 'read')
    if (limited !== null) {
      return { ok: false, dryRun: false, exitCode: -1, command, argv: raw, error: limited }
    }

    const result = await execEnvelope(raw)
    audit(botId, command, {
      argv: sanitizeArgv(raw, [authToken, ct0]),
      ok: result.ok,
      exitCode: result.exitCode,
      dryRun: false,
      kind: isWrite ? 'write' : 'read',
      ...(result.ok ? {} : { errorCode: result.error?.code ?? '', error: (result.error?.raw ?? result.error?.message ?? '').slice(0, 300) }),
    })
    return {
      ok: result.ok,
      dryRun: false,
      exitCode: result.exitCode,
      command,
      argv: raw,
      ...(result.ok ? { data: result.data ?? null } : (result.error !== undefined ? { error: result.error } : {})),
    }
  }

  return { status, login, logout, settings, probe, binOk, lastProbe, run }
}
