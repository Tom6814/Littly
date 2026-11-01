/**
 * 相册语义分析：用 bot 自己的视觉模型给照片打 caption / tags / category。
 *
 * - 只走 OpenAI 兼容 `POST {baseUrl}/chat/completions`（image_url data URL）；
 *   配置取 bots.ai_vision_*，空串回落到全局 ai.api.*（与 @littly/llm 的解析一致）。
 * - 输出严格 JSON；解析失败 / 单张网络失败都只写该照片的 semantic_status=failed，
 *   不影响批处理里的其它照片。
 * - 视觉函数可注入（`vision` 入参），验收脚本据此完全不发网络请求。
 */
import { readFileSync } from 'node:fs'
import { basename, extname, resolve, sep } from 'node:path'
import { downloadsDir, type BotRow, type LittlyStorage, type PhotoRow } from '@littly/storage'
import { getAIConfig } from '@littly/llm'
import type { Deps } from './deps.ts'

/** 相册分类小集合（控制台筛选与 tag_photo 共用同一套语义）。 */
export const PHOTO_CATEGORIES = ['开心', '无语', '撒娇', '生气', '可爱', '日常', '其他'] as const
export type PhotoCategory = (typeof PHOTO_CATEGORIES)[number]

export interface SemanticPayload {
  caption: string
  tags: string[]
  category: PhotoCategory
  mood: string
}

export interface VisionConfig {
  baseUrl: string
  apiKey: string
  model: string
}

export interface VisionRequest {
  bot: BotRow
  /** data URL（本地相册文件）或 http(s) URL（生成图外链）。 */
  imageUrl: string
}

/** 视觉模型调用：返回模型原始文本（应为严格 JSON）。 */
export type VisionRunner = (request: VisionRequest) => Promise<string>

export interface AnalyzeParams {
  botId: string
  ids?: string[] | undefined
  limit?: number | undefined
  /** 验收/测试注入；生产走 bot 的视觉配置。 */
  vision?: VisionRunner | undefined
}

export interface AnalyzeResult {
  analyzed: number
  failed: number
  skipped: number
  configured: boolean
  errors: Array<{ id: string; error: string }>
}

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 100
const MAX_TAGS = 8
const MAX_CAPTION = 300

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPhotoCategory(value: string): value is PhotoCategory {
  return (PHOTO_CATEGORIES as readonly string[]).includes(value)
}

/**
 * 解析视觉模型输出。容忍 ```json 围栏与前后闲话，但结构必须合法：
 * caption 非空字符串 / tags 数组 / category 字符串 / mood 字符串。
 */
export function parseSemanticPayload(text: string): SemanticPayload {
  const raw = text.trim()
  if (raw === '') throw new Error('视觉模型返回为空')
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  const body = fenced?.[1] ?? raw
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('视觉模型没有返回 JSON 对象')
  let parsed: unknown
  try {
    parsed = JSON.parse(body.slice(start, end + 1)) as unknown
  } catch {
    throw new Error('视觉模型返回的 JSON 解析失败')
  }
  if (!isRecord(parsed)) throw new Error('视觉模型返回的不是 JSON 对象')
  const caption = typeof parsed['caption'] === 'string' ? parsed['caption'].trim() : ''
  if (caption === '') throw new Error('视觉模型返回缺少 caption')
  if (!Array.isArray(parsed['tags'])) throw new Error('视觉模型返回缺少 tags 数组')
  if (typeof parsed['category'] !== 'string') throw new Error('视觉模型返回缺少 category')
  if (typeof parsed['mood'] !== 'string') throw new Error('视觉模型返回缺少 mood')

  const tags: string[] = []
  for (const item of parsed['tags']) {
    if (typeof item !== 'string') continue
    const tag = item.trim()
    if (tag !== '' && !tags.includes(tag)) tags.push(tag)
    if (tags.length >= MAX_TAGS) break
  }
  const categoryRaw = (parsed['category'] as string).trim()
  // 超出小集合的分类归一为「其他」，避免脏值污染筛选器。
  const category: PhotoCategory = isPhotoCategory(categoryRaw) ? categoryRaw : '其他'
  const mood = (parsed['mood'] as string).trim().slice(0, 20)
  return { caption: caption.slice(0, MAX_CAPTION), tags, category, mood }
}

/** 构造严格 JSON 的提示词（只约束输出，不引入额外上下文）。 */
export function buildSemanticPrompt(botName: string): string {
  return [
    `你是相册整理助手，正在整理「${botName || '她'}」的相册照片。`,
    '只输出一个 JSON 对象，不要 markdown 代码围栏，不要任何解释。',
    '格式：{"caption":"一句中文描述（谁/在哪/做什么/氛围，30字内）","tags":["3-6个中文关键词"],"category":"分类","mood":"2-6字情绪"}',
    `category 只能从这些里选一个：${PHOTO_CATEGORIES.join('、')}。`,
    'caption 要具体、口语化；tags 是可检索的场景/物件/情绪词；不要编造照片里不存在的信息。',
  ].join('\n')
}

/** bot 视觉配置是否可用（空串回落到全局 AI 配置）。 */
export async function resolveVisionConfig(storage: LittlyStorage, bot: BotRow): Promise<VisionConfig | null> {
  if (bot.ai_vision_enabled !== 1) return null
  let global = { baseUrl: '', apiKey: '', chatModel: '' }
  try {
    global = await getAIConfig(storage)
  } catch {
    // 全局配置读失败不影响 bot 自带配置；下面逐项回退。
  }
  const baseUrl = bot.ai_vision_base_url.trim() !== '' ? bot.ai_vision_base_url.trim() : global.baseUrl
  const apiKey = bot.ai_vision_api_key.trim() !== '' ? bot.ai_vision_api_key.trim() : global.apiKey
  // 视觉模型必须显式配置：不能拿纯文本 chat 模型顶替（它会直接拒图）。
  const model = bot.ai_vision_model.trim()
  if (baseUrl === '' || apiKey === '' || model === '') return null
  return { baseUrl, apiKey, model }
}

/** 把模型返回的 content（string 或分段数组）拍平成文本。 */
function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (isRecord(part) && typeof part['text'] === 'string') return part['text']
        return ''
      })
      .join('')
  }
  return ''
}

/** 真实视觉调用：OpenAI 兼容 chat/completions + image_url。 */
export function createVisionRunner(config: VisionConfig): VisionRunner {
  const base = config.baseUrl.replace(/\/+$/, '')
  const endpoint = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
  return async ({ bot, imageUrl }) => {
    const body = {
      model: config.model,
      temperature: 0.2,
      max_tokens: 500,
      messages: [
        { role: 'system', content: buildSemanticPrompt(bot.name) },
        {
          role: 'user',
          content: [
            { type: 'text', text: '请分析这张照片，并按要求只输出 JSON。' },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        },
      ],
    }
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    })
    const text = await res.text().catch(() => '')
    if (!res.ok) throw new Error(`视觉模型 HTTP ${res.status}: ${text.slice(0, 300)}`)
    let json: unknown
    try {
      json = JSON.parse(text) as unknown
    } catch {
      throw new Error('视觉模型响应不是合法 JSON')
    }
    const choices = isRecord(json) && Array.isArray(json['choices']) ? json['choices'] : []
    const first = choices[0]
    const message = isRecord(first) && isRecord(first['message']) ? first['message'] : null
    const content = flattenContent(message?.['content'])
    if (content.trim() === '') throw new Error('视觉模型没有返回内容')
    return content
  }
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

/** 本地 `/api/photos/file/...` URL → 持久卷绝对路径；防目录穿越。 */
function localPhotoPath(url: string): string | null {
  const prefix = '/api/photos/file/'
  if (!url.startsWith(prefix)) return null
  let rel = url.slice(prefix.length)
  try {
    rel = decodeURIComponent(rel)
  } catch {
    return null
  }
  if (rel.includes('..') || rel.startsWith('/')) return null
  const root = resolve(downloadsDir())
  const abs = resolve(root, rel)
  if (abs !== root && !abs.startsWith(`${root}${sep}`)) return null
  return abs
}

/** 照片 URL → 视觉模型可吃的 image_url（本地文件转 data URL）。 */
export function photoImageUrl(row: PhotoRow): string {
  if (/^https?:\/\//i.test(row.url)) return row.url
  const file = localPhotoPath(row.url)
  if (file === null) throw new Error(`不支持的图片地址：${row.url.slice(0, 120)}`)
  let data: Buffer
  try {
    data = readFileSync(file)
  } catch {
    throw new Error(`照片文件不存在：${basename(file)}`)
  }
  const mime = row.mime !== '' ? row.mime : (MIME_BY_EXT[extname(file).toLowerCase()] ?? 'image/png')
  return `data:${mime};base64,${data.toString('base64')}`
}

function targetRows(d: Deps, params: AnalyzeParams): { rows: PhotoRow[]; skipped: number } {
  const ids = (params.ids ?? []).map((id) => String(id).trim()).filter((id) => id !== '')
  if (ids.length > 0) {
    const unique = [...new Set(ids)].slice(0, MAX_LIMIT)
    const rows: PhotoRow[] = []
    let skipped = 0
    for (const id of unique) {
      const row = d.storage.prepare('SELECT * FROM photos WHERE id = ? AND bot_id = ?').get(id, params.botId) as PhotoRow | undefined
      if (row === undefined) skipped += 1
      else rows.push(row)
    }
    return { rows, skipped }
  }
  const requested = Number.isFinite(params.limit) ? Number(params.limit) : DEFAULT_LIMIT
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(requested || DEFAULT_LIMIT)))
  const rows = d.storage
    .prepare("SELECT * FROM photos WHERE bot_id = ? AND semantic_status != 'done' ORDER BY created_at DESC LIMIT ?")
    .all(params.botId, limit) as PhotoRow[]
  return { rows, skipped: 0 }
}

/**
 * 批量分析入口。单张失败只写该行的 failed 状态，继续下一张。
 * 返回 {analyzed, failed, skipped, configured, errors}；未配置视觉模型时 configured=false。
 */
export async function analyzePhotos(d: Deps, params: AnalyzeParams): Promise<AnalyzeResult> {
  const bot = d.persona.loadBot(params.botId)
  if (bot === null) throw new Error('机器人不存在')
  const { rows, skipped } = targetRows(d, params)
  const resolvedRunner: VisionRunner | null =
    params.vision !== undefined
      ? params.vision
      : await (async (): Promise<VisionRunner | null> => {
          const config = await resolveVisionConfig(d.storage, bot)
          return config === null ? null : createVisionRunner(config)
        })()
  if (resolvedRunner === null) {
    return { analyzed: 0, failed: 0, skipped: skipped + rows.length, configured: false, errors: [] }
  }

  let analyzed = 0
  let failed = 0
  const errors: Array<{ id: string; error: string }> = []
  for (const row of rows) {
    d.storage
      .prepare("UPDATE photos SET semantic_status = 'pending', semantic_error = '' WHERE id = ? AND bot_id = ?")
      .run(row.id, params.botId)
    try {
      const imageUrl = photoImageUrl(row)
      const text = await resolvedRunner({ bot, imageUrl })
      const payload = parseSemanticPayload(text)
      d.storage
        .prepare(
          "UPDATE photos SET caption = ?, tags = ?, category = ?, semantic_status = 'done', semantic_at = ?, semantic_error = '' WHERE id = ? AND bot_id = ?",
        )
        .run(payload.caption, JSON.stringify(payload.tags), payload.category, new Date().toISOString(), row.id, params.botId)
      analyzed += 1
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500)
      d.storage
        .prepare("UPDATE photos SET semantic_status = 'failed', semantic_error = ? WHERE id = ? AND bot_id = ?")
        .run(message, row.id, params.botId)
      failed += 1
      errors.push({ id: row.id, error: message })
    }
  }
  return { analyzed, failed, skipped, configured: true, errors }
}

/** 上传后 fire-and-forget 的后台分析入口（不阻塞 HTTP 响应）。 */
export function scheduleSemanticAnalysis(d: Deps, botId: string, photoId: string): void {
  void analyzePhotos(d, { botId, ids: [photoId] })
    .then((result) => {
      if (result.failed > 0) d.log('[photos] 语义分析失败 bot=%s photo=%s: %s', botId, photoId, result.errors[0]?.error ?? '')
    })
    .catch((error: unknown) => {
      d.log('[photos] 语义分析异常 bot=%s photo=%s: %s', botId, photoId, String(error))
    })
}
