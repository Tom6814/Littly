/**
 * B 站凭证文件（bilibili-cli 的 `credential.json`）读写 + Cookie 归一化。
 *
 * 背景（/tmp/bili-spec.md §0 实测）：
 * - 官方 CLI `bili`（PyPI `bilibili-cli`，v0.6.2）把凭证存在
 *   `$HOME/.bilibili-cli/credential.json`（0600），schema 固定为
 *   `{sessdata, bili_jct, ac_time_value, buvid3, buvid4, dedeuserid, saved_at}`。
 * - CLI **不支持**自定义凭证路径的 env（源码里 `Path.home() / ".bilibili-cli"`），
 *   所以「换账号目录」只能通过给子进程换 `HOME`（见 service.ts 的 env 注入）：
 *   `BILI_CLI_HOME` 被解释为「bili CLI 的 HOME」，凭证落在
 *   `<BILI_CLI_HOME>/.bilibili-cli/credential.json`。
 * - `bili login` 是纯 TTY 交互（rich 终端二维码），非 TTY 无输出 → 控制台扫码
 *   由我们后端直连 passport HTTP 拿 Cookie 后**自己写这个文件**（qr.ts），
 *   再跑 `bili status --json` 复核。
 *
 * 安全：本模块只读写凭证，不打印/不记录值；错误信息一律不带 Cookie 原文。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** credential.json 的固定 schema（与 bilibili-cli auth.py save_credential 一致）。 */
export interface BiliCredential {
  sessdata: string
  bili_jct: string
  ac_time_value: string
  buvid3: string
  buvid4: string
  dedeuserid: string
  /** Unix 秒（CLI 写 `time.time()`）。 */
  saved_at: number
}

/** 给控制台看的凭证摘要（不含任何 Cookie 值）。 */
export interface CredentialInfo {
  present: boolean
  /** ISO 时间；无凭证时为空串。 */
  savedAt: string
  /** 是否有 buvid3/buvid4（B 站 412 风控缓解字段）。 */
  hasBuvid: boolean
}

/** passport Set-Cookie / 回调 URL 里能拿到的 Cookie 子集。 */
export interface BiliCookieJar {
  sessdata: string
  bili_jct: string
  dedeuserid: string
  buvid3: string
  buvid4: string
  ac_time_value: string
}

const CONFIG_DIR_NAME = '.bilibili-cli'
const CREDENTIAL_FILE_NAME = 'credential.json'

/**
 * 解析 bili CLI 的 HOME：
 * 1) 显式参数（插件 Config `homeDir` / 测试注入）
 * 2) `BILI_CLI_HOME` 环境变量
 * 3) 当前进程 HOME（`os.homedir()`）
 * @param explicit - 显式指定的 HOME。
 * @returns CLI 的 HOME 绝对路径。
 */
export function resolveBiliHome(explicit?: string): string {
  const fromArg = (explicit ?? '').trim()
  if (fromArg !== '') return fromArg
  const fromEnv = (process.env['BILI_CLI_HOME'] ?? '').trim()
  if (fromEnv !== '') return fromEnv
  return homedir()
}

/**
 * 默认凭证文件路径：`<home>/.bilibili-cli/credential.json`。
 * @param home - CLI 的 HOME（缺省按 resolveBiliHome()）。
 * @returns 凭证文件绝对路径。
 */
export function defaultCredentialPath(home?: string): string {
  return join(resolveBiliHome(home), CONFIG_DIR_NAME, CREDENTIAL_FILE_NAME)
}

/**
 * 读凭证文件；文件缺失/损坏返回 null（绝不抛错，CLI 的自动浏览器提取会兜底）。
 * @param file - 凭证文件路径。
 * @returns 凭证对象或 null。
 */
export function readCredential(file: string): BiliCredential | null {
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<BiliCredential> | null
    if (raw === null || typeof raw !== 'object') return null
    const str = (v: unknown): string => (typeof v === 'string' ? v : '')
    const cred: BiliCredential = {
      sessdata: str(raw.sessdata),
      bili_jct: str(raw.bili_jct),
      ac_time_value: str(raw.ac_time_value),
      buvid3: str(raw.buvid3),
      buvid4: str(raw.buvid4),
      dedeuserid: str(raw.dedeuserid),
      saved_at: typeof raw.saved_at === 'number' && Number.isFinite(raw.saved_at) ? raw.saved_at : 0,
    }
    return cred.sessdata.trim() === '' ? null : cred
  } catch {
    return null
  }
}

/**
 * 写凭证文件（合并旧文件里的 buvid3/buvid4，避免扫码后丢掉风控缓解 Cookie）。
 * - 目录 0700、文件 0600（与 CLI 行为一致）。
 * @param file - 凭证文件路径。
 * @param jar - passport 拿到的 Cookie（缺的字段用旧值/空串补）。
 * @param nowMs - 当前时间（测试可注入）。
 * @returns 实际写入的凭证对象。
 */
export function writeCredential(
  file: string,
  jar: Partial<BiliCookieJar>,
  nowMs: number = Date.now(),
): BiliCredential {
  const previous = readCredential(file)
  const pick = (next: string | undefined, prev: string | undefined, fallback = ''): string => {
    const value = (next ?? '').trim()
    if (value !== '') return value
    return (prev ?? '').trim() || fallback
  }
  const credential: BiliCredential = {
    sessdata: (jar.sessdata ?? '').trim(),
    bili_jct: (jar.bili_jct ?? '').trim(),
    ac_time_value: pick(jar.ac_time_value, previous?.ac_time_value),
    buvid3: pick(jar.buvid3, previous?.buvid3),
    buvid4: pick(jar.buvid4, previous?.buvid4),
    dedeuserid: pick(jar.dedeuserid, previous?.dedeuserid),
    saved_at: Math.floor(nowMs / 1000),
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, `${JSON.stringify(credential, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  // 显式 chmod：文件已存在时 mode 参数不生效（umask/旧权限）。
  chmodSync(file, 0o600)
  return credential
}

/**
 * 删除凭证文件（登出 / 提取浏览器 Cookie 前清空）。
 * @param file - 凭证文件路径。
 * @returns 之前是否存在。
 */
export function deleteCredential(file: string): boolean {
  if (!existsSync(file)) return false
  try {
    rmSync(file, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * 凭证摘要（给控制台状态用）：只暴露存在性/时间/是否有 buvid。
 * @param file - 凭证文件路径。
 * @returns 摘要。
 */
export function credentialInfo(file: string): CredentialInfo {
  const cred = readCredential(file)
  if (cred === null) return { present: false, savedAt: '', hasBuvid: false }
  const savedAt = cred.saved_at > 0 ? new Date(cred.saved_at * 1000).toISOString() : ''
  return {
    present: true,
    savedAt,
    hasBuvid: cred.buvid3.trim() !== '' || cred.buvid4.trim() !== '',
  }
}

// --- Cookie 解析（Node fetch 的 Headers → Set-Cookie 列表） ---

/**
 * 取响应里的全部 Set-Cookie（Node ≥20 有 `getSetCookie()`；旧实现回退到合并头）。
 * @param headers - fetch 响应头。
 * @returns Set-Cookie 字符串数组。
 */
export function setCookieLines(headers: Headers): string[] {
  const withGetter = headers as unknown as { getSetCookie?: () => string[] }
  if (typeof withGetter.getSetCookie === 'function') {
    const lines = withGetter.getSetCookie()
    if (Array.isArray(lines) && lines.length > 0) return lines
  }
  const single = headers.get('set-cookie')
  if (single === null || single === '') return []
  // 合并头（a=1, b=2）：仅在缺少 getSetCookie 的运行时走到这里；
  // 用 "名字=" 特征切分，避免把 Expires 里的逗号切坏。
  return single.split(/, (?=[^;,=]+=)/)
}

/**
 * 从 Set-Cookie 行里取 `name=value` 的第一个值（不 URL 解码：B 站 Cookie 按原样回传）。
 * @param lines - Set-Cookie 行。
 * @returns name → value。
 */
export function cookieMapFromSetCookie(lines: string[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of lines) {
    const first = line.split(';')[0] ?? ''
    const idx = first.indexOf('=')
    if (idx <= 0) continue
    const name = first.slice(0, idx).trim()
    const value = first.slice(idx + 1).trim()
    if (name === '' || value === '') continue
    if (!map.has(name)) map.set(name, value)
  }
  return map
}

/**
 * 从 passport 的跳转 URL（`...crossDomain?DedeUserID=..&SESSDATA=..`）里取 Cookie。
 * Set-Cookie 缺失时兜底；值按原样保留（不做 decodeURIComponent）。
 * @param url - data.url。
 * @returns 取到的字段（缺省空串）。
 */
export function cookieMapFromRedirectUrl(url: string): Map<string, string> {
  const map = new Map<string, string>()
  if (typeof url !== 'string' || url === '') return map
  const queryIndex = url.indexOf('?')
  if (queryIndex < 0) return map
  const query = url.slice(queryIndex + 1)
  for (const pair of query.split('&')) {
    const idx = pair.indexOf('=')
    if (idx <= 0) continue
    const name = pair.slice(0, idx)
    const value = pair.slice(idx + 1)
    if (name !== '' && value !== '') map.set(name, value)
  }
  return map
}

/**
 * 把 Set-Cookie + 跳转 URL 归一化成 CLI 凭证字段（名字大小写兼容）。
 * @param setCookieLinesValue - Set-Cookie 行。
 * @param redirectUrl - 可选跳转 URL 兜底。
 * @returns Cookie 子集。
 */
export function cookieJarFrom(setCookieLinesValue: string[], redirectUrl?: string): BiliCookieJar {
  const merged = new Map<string, string>()
  for (const [k, v] of cookieMapFromSetCookie(setCookieLinesValue)) merged.set(k.toLowerCase(), v)
  if (redirectUrl !== undefined && redirectUrl !== '') {
    for (const [k, v] of cookieMapFromRedirectUrl(redirectUrl)) {
      const key = k.toLowerCase()
      if (!merged.has(key)) merged.set(key, v)
    }
  }
  const get = (...names: string[]): string => {
    for (const name of names) {
      const value = merged.get(name)
      if (value !== undefined && value !== '') return value
    }
    return ''
  }
  return {
    sessdata: get('sessdata'),
    bili_jct: get('bili_jct'),
    dedeuserid: get('dedeuserid'),
    buvid3: get('buvid3'),
    buvid4: get('buvid4'),
    ac_time_value: '',
  }
}

/**
 * 从凭证里提取需要脱敏的值（日志/审计/错误信息里出现即替换为 ***）。
 * @param credential - 凭证对象（可为 null）。
 * @returns 需要脱敏的字符串列表。
 */
export function credentialSecrets(credential: BiliCredential | null): string[] {
  if (credential === null) return []
  return [credential.sessdata, credential.bili_jct, credential.ac_time_value, credential.buvid3, credential.buvid4]
    .map(v => v.trim())
    .filter(v => v.length >= 8)
}
