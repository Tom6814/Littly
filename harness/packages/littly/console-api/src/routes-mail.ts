/**
 * 邮箱控制台端点（与 @littly/mail 配套）。
 *
 * - GET    /api/mail/status    required；密码永不回传（hasPassword 布尔）
 * - PUT    /api/mail/account   admin；password 空/掩码=不改；返回 status
 * - POST   /api/mail/test      admin；IMAP INBOX 只读 + SMTP verify，分别返回结果
 * - POST   /api/mail/cmd       required；控制台预览走同一 service（写命令同开关/dry-run）
 * - PUT    /api/mail/settings  admin；{allowWrite}
 * - DELETE /api/mail/account   admin；清空凭据（二次确认由前端做）
 */
import { json, err, bodyRecord, reqStr, reqBool, reqNum } from './http.ts'
import { isMaskedInput } from './mapping.ts'
import type { RegisterFn } from './deps.ts'
import { MailError, maskMailSecrets } from '@littly/mail'

function unavailable(res: Parameters<typeof err>[0]): void {
  err(res, 501, 'mail_unavailable', '邮箱插件未装配（@littly/mail 未加载）')
}

function failMail(ctx: { res: Parameters<typeof err>[0] }, error: unknown): void {
  if (error instanceof MailError) {
    err(ctx.res, error.status, error.code, error.message)
    return
  }
  // 跨模块实例（src/lib 混用或注入 fake）时按结构识别，避免把可读错误吞成 500。
  const rec = error as { status?: unknown; code?: unknown; message?: unknown }
  if (typeof rec?.status === 'number' && typeof rec?.code === 'string' && typeof rec?.message === 'string') {
    err(ctx.res, rec.status, rec.code, rec.message)
    return
  }
  const message = error instanceof Error ? maskMailSecrets(error.message) : '邮箱操作失败（内部错误）'
  err(ctx.res, 500, 'internal', message)
}

/** 校验 host：非空、无空白/控制字符；允许域名或 IP。 */
function validHost(value: string): boolean {
  return value.trim() !== '' && !/[\s\u0000-\u001f]/u.test(value) && value.length <= 255
}

export const registerMailRoutes: RegisterFn = (r, d) => {
  r.get('/api/mail/status', 'required', (ctx) => {
    const service = d.mail
    if (service === undefined) { unavailable(ctx.res); return }
    json(ctx.res, 200, { data: service.status() })
  })

  r.put('/api/mail/account', 'admin', (ctx) => {
    const service = d.mail
    if (service === undefined) { unavailable(ctx.res); return }
    const body = bodyRecord(ctx.body)
    const address = reqStr(body, 'address')
    if (address !== undefined && address.trim() !== '' && !/^[^@\s]+@[^@\s]+$/u.test(address.trim())) {
      err(ctx.res, 400, 'bad_address', '邮箱地址格式不正确')
      return
    }
    const imapHost = reqStr(body, 'imapHost', 'imap_host')
    const smtpHost = reqStr(body, 'smtpHost', 'smtp_host')
    if (imapHost !== undefined && imapHost.trim() !== '' && !validHost(imapHost)) { err(ctx.res, 400, 'bad_host', 'IMAP 服务器地址不合法'); return }
    if (smtpHost !== undefined && smtpHost.trim() !== '' && !validHost(smtpHost)) { err(ctx.res, 400, 'bad_host', 'SMTP 服务器地址不合法'); return }
    const imapPort = reqNum(body, 'imapPort')
    const smtpPort = reqNum(body, 'smtpPort')
    if (imapPort !== undefined && (!Number.isInteger(imapPort) || imapPort < 1 || imapPort > 65535)) { err(ctx.res, 400, 'bad_port', 'IMAP 端口不合法（1-65535）'); return }
    if (smtpPort !== undefined && (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535)) { err(ctx.res, 400, 'bad_port', 'SMTP 端口不合法（1-65535）'); return }
    const imapSecure = reqBool(body, 'imapSecure')
    const smtpSecure = reqBool(body, 'smtpSecure')
    const username = reqStr(body, 'username')
    const fromName = reqStr(body, 'fromName')
    const password = reqStr(body, 'password')
    const set = (key: string, value: string): void => d.storage.setSetting(key, value)
    if (address !== undefined) set('mail.address', address.trim())
    if (imapHost !== undefined) set('mail.imap_host', imapHost.trim())
    if (smtpHost !== undefined) set('mail.smtp_host', smtpHost.trim())
    if (imapPort !== undefined) set('mail.imap_port', String(imapPort))
    if (smtpPort !== undefined) set('mail.smtp_port', String(smtpPort))
    if (imapSecure !== undefined) set('mail.imap_secure', imapSecure ? '1' : '0')
    if (smtpSecure !== undefined) set('mail.smtp_secure', smtpSecure ? '1' : '0')
    if (username !== undefined) set('mail.username', username.trim())
    if (fromName !== undefined) set('mail.from_name', fromName.trim())
    // 密码：空 = 不修改；'***'/掩码 = 保持；其它 = 更新（永不回传）。
    const passwordIsMask = password !== undefined && (password === '***' || /^\*+$/u.test(password.trim()) || isMaskedInput(password))
    if (password !== undefined && password.trim() !== '' && !passwordIsMask) set('mail.password', password.trim())
    json(ctx.res, 200, { data: { ok: true, status: service.status() } })
  })

  r.post('/api/mail/test', 'admin', async (ctx) => {
    const service = d.mail
    if (service === undefined) { unavailable(ctx.res); return }
    try { json(ctx.res, 200, { data: await service.test() }) } catch (error) { failMail(ctx, error) }
  })

  r.post('/api/mail/cmd', 'required', async (ctx) => {
    const service = d.mail
    if (service === undefined) { unavailable(ctx.res); return }
    const body = bodyRecord(ctx.body)
    const command = reqStr(body, 'command') ?? ''
    const params = body['params'] !== null && typeof body['params'] === 'object' && !Array.isArray(body['params'])
      ? body['params'] as Record<string, unknown>
      : {}
    const dryRun = reqBool(body, 'dryRun')
    try {
      const result = await service.run(command, params, { botId: ctx.user?.id ?? 'console', ...(dryRun !== undefined ? { dryRun } : {}) })
      json(ctx.res, 200, { data: result })
    } catch (error) { failMail(ctx, error) }
  })

  r.put('/api/mail/settings', 'admin', (ctx) => {
    const service = d.mail
    if (service === undefined) { unavailable(ctx.res); return }
    const body = bodyRecord(ctx.body)
    const allowWrite = reqBool(body, 'allowWrite')
    if (allowWrite === undefined) { err(ctx.res, 400, 'bad_request', 'allowWrite 需为布尔值'); return }
    d.storage.setSetting('mail.allow_write', allowWrite ? '1' : '0')
    json(ctx.res, 200, { data: { ok: true, status: service.status() } })
  })

  r.del('/api/mail/account', 'admin', (ctx) => {
    const service = d.mail
    if (service === undefined) { unavailable(ctx.res); return }
    try { d.storage.prepare("DELETE FROM global_settings WHERE key LIKE 'mail.%'").run() } catch { /* ignore */ }
    json(ctx.res, 200, { data: { ok: true, status: service.status() } })
  })
}
