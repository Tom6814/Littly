#!/usr/bin/env node
/**
 * 绑定闭环验证：发码 → 渠道侧消费 → 身份归一 → 状态可见 → 解绑。
 * 运行：node scripts/verify-bind.mjs
 *
 * 覆盖「绑定一次，全渠道同一条会话线」这条承诺的完整链路：
 * 控制台发码（6 位码 / Telegram nonce）→ 渠道侧 tryHandleBinding 命中 →
 * 写 channel_identities + 联系人晋升 → 绑定状态可见 → 解绑后身份消失。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LittlyStorage } from '../packages/littly/storage/src/index.ts'
import { createBindToken, genBindCode, genTgNonce } from '../packages/littly/console-api/src/routes-bind.ts'
import { tryHandleBinding, MSG_SUCCESS_QQ, MSG_EXPIRED, MSG_CONFLICT } from '../packages/littly/channel-snowluma/src/binding.ts'

let pass = 0
let fail = 0
const ok = (cond, name) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.error(`  ✗ ${name}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'littly-bind-'))
const storage = new LittlyStorage({ logger: { info: () => {} } }, { file: join(dir, 'b.db') })
const now = new Date().toISOString()
storage.prepare("INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u1','tori','x','admin',?)").run(now)
storage.prepare("INSERT INTO bots (id, name, created_at) VALUES ('b1','小璃',?)").run(now)

console.log('== 码的形态 ==')
const code = genBindCode()
ok(/^[A-Z0-9]{6}$/.test(code), `6 位码格式合法（${code}）`)
ok(!/[IO01]/.test(code), '字母表剔除易混淆的 I/O/0/1')
ok(genTgNonce().length >= 20, 'Telegram nonce 是长随机串')

console.log('== 发码 ==')
const issued = createBindToken(storage, 'u1', 'qqp_code', 'b1')
ok(/^[A-Z0-9]{6}$/.test(issued.token), '发出的就是 6 位码')
ok(new Date(issued.expiresAt).getTime() - Date.now() > 9 * 60 * 1000, '有效期约 10 分钟')
const row = storage.prepare('SELECT kind, bot_id, used_at FROM binding_tokens WHERE token = ?').get(issued.token)
ok(row?.kind === 'qqp_code', 'kind = qqp_code（与渠道侧一致）')
ok(row?.bot_id === 'b1', '绑定了 bot')
ok(row?.used_at === null, '初始未使用')

// 同一 kind 再发一个码 → 旧的立即作废（一人同时只有一个有效码）
const issued2 = createBindToken(storage, 'u1', 'qqp_code', 'b1')
ok(issued2.token !== issued.token, '新码与旧码不同')
const oldGone = storage.prepare('SELECT id FROM binding_tokens WHERE token = ?').get(issued.token)
ok(oldGone === undefined, '旧码已作废')

console.log('== 渠道侧消费 ==')
const miss = await tryHandleBinding(storage, { channel: 'qqp', externalId: '10001', text: '你好呀' })
ok(miss.handled === false, '非绑定消息不拦截')
const wrongCode = await tryHandleBinding(storage, { channel: 'qqp', externalId: '10001', text: '绑定 ZZZZZZ' })
ok(wrongCode.handled === true && wrongCode.reply === MSG_EXPIRED, '错误码 → 失效提示')

const hit = await tryHandleBinding(storage, { channel: 'qqp', externalId: '10001', text: `绑定 ${issued2.token}` })
ok(hit.handled === true, '绑定码命中')
ok(hit.reply === MSG_SUCCESS_QQ, '回复成功文案')

console.log('== 身份归一 ==')
const identity = storage
  .prepare("SELECT user_id, channel, external_id FROM channel_identities WHERE channel = 'qqp' AND external_id = '10001'")
  .get()
ok(identity?.user_id === 'u1', '身份绑定到登录用户（跨渠道同一条会话线）')
const used = storage.prepare('SELECT used_at FROM binding_tokens WHERE token = ?').get(issued2.token)
ok(used?.used_at !== null && used?.used_at !== undefined, '码被标记为已用（一次性）')

const replay = await tryHandleBinding(storage, { channel: 'qqp', externalId: '10001', text: `绑定 ${issued2.token}` })
ok(replay.handled === true && replay.reply === MSG_EXPIRED, '同一个码不能重复绑定')

// 别人抢同一个渠道身份 → 冲突
storage.prepare("INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u2','other','x','user',?)").run(now)
const otherIssued = createBindToken(storage, 'u2', 'qqp_code', 'b1')
const conflict = await tryHandleBinding(storage, { channel: 'qqp', externalId: '10001', text: `绑定 ${otherIssued.token}` })
ok(conflict.handled === true && conflict.reply === MSG_CONFLICT, '冲突提示（不静默抢占）')

console.log('== 联系人晋升 ==')
storage.prepare("INSERT INTO contacts (id, bot_id, sender, name, channel, created_at, updated_at) VALUES ('ct1','b1','10001','阿明','qqp',?,?)").run(now, now)
storage.prepare("UPDATE contacts SET user_id = 'u1' WHERE bot_id = 'b1' AND sender = '10001'").run()
const promoted = storage.prepare("SELECT user_id FROM contacts WHERE id = 'ct1'").get()
ok(promoted?.user_id === 'u1', '联系人被认领为登录用户（历史与记忆保留）')

console.log('== 解绑 ==')
const res = storage.prepare("DELETE FROM channel_identities WHERE user_id = ? AND channel = ? AND external_id = ?").run('u1', 'qqp', '10001')
ok(Number(res.changes) > 0, '身份已删除')
ok(storage.prepare("SELECT id FROM channel_identities WHERE user_id = 'u1'").get() === undefined, '解绑后状态里没有了')
const contactKept = storage.prepare("SELECT id FROM contacts WHERE id = 'ct1'").get()
ok(contactKept !== undefined, '解绑不删联系人（历史与记忆保留）')

storage.close()
rmSync(dir, { recursive: true, force: true })

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
