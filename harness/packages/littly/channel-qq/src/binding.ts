/**
 * 绑定流（旧 internal/channel/binding.ts 的渠道侧移植）。
 * - tg = deep-link nonce（/start bind_<nonce>）；qqp = 6 位绑定码「绑定 XXXXXX」
 * - 命中即短路（返回 handled=true，调用方不得再走正常 AI 流程）
 * - 限频计数存 global_settings `bind.fail.<channel>:<externalId>`，值 "count|windowStartMs"
 */
import { randomUUID } from 'node:crypto'
import type { LittlyStorage } from '@littly/storage'
import { promoteContact as promoteContactShared } from '@littly/agents'

export const BIND_TTL_MS = 10 * 60 * 1000

const BIND_CODE_RE = /^绑定\s*([A-Z0-9]{6})$/
const TG_NONCE_RE = /^(?:\/start\s+)?bind_([a-zA-Z0-9_-]+)$/
const RATE_LIMIT_MAX = 5
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000

// --- 回复文案（与旧项目逐字一致，勿随意改动） ---
export const MSG_EXPIRED = '绑定信息已失效，请回到网页重新生成哦'
export const MSG_CONFLICT = '这个号已经绑定了其他账号，请先用对应账号解绑后再试'
export const MSG_RATE = '尝试次数太多啦，请一小时后再试'
export const MSG_SUCCESS_TG = '绑定成功 🎉 网页端和 Telegram 里的我就是同一个我啦～'
export const MSG_SUCCESS_QQ = '绑定成功 🎉 网页端和 QQ 里的我就是同一个我啦～'

export interface BindingOutcome {
  handled: boolean
  reply?: string | undefined
}

export interface BindingContext {
  channel: string
  /** 渠道原生外部 id（tg 数字用户 id / qqp uin） */
  externalId: string
  /** 原始消息文本 */
  text: string
}

interface TokenRow {
  id: string
  user_id: string
  kind: string
  expires_at: string
  used_at: string | null
}

function kindFor(channel: string): string {
  return channel === 'tg' ? 'tg_deeplink' : 'qqp_code'
}

function isRateLimited(storage: LittlyStorage, senderKey: string): boolean {
  const row = storage
    .prepare('SELECT value FROM global_settings WHERE key = ?')
    .get(`bind.fail.${senderKey}`) as { value: string } | undefined
  if (!row) return false
  const parts = row.value.split('|')
  const count = Number(parts[0] ?? '0')
  const start = Number(parts[1] ?? '0')
  return Date.now() - start < RATE_LIMIT_WINDOW_MS && count >= RATE_LIMIT_MAX
}

function recordBindFailure(storage: LittlyStorage, senderKey: string): void {
  const key = `bind.fail.${senderKey}`
  const now = Date.now()
  const row = storage
    .prepare('SELECT value FROM global_settings WHERE key = ?')
    .get(key) as { value: string } | undefined
  const parts = row ? row.value.split('|') : []
  const prevCount = Number(parts[0] ?? '0')
  const prevStart = Number(parts[1] ?? '0')
  const inWindow = now - prevStart < RATE_LIMIT_WINDOW_MS && Number.isFinite(prevStart)
  const value = `${inWindow ? prevCount + 1 : 1}|${inWindow ? prevStart : now}`
  storage
    .prepare('INSERT INTO global_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value)
}

/** 绑定拦截主入口：命中返回 handled=true（含失败提示），未命中继续正常流程。 */
export async function tryHandleBinding(storage: LittlyStorage, ctx: BindingContext): Promise<BindingOutcome> {
  const text = ctx.text.trim()
  // tg 走 deep-link nonce（/start bind_xxx）；qqp 走 6 位绑定码
  const match = ctx.channel === 'tg' ? TG_NONCE_RE.exec(text) : BIND_CODE_RE.exec(text)
  if (!match || !match[1]) return { handled: false }

  const senderKey = `${ctx.channel}:${ctx.externalId}`
  if (isRateLimited(storage, senderKey)) return { handled: true, reply: MSG_RATE }

  const kind = kindFor(ctx.channel)
  const token = storage
    .prepare('SELECT id, user_id, kind, expires_at, used_at FROM binding_tokens WHERE token = ?')
    .get(match[1]) as TokenRow | undefined
  if (!token || token.kind !== kind || token.used_at || new Date(token.expires_at).getTime() <= Date.now()) {
    recordBindFailure(storage, senderKey)
    return { handled: true, reply: MSG_EXPIRED }
  }

  // 该渠道外部身份已被其他平台账号占用 → 冲突，绝不静默抢占
  const taken = storage
    .prepare('SELECT user_id FROM channel_identities WHERE channel = ? AND external_id = ?')
    .get(ctx.channel, ctx.externalId) as { user_id: string } | undefined
  if (taken && taken.user_id !== token.user_id) {
    recordBindFailure(storage, senderKey)
    return { handled: true, reply: MSG_CONFLICT }
  }

  const now = new Date().toISOString()
  storage.db.exec('BEGIN IMMEDIATE')
  try {
    storage.prepare('UPDATE binding_tokens SET used_at = ? WHERE id = ?').run(now, token.id)
    // 换号：先移除自己在该渠道的旧身份（自己的数据，安全自替换）
    storage.prepare('DELETE FROM channel_identities WHERE user_id = ? AND channel = ?').run(token.user_id, ctx.channel)
    storage
      .prepare('INSERT INTO channel_identities (id, user_id, channel, external_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), token.user_id, ctx.channel, ctx.externalId, now)
    // 晋升：该渠道同名联系人在所有角色下认领为登录用户（历史与记忆全保留）
    storage
      .prepare("UPDATE contacts SET user_id = ? WHERE channel = ? AND user_id IS NULL AND (sender = ? OR external_id = ?)")
      .run(token.user_id, ctx.channel, ctx.externalId, ctx.externalId)
    storage.db.exec('COMMIT')
  } catch (err) {
    storage.db.exec('ROLLBACK')
    throw err
  }

  return { handled: true, reply: ctx.channel === 'tg' ? MSG_SUCCESS_TG : MSG_SUCCESS_QQ }
}

/** 正常消息路径的晋升：身份已存在则认领该 bot 下未绑定 Contact。 */
/** 正常消息路径的晋升（实现收敛到 @littly/agents 的共享 promoteContact）。 */
export function promoteContact(storage: LittlyStorage, botId: string, channel: string, externalId: string): void {
  promoteContactShared(storage, botId, channel, externalId)
}
