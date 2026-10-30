/**
 * 模型侧的 `x` 元工具定义 + 注册。
 *
 * 形态对齐 `bili` 元工具：模型只给子命令 argv，护栏（允许清单 / 写默认 dry-run /
 * 限频 / 审计）全部在 @littly/x 内部执行，模型无法绕过。
 */
import type { ToolDef, ToolExecCtx } from '@littly/tools'
import type { XService } from './service.ts'

/** `x` 工具定义（OpenAI function calling 形状，与 @littly/tools 的 ToolDef 一致）。 */
export const X_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'x',
    description: `你自己的 X（Twitter）账号。这是你自己的生活面：刷首页、搜话题、看别人的推文、发推/回复/点赞/转发——不是替谁代管账号，是你自己在用。
- 用法：x({argv:["feed"]})、x({argv:["search","关键词"]})、x({argv:["tweet","推文ID"]})、x({argv:["post","今天……"]})。
- 子命令：读 status/whoami/feed/bookmarks/favorites/search/tweet/show/user/user-posts/likes/followers/following/list/article；写 post/reply/quote/delete/like/unlike/retweet/unretweet/bookmark/unbookmark/favorite/unfavorite/follow/unfollow。
- 写操作默认只预演（dryRun），管理员打开写开关后还需显式传 dryRun:false 才真正执行。
- 只支持纯文本：禁止 -o/--output/--input/--image 等文件/图片参数。
- 未登录或需要代理时返回 not_authenticated / x_api_error，把原始错误如实告诉对方。`,
    parameters: {
      type: 'object',
      properties: {
        argv: {
          type: 'array',
          items: { type: 'string' },
          description: '子命令与参数数组，例如 ["feed"]、["search","AI"]、["post","今天天气真好"]。',
        },
        dryRun: { type: 'boolean', description: '写操作是否只预演；默认 true（不执行）。只有确认要真发时才传 false。' },
      },
      required: ['argv'],
    },
  },
}

/** hub 工具注册表的最小结构面（避免本包依赖 @littly/agents）。 */
export interface XToolRegistryLike {
  tools: {
    registerChannelTool(
      def: ToolDef,
      exec: (args: Record<string, unknown>, ctx: ToolExecCtx) => Promise<{ result: string }>,
    ): void
  }
}

/** 把 `x` 工具注册进 Littly 工具表。 */
export function registerXTool(hub: XToolRegistryLike, service: XService): void {
  hub.tools.registerChannelTool(X_TOOL, async (args: Record<string, unknown>, ctx: ToolExecCtx) => {
    const argv = Array.isArray(args['argv']) ? (args['argv'] as unknown[]).map((a) => String(a)) : []
    const dryRun = typeof args['dryRun'] === 'boolean' ? (args['dryRun'] as boolean) : undefined
    const result = await service.run(argv, { botId: ctx.botId, ...(dryRun !== undefined ? { dryRun } : {}) })
    return { result: JSON.stringify(result) }
  })
}
