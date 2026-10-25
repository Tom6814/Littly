/**
 * dsh 插件工具桥 —— 让「社区 dsh 插件 / MCP 服务器」注册的工具对 Littly 的模型可见、可调。
 *
 * 背景（计划 v2 §2 兼容性验收）：dsh 的工具注册表（ctx.tools）与 Littly 自己的工具表
 * （@littly/tools）是两套。社区插件（如 dsh-case 的 case_convert、dsh-toolkit 等）
 * 用 ctx.tools.register() 注册，模型默认看不到它们。
 *
 * 本桥把 ctx.tools 的可见 schema 投影成 Littly 的 ToolDef 形状，并在模型调用这些工具时
 * 转回 ctx.tools.execute() 执行 —— 于是「装一个 dsh 插件」对她立刻可用。
 *
 * 命名：dsh 工具按原名暴露（社区插件的描述里写的就是这个名字）。与 Littly 自带工具同名时
 * 以 Littly 自带的为准（自带工具承载她的记忆/日程/边界语义，不该被外部插件顶掉）。
 */
import type { ToolDef } from '@littly/tools'

/** dsh 工具表（只取本桥需要的两个方法，避免依赖 dsh 内部类型）。 */
export interface DshToolsLike {
  schemas(scope?: unknown, toolSet?: unknown): Array<{ name: string; description?: string; parameters?: Record<string, unknown> }>
  execute(input: {
    calls: Array<{ type: 'tool-call'; id: string; name: string; arguments: string }>
    signal: AbortSignal
    agent?: unknown
    log?: unknown
    toolSet?: unknown
  }): Promise<{ results: Array<{ callId: string; result: unknown }> }>
}

/** 桥接口（hub 只依赖这两个方法）。 */
export interface DshToolBridge {
  /** 当前可见的 dsh 工具（Littly ToolDef 形状）。 */
  list(exclude?: ReadonlySet<string>): ToolDef[]
  /** 调用一个 dsh 工具。 */
  call(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; result: string }>
}

const DEFAULT_TIMEOUT_MS = 120_000

/** 把 dsh 的执行结果投影成给模型看的文本。 */
export function renderDshResult(result: unknown): string {
  if (result === null || result === undefined) return ''
  if (typeof result === 'string') return result
  if (Array.isArray(result)) {
    const parts: string[] = []
    for (const item of result) {
      if (!item || typeof item !== 'object') {
        parts.push(String(item))
        continue
      }
      const rec = item as { type?: string; text?: string; [k: string]: unknown }
      if (typeof rec.text === 'string') parts.push(rec.text)
      else if (rec.type === 'image') parts.push('[图片]')
      else parts.push(JSON.stringify(item))
    }
    return parts.join('\n')
  }
  if (typeof result === 'object') {
    const rec = result as Record<string, unknown>
    // dsh 的执行结果常带 { content: ContentBlock[] } 或 { output: string }
    const content = rec['content']
    if (Array.isArray(content)) return renderDshResult(content)
    if (typeof rec['output'] === 'string') return rec['output']
    if (typeof rec['text'] === 'string') return rec['text']
    if (rec['error'] !== undefined) return JSON.stringify({ error: rec['error'] })
  }
  return JSON.stringify(result)
}

/**
 * 建桥。取工具表用惰性 getter：插件 apply 时 dsh 工具服务可能还没注册，
 * 惰性取保证后到的插件工具也能被看到。ctx.tools 不存在时返回空桥（不阻断启动）。
 */
export function createDshToolBridge(resolve: () => DshToolsLike | undefined): DshToolBridge {
  return {
    list(exclude?: ReadonlySet<string>): ToolDef[] {
      const tools = resolve()
      if (!tools) return []
      let schemas: Array<{ name: string; description?: string; parameters?: Record<string, unknown> }> = []
      try {
        schemas = tools.schemas()
      } catch {
        return []
      }
      const out: ToolDef[] = []
      for (const s of schemas) {
        if (!s || typeof s.name !== 'string' || s.name === '') continue
        if (exclude?.has(s.name)) continue
        out.push({
          type: 'function',
          function: {
            name: s.name,
            description: s.description ?? '',
            parameters: s.parameters ?? { type: 'object', properties: {} },
          },
        })
      }
      return out
    },
    async call(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; result: string }> {
      const tools = resolve()
      if (!tools) return { ok: false, result: JSON.stringify({ error: 'dsh 工具表不可用' }) }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
      try {
        const res = await tools.execute({
          calls: [{ type: 'tool-call', id: `littly-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, arguments: JSON.stringify(args ?? {}) }],
          signal: controller.signal,
        })
        const first = res.results[0]
        const text = renderDshResult(first?.result)
        const failed = (first?.result as { isError?: boolean } | undefined)?.isError === true
        return { ok: !failed, result: text || '(无输出)' }
      } catch (err) {
        return { ok: false, result: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
