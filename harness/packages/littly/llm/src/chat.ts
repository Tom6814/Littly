/**
 * OpenAI 兼容对话补全（旧 ai/client.ts:156-240 忠实移植）。
 * 非流式单响应；工具调用、thinking 抽取（reasoning/reasoning_content/thinking +
 * <think> 标签兜底）、GLM extra-body、tool_choice。
 */
import { getAIConfig, resolveModel, withRetry } from './config.ts'
import type { LittlyStorage } from '@littly/storage'

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

/** 旧 ChatMessage 形态（OpenAI wire 对齐） */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

export interface ToolDef {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface ChatCompleteOptions {
  model?: string | undefined
  temperature?: number | undefined
  tools?: ToolDef[] | undefined
  toolChoice?: 'auto' | 'none' | 'required' | undefined
  enableThinking?: boolean | undefined
  maxTokens?: number | undefined
  retries?: number | undefined
}

export interface ChatResult {
  content: string
  thinking: string
  toolCalls: ToolCall[]
  raw: unknown
}

/** 旧 client.ts:226-240 — 思考内容抽取。 */
export function extractThinking(message: Record<string, unknown>, content: string): string {
  const direct = (message.reasoning ?? message.reasoning_content ?? message.thinking) as string | undefined
  if (direct && typeof direct === 'string' && direct.trim()) return direct.trim()
  const m = /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/i.exec(content)
  return m?.[1]?.trim() ?? ''
}

/** 旧 client.ts — safeParseArgs：坏 JSON 回退 {_raw}。 */
export function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : { _raw: raw }
  } catch {
    return { _raw: raw }
  }
}

export async function chatComplete(
  storage: LittlyStorage,
  messages: ChatMessage[],
  opts: ChatCompleteOptions = {},
): Promise<ChatResult> {
  const cfg = await getAIConfig(storage)
  const model = resolveModel(opts.model, cfg.chatModel)
  if (!cfg.apiKey) throw new Error('AI 服务未配置：请先在全局设置里填写 API Key')
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: opts.temperature ?? 0.8,
  }
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools
    body.tool_choice = opts.toolChoice ?? 'auto'
  }
  // §11.1 GLM 系思考开关：extra body thinking:{type:'enabled'}；其他模型忽略，无害
  if (opts.enableThinking) {
    body.thinking = { type: 'enabled' }
  }
  if (opts.maxTokens) body.max_tokens = opts.maxTokens

  return withRetry(async () => {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 400)}`)
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: Record<string, unknown> }>
    }
    const message = json.choices?.[0]?.message ?? {}
    const content = typeof message.content === 'string' ? message.content : ''
    const thinking = extractThinking(message as Record<string, unknown>, content)
    const rawCalls = (message.tool_calls ?? []) as Array<{
      id?: string
      function?: { name?: string; arguments?: string }
    }>
    const toolCalls: ToolCall[] = rawCalls.map((tc, i) => ({
      id: tc.id ?? `call_${i}`,
      name: tc.function?.name ?? '',
      arguments: safeParseArgs(tc.function?.arguments ?? '{}'),
    }))
    return { content, thinking, toolCalls, raw: json }
  }, opts.retries ?? 1)
}

/** 旧 client.ts:303-324 — 向量批次嵌入（float 格式，Nvidia 端点兼容）。 */
export async function embedTexts(storage: LittlyStorage, texts: string[]): Promise<number[][]> {
  const cfg = await getAIConfig(storage)
  if (!cfg.embeddingModel || !cfg.embeddingApiKey) throw new Error('embedding 未配置')
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += 16) {
    const batch = texts.slice(i, i + 16)
    const res = await fetch(`${cfg.embeddingBaseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.embeddingApiKey}` },
      body: JSON.stringify({ model: cfg.embeddingModel, input: batch, encoding_format: 'float' }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) throw new Error(`embedding HTTP ${res.status}`)
    const json = (await res.json()) as { data?: Array<{ index: number; embedding: number[] }> }
    const rows = [...(json.data ?? [])].sort((a, b) => a.index - b.index)
    if (rows.length !== batch.length) throw new Error('embedding 返回条数不符')
    for (const r of rows) out.push(r.embedding)
  }
  return out
}

/** 向量信封（旧 memory-score.ts encodeEmbedding）：{"m":model,"v":[...]}，换模型自动失效。 */
export function encodeEmbedding(model: string, vector: number[]): string {
  return JSON.stringify({ m: model, v: vector })
}

/** 图像生成（旧 client.ts:244-265）。 */
export async function generateImage(
  storage: LittlyStorage,
  prompt: string,
  opts: { negativePrompt?: string; size?: string } = {},
): Promise<{ base64?: string; url?: string }> {
  const cfg = await getAIConfig(storage)
  if (!cfg.imageBaseUrl || !cfg.imageApiKey) throw new Error('图像服务未配置')
  const sizes = new Set(['1024x1024', '768x1344', '864x1152', '1344x768', '1152x864', '1440x720', '720x1440'])
  const size = opts.size && sizes.has(opts.size) ? opts.size : '1024x1024'
  const res = await fetch(`${cfg.imageBaseUrl}/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.imageApiKey}` },
    body: JSON.stringify({
      model: cfg.imageModel,
      prompt: opts.negativePrompt ? `${prompt}\n\n避免：${opts.negativePrompt}` : prompt,
      size,
      response_format: 'b64_json',
    }),
    signal: AbortSignal.timeout(300_000),
  })
  if (!res.ok) throw new Error(`image HTTP ${res.status}`)
  const json = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> }
  const item = json.data?.[0]
  if (item?.b64_json) return { base64: item.b64_json }
  if (item?.url) return { url: item.url }
  throw new Error('image 返回为空')
}

/** 联网搜索（旧 client.ts:268-299，OpenRouter web plugin；需开关 ai.api.web_search=1）。 */
export async function webSearch(
  storage: LittlyStorage,
  query: string,
  num = 5,
): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const cfg = await getAIConfig(storage)
  if (cfg.webSearch !== '1') throw new Error('联网搜索未开启')
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.chatModel,
      messages: [
        {
          role: 'user',
          content: `搜索「${query}」。只输出 JSON 数组，每项 {"title","url","snippet"}，最多 ${num} 项，不要输出任何其他文字。`,
        },
      ],
      plugins: [{ id: 'web', max_results: num }],
    }),
    signal: AbortSignal.timeout(90_000),
  })
  if (!res.ok) throw new Error(`search HTTP ${res.status}`)
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const content = json.choices?.[0]?.message?.content ?? ''
  const m = /\[[\s\S]*\]/.exec(content)
  if (!m) return []
  try {
    const arr = JSON.parse(m[0]) as Array<{ title?: string; url?: string; snippet?: string }>
    return arr.slice(0, num).map((it) => ({ title: it.title ?? '', url: it.url ?? '', snippet: it.snippet ?? '' }))
  } catch {
    return []
  }
}
