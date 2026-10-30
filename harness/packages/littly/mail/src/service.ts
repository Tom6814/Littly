/**
 * @littly/mail 服务内核 —— 给 AI 绑定邮箱后的 IMAP/SMTP 能力（原生 TS，无 sidecar）。
 *
 * 选型（/tmp/mail-spec.md §0）：imapflow（IMAP）、nodemailer（SMTP）、mailparser（RFC822 解析）。
 * 能力对齐 mcp-email-server / mindstone email-imap：列文件夹/列邮件/搜索/读正文+附件/发送/回复/
 * 标记/移动/归档/删除。
 *
 * 安全与限制：
 * - 凭据存 global_settings（mail.*），**密码永不回传**；日志/审计/错误一律遮罩。
 * - From 固定为绑定地址（禁止伪造）。
 * - 写操作默认 dry-run，需 mail.allow_write='1' 且显式 dryRun:false。
 * - 单次最多 20 封；正文返回截断 100KB；附件下载到 LITTLY_DATA_DIR/mail/<botId>/<uid>/，
 *   防路径穿越（拒绝 ../ 等）；发件附件只允许该目录内路径；单附件 20MB。
 * - 限频：读 60/h、写 10/h（按 bot 统计 audit_logs）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { LittlyStorage } from '@littly/storage'

/** global_settings 键。 */
export const MAIL_KEYS = {
  address: 'mail.address',
  imapHost: 'mail.imap_host',
  imapPort: 'mail.imap_port',
  imapSecure: 'mail.imap_secure',
  smtpHost: 'mail.smtp_host',
  smtpPort: 'mail.smtp_port',
  smtpSecure: 'mail.smtp_secure',
  username: 'mail.username',
  password: 'mail.password',
  imapPassword: 'mail.imap_password',
  smtpPassword: 'mail.smtp_password',
  fromName: 'mail.from_name',
  allowWrite: 'mail.allow_write',
  verifiedAt: 'mail.verified_at',
  lastError: 'mail.last_error',
} as const

/** 读命令 / 写命令允许清单。 */
export const MAIL_READ_COMMANDS = new Set(['folders', 'list', 'search', 'read'])
export const MAIL_WRITE_COMMANDS = new Set(['send', 'reply', 'mark', 'move', 'archive', 'delete'])

/** 默认限制。 */
export const MAIL_LIMITS = {
  maxMessages: 20,
  maxBodyBytes: 100 * 1024,
  maxAttachmentBytes: 20 * 1024 * 1024,
  readPerHour: 60,
  writePerHour: 10,
  timeoutMs: 30_000,
} as const

const HOUR_MS = 60 * 60 * 1000

/** 服务错误（routes 映射 HTTP 状态）。 */
export class MailError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'MailError'
    this.code = code
    this.status = status
  }
}

/** 账号配置（不含密码回传）。 */
export interface MailAccountView {
  address: string
  fromName: string
  imap: { host: string; port: number; secure: boolean; hasPassword: boolean }
  smtp: { host: string; port: number; secure: boolean; hasPassword: boolean }
  username: string
  configured: boolean
  allowWrite: boolean
  verifiedAt: string
  lastError: string
}

export interface MailStatus extends MailAccountView {}

export interface MailTestResult {
  ok: boolean
  imap: boolean
  smtp: boolean
  error?: string
}

/** IMAP 客户端结构面（测试注入 fake）。 */
export interface MailImapClientLike {
  connect(): Promise<unknown>
  logout(): Promise<unknown> | unknown
  mailboxOpen(path: string, options?: { readOnly?: boolean }): Promise<unknown>
  mailboxList(): Promise<Array<{ path: string; name?: string; delimiter?: string; specialUse?: string; flags?: unknown }>>
  fetch(range: string, query: Record<string, unknown>, options?: { uid?: boolean }): Promise<AsyncIterable<Record<string, unknown>> | Array<Record<string, unknown>>>
  fetchOne(seq: number | string, query: Record<string, unknown>, options?: { uid?: boolean }): Promise<Record<string, unknown> | false | undefined>
  search(query: Record<string, unknown>, options?: { uid?: boolean }): Promise<number[]>
  messageFlagsAdd(range: string | number | number[], flags: string[], options?: { uid?: boolean }): Promise<boolean>
  messageFlagsRemove(range: string | number | number[], flags: string[], options?: { uid?: boolean }): Promise<boolean>
  messageMove(range: string | number | number[], destination: string, options?: { uid?: boolean }): Promise<unknown>
  messageDelete(range: string | number | number[], options?: { uid?: boolean }): Promise<boolean>
  expunge?(): Promise<boolean>
}

/** SMTP transport 结构面（测试注入 fake）。 */
export interface MailSmtpLike {
  verify(): Promise<boolean>
  sendMail(message: Record<string, unknown>): Promise<{ messageId?: string; accepted?: unknown[]; rejected?: unknown[]; response?: string }>
  close?(): void
}

/** 解析后的邮件结构（测试可注入 fake parser）。 */
export interface MailAttachmentParsed {
  filename?: string
  contentType?: string
  size?: number
  content?: Buffer
}
export interface ParsedMailLike {
  subject?: string
  from?: { value?: Array<{ address?: string; name?: string }>; text?: string }
  to?: { value?: Array<{ address?: string; name?: string }>; text?: string }
  cc?: { value?: Array<{ address?: string; name?: string }>; text?: string }
  date?: Date | string
  text?: string
  html?: string | Buffer | false
  messageId?: string
  references?: string[] | string
  inReplyTo?: string
  attachments?: MailAttachmentParsed[]
}

export interface MailServiceOptions {
  /** 附件根目录：默认 LITTLY_DATA_DIR/mail。 */
  dataDir?: string
  /** 测试注入：返回 fake IMAP 客户端。 */
  imapFactory?: ((account: ResolvedAccount) => MailImapClientLike | Promise<MailImapClientLike>) | null
  smtpFactory?: ((account: ResolvedAccount) => MailSmtpLike | Promise<MailSmtpLike>) | null
  parseMail?: ((source: Buffer | string) => Promise<ParsedMailLike>) | null
  maxMessages?: number
  maxBodyBytes?: number
  maxAttachmentBytes?: number
  readPerHour?: number
  writePerHour?: number
  now?: () => number
}

/** 解析后的账号（含密码，仅服务内部用）。 */
export interface ResolvedAccount {
  address: string
  fromName: string
  username: string
  password: string
  imapPassword: string
  smtpPassword: string
  imap: { host: string; port: number; secure: boolean }
  smtp: { host: string; port: number; secure: boolean }
}

/** 校验并解析 global_settings 里的账号；缺字段返回错误。 */
export function resolveAccount(storage: LittlyStorage): { account?: ResolvedAccount; error?: string } {
  const get = (key: string): string => (storage.getSetting(key) ?? '').trim()
  const address = get(MAIL_KEYS.address)
  const imapHost = get(MAIL_KEYS.imapHost)
  const smtpHost = get(MAIL_KEYS.smtpHost)
  const username = get(MAIL_KEYS.username) || address
  const password = get(MAIL_KEYS.password)
  if (address === '') return { error: '未绑定邮箱地址' }
  if (!/^[^@\s]+@[^@\s]+$/u.test(address)) return { error: '邮箱地址格式不正确' }
  if (imapHost === '') return { error: '未配置 IMAP 服务器' }
  if (smtpHost === '') return { error: '未配置 SMTP 服务器' }
  if (password === '' && get(MAIL_KEYS.imapPassword) === '' && get(MAIL_KEYS.smtpPassword) === '') return { error: '未配置邮箱密码/授权码' }
  const imapPort = Number(get(MAIL_KEYS.imapPort)) || 993
  const smtpPort = Number(get(MAIL_KEYS.smtpPort)) || 465
  if (!Number.isInteger(imapPort) || imapPort < 1 || imapPort > 65535) return { error: 'IMAP 端口不合法' }
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) return { error: 'SMTP 端口不合法' }
  return {
    account: {
      address,
      fromName: get(MAIL_KEYS.fromName),
      username,
      password,
      imapPassword: get(MAIL_KEYS.imapPassword) || password,
      smtpPassword: get(MAIL_KEYS.smtpPassword) || password,
      imap: { host: imapHost, port: imapPort, secure: get(MAIL_KEYS.imapSecure) !== '0' },
      smtp: { host: smtpHost, port: smtpPort, secure: get(MAIL_KEYS.smtpSecure) !== '0' },
    },
  }
}

/** 遮罩密码/授权码类文本（错误信息、日志、审计用）。 */
export function maskMailSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text
  out = out.replace(/((?:password|passwd|pass|授权码|密码|token)\s*[:：=]\s*)(\S+)/giu, '$1***')
  out = out.replace(/(AUTH\s+[A-Za-z0-9+/=]{4,})/giu, 'AUTH ***')
  for (const secret of secrets) if (secret !== '' && secret.length >= 3) out = out.split(secret).join('***')
  return out
}

/** 安全附件文件名：只允许 basename 字符集，拒绝路径穿越/绝对路径。 */
export function safeAttachmentName(name: string): string {
  const raw = String(name ?? '').trim()
  if (raw === '') throw new MailError('bad_attachment', '附件缺少文件名', 400)
  if (raw.includes('\u0000')) throw new MailError('bad_attachment', '附件名包含非法字符', 400)
  if (isAbsolute(raw) || raw.includes('..') || /["'/\\]/u.test(raw)) {
    throw new MailError('bad_attachment', `附件名不允许路径分量（${raw.slice(0, 80)}）`, 400)
  }
  const cleaned = basename(raw).replace(/[^\w.\- ()（）[\]]+/gu, '_').slice(0, 120)
  if (cleaned === '' || cleaned === '.' || cleaned === '..') throw new MailError('bad_attachment', '附件名不合法', 400)
  return cleaned
}

/** 把正文/HTML 截断到上限。 */
export function truncateText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false }
  const buf = Buffer.from(text)
  // 按字节截断后可能切到多字节字符，去掉尾部替换符。
  const sliced = buf.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/u, '')
  return { text: sliced, truncated: true }
}

/** 规范化 envelope / 地址。 */
export function addressText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object') {
    const rec = value as { text?: unknown; value?: Array<{ address?: unknown; name?: unknown }> }
    if (typeof rec.text === 'string' && rec.text !== '') return rec.text
    if (Array.isArray(rec.value)) {
      return rec.value.map((item) => {
        const address = typeof item?.address === 'string' ? item.address : ''
        const name = typeof item?.name === 'string' ? item.name : ''
        return name !== '' && address !== '' ? `${name} <${address}>` : address || name
      }).filter((x) => x !== '').join(', ')
    }
  }
  return ''
}

/** 附件根目录。 */
export function defaultMailRoot(): string {
  const root = (process.env['LITTLY_DATA_DIR'] ?? '').trim() || join(process.cwd(), 'data')
  return join(root, 'mail')
}

/** 服务接口。 */
export interface MailService {
  status(): MailStatus
  test(): Promise<MailTestResult>
  run(command: string, params: Record<string, unknown>, options?: { dryRun?: boolean; botId?: string }): Promise<Record<string, unknown>>
  readonly dataRoot: string
}

interface ListMessage {
  uid: number
  subject: string
  from: string
  to: string
  date: string
  unread: boolean
  size: number
  messageId?: string
}

interface MailClientContext {
  account: ResolvedAccount
  imap: MailImapClientLike
}

export function createMailService(storage: LittlyStorage, options: MailServiceOptions = {}): MailService {
  const dataRoot = (options.dataDir ?? '').trim() || defaultMailRoot()
  const maxMessages = Math.max(1, options.maxMessages ?? MAIL_LIMITS.maxMessages)
  const maxBodyBytes = Math.max(16, options.maxBodyBytes ?? MAIL_LIMITS.maxBodyBytes)
  const maxAttachmentBytes = Math.max(1024, options.maxAttachmentBytes ?? MAIL_LIMITS.maxAttachmentBytes)
  const readLimit = Math.max(1, options.readPerHour ?? MAIL_LIMITS.readPerHour)
  const writeLimit = Math.max(1, options.writePerHour ?? MAIL_LIMITS.writePerHour)
  const now = options.now ?? (() => Date.now())

  const get = (key: string): string => (storage.getSetting(key) ?? '')
  const set = (key: string, value: string): void => storage.setSetting(key, value)

  function status(): MailStatus {
    const resolved = resolveAccount(storage)
    const account = resolved.account
    const address = get(MAIL_KEYS.address)
    return {
      address,
      fromName: get(MAIL_KEYS.fromName),
      imap: { host: get(MAIL_KEYS.imapHost), port: Number(get(MAIL_KEYS.imapPort)) || 993, secure: get(MAIL_KEYS.imapSecure) !== '0', hasPassword: account !== undefined || (get(MAIL_KEYS.imapPassword) || get(MAIL_KEYS.password)) !== '' },
      smtp: { host: get(MAIL_KEYS.smtpHost), port: Number(get(MAIL_KEYS.smtpPort)) || 465, secure: get(MAIL_KEYS.smtpSecure) !== '0', hasPassword: account !== undefined || (get(MAIL_KEYS.smtpPassword) || get(MAIL_KEYS.password)) !== '' },
      username: get(MAIL_KEYS.username) || address,
      configured: account !== undefined,
      allowWrite: get(MAIL_KEYS.allowWrite) === '1',
      verifiedAt: get(MAIL_KEYS.verifiedAt),
      lastError: get(MAIL_KEYS.lastError),
    }
  }

  async function makeImap(account: ResolvedAccount): Promise<MailImapClientLike> {
    if (options.imapFactory !== undefined && options.imapFactory !== null) return options.imapFactory(account)
    const { ImapFlow } = await import('imapflow') as unknown as { ImapFlow: new (config: Record<string, unknown>) => MailImapClientLike }
    return new ImapFlow({
      host: account.imap.host,
      port: account.imap.port,
      secure: account.imap.secure,
      auth: { user: account.username, pass: account.imapPassword },
      logger: false,
      connectionTimeout: MAIL_LIMITS.timeoutMs,
      greetingTimeout: MAIL_LIMITS.timeoutMs,
      socketTimeout: MAIL_LIMITS.timeoutMs,
    })
  }

  async function makeSmtp(account: ResolvedAccount): Promise<MailSmtpLike> {
    if (options.smtpFactory !== undefined && options.smtpFactory !== null) return options.smtpFactory(account)
    const nodemailer = await import('nodemailer') as unknown as { default?: { createTransport: (config: Record<string, unknown>) => MailSmtpLike }; createTransport?: (config: Record<string, unknown>) => MailSmtpLike }
    const create = nodemailer.createTransport ?? nodemailer.default?.createTransport
    if (create === undefined) throw new MailError('smtp_unavailable', 'nodemailer 不可用', 500)
    return create({
      host: account.smtp.host,
      port: account.smtp.port,
      secure: account.smtp.secure,
      auth: { user: account.username, pass: account.smtpPassword },
      connectionTimeout: MAIL_LIMITS.timeoutMs,
      greetingTimeout: MAIL_LIMITS.timeoutMs,
      socketTimeout: MAIL_LIMITS.timeoutMs,
    })
  }

  async function parse(source: Buffer | string): Promise<ParsedMailLike> {
    if (options.parseMail !== undefined && options.parseMail !== null) return options.parseMail(source)
    const { simpleParser } = await import('mailparser') as unknown as { simpleParser: (input: Buffer | string) => Promise<ParsedMailLike> }
    return simpleParser(source)
  }

  async function withImap<T>(action: (ctx: MailClientContext) => Promise<T>): Promise<T> {
    const resolved = resolveAccount(storage)
    if (resolved.account === undefined) throw new MailError('mail_not_configured', resolved.error ?? '邮箱未配置', 400)
    const account = resolved.account
    const imap = await makeImap(account)
    try {
      await imap.connect()
      return await action({ account, imap })
    } catch (error) {
      if (error instanceof MailError) throw error
      const raw = error instanceof Error ? error.message : String(error)
      throw new MailError('imap_failed', `IMAP 操作失败：${maskMailSecrets(raw, [account.imapPassword])}`, 502)
    } finally {
      try { await imap.logout() } catch { /* ignore */ }
    }
  }

  async function test(): Promise<MailTestResult> {
    const resolved = resolveAccount(storage)
    if (resolved.account === undefined) {
      const error = resolved.error ?? '邮箱未配置'
      set(MAIL_KEYS.lastError, error)
      return { ok: false, imap: false, smtp: false, error }
    }
    const account = resolved.account
    let imapOk = false
    let smtpOk = false
    let imapError = ''
    let smtpError = ''
    try {
      const imap = await makeImap(account)
      await imap.connect()
      await imap.mailboxOpen('INBOX', { readOnly: true })
      imapOk = true
      try { await imap.logout() } catch { /* ignore */ }
    } catch (error) {
      imapError = maskMailSecrets(error instanceof Error ? error.message : String(error), [account.imapPassword])
    }
    try {
      const smtp = await makeSmtp(account)
      smtpOk = await smtp.verify()
      smtp.close?.()
      if (!smtpOk) smtpError = 'SMTP verify 失败（账号/授权码或服务器不允许）'
    } catch (error) {
      smtpError = maskMailSecrets(error instanceof Error ? error.message : String(error), [account.smtpPassword])
    }
    const ok = imapOk && smtpOk
    const parts = [imapError !== '' ? `IMAP：${imapError}` : '', smtpError !== '' ? `SMTP：${smtpError}` : ''].filter((x) => x !== '')
    const error = ok ? '' : `连接测试失败（${parts.join('；') || '未知错误'}）`
    set(MAIL_KEYS.lastError, error)
    if (ok) set(MAIL_KEYS.verifiedAt, new Date(now()).toISOString())
    return { ok, imap: imapOk, smtp: smtpOk, ...(error !== '' ? { error } : {}) }
  }

  /** 限频检查（按 bot 统计 audit_logs 的 mail_<cmd>）。 */
  function rateLimited(botId: string, kind: 'read' | 'write'): MailError | null {
    const since = new Date(now() - HOUR_MS).toISOString()
    try {
      const writeActions = [...MAIL_WRITE_COMMANDS].map((c) => `mail_${c}`)
      const total = (storage.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE bot_id = ? AND category = ? AND action LIKE ? AND created_at >= ?").get(botId, 'tool_call', 'mail\_%', since) as { c: number } | undefined)?.c ?? 0
      const writes = (storage.prepare(`SELECT COUNT(*) AS c FROM audit_logs WHERE bot_id = ? AND category = 'tool_call' AND created_at >= ? AND action IN (${writeActions.map(() => '?').join(',')})`).get(botId, since, ...writeActions) as { c: number } | undefined)?.c ?? 0
      const reads = Math.max(0, total - writes)
      if (kind === 'read' && reads >= readLimit) return new MailError('rate_limited', `邮箱读操作限频：每小时最多 ${readLimit} 次，请稍后再试。`, 429)
      if (kind === 'write' && writes >= writeLimit) return new MailError('rate_limited', `邮箱写操作限频：每小时最多 ${writeLimit} 次，请稍后再试。`, 429)
      return null
    } catch {
      return null
    }
  }

  /** 审计（detail 不含正文/密码/收件人地址；只记结构化信息）。 */
  function audit(botId: string, command: string, detail: Record<string, unknown>): void {
    try {
      storage.prepare('INSERT INTO audit_logs (id, bot_id, category, action, detail, created_at) VALUES (?,?,?,?,?,?)')
        .run(randomUUID(), botId, 'tool_call', `mail_${command}`, JSON.stringify(detail).slice(0, 4000), new Date().toISOString())
    } catch { /* ignore */ }
  }

  function botAttachmentDir(botId: string): string {
    return join(dataRoot, botId.replace(/[^\w.-]/gu, '_'))
  }

  /** 把发件附件路径限制在 bot 附件目录内。 */
  function resolveOutgoingAttachment(botId: string, input: string): { path: string; name: string } {
    const root = botAttachmentDir(botId)
    const candidate = isAbsolute(input) ? input : join(root, input)
    const normalized = resolve(candidate)
    const rel = relative(root, normalized)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || normalized.includes(`${sep}..${sep}`)) {
      throw new MailError('attachment_outside_root', `附件路径不在允许目录内（${input.slice(0, 120)}）`, 400)
    }
    return { path: normalized, name: safeAttachmentName(basename(normalized)) }
  }

  /** 发现特殊文件夹（Trash/Archive）路径；互不兜底。 */
  async function resolveSpecialFolder(imap: MailImapClientLike, special: '\\Trash' | '\\Archive'): Promise<string> {
    const list = await imap.mailboxList()
    const specialLower = special.toLowerCase()
    const bySpecialUse = list.find((box) => (box.specialUse ?? '').toLowerCase().includes(specialLower))
    if (bySpecialUse !== undefined) return bySpecialUse.path
    const byName = special === '\\Trash'
      ? list.find((box) => /trash|已删除|删除/u.test(box.path))
      : list.find((box) => /archive|归档/u.test(box.path))
    if (byName !== undefined) return byName.path
    throw new MailError('folder_missing', `找不到特殊文件夹（${special}）`, 400)
  }

  /** 列邮件（内部）。 */
  async function listMessages(ctx: MailClientContext, input: { folder?: string; limit?: number; unreadOnly?: boolean }): Promise<{ folder: string; messages: ListMessage[]; total: number; truncated: boolean }> {
    const folder = input.folder ?? 'INBOX'
    const limit = Math.min(maxMessages, Math.max(1, Math.round(input.limit ?? 10)))
    const mailbox = await ctx.imap.mailboxOpen(folder, { readOnly: true }) as { exists?: number } | boolean | undefined
    const exists = typeof mailbox === 'object' && mailbox !== null && typeof mailbox.exists === 'number' ? mailbox.exists : 0
    const collected: ListMessage[] = []
    if (exists > 0) {
      const fetchResult = await ctx.imap.fetch('1:*', { uid: true, envelope: true, flags: true, internalDate: true, size: true })
      const iterable = fetchResult as AsyncIterable<Record<string, unknown>>
      for await (const message of iterable) {
        const flags = message['flags'] instanceof Set ? message['flags'] as Set<string> : new Set<string>(Array.isArray(message['flags']) ? message['flags'] as string[] : [])
        const unread = !flags.has('\\Seen')
        if (input.unreadOnly === true && !unread) continue
        const envelope = (message['envelope'] ?? {}) as Record<string, unknown>
        collected.push({
          uid: Number(message['uid'] ?? 0),
          subject: String(envelope['subject'] ?? ''),
          from: addressText(envelope['from']),
          to: addressText(envelope['to']),
          date: message['internalDate'] instanceof Date ? (message['internalDate'] as Date).toISOString() : String(message['internalDate'] ?? ''),
          unread,
          size: Number(message['size'] ?? 0),
          ...(typeof envelope['messageId'] === 'string' ? { messageId: envelope['messageId'] } : {}),
        })
      }
    }
    collected.sort((a, b) => b.uid - a.uid)
    return { folder, messages: collected.slice(0, limit), total: collected.length, truncated: collected.length > limit }
  }

  /** 读一封（内部，含附件落盘）。 */
  async function readMessage(ctx: MailClientContext, input: { uid: number; folder?: string; attachments?: boolean; botId: string }): Promise<Record<string, unknown>> {
    const folder = input.folder ?? 'INBOX'
    await ctx.imap.mailboxOpen(folder, { readOnly: true })
    const fetched = await ctx.imap.fetchOne(input.uid, { uid: true, source: true, envelope: true, flags: true, internalDate: true, size: true }, { uid: true })
    if (fetched === false || fetched === undefined) throw new MailError('message_not_found', `邮件不存在（uid=${input.uid}）`, 404)
    const source = fetched['source']
    if (source === undefined) throw new MailError('read_failed', '邮件正文不可用', 502)
    const parsed = await parse(source as Buffer | string)
    const body = truncateText(String(parsed.text ?? ''), maxBodyBytes)
    const htmlRaw = parsed.html === false || parsed.html === undefined ? '' : String(parsed.html)
    const html = truncateText(htmlRaw, maxBodyBytes)
    const result: Record<string, unknown> = {
      uid: input.uid,
      folder,
      subject: String(parsed.subject ?? ''),
      from: addressText(parsed.from),
      to: addressText(parsed.to),
      cc: addressText(parsed.cc),
      date: parsed.date instanceof Date ? parsed.date.toISOString() : String(parsed.date ?? ''),
      text: body.text,
      textTruncated: body.truncated,
      ...(htmlRaw !== '' ? { html: html.text, htmlTruncated: html.truncated } : {}),
      attachments: [],
    }
    const attachments = parsed.attachments ?? []
    if ((input.attachments ?? false) && attachments.length > 0) {
      const dir = join(botAttachmentDir(input.botId), String(input.uid))
      mkdirSync(dir, { recursive: true })
      const saved: Array<Record<string, unknown>> = []
      let totalBytes = 0
      for (const attachment of attachments) {
        const content = attachment.content
        const size = content !== undefined ? content.length : (attachment.size ?? 0)
        if (size > maxAttachmentBytes) {
          saved.push({ filename: attachment.filename ?? '', size, error: `附件超过上限（${maxAttachmentBytes} 字节）` })
          continue
        }
        totalBytes += size
        if (totalBytes > maxAttachmentBytes) {
          saved.push({ filename: attachment.filename ?? '', size, error: '本次附件总大小超过上限' })
          continue
        }
        let name: string
        try {
          name = safeAttachmentName(attachment.filename ?? `attachment-${saved.length + 1}`)
        } catch (error) {
          saved.push({ filename: attachment.filename ?? '', size, error: error instanceof Error ? error.message : '附件名不合法' })
          continue
        }
        if (content !== undefined) {
          const target = join(dir, name)
          if (!resolve(target).startsWith(resolve(dir) + sep)) {
            saved.push({ filename: name, size, error: '附件路径不合法' })
            continue
          }
          writeFileSync(target, content)
          saved.push({ filename: name, size, path: relative(dataRoot, target), contentType: attachment.contentType ?? '' })
        } else {
          saved.push({ filename: name, size, contentType: attachment.contentType ?? '', note: '未提供内容（仅元数据）' })
        }
      }
      result['attachments'] = saved
    } else {
      result['attachments'] = attachments.slice(0, 50).map((att) => ({ filename: att.filename ?? '', size: att.size ?? att.content?.length ?? 0, contentType: att.contentType ?? '' }))
    }
    return result
  }

  /** 组装回复邮件（From 固定、References/In-Reply-To 正确）。 */
  function buildReply(original: ParsedMailLike, input: { text?: string; html?: string }): { to: string; subject: string; text: string; html?: string; inReplyTo?: string; references?: string[] } {
    const fromAddress = original.from?.value?.[0]?.address ?? ''
    const originalSubject = String(original.subject ?? '')
    const subject = /^re:/iu.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`
    const raw = original.references
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
    const messageId = original.messageId ?? ''
    const references = [...list, ...(messageId !== '' ? [messageId] : [])].filter((x) => x !== '')
    return {
      to: fromAddress,
      subject,
      text: String(input.text ?? ''),
      ...(input.html !== undefined ? { html: input.html } : {}),
      ...(messageId !== '' ? { inReplyTo: messageId } : {}),
      ...(references.length > 0 ? { references } : {}),
    }
  }

  async function sendMessage(ctx: MailClientContext, input: { to: unknown; subject: unknown; text: unknown; html?: unknown; cc?: unknown; bcc?: unknown; attachments?: unknown; botId: string }, replyHeaders?: { inReplyTo?: string; references?: string[] }): Promise<Record<string, unknown>> {
    const account = ctx.account
    const to = Array.isArray(input.to) ? input.to.map((x) => String(x)).filter((x) => x !== '') : String(input.to ?? '').split(',').map((x) => x.trim()).filter((x) => x !== '')
    if (to.length === 0) throw new MailError('bad_request', 'send 需要收件人 to', 400)
    const subject = String(input.subject ?? '')
    if (subject === '') throw new MailError('bad_request', 'send 需要 subject', 400)
    const text = String(input.text ?? '')
    if (text === '' && String(input.html ?? '') === '') throw new MailError('bad_request', 'send 需要 text 或 html 正文', 400)
    const attachments: Array<{ filename: string; content: Buffer }> = []
    if (Array.isArray(input.attachments)) {
      for (const raw of input.attachments) {
        const resolved = resolveOutgoingAttachment(input.botId, String(raw))
        let content: Buffer
        try {
          content = readFileSync(resolved.path)
        } catch {
          throw new MailError('attachment_missing', `附件不存在（${resolved.name}）`, 400)
        }
        if (content.length > maxAttachmentBytes) throw new MailError('attachment_too_large', `附件超过上限（${resolved.name}）`, 400)
        attachments.push({ filename: resolved.name, content })
      }
    }
    const message: Record<string, unknown> = {
      // From 固定为绑定地址（忽略调用方任何伪造尝试）
      from: account.fromName !== '' ? `${account.fromName} <${account.address}>` : account.address,
      to,
      subject,
      text,
      ...(String(input.html ?? '') !== '' ? { html: String(input.html) } : {}),
      ...(replyHeaders?.inReplyTo !== undefined && replyHeaders.inReplyTo !== '' ? { inReplyTo: replyHeaders.inReplyTo } : {}),
      ...(replyHeaders?.references !== undefined && replyHeaders.references.length > 0 ? { references: replyHeaders.references } : {}),
      ...(Array.isArray(input.cc) ? { cc: (input.cc as unknown[]).map((x) => String(x)) } : String(input.cc ?? '') !== '' ? { cc: String(input.cc) } : {}),
      ...(Array.isArray(input.bcc) ? { bcc: (input.bcc as unknown[]).map((x) => String(x)) } : String(input.bcc ?? '') !== '' ? { bcc: String(input.bcc) } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    }
    const smtp = await makeSmtp(account)
    try {
      const info = await smtp.sendMail(message)
      smtp.close?.()
      return { ok: true, messageId: info.messageId ?? '', accepted: Array.isArray(info.accepted) ? info.accepted.length : 0 }
    } catch (error) {
      smtp.close?.()
      const raw = error instanceof Error ? error.message : String(error)
      throw new MailError('smtp_failed', `SMTP 发送失败：${maskMailSecrets(raw, [account.smtpPassword])}`, 502)
    }
  }

  async function run(command: string, params: Record<string, unknown>, runOptions: { dryRun?: boolean; botId?: string } = {}): Promise<Record<string, unknown>> {
    const botId = (runOptions.botId ?? '').trim() || 'console'
    const isWrite = MAIL_WRITE_COMMANDS.has(command)
    const isRead = MAIL_READ_COMMANDS.has(command)
    if (!isRead && !isWrite) throw new MailError('command_not_allowed', `未知/不允许的 mail 命令：${command}（读：${[...MAIL_READ_COMMANDS].join('/')}；写：${[...MAIL_WRITE_COMMANDS].join('/')}）`, 400)
    const resolved = resolveAccount(storage)
    if (resolved.account === undefined) {
      const message = resolved.error ?? '邮箱未配置'
      throw new MailError('mail_not_configured', message, 400)
    }
    const account = resolved.account
    if (isWrite) {
      const allowWrite = get(MAIL_KEYS.allowWrite) === '1'
      const effectiveDryRun = !allowWrite || runOptions.dryRun !== false
      if (effectiveDryRun) {
        audit(botId, command, { command, dryRun: true, ok: true })
        return {
          ok: true,
          dryRun: true,
          command,
          note: allowWrite ? '写操作默认预演，未真正执行（要执行请显式传 dryRun:false）。' : '写操作默认预演，未真正执行（需要管理员在控制台打开「允许写操作」）。',
        }
      }
    }
    const limited = rateLimited(botId, isWrite ? 'write' : 'read')
    if (limited !== null) throw limited
    try {
      const result = await (async (): Promise<Record<string, unknown>> => {
        switch (command) {
          case 'folders': {
            return await withImap(async (ctx) => {
              const list = await ctx.imap.mailboxList()
              return { ok: true, folders: list.slice(0, 200).map((box) => ({ path: box.path, name: box.name ?? box.path, delimiter: box.delimiter ?? '/', ...(box.specialUse !== undefined ? { specialUse: box.specialUse } : {}) })) }
            })
          }
          case 'list': {
            return await withImap(async (ctx) => {
              const result = await listMessages(ctx, { folder: typeof params['folder'] === 'string' ? params['folder'] : 'INBOX', limit: Number(params['limit']) || 10, unreadOnly: params['unreadOnly'] === true })
              return { ok: true, ...result }
            })
          }
          case 'search': {
            const query = String(params['query'] ?? '').trim()
            if (query === '') throw new MailError('bad_request', 'search 需要 query', 400)
            return await withImap(async (ctx) => {
              const folder = typeof params['folder'] === 'string' ? params['folder'] : 'INBOX'
              await ctx.imap.mailboxOpen(folder, { readOnly: true })
              const uids = await ctx.imap.search({ text: query }, { uid: true })
              const limit = Math.min(maxMessages, Math.max(1, Number(params['limit']) || 10))
              const picked = uids.slice(-limit).reverse()
              const messages: ListMessage[] = []
              for (const uid of picked) {
                const fetched = await ctx.imap.fetchOne(uid, { uid: true, envelope: true, flags: true, internalDate: true, size: true }, { uid: true })
                if (fetched === false || fetched === undefined) continue
                const envelope = (fetched['envelope'] ?? {}) as Record<string, unknown>
                const flags = fetched['flags'] instanceof Set ? fetched['flags'] as Set<string> : new Set<string>(Array.isArray(fetched['flags']) ? fetched['flags'] as string[] : [])
                messages.push({ uid: Number(fetched['uid'] ?? uid), subject: String(envelope['subject'] ?? ''), from: addressText(envelope['from']), to: addressText(envelope['to']), date: fetched['internalDate'] instanceof Date ? (fetched['internalDate'] as Date).toISOString() : String(fetched['internalDate'] ?? ''), unread: !flags.has('\\Seen'), size: Number(fetched['size'] ?? 0) })
              }
              return { ok: true, folder, query, messages, total: uids.length }
            })
          }
          case 'read': {
            const uid = Number(params['uid'])
            if (!Number.isInteger(uid) || uid <= 0) throw new MailError('bad_request', 'read 需要合法 uid', 400)
            return await withImap(async (ctx) => {
              const message = await readMessage(ctx, { uid, folder: typeof params['folder'] === 'string' ? params['folder'] : 'INBOX', attachments: params['attachments'] === true, botId })
              return { ok: true, message }
            })
          }
          case 'send': {
            return await withImap(async (ctx) => sendMessage(ctx, { to: params['to'], subject: params['subject'], text: params['text'], html: params['html'], cc: params['cc'], bcc: params['bcc'], attachments: params['attachments'], botId }))
          }
          case 'reply': {
            const uid = Number(params['uid'])
            if (!Number.isInteger(uid) || uid <= 0) throw new MailError('bad_request', 'reply 需要合法 uid', 400)
            return await withImap(async (ctx) => {
              const folder = typeof params['folder'] === 'string' ? params['folder'] : 'INBOX'
              await ctx.imap.mailboxOpen(folder, { readOnly: false })
              const fetched = await ctx.imap.fetchOne(uid, { uid: true, source: true, envelope: true }, { uid: true })
              if (fetched === false || fetched === undefined) throw new MailError('message_not_found', `邮件不存在（uid=${uid}）`, 404)
              const parsed = await parse(fetched['source'] as Buffer | string)
              const base = buildReply(parsed, { ...(typeof params['text'] === 'string' ? { text: params['text'] } : {}), ...(typeof params['html'] === 'string' ? { html: params['html'] } : {}) })
              return await sendMessage(
                ctx,
                {
                  to: base.to,
                  subject: base.subject,
                  text: base.text,
                  ...(base.html !== undefined ? { html: base.html } : {}),
                  botId,
                },
                {
                  ...(base.inReplyTo !== undefined ? { inReplyTo: base.inReplyTo } : {}),
                  ...(base.references !== undefined ? { references: base.references } : {}),
                },
              )
            })
          }
          case 'mark': {
            const uid = Number(params['uid'])
            if (!Number.isInteger(uid) || uid <= 0) throw new MailError('bad_request', 'mark 需要合法 uid', 400)
            const flags = Array.isArray(params['flags']) ? (params['flags'] as unknown[]).map((x) => String(x)) : params['seen'] === true ? ['\\Seen'] : params['seen'] === false ? ['\\Seen'] : []
            if (flags.length === 0) throw new MailError('bad_request', 'mark 需要 flags 或 seen', 400)
            return await withImap(async (ctx) => {
              await ctx.imap.mailboxOpen(typeof params['folder'] === 'string' ? params['folder'] : 'INBOX', { readOnly: false })
              if (params['seen'] === false) await ctx.imap.messageFlagsRemove(uid, flags, { uid: true })
              else await ctx.imap.messageFlagsAdd(uid, flags, { uid: true })
              return { ok: true, command: 'mark', uid, flags, action: params['seen'] === false ? 'remove' : 'add' }
            })
          }
          case 'move': {
            const uid = Number(params['uid'])
            const target = String(params['target'] ?? '').trim()
            if (!Number.isInteger(uid) || uid <= 0) throw new MailError('bad_request', 'move 需要合法 uid', 400)
            if (target === '') throw new MailError('bad_request', 'move 需要 target 文件夹', 400)
            return await withImap(async (ctx) => {
              await ctx.imap.mailboxOpen(typeof params['folder'] === 'string' ? params['folder'] : 'INBOX', { readOnly: false })
              await ctx.imap.messageMove(uid, target, { uid: true })
              return { ok: true, command: 'move', uid, target }
            })
          }
          case 'archive': {
            const uid = Number(params['uid'])
            if (!Number.isInteger(uid) || uid <= 0) throw new MailError('bad_request', 'archive 需要合法 uid', 400)
            return await withImap(async (ctx) => {
              const folder = typeof params['folder'] === 'string' ? params['folder'] : 'INBOX'
              await ctx.imap.mailboxOpen(folder, { readOnly: false })
              const archive = await resolveSpecialFolder(ctx.imap, '\\Archive')
              await ctx.imap.messageMove(uid, archive, { uid: true })
              return { ok: true, command: 'archive', uid, target: archive }
            })
          }
          case 'delete': {
            const uid = Number(params['uid'])
            if (!Number.isInteger(uid) || uid <= 0) throw new MailError('bad_request', 'delete 需要合法 uid', 400)
            return await withImap(async (ctx) => {
              const folder = typeof params['folder'] === 'string' ? params['folder'] : 'INBOX'
              await ctx.imap.mailboxOpen(folder, { readOnly: false })
              try {
                const trash = await resolveSpecialFolder(ctx.imap, '\\Trash')
                await ctx.imap.messageMove(uid, trash, { uid: true })
                return { ok: true, command: 'delete', uid, mode: 'moved-to-trash', trash }
              } catch (error) {
                if (error instanceof MailError && error.code === 'folder_missing') {
                  if (params['force'] !== true) throw new MailError('force_required', '没有 Trash 文件夹：删除将不可恢复，需要显式传 force:true', 400)
                  await ctx.imap.messageDelete(uid, { uid: true })
                  return { ok: true, command: 'delete', uid, mode: 'expunged' }
                }
                throw error
              }
            })
          }
          default: throw new MailError('command_not_allowed', `未知 mail 命令：${command}`, 400)
        }
      })()
      const safe: Record<string, unknown> = { ...result }
      // 审计：只记结构化摘要，绝不记正文/收件人地址/密码。
      const count = Array.isArray(result['messages']) ? (result['messages'] as unknown[]).length : undefined
      audit(botId, command, {
        command,
        ...(count !== undefined ? { count } : {}),
        ...(typeof params['folder'] === 'string' ? { folder: params['folder'] } : {}),
        ...(Number.isInteger(Number(params['uid'])) ? { uid: Number(params['uid']) } : {}),
        ...(command === 'send' || command === 'reply' ? { recipients: Array.isArray(params['to']) ? (params['to'] as unknown[]).length : String(params['to'] ?? '').split(',').filter((x) => x.trim() !== '').length } : {}),
        ok: true,
      })
      return safe
    } catch (error) {
      const message = error instanceof MailError ? error.message : maskMailSecrets(error instanceof Error ? error.message : String(error), [account.password, account.imapPassword, account.smtpPassword])
      audit(botId, command, { command, ok: false, errorCode: error instanceof MailError ? error.code : 'mail_failed', ...(Number.isInteger(Number(params['uid'])) ? { uid: Number(params['uid']) } : {}) })
      if (error instanceof MailError) throw error
      throw new MailError('mail_failed', message, 502)
    }
  }

  return { status, test, run, dataRoot }
}
