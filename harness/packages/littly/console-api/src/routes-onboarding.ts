/**
 * 引导（onboarding）端点：首启配置向导的后端。
 *
 * 设计目标（用户要求「启动时有一个完整引导配置界面的全新前端」）：
 * - 让首次部署的用户在控制台里一次走完：模型连接 → 她是谁 → 记忆/主动性 → 接入微信 → 完成；
 * - 每一步都可独立完成、可跳过、可回访；状态存 global_settings['onboarding']；
 * - 所有写入都落到既有配置真相源（ai.api.* / bots 行 / 各渠道字段），不引入第二套配置。
 *
 * 与既有接口的关系：
 * - 模型配置的读写真相源仍是 `ai.api.*`（llm/config.ts 的 KV_KEYS），这里只做「一次写多项 + 测连接」。
 * - 播种仍走 `seed.ts` 的 ensureSeed（首次打开控制台自动建「小璃」的技能保留）。
 */
import type { LittlyStorage } from '@littly/storage'
import { invalidateAIConfigCache } from '@littly/llm'
import { json, bodyRecord, reqStr } from './http.ts'
import { ensureSeed } from './seed.ts'
import type { Deps, RegisterFn } from './deps.ts'

/** global_settings 里的引导状态键。 */
export const ONBOARDING_KEY = 'onboarding'

export interface OnboardingState {
  completed: boolean
  completedAt?: string
  /** 首次完成时间（幂等重放不覆盖）。 */
  startedAt?: string
}

interface BotLite {
  id: string
  name: string
  system_prompt: string
  character_id: string | null
  ai_model: string
  wx_enabled: number
  wx_hub_bot_id: string
  wx_push_token: string
  wx_friend_qrcode: string
}

function readState(d: Deps): OnboardingState {
  const raw = d.storage.getSetting(ONBOARDING_KEY)
  if (raw === null || raw === '') return { completed: false }
  try {
    const j = JSON.parse(raw) as Record<string, unknown>
    return {
      completed: j['completed'] === true,
      ...(typeof j['completedAt'] === 'string' ? { completedAt: j['completedAt'] } : {}),
      ...(typeof j['startedAt'] === 'string' ? { startedAt: j['startedAt'] } : {}),
    }
  } catch {
    return { completed: false }
  }
}

function writeState(d: Deps, state: OnboardingState): void {
  const now = new Date().toISOString()
  const merged: OnboardingState = {
    completed: state.completed,
    startedAt: state.startedAt ?? now,
    ...(state.completedAt !== undefined ? { completedAt: state.completedAt } : {}),
  }
  d.storage.setSetting(ONBOARDING_KEY, JSON.stringify(merged))
}

function firstBot(d: Deps): BotLite | undefined {
  return d.storage
    .prepare(
      'SELECT id, name, system_prompt, character_id, ai_model, wx_enabled, wx_hub_bot_id, wx_push_token, wx_friend_qrcode FROM bots ORDER BY created_at ASC LIMIT 1',
    )
    .get() as BotLite | undefined
}

/** 模型步骤是否已就绪：baseUrl + apiKey + chatModel 三件齐（DB 优先，env 兜底）。 */
function modelReady(storage: LittlyStorage): boolean {
  const get = (key: string, env: string): string => {
    const v = storage.getSetting(key)
    if (v !== null && v !== '') return v
    return process.env[env] ?? ''
  }
  const baseUrl = get('ai.api.base_url', 'OPENAI_BASE_URL') || 'https://openrouter.ai/api/v1'
  const apiKey = get('ai.api.api_key', 'OPENAI_API_KEY')
  const chatModel = get('ai.api.chat_model', 'OPENAI_CHAT_MODEL')
  return baseUrl !== '' && apiKey !== '' && chatModel !== ''
}

/** 微信步骤是否已就绪：bots 上已有 iLink 凭据（绑定成功）或旧桥接配置。 */
function wechatReady(bot: BotLite | undefined): boolean {
  if (bot === undefined) return false
  return (
    bot.wx_hub_bot_id !== '' ||
    bot.wx_push_token !== '' ||
    bot.wx_friend_qrcode !== ''
  )
}

function stepsOf(d: Deps, bot: BotLite | undefined): Record<string, boolean> {
  return {
    model: modelReady(d.storage),
    persona: bot !== undefined && (bot.system_prompt.trim() !== '' || (bot.character_id ?? '') !== ''),
    wechat: wechatReady(bot),
  }
}

/** 让 seed 先跑一遍（幂等）：首启即有小璃/铁律/角色卡/世界书。 */
function ensureSeeded(d: Deps): { seeded: boolean; botId?: string } {
  try {
    const result = ensureSeed(d)
    const botId = result.botId ?? firstBot(d)?.id
    return { seeded: result.seeded === true, ...(botId !== undefined ? { botId } : {}) }
  } catch {
    return { seeded: false }
  }
}

/** 解析模型探测目标：请求体优先，否则回落到已存配置/env。 */
function resolveProbeTarget(storage: LittlyStorage, body: Record<string, unknown>): {
  baseUrl: string
  apiKey: string
  model: string
} {
  const stored = (key: string, env: string): string => {
    const v = storage.getSetting(key)
    if (v !== null && v !== '') return v
    return process.env[env] ?? ''
  }
  const baseUrl = reqStr(body, 'baseUrl', 'base_url') ?? stored('ai.api.base_url', 'OPENAI_BASE_URL') ?? 'https://openrouter.ai/api/v1'
  const apiKey = reqStr(body, 'apiKey', 'api_key') ?? stored('ai.api.api_key', 'OPENAI_API_KEY') ?? ''
  const model = reqStr(body, 'model', 'chatModel', 'chat_model') ?? stored('ai.api.chat_model', 'OPENAI_CHAT_MODEL') ?? ''
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, model }
}

/** POST /api/onboarding/test-model 的实现：发一条最小 chat completion。 */
async function probeModel(target: { baseUrl: string; apiKey: string; model: string }): Promise<{
  ok: boolean
  latencyMs: number
  model: string
  error?: string
}> {
  const started = Date.now()
  const finish = (ok: boolean, error?: string): { ok: boolean; latencyMs: number; model: string; error?: string } => ({
    ok,
    latencyMs: Date.now() - started,
    model: target.model,
    ...(error !== undefined ? { error } : {}),
  })
  if (target.apiKey === '') return finish(false, '缺少 API Key')
  if (target.model === '') return finish(false, '缺少模型名')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const res = await fetch(`${target.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${target.apiKey}`,
      },
      body: JSON.stringify({
        model: target.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8,
        temperature: 0,
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      // 上游错误体可能很长：只留前 300 字，避免把整页日志塞进控制台
      return finish(false, `HTTP ${res.status}${text !== '' ? `：${text.slice(0, 300)}` : ''}`)
    }
    await res.json().catch(() => null)
    return finish(true)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return finish(false, message.includes('abort') ? '请求超时（20s）' : message)
  } finally {
    clearTimeout(timer)
  }
}

/** 写入模型配置（与 routes-admin 的 applyAiSettings 同一批 KV，不引入新键）。 */
function applyModelSettings(storage: LittlyStorage, body: Record<string, unknown>): void {
  const put = (key: string, ...aliases: string[]): void => {
    const value = reqStr(body, key, ...aliases)
    if (value !== undefined) storage.setSetting(key, value)
  }
  put('ai.api.base_url', 'baseUrl')
  put('ai.api.api_key', 'apiKey')
  put('ai.api.chat_model', 'chatModel', 'model')
  put('ai.api.embedding_model', 'embeddingModel')
  put('ai.api.embedding_base_url', 'embeddingBaseUrl')
  put('ai.api.embedding_api_key', 'embeddingApiKey')
  put('ai.api.growth_model', 'growthModel')
  put('ai.api.image_base_url', 'imageBaseUrl')
  put('ai.api.image_model', 'imageModel')
  put('ai.api.image_api_key', 'imageApiKey')
}

export const registerOnboardingRoutes: RegisterFn = (r, d: Deps): void => {
  /** 引导状态 + 每步是否已就绪 + 首个 bot。 */
  r.get('/api/onboarding', 'required', (ctx) => {
    let state = readState(d)
    // 老实例兼容：从未写过 onboarding 状态、但库里已经有 bot/角色卡且模型已配置 →
    // 视为「早已完成引导」，不再强制新用户在已配置好的实例上重走一遍（避免重复建角色卡）。
    // 显式重置（/api/onboarding/reset）会写入 key，因此不会再次命中这条推断。
    if (d.storage.getSetting(ONBOARDING_KEY) === null) {
      const existing = firstBot(d)
      const configured =
        existing !== undefined &&
        (existing.system_prompt.trim() !== '' || (existing.character_id ?? '') !== '') &&
        modelReady(d.storage)
      if (configured) state = { ...state, completed: true }
    }
    const bot = firstBot(d)
    json(ctx.res, 200, {
      data: {
        ...state,
        steps: stepsOf(d, bot),
        ...(bot !== undefined ? { botId: bot.id, botName: bot.name } : {}),
      },
    })
  })

  /** 测试模型连接（不落库：用户点「下一步」时才 apply）。 */
  r.post('/api/onboarding/test-model', 'required', async (ctx) => {
    const body = bodyRecord(ctx.body)
    const target = resolveProbeTarget(d.storage, body)
    const result = await probeModel(target)
    if (!result.ok) {
      json(ctx.res, 200, { data: result })
      return
    }
    json(ctx.res, 200, { data: result })
  })

  /** 一次性写入模型配置（引导第 2 步）；admin 才可写，避免普通用户改全局模型。 */
  r.post('/api/onboarding/apply', 'admin', (ctx) => {
    const body = bodyRecord(ctx.body)
    applyModelSettings(d.storage, body)
    // 模型/密钥可能变化 → 立刻失效 llm 的 30s 缓存
    invalidateAIConfigCache()
    const seeded = ensureSeeded(d)
    json(ctx.res, 200, {
      data: {
        ...readState(d),
        steps: stepsOf(d, firstBot(d)),
        seeded: seeded.seeded,
        ...(seeded.botId !== undefined ? { botId: seeded.botId } : {}),
      },
    })
  })

  /** 完成引导：幂等；已完成的重复调用不覆盖 completedAt。 */
  r.post('/api/onboarding/complete', 'required', (ctx) => {
    const state = readState(d)
    if (!state.completed) {
      writeState(d, { completed: true, completedAt: new Date().toISOString(), ...(state.startedAt !== undefined ? { startedAt: state.startedAt } : {}) })
    }
    const bot = firstBot(d)
    json(ctx.res, 200, {
      data: {
        ...readState(d),
        steps: stepsOf(d, bot),
        ...(bot !== undefined ? { botId: bot.id, botName: bot.name } : {}),
      },
    })
  })

  /** 重新走引导（管理员）：清 completed 位，不删任何配置/数据。 */
  r.post('/api/onboarding/reset', 'admin', (ctx) => {
    d.storage.setSetting(ONBOARDING_KEY, JSON.stringify({ completed: false, startedAt: new Date().toISOString() }))
    json(ctx.res, 200, { data: readState(d) })
  })
}
