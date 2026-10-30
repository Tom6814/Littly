/**
 * 模型侧 `mail` 元工具 + 注册。
 * 形态对齐 bili/x 元工具：模型只给 command+params，护栏（写默认 dry-run / 限频 / 审计 /
 * 附件目录限制）全在 @littly/mail 服务内，模型绕不过去。
 */
import type { ToolDef, ToolExecCtx } from '@littly/tools'
import type { MailService } from './service.ts'

/** `mail` 工具定义（OpenAI function calling 形状）。 */
export const MAIL_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'mail',
    description: `你自己的邮箱（用户给你绑定的邮箱）。收发/阅读/整理邮件：
- 读：mail({command:"folders"})、mail({command:"list", params:{folder:"INBOX", limit:10, unreadOnly:true}})、mail({command:"search", params:{query:"关键词"}})、mail({command:"read", params:{uid:123, attachments:true}})。
- 写：mail({command:"send", params:{to:"a@b.com", subject:"…", text:"…"}})、reply（params:{uid,text}）、mark（params:{uid,seen:true}）、move（params:{uid,target:"文件夹"}）、archive（params:{uid}）、delete（params:{uid}；默认进 Trash，无 Trash 才需 force:true）。
- 写操作默认只预演（dryRun），管理员打开写开关后还要显式传 dryRun:false 才真正执行。
- 附件：read 时 attachments:true 会下载到服务器目录；send 的 attachments 只允许该目录内路径。
- 未绑定/凭据错误会返回可读错误（mail_not_configured / imap_failed / smtp_failed）。`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '命令：folders/list/search/read（读）；send/reply/mark/move/archive/delete（写）' },
        params: { type: 'object', description: '命令参数（不同命令不同字段，例如 list: {folder,limit,unreadOnly}；read: {uid,attachments}；send: {to,subject,text,html?,attachments?}）' },
        dryRun: { type: 'boolean', description: '写操作是否只预演；默认 true（不执行）。只有确认要真操作时才传 false。' },
      },
      required: ['command'],
    },
  },
}

/** hub 工具注册表最小结构面（避免依赖 @littly/agents 具体类型）。 */
export interface MailToolRegistryLike {
  tools: {
    registerChannelTool(
      def: ToolDef,
      exec: (args: Record<string, unknown>, ctx: ToolExecCtx) => Promise<{ result: string }>,
    ): void
  }
}

/** 把 `mail` 工具注册进 Littly 工具表。 */
export function registerMailTool(hub: MailToolRegistryLike, service: MailService): void {
  hub.tools.registerChannelTool(MAIL_TOOL, async (args: Record<string, unknown>, ctx: ToolExecCtx) => {
    const command = String(args['command'] ?? '').trim()
    const params = args['params'] !== null && typeof args['params'] === 'object' && !Array.isArray(args['params'])
      ? args['params'] as Record<string, unknown>
      : {}
    const dryRun = typeof args['dryRun'] === 'boolean' ? args['dryRun'] as boolean : undefined
    try {
      const result = await service.run(command, params, { botId: ctx.botId, ...(dryRun !== undefined ? { dryRun } : {}) })
      return { result: JSON.stringify({ ok: true, ...result }) }
    } catch (error) {
      const rec = error as { code?: unknown; message?: unknown; status?: unknown }
      return { result: JSON.stringify({ ok: false, error: { code: String(rec.code ?? 'mail_failed'), message: String(rec.message ?? error) } }) }
    }
  })
}
