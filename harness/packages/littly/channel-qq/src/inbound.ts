/**
 * QQ 双渠道入站处理（重写：整合旧 channel-snowluma 的媒体/@门/绑定/联系人与
 * 旧 channel-qq-official 的 sender 归一化思路）。
 *
 * 渠道 id：
 * - hub channelId：snowluma 适配器 → 'snowluma'；官方 QQBot → 'qqp'（出站由 hub 的
 *   registerChannel 回调到本包 manager；scene 文案沿用 QQ）。
 * - 身份/绑定 channel：统一 'qqp'（QQ 身份只有一份，旧的 QQ 绑定关系全部保留）。
 *
 * DoD：
 * - 私聊全处理；群聊仅 @bot（SnowLuma: at 段/昵称回退；QQBot: SDK 的 @ 判定）。
 * - 绑定码短路；已绑定身份归并到用户会话线；联系人 upsert；图片入相册；缓冲入队。
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { downloadsDir, type BotRow, type LittlyStorage } from '@littly/storage'
import type { LittlyHub } from '@littly/agents'
import type { InboundMessage } from './adapters/base.ts'
import { promoteContact, tryHandleBinding } from './binding.ts'
import { resolveContact } from '@littly/agents'
import type { QqChannelKind, QqChannelManager } from './manager.ts'

/** 入站处理依赖。 */
export interface QqInboundDeps {
  storage: LittlyStorage
  hub: LittlyHub
  manager: QqChannelManager
  log: (msg: string, ...args: unknown[]) => void
  /** 相册 URL → 公网 URL（SnowLuma 服务端拉取图片用）。 */
  photoPublicUrl: (url: string) => string
}

/** 群聊 @ 门：SnowLuma 用 at 段；QQBot 用 SDK 判定；都缺失时用昵称子串回退。 */
export function shouldProcessGroupMessage(message: InboundMessage, selfNickname: string): boolean {
  if (message.kind !== 'group') return true
  if (message.mentionsBot === true) return true
  if (message.replyToBot === true) return true
  const nick = selfNickname.trim()
  return nick !== '' && message.text.includes(nick)
}

/** 渠道适配器 id → hub channelId / 身份 channel / sender 前缀。 */
export function channelMeta(kind: QqChannelKind): { hubChannel: string; identityChannel: string; senderPrefix: string } {
  return kind === 'snowluma'
    ? { hubChannel: 'snowluma', identityChannel: 'qqp', senderPrefix: 'qqp_' }
    : { hubChannel: 'qqp', identityChannel: 'qqp', senderPrefix: 'qq_' }
}

/** 解析已绑定用户之外的外部 id（snowluma 为 uin，qqbot 为 openid）。 */
export function resolveExternalId(deps: QqInboundDeps, botId: string, sender: string, identityChannel: string): string {
  const prefix = sender.startsWith('qqp_') ? sender.slice(4) : sender.startsWith('qq_') ? sender.slice(3) : ''
  if (prefix !== '' && /^\d+$/.test(prefix)) return prefix
  if (sender.startsWith('qq_')) return sender.slice(3)
  const identity = deps.storage
    .prepare('SELECT external_id FROM channel_identities WHERE user_id = ? AND channel = ?')
    .get(sender, identityChannel) as { external_id: string } | undefined
  if (identity?.external_id) return identity.external_id
  const contact = deps.storage
    .prepare('SELECT external_id FROM contacts WHERE bot_id = ? AND sender = ?')
    .get(botId, sender) as { external_id: string } | undefined
  return contact?.external_id ?? ''
}

// --- 图片入库（fire-and-forget，best effort；B11 持久卷） ---

function extFor(contentType: string | null): string {
  if (contentType?.includes('png') === true) return '.png'
  if (contentType?.includes('gif') === true) return '.gif'
  if (contentType?.includes('webp') === true) return '.webp'
  return '.jpg'
}

/** 下载入站图片进相册（异步、单张失败跳过）。 */
export async function importInboundPhotos(deps: QqInboundDeps, bot: BotRow, sender: string, urls: string[]): Promise<number> {
  const dir = join(downloadsDir(), 'photos')
  mkdirSync(dir, { recursive: true })
  let imported = 0
  for (const url of urls.slice(0, 9)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
      if (!res.ok) continue
      const buf = Buffer.from(await res.arrayBuffer())
      const filename = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${extFor(res.headers.get('content-type'))}`
      writeFileSync(join(dir, filename), buf)
      deps.storage
        .prepare('INSERT INTO photos (id, bot_id, url, caption, tags, created_at) VALUES (?,?,?,?,?,?)')
        .run(randomUUID(), bot.id, `/api/photos/file/photos/${filename}`, `来自 ${sender}`, '[]', new Date().toISOString())
      imported++
      deps.log('[channel-qq] 已收录 1 张图进相册 (bot=%s)', bot.name)
    } catch {
      // 单张失败跳过
    }
  }
  return imported
}

/**
 * 入站主入口：绑定短路 → 身份归一化 → 联系人 upsert → 图片入相册 → 缓冲入队。
 * @param deps - 依赖
 * @param bot - bot 行
 * @param kind - 适配器种类
 * @param message - 适配器归一化后的消息
 */
export async function handleInboundMessage(deps: QqInboundDeps, bot: BotRow, kind: QqChannelKind, message: InboundMessage): Promise<void> {
  const meta = channelMeta(kind)
  const externalId = message.kind === 'group' ? message.externalId : message.senderId
  const clean = message.text.trim()
  const images = message.images.map((img) => img.url ?? '').filter((url) => url !== '')
  if (externalId === '') return
  // 群聊 @ 门：SnowLuma 用 at 段（mentionsBot）、QQBot 用 SDK 判定；回复 bot 也算定向。
  if (message.kind === 'group' && message.mentionsBot !== true && message.replyToBot !== true) return
  if (clean === '' && images.length === 0) return

  // 绑定流只吃纯文本（私聊与群聊均可；身份 channel 统一 qqp）
  if (clean !== '') {
    const binding = await tryHandleBinding(deps.storage, { channel: meta.identityChannel, externalId, text: clean })
    if (binding.handled) {
      if (binding.reply !== undefined && binding.reply !== '') {
        try {
          await deps.manager.send(bot.id, kind, { channel: meta.hubChannel, kind: message.kind, externalId }, [binding.reply])
        } catch (err) {
          deps.log('[channel-qq] 绑定回复失败 (bot=%s): %s', bot.name, String(err))
        }
      }
      return
    }
  }

  // 身份归一化：已绑定的 QQ 账号归并到绑定用户的会话线
  const identity = deps.storage
    .prepare('SELECT user_id FROM channel_identities WHERE channel = ? AND external_id = ?')
    .get(meta.identityChannel, externalId) as { user_id: string } | undefined
  const sender = identity?.user_id ?? `${meta.senderPrefix}${externalId}`

  // 联系人 upsert：私聊落 external_id（投递地址）；群聊绝不动 external_id，且不覆盖已有值
  const name = message.kind === 'group' ? (message.senderName !== '' ? message.senderName : externalId) : externalId
  const privateExternal = message.kind === 'private' ? externalId : ''
  const now = new Date().toISOString()
  const existing = deps.storage
    .prepare('SELECT id, external_id FROM contacts WHERE bot_id = ? AND sender = ?')
    .get(bot.id, sender) as { id: string; external_id: string } | undefined
  if (existing !== undefined) {
    if (privateExternal !== '' && existing.external_id === '') {
      deps.storage.prepare('UPDATE contacts SET name = ?, external_id = ?, channel = ?, updated_at = ? WHERE id = ?')
        .run(name, privateExternal, meta.identityChannel, now, existing.id)
    } else {
      deps.storage.prepare('UPDATE contacts SET name = ?, updated_at = ? WHERE id = ?').run(name, now, existing.id)
    }
  } else {
    deps.storage
      .prepare('INSERT INTO contacts (id, bot_id, sender, name, external_id, channel, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(randomUUID(), bot.id, sender, name, privateExternal, meta.identityChannel, now, now)
  }
  promoteContact(deps.storage, bot.id, meta.identityChannel, externalId)
  // 兜底：确保 user_id/name/is_owner 与用户身份一致（跨平台同一用户=同一联系人）
  resolveContact(deps.storage, bot.id, sender, {
    channel: meta.identityChannel,
    externalId,
    // 群聊的 external_id 绝不落库（投递地址只由私聊落库，避免污染私聊目标）
    persistExternal: message.kind === 'private',
    ...(message.senderName !== '' ? { name: message.senderName } : {}),
  })
  deps.manager.noteInbound(bot.id, sender, {
    kind: message.kind,
    externalId: message.kind === 'group' ? message.externalId : externalId,
    hubChannel: meta.hubChannel,
  })

  // 用户发的图片自动进相册（后台异步，不阻断对话）
  const httpImages = images.filter((url) => /^https?:\/\//.test(url))
  if (httpImages.length > 0) {
    void importInboundPhotos(deps, bot, sender, httpImages).catch((err) =>
      deps.log('[channel-qq] 相册入库失败 (bot=%s): %s', bot.name, String(err)),
    )
  }

  if (clean !== '') {
    // §buffer — 落库即入缓冲；hub 自行调度到期合并投递（channelId = 本适配器 hub channel）
    deps.hub.enqueueBufferedMessage({ botId: bot.id, sender, text: clean, channelId: meta.hubChannel })
  }
}
