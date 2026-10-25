/**
 * SnowLuma 渠道专属工具（经 hub.tools.registerChannelTool 注册）：
 * send_qq_face / set_qq_profile / set_qq_avatar / post_qzone。
 *
 * 工具定义复用 @littly/tools 内置 schema（registry 的 collectTools 会剔除这四个
 * 内置行，改由本插件在 SnowLuma 在线时补挂）；exec 结果为 JSON 字符串（registry
 * 统一序列化的既定契约）。
 */
import type { ToolDef, ToolExecCtx } from '@littly/tools'
import { toolByName } from '@littly/tools'
import { callBotAction, type SnowlumaDeps } from './client.ts'
import { resolveQqpUin } from './inbound.ts'

function okResult(payload: Record<string, unknown>): { result: string } {
  return { result: JSON.stringify({ ok: true, ...payload }) }
}

function failResult(error: string): { result: string } {
  return { result: JSON.stringify({ ok: false, error }) }
}

function envelopeOk(res: { retcode?: number; status?: string } | null): boolean {
  return !!res && (res.retcode === 0 || res.status === 'ok')
}

function toolOrThrow(name: string): ToolDef {
  const def = toolByName(name)
  if (!def) throw new Error(`内置工具定义缺失: ${name}`)
  return def
}

export function registerSnowlumaTools(deps: SnowlumaDeps): void {
  const registry = deps.hub.tools

  // --- send_qq_face：QQ 自带表情（仅 QQ 聊天场景可用） ---
  registry.registerChannelTool(toolOrThrow('send_qq_face'), async (args, ctx: ToolExecCtx) => {
    if (ctx.channelId !== 'qqp') return failResult('该动作仅在 QQ 聊天中可用')
    const id = Number(args.id)
    if (!Number.isInteger(id)) throw new Error('id 必须是 QQ 表情编号')
    const uin = resolveQqpUin(deps, ctx.botId, ctx.sender)
    if (!uin) throw new Error('没有 QQ uin（对方需要先给 bot 发过消息）')
    const res = await callBotAction(deps.storage, ctx.botId, 'send_private_msg', {
      user_id: Number(uin),
      message: [{ type: 'face', data: { id } }],
    })
    if (!envelopeOk(res)) throw new Error('SnowLuma 连接不可用或发送失败')
    return okResult({})
  })

  // --- set_qq_profile：改昵称 / 个性签名（账号级动作，任何场景可用） ---
  registry.registerChannelTool(toolOrThrow('set_qq_profile'), async (args, ctx: ToolExecCtx) => {
    const nickname = String(args.nickname ?? '').trim()
    const personalNote = String(args.personalNote ?? '').trim()
    if (!nickname && !personalNote) throw new Error('nickname 与 personalNote 至少填一个')
    const params: Record<string, unknown> = {}
    if (nickname) params.nickname = nickname
    if (personalNote) params.personal_note = personalNote
    const res = await callBotAction(deps.storage, ctx.botId, 'set_qq_profile', params)
    if (!envelopeOk(res)) throw new Error('SnowLuma 连接不可用或修改失败')
    return okResult({})
  })

  // --- set_qq_avatar：换头像（相册图 → 公网 URL → SnowLuma 服务端拉取） ---
  registry.registerChannelTool(toolOrThrow('set_qq_avatar'), async (args, ctx: ToolExecCtx) => {
    const photoId = String(args.photoId ?? '')
    const photo = deps.storage
      .prepare('SELECT url FROM photos WHERE id = ? AND bot_id = ?')
      .get(photoId, ctx.botId) as { url: string } | undefined
    if (!photo) throw new Error('照片不存在（先 view_album 选好照片 id）')
    const res = await callBotAction(deps.storage, ctx.botId, 'set_qq_avatar', {
      file: deps.photoPublicUrl(photo.url),
    })
    if (!envelopeOk(res)) throw new Error('SnowLuma 连接不可用或修改失败')
    return okResult({})
  })

  // --- post_qzone：发空间说说（原生 send_qzone_msg，可配相册图） ---
  // ★ 风险提示：走真实 QQ 空间接口，高频调用触发风控（契约 §5），调用方需自行限流。
  registry.registerChannelTool(toolOrThrow('post_qzone'), async (args, ctx: ToolExecCtx) => {
    const text = String(args.text ?? '').trim()
    if (!text) throw new Error('text 必填')
    const photoIds = Array.isArray(args.photoIds) ? args.photoIds.map((x) => String(x)) : []
    const images: string[] = []
    for (const id of photoIds.slice(0, 9)) {
      const photo = deps.storage
        .prepare('SELECT url FROM photos WHERE id = ? AND bot_id = ?')
        .get(id, ctx.botId) as { url: string } | undefined
      if (photo) images.push(deps.photoPublicUrl(photo.url))
    }
    const params: Record<string, unknown> = { content: text, ugc_right: 1 }
    if (images.length > 0) params.images = images
    const res = await callBotAction(deps.storage, ctx.botId, 'send_qzone_msg', params)
    if (!envelopeOk(res)) throw new Error('SnowLuma 连接不可用或发布失败')
    return okResult({ images: images.length })
  })
}
