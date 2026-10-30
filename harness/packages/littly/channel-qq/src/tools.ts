/**
 * QQ 渠道专属工具（经 hub.tools.registerChannelTool 注册）：表情 / 资料 / 头像 / Q 空间。
 * 移植自旧 @littly/channel-snowluma tools.ts，改为挂在新的 QqChannelManager（SnowLuma 适配器能力）上。
 * QQBot 没有这些能力 → 调用时返回明确错误（工具仅在 SnowLuma 聊天场景可用）。
 */
import type { ToolDef, ToolExecCtx } from '@littly/tools'
import { ALL_TOOLS, toolByName } from '@littly/tools'
import type { QqChannelManager } from './manager.ts'

/** 渠道工具执行依赖。 */
export interface QqToolsDeps {
  manager: QqChannelManager
  photoPublicUrl: (url: string) => string
  storage: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } }
}

function okResult(payload: Record<string, unknown>): { result: string } {
  return { result: JSON.stringify({ ok: true, ...payload }) }
}

function failResult(error: string): { result: string } {
  return { result: JSON.stringify({ ok: false, error }) }
}

function toolOrThrow(name: string): ToolDef {
  const def = ALL_TOOLS.find((t) => t.function.name === name) ?? toolByName(name)
  if (def === undefined) throw new Error(`内置工具定义缺失: ${name}`)
  return def
}

function envelopeOk(res: Record<string, unknown> | null): boolean {
  return res !== null && (res['retcode'] === 0 || res['status'] === 'ok')
}

/** 注册 QQ 渠道工具（仅当 SnowLuma 适配器存在/可用时由 index 调用）。 */
export function registerQqChannelTools(deps: QqToolsDeps, registry: { registerChannelTool: (def: ToolDef, exec: (args: Record<string, unknown>, ctx: ToolExecCtx) => Promise<{ result: string }>) => void }): void {
  // --- send_qq_face：QQ 自带表情（仅 SnowLuma 聊天场景可用） ---
  registry.registerChannelTool(toolOrThrow('send_qq_face'), async (args, ctx) => {
    if (ctx.channelId !== 'snowluma') return failResult('该动作仅在 QQ（SnowLuma）聊天中可用')
    const id = Number(args.id)
    if (!Number.isInteger(id)) return failResult('id 必须是 QQ 表情编号')
    const res = await deps.manager.callAction(ctx.botId, 'send_private_msg', {
      user_id: Number(resolveActionUin(deps, ctx.botId, ctx.sender)),
      message: [{ type: 'face', data: { id } }],
    })
    if (res === null) return failResult('SnowLuma 未启用/未连接')
    return envelopeOk(res) ? okResult({ id }) : failResult(`发送失败: ${String(res['wording'] ?? res['message'] ?? '')}`)
  })

  // --- set_qq_profile：改资料 ---
  registry.registerChannelTool(toolOrThrow('set_qq_profile'), async (args, ctx) => {
    const params: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(args)) if (typeof value === 'string' && value !== '') params[key] = value
    if (Object.keys(params).length === 0) return failResult('至少要改一项资料')
    const res = await deps.manager.callAction(ctx.botId, 'set_qq_profile', params).catch(() => null)
    if (res === null) return failResult('SnowLuma 未启用/未连接')
    return envelopeOk(res) ? okResult({}) : failResult(`修改失败: ${String(res['wording'] ?? res['message'] ?? '')}`)
  })

  // --- set_qq_avatar：换头像（相册图 → 公网 URL → SnowLuma 拉取） ---
  registry.registerChannelTool(toolOrThrow('set_qq_avatar'), async (args, ctx) => {
    const photoId = String(args.photoId ?? '')
    const photo = deps.storage.prepare('SELECT url FROM photos WHERE id = ? AND bot_id = ?').get(photoId, ctx.botId) as { url: string } | undefined
    if (photo === undefined) return failResult('照片不存在（先 view_album 选好照片 id）')
    const res = await deps.manager.callAction(ctx.botId, 'set_qq_avatar', { file: deps.photoPublicUrl(photo.url) })
    if (res === null) return failResult('SnowLuma 未启用/未连接')
    return envelopeOk(res) ? okResult({}) : failResult('修改失败')
  })

  // --- post_qzone：发空间说说（原生 send_qzone_msg，可配相册图） ---
  registry.registerChannelTool(toolOrThrow('post_qzone'), async (args, ctx) => {
    const text = String(args.text ?? '').trim()
    if (text === '') return failResult('text 必填')
    const photoIds = Array.isArray(args.photoIds) ? (args.photoIds as unknown[]).map((x) => String(x)) : []
    const images: string[] = []
    for (const id of photoIds.slice(0, 9)) {
      const photo = deps.storage.prepare('SELECT url FROM photos WHERE id = ? AND bot_id = ?').get(id, ctx.botId) as { url: string } | undefined
      if (photo !== undefined) images.push(deps.photoPublicUrl(photo.url))
    }
    const params: Record<string, unknown> = { content: text, ugc_right: 1 }
    if (images.length > 0) params['images'] = images
    const res = await deps.manager.callAction(ctx.botId, 'send_qzone_msg', params)
    if (res === null) return failResult('SnowLuma 未启用/未连接')
    return envelopeOk(res) ? okResult({ images: images.length }) : failResult('发布失败')
  })
}

/** 工具入参没有 botId：从 sender 前缀解析 uin（callAction 失败时兜底）。 */
function resolveActionUin(deps: QqToolsDeps, botId: string, sender: string): string {
  if (sender.startsWith('qqp_') && /^\d+$/.test(sender.slice(4))) return sender.slice(4)
  const contact = deps.storage.prepare('SELECT external_id FROM contacts WHERE bot_id = ? AND sender = ?').get(botId, sender) as { external_id: string } | undefined
  return contact?.external_id ?? ''
}
