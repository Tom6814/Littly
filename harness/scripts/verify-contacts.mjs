#!/usr/bin/env node
/**
 * 联系人身份关联修复验证（跨平台同一用户 = 同一联系人；联系人按 bot 隔离）。
 * 运行：node scripts/verify-contacts.mjs
 *
 * 用真 SQLite 临时库 + 假 hub 依赖，不联网。覆盖：
 *  - web 首聊（hub.enqueueBufferedMessage 兜底）→ user_id/name/is_owner 正确，name 不再是 UUID/邮箱
 *  - 同一用户先 web 后 QQ（identity 绑定）→ 只有一行联系人，sender 稳定
 *  - 渠道未绑定 → 新建（user_id 空）→ 绑定后 promote 补 user_id/name/is_owner
 *  - 旧数据 web 场景（sender=用户id、external_id=''）promote 能补上（旧实现永远补不上）
 *  - repairContacts：goldwhale 类空 user_id 行修复；幂等第二次 0 变更；is_owner 不被清除
 *  - 不同 bot 下同用户各自一行；未知 sender / 空 users 表 / bots.owner_id 为空不误伤
 *  - looksLikeRawId 判定
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LittlyStorage } from '../packages/littly/storage/src/index.ts'
import { LittlyHub } from '../packages/littly/agents/src/index.ts'
import { resolveContact, promoteContact, repairContacts, looksLikeRawId } from '../packages/littly/agents/src/contacts.ts'

let pass = 0
let fail = 0
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? `（${detail}）` : ''}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? `（${detail}）` : ''}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'littly-contacts-'))
let dbSeq = 0
function freshStorage() {
  dbSeq++
  const storage = new LittlyStorage({ logger: { info: () => {} } }, { file: join(dir, `c-${dbSeq}.db`) })
  storage.setSetting('platform.secret', 'contacts-test-secret')
  return storage
}
const now = new Date().toISOString()
function seedBase(storage, opts = {}) {
  const owner = 'u-owner'
  const guest = 'u-guest'
  storage.prepare("INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?,?,?,?,?)").run(owner, 'tori', 'x', 'admin', now)
  storage.prepare("INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?,?,?,?,?)").run(guest, 'guest-nick', 'x', 'user', now)
  storage.prepare("INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?,?,?,?,?)").run('u-gold', 'goldwhale', 'x', 'user', now)
  storage.prepare("INSERT INTO bots (id, name, owner_id, created_at) VALUES (?,?,?,?)").run('bot-a', '小璃', opts.ownerA === undefined ? owner : opts.ownerA, now)
  storage.prepare("INSERT INTO bots (id, name, owner_id, created_at) VALUES (?,?,?,?)").run('bot-b', '另一个角色', owner, now)
  return { owner, guest }
}
const contactRows = (storage, botId) => storage.prepare('SELECT * FROM contacts WHERE bot_id = ? ORDER BY created_at').all(botId)
const hubStub = (storage) => new LittlyHub(storage, {} , {}, process.cwd(), () => {})

console.log('== 纯函数 looksLikeRawId ==')
{
  ok(looksLikeRawId('3f9c2b1a-5d4e-4f6a-8b7c-1d2e3f4a5b6c'), 'UUID 视为裸 id')
  ok(looksLikeRawId('tori@example.com'), '邮箱视为裸 id')
  ok(looksLikeRawId('10001'), '纯数字 uin 视为裸 id')
  ok(looksLikeRawId('u-owner', 'u-owner'), '等于 sender 视为裸 id')
  ok(looksLikeRawId('abcdef1234567890abcdef'), '长 hex openid 视为裸 id')
  ok(looksLikeRawId('tori') === false, '正常昵称不算裸 id')
  ok(looksLikeRawId('小璃') === false, '中文昵称不算裸 id')
}

console.log('== web 首聊：hub.enqueueBufferedMessage 兜底 ==')
{
  const storage = freshStorage()
  const { owner } = seedBase(storage)
  const hub = hubStub(storage)
  const first = hub.enqueueBufferedMessage({ botId: 'bot-a', sender: owner, text: '你好', channelId: 'web' })
  ok(typeof first.messageId === 'string', 'enqueue 返回 messageId')
  const rows = contactRows(storage, 'bot-a')
  ok(rows.length === 1, 'web 首聊只建一行联系人')
  ok(rows[0].sender === owner, 'sender = 用户 id（稳定）')
  ok(rows[0].user_id === owner, 'user_id = 用户 id')
  ok(rows[0].name === 'tori', 'name = users.username（不是 UUID/邮箱）')
  ok(rows[0].is_owner === 1, 'is_owner = 1（bots.owner_id 匹配）')
  ok(rows[0].name !== owner, 'name 不等于 sender')
  hub.enqueueBufferedMessage({ botId: 'bot-a', sender: owner, text: '再聊一句', channelId: 'web' })
  ok(contactRows(storage, 'bot-a').length === 1, '第二次 web 消息不新增联系人')
  // guest
  resolveContact(storage, 'bot-a', 'u-guest', { channel: 'web' })
  const guestRow = storage.prepare("SELECT * FROM contacts WHERE bot_id = 'bot-a' AND sender = 'u-guest'").get()
  ok(guestRow.user_id === 'u-guest' && guestRow.name === 'guest-nick' && guestRow.is_owner === 0, 'guest web 联系人 user_id/name/is_owner 正确')
  // runTurn 路径也保证联系人存在（不真正调模型：直接调 resolveContact 模拟其前置逻辑）
  storage.prepare('DELETE FROM contacts').run()
  resolveContact(storage, 'bot-a', owner, { channel: 'web' })
  ok(contactRows(storage, 'bot-a').length === 1 && contactRows(storage, 'bot-a')[0].user_id === owner, 'runTurn 前置 resolveContact 也建联系人并关联')
  storage.close()
}

console.log('== 渠道未绑定 → 绑定后 promote 修复 ==')
{
  const storage = freshStorage()
  const { owner } = seedBase(storage)
  // 未绑定：QQ 私聊
  const created = resolveContact(storage, 'bot-a', 'qqp_12345', { channel: 'qqp', externalId: '12345', name: 'QQ小号' })
  ok(created.created === true && created.userId === null, '未绑定渠道 → 新建联系人（user_id 空）')
  const row0 = storage.prepare("SELECT * FROM contacts WHERE bot_id = 'bot-a' AND sender = 'qqp_12345'").get()
  ok(row0.name === 'QQ小号' && row0.channel === 'qqp' && row0.external_id === '12345', '渠道联系人 name/channel/external_id 正确（不是裸 uin）')
  // 绑定后 promote
  storage.prepare('INSERT INTO channel_identities (id, user_id, channel, external_id, created_at) VALUES (?,?,?,?,?)').run('id1', owner, 'qqp', '12345', now)
  promoteContact(storage, 'bot-a', 'qqp', '12345')
  const row1 = storage.prepare("SELECT * FROM contacts WHERE bot_id = 'bot-a' AND sender = 'qqp_12345'").get()
  ok(row1.user_id === owner, 'promote 后 user_id 补上')
  ok(row1.is_owner === 1, 'promote 后 is_owner=1')
  ok(contactRows(storage, 'bot-a').length === 1, 'promote 不新增行')
  // 再次进来按 identity 归一化：sender 变成用户 id，与 web 共用一行
  const existing = storage.prepare("SELECT * FROM contacts WHERE bot_id = 'bot-a' AND sender = 'qqp_12345'").get()
  ok(existing.user_id === owner, 'identity 反查得到 user_id')
  storage.close()
}

console.log('== 同一用户先 web 后 QQ → 只有一行 ==')
{
  const storage = freshStorage()
  const { owner } = seedBase(storage)
  resolveContact(storage, 'bot-a', owner, { channel: 'web' })
  storage.prepare('INSERT INTO channel_identities (id, user_id, channel, external_id, created_at) VALUES (?,?,?,?,?)').run('id2', owner, 'qqp', '555', now)
  promoteContact(storage, 'bot-a', 'qqp', '555')
  const again = resolveContact(storage, 'bot-a', owner, { channel: 'qqp', externalId: '555', name: 'QQ昵称' })
  ok(again.created === false, 'web 已有 → QQ 不新建')
  const rows = contactRows(storage, 'bot-a')
  ok(rows.length === 1, '同一 bot 同一用户只有一行联系人（跨平台）')
  ok(rows[0].sender === owner && rows[0].user_id === owner, 'sender/user_id 稳定为用户 id')
  ok(rows[0].name === 'tori', 'name 保持 username（不被渠道昵称覆盖）')
  ok(rows[0].is_owner === 1, 'is_owner 保持 1')
  // 记忆 sender 稳定：用同一 sender 写两条 memory 语义（这里直接断言 sender 未变）
  const senderAfter = storage.prepare("SELECT sender FROM contacts WHERE bot_id = 'bot-a'").get().sender
  ok(senderAfter === owner, '记忆 sender 不变（跨平台共用历史）')
  storage.close()
}

console.log('== 旧 web 场景：sender=用户id、external_id 为空也能 promote ==')
{
  const storage = freshStorage()
  const { owner } = seedBase(storage)
  // 旧代码遗留：联系人 user_id 为空（sender 是用户 id）
  storage.prepare("INSERT INTO contacts (id, bot_id, sender, name, external_id, channel, user_id, is_owner, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run('legacy1', 'bot-a', owner, owner, '', '', null, 0, now, now)
  storage.prepare('INSERT INTO channel_identities (id, user_id, channel, external_id, created_at) VALUES (?,?,?,?,?)').run('id3', owner, 'qqp', '777', now)
  promoteContact(storage, 'bot-a', 'qqp', '777')
  const row = storage.prepare("SELECT * FROM contacts WHERE id = 'legacy1'").get()
  ok(row.user_id === owner, '旧 web 行（external_id 空）被 promote 补上 user_id')
  ok(row.name === 'tori', '旧 web 行 name 从裸 id 修成 username')
  ok(row.is_owner === 1, '旧 web 行 is_owner 补成 1')
  ok(contactRows(storage, 'bot-a').length === 1, 'promote 未复制出新行')
  storage.close()
}

console.log('== 不同 bot 隔离 ==')
{
  const storage = freshStorage()
  const { owner } = seedBase(storage)
  resolveContact(storage, 'bot-a', owner, { channel: 'web' })
  resolveContact(storage, 'bot-b', owner, { channel: 'web' })
  ok(contactRows(storage, 'bot-a').length === 1, 'bot-a 下 1 行')
  ok(contactRows(storage, 'bot-b').length === 1, 'bot-b 下 1 行')
  ok(contactRows(storage, 'bot-a')[0].id !== contactRows(storage, 'bot-b')[0].id, '不同 bot 是不同联系人行（按角色隔离）')
  storage.close()
}

console.log('== repairContacts：存量修复 / 幂等 / 不清 is_owner ==')
{
  const storage = freshStorage()
  const { owner } = seedBase(storage)
  // goldwhale 类旧行：name 是邮箱、user_id 空
  storage.prepare("INSERT INTO contacts (id, bot_id, sender, name, external_id, channel, user_id, is_owner, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run('old-gold', 'bot-a', 'u-gold', 'goldwhale@example.com', '', 'web', null, 0, now, now)
  // 渠道旧行：sender=qqp_777，user_id 空，但 identity 已存在
  storage.prepare("INSERT INTO contacts (id, bot_id, sender, name, external_id, channel, user_id, is_owner, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run('old-qq', 'bot-a', 'qqp_777', '777', '777', 'qqp', null, 0, now, now)
  storage.prepare('INSERT INTO channel_identities (id, user_id, channel, external_id, created_at) VALUES (?,?,?,?,?)').run('id4', owner, 'qqp', '777', now)
  const messagesBefore = storage.prepare('SELECT COUNT(*) AS c FROM messages').get().c
  const first = repairContacts(storage)
  ok(first.scanned === 2, 'repairContacts scanned=2')
  ok(first.repaired === 2, 'repairContacts repaired=2')
  const gold = storage.prepare("SELECT * FROM contacts WHERE id = 'old-gold'").get()
  ok(gold.user_id === 'u-gold', 'goldwhale 类行 user_id 补上')
  ok(gold.name === 'goldwhale', 'goldwhale 类行 name 从邮箱修成 username')
  const qq = storage.prepare("SELECT * FROM contacts WHERE id = 'old-qq'").get()
  ok(qq.user_id === owner && qq.is_owner === 1, '渠道旧行经 identity 反查补 user_id/is_owner（主人）')
  const second = repairContacts(storage)
  ok(second.repaired === 0, '第二次 repairContacts 0 变更（幂等）')
  ok(storage.prepare('SELECT COUNT(*) AS c FROM contacts').get().c === 2, 'repair 不删行')
  ok(storage.prepare('SELECT COUNT(*) AS c FROM messages').get().c === messagesBefore, 'repair 不改消息')
  // is_owner 已 1 的行不被清除
  storage.prepare("INSERT INTO contacts (id, bot_id, sender, name, external_id, channel, user_id, is_owner, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run('owned', 'bot-a', 'unknown-x', '老熟人', '', 'web', null, 1, now, now)
  repairContacts(storage)
  ok(storage.prepare("SELECT is_owner FROM contacts WHERE id = 'owned'").get().is_owner === 1, 'is_owner=1 不被 repair 清除')
  storage.close()
}

console.log('== 不误伤（未知 sender / 空 users / owner_id 空）==')
{
  const storage = freshStorage()
  seedBase(storage)
  const r = resolveContact(storage, 'bot-a', 'totally-unknown', { channel: 'web' })
  ok(r.userId === null && r.isOwner === false, '未知 sender → user_id 空、is_owner=0')
  ok(r.name === '', '未知 sender 且无昵称 → name 留空（不落 sender）')
  const unknown = storage.prepare("SELECT * FROM contacts WHERE sender = 'totally-unknown'").get()
  ok(unknown.name !== 'totally-unknown', 'name 不等于 sender')
  storage.close()

  // 空 users 表 + bots.owner_id 为空
  const storage2 = freshStorage()
  storage2.prepare("INSERT INTO bots (id, name, owner_id, created_at) VALUES ('bot-x','无主角色','',?)").run(now)
  const res = resolveContact(storage2, 'bot-x', 'someone', { channel: 'web', name: '路人' })
  ok(res.userId === null && res.isOwner === false && res.name === '路人', '空 users 表 + 无 owner → 正常建行不误伤')
  const repaired = repairContacts(storage2)
  ok(repaired.scanned === 1 && repaired.repaired === 0, '空 users 表 repair 0 变更')
  const repaired2 = repairContacts(storage2)
  ok(repaired2.repaired === 0, '空 users 表第二次 repair 仍 0')
  // 有 bots.owner_id 但用户不存在 → 不置 owner
  storage2.prepare("INSERT INTO bots (id, name, owner_id, created_at) VALUES ('bot-y','有主角色','missing-user',?)").run(now)
  const res2 = resolveContact(storage2, 'bot-y', 'u-gold', { channel: 'web' })
  ok(res2.userId === null && res2.isOwner === false, 'owner_id 指向不存在用户 → 不误置 owner')
  storage2.close()
}

rmSync(dir, { recursive: true, force: true })
console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
