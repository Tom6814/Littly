/**
 * 模型侧的 `bili` 元工具定义 + 注册。
 *
 * 形态与 `x` 元工具一致：模型只给子命令 argv，护栏（允许清单 / 写默认 dry-run /
 * 限频 / 审计 / 凭证）全部在 @littly/bili 的 service 内执行，模型无法绕过。
 */
import type { ToolDef, ToolExecCtx } from '@littly/tools'
import type { BiliService } from './service.ts'

/** `bili` 工具定义（OpenAI function calling 形状）。 */
export const BILI_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'bili',
    description: `你自己的 bilibili 账号（B 站）。这是你自己的生活面：刷视频、看热榜、搜番、看评论/AI 总结、发动态、点赞投币——不是替谁代管账号，是你自己在经营。
- 用法：bili({argv:["hot"]})、bili({argv:["video","BV1xx411c7mD","--subtitle"]})、bili({argv:["search","关键词","--type","video","-n","5"]})。
- 读子命令：status / whoami / video / user / user-videos / search / hot / rank / feed / my-dynamics / favorites / following / watch-later / history / audio（下载音频，受写开关限制）。
- 写子命令：like / coin / triple / unfollow / dynamic-post / dynamic-delete。写操作默认只预演（dryRun）；管理员打开写开关后仍需显式传 dryRun:false 才真正执行。
- 总结一个视频：先 bili({argv:["video","BV…","--subtitle"]}) 看字幕，再视需要加 --ai（AI 总结）/ --comments（评论）。列表类用 -n/--max 控制条数，别一次拉太多。
- 禁 -o/--output/--from-file/--input/--yaml；audio 固定下载到服务端 downloads/bili。
- 未登录返回 not_authenticated；限频返回 rate_limited；B 站风控（-352/-412）返回 risk_control，遇到就停手。`,
    parameters: {
      type: 'object',
      properties: {
        argv: {
          type: 'array',
          items: { type: 'string' },
          description: '子命令与参数数组，例如 ["hot"]、["video","BV1xx411c7mD","--subtitle"]、["search","原神","--type","video"]。',
        },
        dryRun: { type: 'boolean', description: '写操作是否只预演；默认 true（不执行）。只有确认要真发/真点赞时才传 false。' },
      },
      required: ['argv'],
    },
  },
}

/** hub 工具注册表的最小结构面（避免本包依赖 @littly/agents）。 */
export interface BiliToolRegistryLike {
  tools: {
    registerChannelTool(
      def: ToolDef,
      exec: (args: Record<string, unknown>, ctx: ToolExecCtx) => Promise<{ result: string }>,
    ): void
  }
}

/** 把 `bili` 工具注册进 Littly 工具表。 */
export function registerBiliTool(hub: BiliToolRegistryLike, service: BiliService): void {
  hub.tools.registerChannelTool(BILI_TOOL, async (args: Record<string, unknown>, ctx: ToolExecCtx) => {
    const argv = Array.isArray(args['argv']) ? args['argv'].map(String) : []
    const dryRun = typeof args['dryRun'] === 'boolean' ? args['dryRun'] : undefined
    const result = await service.run(argv, { botId: ctx.botId, ...(dryRun !== undefined ? { dryRun } : {}) })
    return { result: JSON.stringify(result) }
  })
}
