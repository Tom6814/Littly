/**
 * 「当前她」（bot）的全局选择状态 —— 模块级单例，与 auth store 同风格。
 * 所有按 botId 查询的页面（记忆/世界书/联系人/渠道/对话…）都从这里取当前 bot，
 * 保证 AppShell 的切换器与页面看到的是同一份状态。
 */
import { computed, reactive } from 'vue'
import { botsApi } from '@/api/endpoints'
import type { Bot } from '@/api/types'

const LS_KEY = 'littly.currentBotId'

function readStored(): string | null {
  try {
    return localStorage.getItem(LS_KEY)
  } catch {
    return null
  }
}

const state = reactive({
  bots: [] as Bot[],
  currentBotId: readStored() as string | null,
  ready: false,
  loading: false,
  error: '',
})

let bootstrapTask: Promise<void> | null = null

function setCurrent(id: string): void {
  if (!id) return
  state.currentBotId = id
  try {
    localStorage.setItem(LS_KEY, id)
  } catch {
    /* storage unavailable — 会话内仍然生效 */
  }
}

/** 取不到列表时也不抛错：页面用 currentBotId 可能为 null 自行处理空态。 */
async function bootstrap(): Promise<void> {
  if (state.ready) return
  if (bootstrapTask) return bootstrapTask
  bootstrapTask = (async () => {
    state.loading = true
    state.error = ''
    try {
      state.bots = await botsApi.list()
      const stored = state.currentBotId
      const valid = stored !== null && state.bots.some((b) => b.id === stored)
      if (!valid) {
        const first = state.bots[0]
        state.currentBotId = first?.id ?? null
        if (first) {
          try {
            localStorage.setItem(LS_KEY, first.id)
          } catch {
            /* ignore */
          }
        }
      }
      state.ready = true
    } catch (e) {
      state.error = e instanceof Error ? e.message : '加载 bot 列表失败'
    } finally {
      state.loading = false
      bootstrapTask = null
    }
  })()
  return bootstrapTask
}

/**
 * 强制重新拉取（后端在首次 /api/chat 时才播种默认 bot，因此首发消息后需要
 * 刷新一次才能拿到新 bot 的 id，否则后续消息与实时流都没有 botId 可用）。
 */
async function refresh(): Promise<void> {
  state.ready = false
  bootstrapTask = null
  await bootstrap()
}

/** 换账号后重置（页面/守卫不需要主动调，AppShell 登出时调）。 */
function reset(): void {
  state.bots = []
  state.currentBotId = null
  state.ready = false
  state.error = ''
}

export function useBots() {
  const currentBotId = computed(() => state.currentBotId)
  const currentBot = computed(() => state.bots.find((b) => b.id === state.currentBotId) ?? null)
  return {
    state,
    bots: computed(() => state.bots),
    currentBotId,
    currentBot,
    bootstrap,
    refresh,
    setCurrent,
    reset,
  }
}
