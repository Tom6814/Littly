#!/usr/bin/env node
/**
 * 邮箱功能行为验证（@littly/mail）。
 * 运行：node scripts/verify-mail.mjs
 *
 * 注入 fake IMAP / SMTP / mailparser，不联网、不需要真实邮箱。覆盖：
 *  - 配置解析 / status 掩码（密码永不回传）/ test 成功与失败（可读错误）
 *  - folders / list / search / read 解析、20 封上限、未读过滤、正文截断
 *  - 附件落盘（mail/<botId>/<uid>/）+ 路径穿越拒绝 + 大小上限
 *  - send / reply 构建（From 固定、References/In-Reply-To 正确、附件只允许邮箱目录内）
 *  - 写开关 + dry-run（默认预演）、mark / move / archive / delete（Trash 优先，无 Trash 需 force）
 *  - 限频（读 60/h 写 10/h 语义，用注入小阈值验证）、审计脱敏
 *  - console-api 六端点（status/account/test/cmd/settings/remove）与密码掩码写语义
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LittlyStorage } from '../packages/littly/storage/src/index.ts'
import {
  createMailService, MailError, maskMailSecrets, safeAttachmentName, truncateText, resolveAccount, MAIL_KEYS,
} from '../packages/littly/mail/src/service.ts'
import { registerMailRoutes } from '../packages/littly/console-api/src/routes-mail.ts'

let pass = 0
let fail = 0
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? `（${detail}）` : ''}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? `（${detail}）` : ''}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'littly-mail-'))
const storage = new LittlyStorage({ logger: { info: () => {} } }, { file: join(dir, 'mail.db') })
storage.setSetting('platform.secret', 'mail-test-secret')

// ---------- fixtures ----------
const parsedFixture = (o) => ({
  subject: o.subject,
  from: { value: [{ address: o.from ?? 'alice@example.com', name: o.fromName ?? 'Alice' }], text: `${o.fromName ?? 'Alice'} <${o.from ?? 'alice@example.com'}>` },
  to: { value: [{ address: o.to ?? 'me@example.com' }], text: o.to ?? 'me@example.com' },
  cc: { value: [], text: '' },
  date: new Date(o.date ?? '2026-10-30T08:00:00.000Z'),
  text: o.text ?? '正文内容',
  html: o.html ?? false,
  messageId: o.messageId ?? `<${o.uid}@example.com>`,
  references: o.references ?? [`<prev-${o.uid}@example.com>`],
  attachments: (o.attachments ?? []).map((a) => ({ filename: a.filename, contentType: 'text/plain', size: Buffer.byteLength(a.content), content: Buffer.from(a.content) })),
})
const fakeParse = async (source) => parsedFixture(JSON.parse(String(source)))

const makeMsg = (uid, extra = {}) => {
  const o = { uid, subject: extra.subject ?? `邮件 ${uid}`, from: extra.from ?? 'alice@example.com', messageId: `<${uid}@example.com>`, date: extra.date ?? new Date(2026, 9, 30, 8, uid % 60).toISOString(), text: extra.text ?? `第 ${uid} 封正文`, references: [`<prev-${uid}@example.com>`], ...extra }
  return {
    uid,
    folder: 'INBOX',
    flags: new Set(extra.unread === true ? [] : ['\\Seen']),
    internalDate: new Date(o.date),
    size: 1000 + uid,
    envelope: { subject: o.subject, from: { text: `${o.from}` }, to: { text: 'me@example.com' }, messageId: o.messageId },
    source: JSON.stringify(o),
    parsed: o,
  }
}

const state = {
  mailboxes: [
    { path: 'INBOX', name: 'INBOX', delimiter: '/', specialUse: '\\Inbox' },
    { path: 'Sent', name: 'Sent', delimiter: '/', specialUse: '\\Sent' },
    { path: 'Archive', name: 'Archive', delimiter: '/', specialUse: '\\Archive' },
    { path: 'Trash', name: 'Trash', delimiter: '/', specialUse: '\\Trash' },
    { path: 'Junk', name: 'Junk', delimiter: '/', specialUse: '\\Junk' },
  ],
  messages: Array.from({ length: 25 }, (_, i) => makeMsg(i + 1, { unread: (i + 1) % 3 === 0 })),
  sent: [],
  verifyOk: true,
  connectFail: false,
  smtpFail: false,
  hideTrash: false,
  moves: [],
  deleted: [],
}

class FakeImap {
  constructor(s) { this.state = s; this.folder = 'INBOX' }
  async connect() {
    if (this.state.connectFail) throw new Error('Invalid credentials: AUTH failed (password=hunter2)')
    return {}
  }
  async logout() {}
  async mailboxOpen(path) {
    if (!this.state.mailboxes.some((b) => b.path === path)) throw new Error(`Mailbox not found: ${path}`)
    this.folder = path
    return { exists: this.state.messages.filter((m) => m.folder === path).length }
  }
  async mailboxList() {
    return this.state.hideTrash ? this.state.mailboxes.filter((b) => b.path !== 'Trash') : this.state.mailboxes
  }
  async *fetch() {
    for (const m of this.state.messages.filter((x) => x.folder === this.folder)) {
      yield { uid: m.uid, flags: m.flags, internalDate: m.internalDate, size: m.size, envelope: m.envelope, source: m.source }
    }
  }
  async fetchOne(uid) {
    const m = this.state.messages.find((x) => x.uid === Number(uid) && x.folder === this.folder)
    if (m === undefined) return false
    return { uid: m.uid, flags: m.flags, internalDate: m.internalDate, size: m.size, envelope: m.envelope, source: m.source }
  }
  async search(query) {
    const q = String(query.text ?? '').toLowerCase()
    return this.state.messages.filter((m) => m.folder === this.folder && (m.parsed.subject.toLowerCase().includes(q) || m.parsed.text.toLowerCase().includes(q))).map((m) => m.uid)
  }
  async messageFlagsAdd(uid, flags) {
    const m = this.state.messages.find((x) => x.uid === Number(uid))
    for (const f of flags) m?.flags.add(f)
    return true
  }
  async messageFlagsRemove(uid, flags) {
    const m = this.state.messages.find((x) => x.uid === Number(uid))
    for (const f of flags) m?.flags.delete(f)
    return true
  }
  async messageMove(uid, target) {
    const m = this.state.messages.find((x) => x.uid === Number(uid))
    this.state.moves.push({ uid: Number(uid), target })
    if (m !== undefined) m.folder = target
    return { uid, target }
  }
  async messageDelete(uid) {
    this.state.deleted.push(Number(uid))
    this.state.messages = this.state.messages.filter((x) => x.uid !== Number(uid))
    return true
  }
  async expunge() { return true }
}

class FakeSmtp {
  constructor(s) { this.state = s }
  async verify() { return this.state.verifyOk }
  async sendMail(message) {
    if (this.state.smtpFail) throw new Error('SMTP auth failed (password=hunter2)')
    this.state.sent.push(message)
    return { messageId: `<sent-${this.state.sent.length}@test>`, accepted: [message.to], rejected: [] }
  }
  close() {}
}

const mailDataDir = join(dir, 'mail')
const makeService = (overrides = {}) => createMailService(storage, {
  dataDir: mailDataDir,
  imapFactory: () => new FakeImap(state),
  smtpFactory: () => new FakeSmtp(state),
  parseMail: fakeParse,
  maxBodyBytes: 200,
  maxAttachmentBytes: 2048,
  maxMessages: 20,
  readPerHour: 50,
  writePerHour: 50,
  ...overrides,
})

function seedAccount() {
  const set = (k, v) => storage.setSetting(k, v)
  set(MAIL_KEYS.address, 'me@example.com')
  set(MAIL_KEYS.imapHost, 'imap.example.com')
  set(MAIL_KEYS.imapPort, '993')
  set(MAIL_KEYS.imapSecure, '1')
  set(MAIL_KEYS.smtpHost, 'smtp.example.com')
  set(MAIL_KEYS.smtpPort, '465')
  set(MAIL_KEYS.smtpSecure, '1')
  set(MAIL_KEYS.username, 'me@example.com')
  set(MAIL_KEYS.password, 'hunter2-secret')
}
const service = makeService()

console.log('== 配置 / status ==')
{
  const st0 = service.status()
  ok(st0.configured === false && st0.address === '', '未配置时 status.configured=false')
  ok(resolveAccount(storage).error === '未绑定邮箱地址', '未配置时 resolveAccount 返回可读错误')
  seedAccount()
  const st = service.status()
  ok(st.configured === true && st.address === 'me@example.com', '绑定后 configured/address')
  ok(st.imap.host === 'imap.example.com' && st.imap.port === 993 && st.imap.secure === true, 'status.imap host/port/secure')
  ok(st.smtp.host === 'smtp.example.com' && st.smtp.port === 465, 'status.smtp host/port')
  ok(st.imap.hasPassword === true && st.smtp.hasPassword === true, 'status.hasPassword=true（布尔而非明文）')
  ok(JSON.stringify(st).includes('hunter2-secret') === false, 'status 不含密码明文')
  ok(st.allowWrite === false, 'allowWrite 默认 false')
  ok(resolveAccount(storage).account?.password === 'hunter2-secret', 'resolveAccount 内部能拿到密码（仅服务端）')
  // 独立密码覆盖
  storage.setSetting(MAIL_KEYS.imapPassword, 'imap-pass')
  storage.setSetting(MAIL_KEYS.smtpPassword, 'smtp-pass')
  const acc = resolveAccount(storage).account
  ok(acc?.imapPassword === 'imap-pass' && acc?.smtpPassword === 'smtp-pass', 'IMAP/SMTP 独立密码覆盖共用密码')
  storage.setSetting(MAIL_KEYS.imapPassword, '')
  storage.setSetting(MAIL_KEYS.smtpPassword, '')
}

console.log('== test ==')
{
  state.connectFail = false; state.verifyOk = true
  const t = await service.test()
  ok(t.ok === true && t.imap === true && t.smtp === true, 'test 成功（IMAP+SMTP）')
  ok(service.status().verifiedAt !== '', 'test 成功写 verifiedAt')
  state.connectFail = true
  const tf = await service.test()
  ok(tf.ok === false && tf.imap === false && tf.error?.includes('IMAP'), 'IMAP 失败 → imap=false + 可读错误')
  ok(tf.error?.includes('hunter2') !== true, 'IMAP 错误里遮罩密码')
  state.connectFail = false; state.verifyOk = false
  const ts = await service.test()
  ok(ts.ok === false && ts.smtp === false && ts.error?.includes('SMTP'), 'SMTP 失败 → smtp=false + 可读错误')
  ok(ts.error?.includes('hunter2') !== true, 'SMTP 错误里遮罩密码')
  state.verifyOk = true
  ok(service.status().lastError !== '', 'test 失败写 lastError')
}

console.log('== 读：folders / list / search / read ==')
{
  const folders = await service.run('folders', {}, { botId: 'b-mail' })
  ok(folders.ok === true && Array.isArray(folders.folders) && folders.folders.length === 5, 'folders 返回 5 个文件夹')
  ok(folders.folders.some((f) => f.specialUse === '\\Trash'), 'folders 含 specialUse')
  const list = await service.run('list', { limit: 10 }, { botId: 'b-mail' })
  ok(list.ok === true && list.messages.length === 10, 'list 默认返回 10 封')
  ok(list.messages[0].uid === 25, 'list 按 uid 倒序（最新在前）')
  ok(list.messages[0].subject.includes('邮件'), 'list 含 subject/from/date/unread')
  ok(['subject', 'from', 'unread', 'date'].every((k) => k in list.messages[0]), 'list 字段齐全')
  const unread = await service.run('list', { unreadOnly: true, limit: 20 }, { botId: 'b-mail' })
  ok(unread.messages.every((m) => m.unread === true), 'list unreadOnly 过滤')
  const many = await service.run('list', { limit: 100 }, { botId: 'b-mail' })
  ok(many.messages.length === 20 && many.total === 25 && many.truncated === true, 'list 单次最多 20 封（total=25/truncated）')
  const search = await service.run('search', { query: '第 7 封' }, { botId: 'b-mail' })
  ok(search.ok === true && search.messages.length === 1 && search.messages[0].uid === 7, 'search 命中指定邮件')
  let emptyQuery = null
  try { await service.run('search', {}, { botId: 'b-mail' }) } catch (e) { emptyQuery = e }
  ok(emptyQuery instanceof MailError && emptyQuery.code === 'bad_request', 'search 缺 query → bad_request')
  const read = await service.run('read', { uid: 25 }, { botId: 'b-mail' })
  ok(read.ok === true && read.message.subject === '邮件 25' && read.message.from.includes('alice'), 'read 解析 subject/from')
  ok(read.message.text === '第 25 封正文', 'read 返回正文')
  const notFound = await (async () => { try { await service.run('read', { uid: 9999 }, { botId: 'b-mail' }) } catch (e) { return e } })()
  ok(notFound instanceof MailError && notFound.code === 'message_not_found' && notFound.status === 404, 'read 不存在 uid → message_not_found 404')
  // 正文截断：临时插入超长正文邮件
  state.messages.push(makeMsg(900, { subject: '长正文', text: 'x'.repeat(500) }))
  const longRead = await service.run('read', { uid: 900 }, { botId: 'b-mail' })
  ok(longRead.message.textTruncated === true && Buffer.byteLength(longRead.message.text) <= 200, 'read 正文截断（≤maxBodyBytes，标记 truncated）')
  state.messages = state.messages.filter((m) => m.uid !== 900)
}

console.log('== 附件：落盘 / 穿越拒绝 / 大小上限 ==')
{
  state.messages.push(makeMsg(901, {
    subject: '带附件',
    text: '看附件',
    attachments: [
      { filename: 'good.txt', content: 'good attachment body' },
      { filename: '../evil.txt', content: 'evil' },
    ],
  }))
  const read = await service.run('read', { uid: 901, attachments: true }, { botId: 'b-attach' })
  const saved = read.message.attachments
  const good = saved.find((a) => a.filename === 'good.txt')
  ok(good?.path === join('b-attach', '901', 'good.txt'), '附件落盘 mail/<botId>/<uid>/<filename>')
  ok(existsSync(join(mailDataDir, 'b-attach', '901', 'good.txt')), '附件文件真实存在')
  ok(saved.some((a) => (a.error ?? '').includes('路径') || (a.error ?? '').includes('不合法')), '路径穿越附件名被拒绝')
  ok(existsSync(join(mailDataDir, 'b-attach', 'evil.txt')) === false && existsSync(join(dir, 'evil.txt')) === false, '穿越附件没有写到目录外')
  ok(safeAttachmentName('report (1).pdf') === 'report (1).pdf', 'safeAttachmentName 允许常规文件名')
  for (const bad of ['../x.txt', '/etc/passwd', 'a/b.txt', 'x\u0000y']) {
    let err = null
    try { safeAttachmentName(bad) } catch (e) { err = e }
    ok(err instanceof MailError && err.code === 'bad_attachment', `safeAttachmentName 拒绝 ${JSON.stringify(bad)}`)
  }
  // 大小上限（maxAttachmentBytes 2048）
  state.messages.push(makeMsg(902, { subject: '大附件', attachments: [{ filename: 'big.bin', content: 'x'.repeat(5000) }] }))
  const big = await service.run('read', { uid: 902, attachments: true }, { botId: 'b-attach' })
  ok(big.message.attachments[0]?.error?.includes('上限'), '超大附件被拒绝（附 error）')
  state.messages = state.messages.filter((m) => ![901, 902].includes(m.uid))
}

console.log('== 写开关 / dry-run / send 构建 ==')
{
  storage.setSetting(MAIL_KEYS.allowWrite, '0')
  state.sent.length = 0
  const preview = await service.run('send', { to: 'a@b.com', subject: 'Hi', text: 'hello' }, { botId: 'b-mail' })
  ok(preview.ok === true && preview.dryRun === true, '写开关关：send 默认 dry-run')
  ok(preview.note.includes('预演'), 'dry-run 带可读 note')
  ok(state.sent.length === 0, 'dry-run 不真的发信')
  storage.setSetting(MAIL_KEYS.allowWrite, '1')
  const preview2 = await service.run('send', { to: 'a@b.com', subject: 'Hi', text: 'hello' }, { botId: 'b-mail' })
  ok(preview2.dryRun === true && state.sent.length === 0, '开关打开但未显式 dryRun:false → 仍预演')
  const sent = await service.run('send', { to: 'a@b.com', subject: '你好', text: '正文', from: 'fake@evil.com' }, { botId: 'b-mail', dryRun: false })
  ok(sent.ok === true && state.sent.length === 1, 'dryRun:false → 真的发信')
  const msg = state.sent[0]
  ok(msg.from === 'me@example.com', 'From 固定为绑定地址（忽略 params.from）')
  ok(Array.isArray(msg.to) && msg.to[0] === 'a@b.com' && msg.subject === '你好', 'send to/subject 正确')
  let badTo = null
  try { await service.run('send', { to: '', subject: 'x', text: 'y' }, { botId: 'b-mail', dryRun: false }) } catch (e) { badTo = e }
  ok(badTo instanceof MailError && badTo.code === 'bad_request', 'send 缺 to → bad_request')
  // 附件：目录外拒绝、目录内允许
  let outside = null
  try { await service.run('send', { to: 'a@b.com', subject: 'x', text: 'y', attachments: ['../escape.txt'] }, { botId: 'b-mail', dryRun: false }) } catch (e) { outside = e }
  ok(outside instanceof MailError && outside.code === 'attachment_outside_root', '发件附件目录外 → attachment_outside_root')
  mkdirSync(join(mailDataDir, 'b-mail'), { recursive: true })
  writeFileSync(join(mailDataDir, 'b-mail', 'note.txt'), 'inside attachment')
  const withAttach = await service.run('send', { to: 'a@b.com', subject: '带附件', text: 'y', attachments: ['note.txt'] }, { botId: 'b-mail', dryRun: false })
  ok(withAttach.ok === true && Array.isArray(state.sent.at(-1).attachments) && state.sent.at(-1).attachments[0].filename === 'note.txt', '目录内附件可发送')
}

console.log('== reply 构建（References/In-Reply-To）==')
{
  state.sent.length = 0
  const reply = await service.run('reply', { uid: 5, text: '收到，谢谢' }, { botId: 'b-mail', dryRun: false })
  ok(reply.ok === true && state.sent.length === 1, 'reply 发送成功')
  const msg = state.sent[0]
  ok(msg.subject === 'Re: 邮件 5', 'reply subject 加 Re:')
  ok((Array.isArray(msg.to) ? msg.to[0] : msg.to) === 'alice@example.com', 'reply to 原发件人')
  ok(Array.isArray(msg.references) && msg.references.includes('<5@example.com>'), 'reply References 含原 messageId')
  ok(msg.inReplyTo === '<5@example.com>', 'reply In-Reply-To 正确')
  ok(msg.from === 'me@example.com', 'reply From 固定为绑定地址')
  const twice = await service.run('reply', { uid: 5, text: '再回一封' }, { botId: 'b-mail', dryRun: false })
  ok(twice.ok === true && state.sent[1].subject === 'Re: 邮件 5', '已 Re: 主题不重复加前缀')
}

console.log('== mark / move / archive / delete ==')
{
  const mark = await service.run('mark', { uid: 3, seen: true }, { botId: 'b-mail', dryRun: false })
  ok(mark.ok === true && state.messages.find((m) => m.uid === 3).flags.has('\\Seen'), 'mark seen=true 加 \\Seen')
  ok(mark.action === 'add', 'mark 返回 action=add')
  const unmark = await service.run('mark', { uid: 3, seen: false }, { botId: 'b-mail', dryRun: false })
  ok(unmark.ok === true && unmark.action === 'remove', 'mark seen=false 移除 \\Seen')
  const moved = await service.run('move', { uid: 4, target: 'Archive' }, { botId: 'b-mail', dryRun: false })
  ok(moved.ok === true && moved.target === 'Archive', 'move 到目标文件夹')
  const archived = await service.run('archive', { uid: 6 }, { botId: 'b-mail', dryRun: false })
  ok(archived.ok === true && archived.target === 'Archive', 'archive 自动找 \\Archive')
  const del = await service.run('delete', { uid: 7 }, { botId: 'b-mail', dryRun: false })
  ok(del.ok === true && del.mode === 'moved-to-trash', 'delete 默认移入 Trash')
  state.hideTrash = true
  let forceErr = null
  try { await service.run('delete', { uid: 8 }, { botId: 'b-mail', dryRun: false }) } catch (e) { forceErr = e }
  ok(forceErr instanceof MailError && forceErr.code === 'force_required', '无 Trash 且无 force → force_required')
  const forced = await service.run('delete', { uid: 8, force: true }, { botId: 'b-mail', dryRun: false })
  ok(forced.ok === true && forced.mode === 'expunged' && state.deleted.includes(8), 'force:true 才真正删除')
  state.hideTrash = false
  let unknown = null
  try { await service.run('rm-rf', {}, { botId: 'b-mail' }) } catch (e) { unknown = e }
  ok(unknown instanceof MailError && unknown.code === 'command_not_allowed', '未知命令拒绝')
  let noUid = null
  try { await service.run('move', {}, { botId: 'b-mail', dryRun: false }) } catch (e) { noUid = e }
  ok(noUid instanceof MailError && noUid.code === 'bad_request', 'move 缺 uid → bad_request')
}

console.log('== 限频（注入小阈值）==')
{
  const limited = makeService({ readPerHour: 2, writePerHour: 1 })
  const readBot = 'b-rate-read'
  ok((await limited.run('folders', {}, { botId: readBot })).ok === true, '限频：第 1 次读通过')
  ok((await limited.run('folders', {}, { botId: readBot })).ok === true, '限频：第 2 次读通过')
  let rateRead = null
  try { await limited.run('folders', {}, { botId: readBot }) } catch (e) { rateRead = e }
  ok(rateRead instanceof MailError && rateRead.code === 'rate_limited' && rateRead.status === 429, '读超过阈值 → rate_limited 429', String(rateRead?.code) + '/' + String(rateRead?.status) + '/' + String(rateRead?.message))
  const writeBot = 'b-rate-write'
  ok((await limited.run('mark', { uid: 9, seen: true }, { botId: writeBot, dryRun: false })).ok === true, '限频：第 1 次写通过')
  let rateWrite = null
  try { await limited.run('mark', { uid: 9, seen: false }, { botId: writeBot, dryRun: false }) } catch (e) { rateWrite = e }
  ok(rateWrite instanceof MailError && rateWrite.code === 'rate_limited', '写超过阈值 → rate_limited', String(rateWrite?.code) + '/' + String(rateWrite?.message))
}

console.log('== 审计脱敏 ==')
{
  const rows = storage.prepare("SELECT action, detail FROM audit_logs WHERE category = 'tool_call' AND action LIKE 'mail\\_%' ESCAPE '\\'").all()
  const actions = rows.map((r) => r.action)
  for (const expected of ['mail_folders', 'mail_list', 'mail_read', 'mail_send', 'mail_reply', 'mail_mark', 'mail_move', 'mail_archive', 'mail_delete']) {
    ok(actions.includes(expected), `审计 action ${expected}`)
  }
  const all = JSON.stringify(rows)
  ok(all.includes('hunter2') === false, '审计不含密码')
  ok(all.includes('收到，谢谢') === false && all.includes('正文') === false, '审计不含正文内容')
  const sendRow = rows.map((r) => ({ action: r.action, detail: JSON.parse(r.detail) })).find((r) => r.action === 'mail_send' && typeof r.detail.recipients === 'number')
  ok(typeof sendRow?.detail.recipients === 'number', 'send 审计记收件人数（非地址）')
  ok(all.includes('alice@example.com') === false, '审计不含收件人地址')
}

console.log('== console-api 路由（status/account/test/cmd/settings/remove）==')
{
  class FakeRouter {
    routes = []
    add(method, path, auth, handler) { this.routes.push({ method, path, auth, handler }) }
    get(p, a, h) { this.add('GET', p, a, h) }
    post(p, a, h) { this.add('POST', p, a, h) }
    put(p, a, h) { this.add('PUT', p, a, h) }
    del(p, a, h) { this.add('DELETE', p, a, h) }
  }
  const fakeRes = () => ({ statusCode: 0, headers: {}, body: '', writeHead(c, h) { this.statusCode = c; this.headers = h ?? {} }, end(b) { this.body = String(b ?? '') } })
  const call = async (router, method, path, { body, user = { id: 'admin-1', username: 'admin', role: 'admin' } } = {}) => {
    const route = router.routes.find((rt) => rt.method === method && rt.path === path)
    if (route === undefined) return { status: 404, json: null }
    const res = fakeRes()
    await route.handler({ req: {}, res, url: new URL(`http://x${path}`), method, params: {}, query: new URLSearchParams(), body, fields: {}, files: [], user })
    let parsed = null
    try { parsed = res.body ? JSON.parse(res.body) : null } catch { parsed = null }
    return { status: res.statusCode, json: parsed, route }
  }
  const router = new FakeRouter()
  registerMailRoutes(router, { storage, mail: service })
  const st = await call(router, 'GET', '/api/mail/status')
  ok(st.status === 200 && st.json?.data?.address === 'me@example.com', 'GET /api/mail/status 200')
  ok(JSON.stringify(st.json).includes('hunter2') === false, 'status 路由不返回密码')
  const saved = await call(router, 'PUT', '/api/mail/account', { body: { address: 'new@example.com', imapHost: 'imap2.example.com', smtpHost: 'smtp2.example.com', imapPort: 143, imapSecure: false, password: '' } })
  ok(saved.status === 200 && saved.json?.data?.status?.address === 'new@example.com', 'PUT account 更新非密码字段')
  ok(resolveAccount(storage).account?.password === 'hunter2-secret', 'password 空 = 不修改')
  const masked = await call(router, 'PUT', '/api/mail/account', { body: { password: '***' } })
  ok(masked.status === 200 && resolveAccount(storage).account?.password === 'hunter2-secret', "password '***' = 保持")
  const changed = await call(router, 'PUT', '/api/mail/account', { body: { password: 'new-pass-123' } })
  ok(changed.status === 200 && resolveAccount(storage).account?.password === 'new-pass-123', 'password 新值更新')
  ok(JSON.stringify(changed.json).includes('new-pass-123') === false, 'PUT 响应不回传新密码')
  const badAddress = await call(router, 'PUT', '/api/mail/account', { body: { address: 'not-an-email' } })
  ok(badAddress.status === 400 && badAddress.json?.error?.code === 'bad_address', '非法地址 → 400 bad_address')
  const badPort = await call(router, 'PUT', '/api/mail/account', { body: { imapPort: 70000 } })
  ok(badPort.status === 400 && badPort.json?.error?.code === 'bad_port', '非法端口 → 400 bad_port')
  const testRes = await call(router, 'POST', '/api/mail/test')
  ok(testRes.status === 200 && testRes.json?.data?.ok === true, 'POST /api/mail/test 200')
  const cmdRes = await call(router, 'POST', '/api/mail/cmd', { body: { command: 'folders' } })
  ok(cmdRes.status === 200 && Array.isArray(cmdRes.json?.data?.folders), 'POST /api/mail/cmd 读命令 200')
  const cmdBad = await call(router, 'POST', '/api/mail/cmd', { body: { command: 'rm-rf' } })
  ok(cmdBad.status === 400 && cmdBad.json?.error?.code === 'command_not_allowed', 'cmd 未知命令 → 400 可读错误码')
  const settings = await call(router, 'PUT', '/api/mail/settings', { body: { allowWrite: true } })
  ok(settings.status === 200 && service.status().allowWrite === true, 'PUT settings 打开写开关')
  const removed = await call(router, 'DELETE', '/api/mail/account')
  ok(removed.status === 200 && service.status().configured === false, 'DELETE account 清空凭据')
  ok((storage.getSetting(MAIL_KEYS.password) ?? '') === '', 'DELETE 后密码已清空')
  // 鉴权声明
  ok(router.routes.find((r) => r.method === 'GET' && r.path === '/api/mail/status').auth === 'required', 'GET status 声明 required')
  for (const [method, path] of [['PUT', '/api/mail/account'], ['POST', '/api/mail/test'], ['PUT', '/api/mail/settings'], ['DELETE', '/api/mail/account']]) {
    ok(router.routes.find((r) => r.method === method && r.path === path)?.auth === 'admin', `${method} ${path} 声明 admin`)
  }
  ok(router.routes.find((r) => r.method === 'POST' && r.path === '/api/mail/cmd').auth === 'required', 'POST cmd 声明 required')
}

console.log('== 工具函数 ==')
{
  ok(maskMailSecrets('password=hunter2 ok').includes('password=***'), 'maskMailSecrets 遮罩 password=')
  ok(maskMailSecrets('secret-value', ['secret-value']).includes('***'), 'maskMailSecrets 遮罩已知值')
  ok(truncateText('abcdef', 3).text === 'abc' && truncateText('abcdef', 3).truncated === true, 'truncateText 截断')
  ok(truncateText('abc', 100).truncated === false, 'truncateText 未超限不截断')
}

storage.close()
rmSync(dir, { recursive: true, force: true })
console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
