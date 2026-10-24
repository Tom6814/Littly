/**
 * dsh LlmAdapter 壳：把 @littly 的 OpenAI 兼容通道注册进 ctx.llm（路由 'littly'），
 * 让 dsh 原生部件（session-title 等）也能用我们的配置链。
 * 对话主链路（hub）直走 chatComplete() 保持旧行为逐字节一致；本适配器是桥。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolSchema } from '@deepseek-ai/dsh-llm'
import type { LittlyStorage } from '@littly/storage'
import { chatComplete, type ChatMessage } from './chat.ts'

export const name = 'littly-llm'

export const inject = ['littlyStorage']

export interface Config {}

export const Config: z<Config> = z.object({})

class LittlyAdapter extends LlmAdapter {
  constructor(private readonly storage: LittlyStorage) {
    super()
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const messages = mapMessages(options)
    const tools: import('./chat.ts').ToolDef[] | undefined = options.tools?.map((t: ToolSchema) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
    const res = await chatComplete(this.storage, messages, {
      model: options.model,
      temperature: options.temperature,
      tools,
      toolChoice: tools ? 'auto' : undefined,
      enableThinking: false,
      maxTokens: options.maxTokens,
      retries: 0,
    })
    let index = 0
    if (res.thinking) {
      yield { type: 'block-start', index, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index, text: res.thinking }
      yield { type: 'block-end', index, block: { type: 'reasoning', text: res.thinking } }
      index++
    }
    if (res.content) {
      yield { type: 'block-start', index, blockType: 'text' }
      yield { type: 'text-delta', index, text: res.content }
      yield { type: 'block-end', index, block: { type: 'text', text: res.content } }
      index++
    }
    for (const tc of res.toolCalls) {
      const args = JSON.stringify(tc.arguments)
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index, id: tc.id, name: tc.name, argumentsDelta: args }
      yield { type: 'block-end', index, block: { type: 'tool-call', id: tc.id, name: tc.name, arguments: args } }
      index++
    }
    yield { type: 'finish', reason: 'stop' }
  }
}

function mapMessages(options: GenerateOptions): ChatMessage[] {
  const out: ChatMessage[] = []
  if (options.system !== undefined && options.system !== '') {
    out.push({ role: 'system', content: options.system })
  }
  for (const m of options.messages) {
    const text = m.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
    if (m.role === 'user') {
      out.push({ role: 'user', content: text })
    } else if (m.role === 'assistant') {
      const calls = m.content.filter((b) => b.type === 'tool-call')
      out.push({
        role: 'assistant',
        content: text,
        ...(calls.length > 0
          ? {
              tool_calls: calls.map((b) => ({
                id: (b as { id: string }).id,
                type: 'function' as const,
                function: { name: (b as { name: string }).name, arguments: (b as { arguments: string }).arguments },
              })),
            }
          : {}),
      })
    } else if (m.role === 'tool') {
      out.push({
        role: 'tool',
        content: text,
        tool_call_id: (m as unknown as { toolCallId: string }).toolCallId,
      })
    } else if (m.role === 'system') {
      out.push({ role: 'system', content: text })
    }
  }
  return out
}

export function apply(ctx: Context, _config: Config): void {
  const storage = ctx.littlyStorage as LittlyStorage
  ctx.llm.registerAdapter(['littly'], new LittlyAdapter(storage))
  ctx.logger.info('littly llm adapter registered (route: littly)')
}
