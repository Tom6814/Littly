/**
 * 绑定端点：生成绑定码 / 查看绑定状态 / 解绑。
 *
 * 移植自旧项目 src/app/api/bind/*（旧 internal/channel/binding.ts 的发码侧）。
 * 渠道侧（各渠道包的 src/binding.ts）只读 binding_tokens —— 没有发码入口，
 * 「绑定一次，全渠道同一条会话线」这条承诺就兑现不了：这里补上发码与解绑。
 *
 * 码的形态与旧实现一致：
 * - 6 位码（微信/QQ/QQ 个人号/Discord）：字母表剔除易混淆的 I/O/0/1
 * - Telegram：128-bit nonce，走 deep-link（/start bind_<nonce>）
 * - 有效期 10 分钟；同一人同一 kind 只保留一个有效码（新的让旧的作废）
 */
import { randomBytes } from 'node:crypto'
import type { LittlyStorage } from '@littly/storage'
import { json, err, bodyRecord, reqStr } from './http.ts'
import type { RegisterFn } from './deps.ts'

/** 6 位码字母表（剔除易混淆的 I/O/0/1）。 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const BIND_TTL_MS = 10 * 60 * 1000

/** 渠道 → binding_tokens.kind。 */
const CHANNEL_KINDS: Record<string, string> = {
  wechat: 'wechat_code',
  qq: 'qq_code',
  qqp: 'qqp_code',
  discord: 'discord_code',
  tg: 'tg_deeplink',
}

export function genBindCode(): string {
  const bytes = randomBytes(6)
  let code = ''
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length]
  return code
}

export function genTgNonce(): string {
  return randomBytes(16).toString('base64url')
}

/** 生成一个绑定码（同 kind 的旧未用码立即作废；撞唯一键就换一个再来一次）。 */
export function createBindToken(
  storage: LittlyStorage,
  userId: string,
  kind: string,
  botId = '',
): { token: string; expiresAt: string } {
  storage.prepare("DELETE FROM binding_tokens WHERE user_id = ? AND kind = ? AND used_at IS NULL").run(userId, kind)
  const expiresAt = new Date(Date.now() + BIND_TTL_MS).toISOString()
  const make = kind === 'tg_deeplink' ? genTgNonce : genBindCode
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = make()
    try {
      storage
        .prepare('INSERT INTO binding_tokens (id, user_id, bot_id, token, kind, expires_at, used_at, created_at) VALUES (?,?,?,?,?,?,NULL,?)')
        .run(globalThis.crypto.randomUUID(), userId, botId, token, kind, expiresAt, new Date().toISOString())
      return { token, expiresAt }
    } catch {
      // 撞唯一键 → 换一个码再试
    }
  }
  throw new Error('绑定码生成失败（连续撞码）')
}

export const registerBindRoutes: RegisterFn = (r, d) => {
  // 生成绑定码
  r.post('/api/bind/:channel/code', 'required', (ctx) => {
    const channel = (ctx.params['channel'] ?? '').trim()
    const kind = CHANNEL_KINDS[channel]
    if (kind === undefined) {
      err(ctx.res, 400, 'bad_request', `不支持的渠道：${channel || '(空)'}`)
      return
    }
    const body = bodyRecord(ctx.body)
    const botId = reqStr(body, 'botId') ?? ''
    try {
      const { token, expiresAt } = createBindToken(d.storage, ctx.user!.id, kind, botId)
      json(ctx.res, 200, {
        data: {
          channel,
          kind,
          code: token,
          expiresAt,
          // Telegram 走 deep-link，其余渠道在渠道里发「绑定 <码>」
          instruction:
            kind === 'tg_deeplink'
              ? '把下面的链接发到 Telegram（或让对方点）：启动参数里的 bind_ 后面那串就是码'
              : '在对方渠道里私聊她发：绑定 ' + token,
        },
      })
    } catch (e) {
      err(ctx.res, 500, 'internal', e instanceof Error ? e.message : String(e))
    }
  })

  // 绑定状态：我在哪些渠道已经绑了
  r.get('/api/bind/status', 'required', (ctx) => {
    const rows = d.storage
      .prepare('SELECT channel, external_id, created_at FROM channel_identities WHERE user_id = ? ORDER BY created_at DESC')
      .all(ctx.user!.id) as unknown as Array<{ channel: string; external_id: string; created_at: string }>
    json(ctx.res, 200, {
      data: {
        identities: rows.map((row) => ({
          channel: row.channel,
          externalId: row.external_id,
          createdAt: row.created_at,
        })),
        pending: d.storage
          .prepare('SELECT kind, token, expires_at FROM binding_tokens WHERE user_id = ? AND used_at IS NULL AND expires_at > ?')
          .all(ctx.user!.id, new Date().toISOString()) as unknown as Array<{ kind: string; token: string; expires_at: string }>,
      },
    })
  })

  // 解绑：解掉某个渠道的绑定身份（历史与记忆保留）
  r.post('/api/bind/unbind', 'required', (ctx) => {
    const body = bodyRecord(ctx.body)
    const channel = reqStr(body, 'channel') ?? ''
    const externalId = reqStr(body, 'externalId') ?? ''
    if (channel === '' || externalId === '') {
      err(ctx.res, 400, 'bad_request', '缺少 channel 或 externalId')
      return
    }
    const res = d.storage
      .prepare('DELETE FROM channel_identities WHERE user_id = ? AND channel = ? AND external_id = ?')
      .run(ctx.user!.id, channel, externalId)
    const changed = Number(res.changes ?? 0) > 0
    json(ctx.res, 200, { data: { ok: changed, unbound: changed ? { channel, externalId } : null } })
  })
}

