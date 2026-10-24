/**
 * 配置解析：DB GlobalSetting(ai.api.*) → 环境变量(OPENAI_*) → 内置默认。
 * 旧 ai/client.ts:7-101 逐字移植；30s 内存缓存，写后主动失效。
 */
import type { LittlyStorage } from '@littly/storage'

export interface LittlyAIConfig {
  baseUrl: string
  apiKey: string
  chatModel: string
  growthModel: string
  embeddingModel: string
  embeddingBaseUrl: string
  embeddingApiKey: string
  imageBaseUrl: string
  imageModel: string
  imageApiKey: string
  webSearch: string
}

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'

const KV_KEYS = {
  baseUrl: 'ai.api.base_url',
  apiKey: 'ai.api.api_key',
  chatModel: 'ai.api.chat_model',
  growthModel: 'ai.api.growth_model',
  embeddingModel: 'ai.api.embedding_model',
  embeddingBaseUrl: 'ai.api.embedding_base_url',
  embeddingApiKey: 'ai.api.embedding_api_key',
  imageBaseUrl: 'ai.api.image_base_url',
  imageModel: 'ai.api.image_model',
  imageApiKey: 'ai.api.image_api_key',
  webSearch: 'ai.api.web_search',
} as const

function envFor(key: keyof typeof KV_KEYS): string {
  const map: Record<keyof typeof KV_KEYS, string> = {
    baseUrl: 'OPENAI_BASE_URL',
    apiKey: 'OPENAI_API_KEY',
    chatModel: 'OPENAI_CHAT_MODEL',
    growthModel: 'OPENAI_GROWTH_MODEL',
    embeddingModel: 'OPENAI_EMBEDDING_MODEL',
    embeddingBaseUrl: 'OPENAI_EMBEDDING_BASE_URL',
    embeddingApiKey: 'OPENAI_EMBEDDING_API_KEY',
    imageBaseUrl: 'OPENAI_IMAGE_BASE_URL',
    imageModel: 'OPENAI_IMAGE_MODEL',
    imageApiKey: 'OPENAI_IMAGE_API_KEY',
    webSearch: 'OPENAI_WEB_SEARCH',
  }
  return process.env[map[key]] ?? ''
}

let cache: { config: LittlyAIConfig; at: number } | null = null
const CACHE_TTL_MS = 30_000

export function invalidateAIConfigCache(): void {
  cache = null
}

export async function getAIConfig(storage: LittlyStorage): Promise<LittlyAIConfig> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.config
  const get = (key: keyof typeof KV_KEYS): string => {
    const v = storage.getSetting(KV_KEYS[key])
    if (v !== null && v !== '') return v
    return envFor(key)
  }
  const config: LittlyAIConfig = {
    baseUrl: get('baseUrl') || DEFAULT_BASE_URL,
    apiKey: get('apiKey'),
    chatModel: get('chatModel'),
    growthModel: get('growthModel'),
    embeddingModel: get('embeddingModel'),
    embeddingBaseUrl: get('embeddingBaseUrl') || get('baseUrl') || DEFAULT_BASE_URL,
    embeddingApiKey: get('embeddingApiKey') || get('apiKey'),
    imageBaseUrl: get('imageBaseUrl'),
    imageModel: get('imageModel'),
    imageApiKey: get('imageApiKey') || get('apiKey'),
    webSearch: get('webSearch'),
  }
  cache = { config, at: Date.now() }
  return config
}

/** 旧 client.ts:104-111 — GLM 系模型名替换 hack：bot 指定 glm-* 而全局模型不是时，跟随全局。 */
export function resolveModel(botModel: string | undefined, globalModel: string): string {
  if (botModel && /^glm/i.test(botModel) && globalModel && !/^glm/i.test(globalModel)) {
    return globalModel
  }
  return botModel || globalModel || ''
}

/** 旧 client.ts:145-154 — 简单重试：退避 600ms ×2^n。 */
export async function withRetry<T>(fn: () => Promise<T>, retries = 1): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 600 * 2 ** attempt))
      }
    }
  }
  throw lastErr
}
