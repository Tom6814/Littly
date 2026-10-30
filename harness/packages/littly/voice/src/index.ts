/**
 * 语音消息三轮流水线（旧 voice/pipeline.ts 忠实移植）：
 * 上下文提取AI → 语气AI判定/改写（语气门已收窄：只按技术可读性判退）→ Fish TTS。
 * 任何失败静默回落文字（fail-open），绝不阻塞聊天管道。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { downloadsDir, type LittlyStorage } from '@littly/storage'
import { chatComplete } from '@littly/llm'
import { fishTTS, normalizeEmotion, type FishLatency } from './fish-tts.ts'

export interface VoiceBotConfig {
  ai_voice_enabled: number
  ai_voice_model: string
  ai_voice_reference_id: string
  ai_voice_api_key: string
  ai_voice_temperature: number
  ai_voice_speed: number
}

export interface VoicePipelineInput {
  bot: VoiceBotConfig
  /** 角色AI产出的完整回复（已 fixParenPerson） */
  finalReply: string
  /** 干净的历史（仅 user/assistant，正序）：{ role, content } */
  history: Array<{ role: string; content: string }>
  /** 用户本条消息 */
  currentText: string
}

export interface VoiceOutcome {
  useVoice: boolean
  /** 实际朗读文本（voiceText）；不用语音时为空 */
  text: string
  /** 相对路径 /api/photos/file/audio/xxx.mp3；不用语音时为空 */
  audioUrl: string
  emotion: string | null
}

const CONTEXT_WINDOW = 8
const RAW_CONTEXT_CHARS = 500
const COMPRESSED_CONTEXT_CHARS = 120

/** 语气门系统提示词（契约回归锁定：短/冷/碎片不得作为拒绝理由） */
export const TONE_SYSTEM_PROMPT = `你是语音消息改写器。我会给你【对话上下文】和【角色刚才的回复】。
你只做两件事：
1. 判断这条回复是否适合用「语音」发送。
2. 若适合，把回复改写成一段自然连贯的口语化句子：把被拆成短行的微信式分行还原成一句通顺的话，并按情绪补上 1~2 个中文口语语音词（例如：嘛、啦、嗯、哎、啊、呀、噗、啧、喔、诶），让它在语音里像真人说话。

默认用「语音」。她说话的口吻由她自己的性格决定，不由你评判——短句、碎片、冷淡、敷衍、随口一句、只回一个「嗯」「哼」，这些都很适合语音，照原意改写成口语即可，不要因为「太短」「太冷」就退回文字。

只有『技术上念不出来』才退回文字（保持原样，不改写）：
- 含链接、网址或其它非纯文本内容；
- 含代码、命令、程序输出等技术字符；
- 整条没有任何可朗读的文字，只有符号、表情或 emoji；
- 整条只有一个括号动作、完全没有正文（如「（摸摸头）」）。

输出要求：
- 只输出一个 JSON 对象，不要 markdown 代码块，不要任何其它文字。
- 结构：{"useVoice": true 或 false, "text": "改写后的句子（不用语音时填空字符串）", "emotion": "happy|excited|calm|gentle|sad|angry|surprised|laughing|whisper|sigh 或 null"}
- emotion 从给定列表挑最贴近的一个；拿不准就 null。
- 不用语音时 useVoice 必须为 false。`

export async function runVoicePipeline(
  storage: LittlyStorage,
  input: VoicePipelineInput,
  cwd: string,
): Promise<VoiceOutcome> {
  const negative: VoiceOutcome = { useVoice: false, text: '', audioUrl: '', emotion: null }
  try {
    const { bot, finalReply, history, currentText } = input
    if (!bot.ai_voice_enabled || !finalReply.trim()) return negative

    const context = await extractVoiceContext(storage, history, currentText)
    const decision = await toneDecide(storage, context, finalReply, bot.ai_voice_model || undefined)
    if (!decision.useVoice || !decision.text.trim()) return negative

    const emotion = normalizeEmotion(decision.emotion)
    const apiKey = bot.ai_voice_api_key || process.env.FISH_AUDIO_API_KEY || ''
    if (!apiKey) return negative

    const ttsText = emotion ? `[${emotion}] ${decision.text.trim()}` : decision.text.trim()
    const buf = await fishTTS(ttsText, {
      apiKey,
      model: bot.ai_voice_model || 's2.1-pro-free',
      ...(bot.ai_voice_reference_id ? { referenceId: bot.ai_voice_reference_id } : {}),
      temperature: bot.ai_voice_temperature ?? 0.7,
      speed: bot.ai_voice_speed ?? 1,
      latency: 'balanced' as FishLatency,
    })
    const url = saveAudioFile(buf, cwd)
    return { useVoice: true, text: decision.text.trim(), audioUrl: url, emotion }
  } catch (e) {
    console.warn('[voice] pipeline failed, fallback to text:', e instanceof Error ? e.message : e)
    return negative
  }
}

// ── 1. 上下文提取（绝不接收工具数据；只格式化 role + content）──
function formatContext(history: Array<{ role: string; content: string }>, currentText: string): string {
  const recent = history.slice(-CONTEXT_WINDOW)
  const lines = recent.map((m) => `[${m.role === 'user' ? '对方' : '我'}] ${m.content}`)
  const lastUser = [...recent].reverse().find((m) => m.role === 'user')
  if (lastUser?.content !== currentText) lines.push(`[对方] ${currentText}`)
  return lines.join('\n')
}

async function extractVoiceContext(storage: LittlyStorage, history: Array<{ role: string; content: string }>, currentText: string): Promise<string> {
  const raw = formatContext(history, currentText)
  if (!raw) return currentText
  if (raw.length <= RAW_CONTEXT_CHARS) return raw
  try {
    const res = await chatComplete(storage, [
      {
        role: 'system',
        content:
          '你是对话上下文提炼器。给定一段聊天记录（[对方]/[我] 交替），提炼出对「此刻要如何回应」最关键的信息：' +
          '双方在聊什么话题、当前情绪氛围、对方刚说的核心意思、之前有没有约定或关系进展。' +
          `输出 ${COMPRESSED_CONTEXT_CHARS} 字以内的中文短文，只输出正文，不要任何标签、标题或代码块。`,
      },
      { role: 'user', content: `【聊天记录】\n${raw}` },
    ], { temperature: 0.3, maxTokens: 300 })
    return res.content?.trim() || raw.slice(-RAW_CONTEXT_CHARS)
  } catch {
    return raw.slice(-RAW_CONTEXT_CHARS)
  }
}

// ── 2. 语气AI 判定 + 改写 ──
async function toneDecide(storage: LittlyStorage, context: string, finalReply: string, model?: string): Promise<{ useVoice: boolean; text: string; emotion: string | null }> {
  const negative = { useVoice: false, text: '', emotion: null }
  try {
    const res = await chatComplete(storage, [
      { role: 'system', content: TONE_SYSTEM_PROMPT },
      { role: 'user', content: `【最近聊天上下文】\n${context}\n\n【角色刚才的回复】\n${finalReply}\n\n请输出判定 JSON。` },
    ], { model, temperature: 0.5, maxTokens: 400 })
    const raw = res.content?.trim() ?? ''
    const obj = extractJson(raw)
    if (!obj) return negative
    const text = typeof obj.text === 'string' ? obj.text.trim() : ''
    const useVoice = obj.useVoice === true && !!text
    const emotion = normalizeEmotion(typeof obj.emotion === 'string' ? obj.emotion : null)
    return { useVoice, text, emotion }
  } catch (e) {
    console.warn('[voice] toneDecide failed:', e instanceof Error ? e.message : e)
    return negative
  }
}

function extractJson(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// ── 3. 存盘 ──
export function saveAudioFile(buf: Buffer, _cwd: string): string {
  // B11：落持久卷（LITTLY_DATA_DIR/downloads/audio），URL 不变。
  const dir = join(downloadsDir(), 'audio')
  mkdirSync(dir, { recursive: true })
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`
  writeFileSync(join(dir, filename), buf)
  return `/api/photos/file/audio/${filename}`
}
