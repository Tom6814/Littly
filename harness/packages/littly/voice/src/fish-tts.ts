/**
 * Fish Audio TTS 客户端（旧 voice/fish-tts.ts 忠实移植）。
 * 端点 POST https://api.fish.audio/v1/tts，model 走请求头，响应为二进制音频。
 */

export type FishLatency = 'low' | 'normal' | 'balanced'

export interface FishTTSOptions {
  apiKey: string
  /** header model，默认 s2.1-pro-free（免费开发者档） */
  model?: string
  /** 音色模型 ID（每角色独立）；空则交给服务端 */
  referenceId?: string
  /** 0~1，越高越有表现力（波动），默认 0.7 */
  temperature?: number
  /** 语速 0.5~2，默认 1 */
  speed?: number
  format?: 'mp3' | 'wav' | 'pcm' | 'opus'
  /** low=最快（音质略降） | normal | balanced=均衡（默认） */
  latency?: FishLatency
}

const FISH_TTS_URL = 'https://api.fish.audio/v1/tts'

export async function fishTTS(text: string, opts: FishTTSOptions): Promise<Buffer> {
  if (!opts.apiKey) throw new Error('Fish Audio API Key 未配置')
  if (!text.trim()) throw new Error('Fish TTS 文本为空')

  const body: Record<string, unknown> = {
    text,
    temperature: opts.temperature ?? 0.7,
    top_p: 0.7,
    normalize: true,
    format: opts.format ?? 'mp3',
    chunk_length: 200,
    latency: opts.latency ?? 'balanced',
    prosody: { speed: opts.speed ?? 1 },
  }
  if (opts.referenceId) body.reference_id = opts.referenceId

  const res = await fetch(FISH_TTS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
      model: opts.model ?? 's2.1-pro-free',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Fish TTS 失败 (${res.status}): ${detail.slice(0, 200)}`)
  }

  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length) throw new Error('Fish TTS 返回空音频')
  return buf
}

/** 流式 TTS（通话用）：chunked MP3 字节流；signal 可中断（用户打断时 abort）。 */
export async function streamFishAudio(
  text: string,
  opts: FishTTSOptions & { sampleRate?: number },
  onChunk: (buf: Buffer) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!opts.apiKey) throw new Error('Fish Audio API Key 未配置')
  if (!text.trim()) throw new Error('Fish TTS 文本为空')

  const body: Record<string, unknown> = {
    text,
    temperature: opts.temperature ?? 0.7,
    top_p: 0.7,
    normalize: true,
    format: 'mp3',
    sample_rate: opts.sampleRate ?? 44100,
    mp3_bitrate: 128,
    chunk_length: 300,
    min_chunk_length: 50,
    condition_on_previous_chunks: true,
    latency: opts.latency ?? 'balanced',
    prosody: { speed: opts.speed ?? 1 },
  }
  if (opts.referenceId) body.reference_id = opts.referenceId

  const res = await fetch(FISH_TTS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
      model: opts.model ?? 's2.1-pro-free',
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Fish TTS 失败 (${res.status}): ${detail.slice(0, 200)}`)
  }
  const reader = res.body?.getReader()
  if (!reader) throw new Error('Fish TTS 无可读流')
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value && value.length) onChunk(Buffer.from(value))
  }
}

/** S2 情感标签白名单（[bracket] 语法） */
export const TTS_EMOTIONS = ['happy', 'excited', 'calm', 'gentle', 'sad', 'angry', 'surprised', 'laughing', 'whisper', 'sigh'] as const
export type TtsEmotion = (typeof TTS_EMOTIONS)[number]

/** 校验语气AI返回的情感标签是否在白名单内（防注入任意文本） */
export function normalizeEmotion(raw: string | null | undefined): string | null {
  if (!raw) return null
  const tag = raw.trim().replace(/^\[|\]$/g, '').toLowerCase()
  return (TTS_EMOTIONS as readonly string[]).includes(tag) ? tag : null
}
