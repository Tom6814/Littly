/**
 * 首次引导状态。
 * 后端 `GET /api/onboarding` 由 bugfix 实现中；接口未就绪（404/网络失败）时
 * 降级到 localStorage，保证引导流程可走通、不阻塞前端交付。
 */
import { computed, reactive } from 'vue'
import { onboardingApi } from '@/api/endpoints'
import type { OnboardingState, TestModelResult } from '@/api/types'

const LS_KEY = 'littly.onboarding.v1'

const state = reactive({
  completed: false,
  steps: { model: false, persona: false, wechat: false } as Required<OnboardingState['steps']>,
  /** api = 真接口；mock = 本地降级 */
  source: 'mock' as 'api' | 'mock',
  ready: false,
  loading: false,
})

function readLocal(): OnboardingState | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as OnboardingState
    if (typeof parsed === 'object' && parsed !== null) return parsed
  } catch {
    /* ignore corrupted local state */
  }
  return null
}

function applyLocal(ob: OnboardingState): void {
  state.completed = ob.completed
  state.steps = {
    model: ob.steps?.model ?? false,
    persona: ob.steps?.persona ?? false,
    wechat: ob.steps?.wechat ?? false,
  }
}

function persistLocal(): void {
  try {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        completed: state.completed,
        steps: state.steps,
        completedAt: state.completed ? new Date().toISOString() : undefined,
      }),
    )
  } catch {
    /* storage unavailable — 引导仍可继续，只是不记忆 */
  }
}

let bootstrapTask: Promise<void> | null = null

async function bootstrap(): Promise<void> {
  if (state.ready) return
  if (bootstrapTask) return bootstrapTask
  bootstrapTask = (async () => {
    state.loading = true
    const local = readLocal()
    try {
      const remote = await onboardingApi.get()
      applyLocal(remote)
      state.source = 'api'
    } catch {
      // 契约接口尚未就绪：用本地状态兜底
      if (local) applyLocal(local)
      state.source = 'mock'
    } finally {
      state.ready = true
      state.loading = false
      bootstrapTask = null
    }
  })()
  return bootstrapTask
}

/** 标记某一步已完成（模型连接 / 人格 / 微信），写入本地缓存。 */
function markStep(step: keyof OnboardingState['steps'], done = true): void {
  state.steps = { ...state.steps, [step]: done }
  persistLocal()
}

async function testModel(input: { baseUrl: string; apiKey: string; model: string }): Promise<TestModelResult> {
  try {
    return await onboardingApi.testModel(input)
  } catch {
    return { ok: false, error: '测试接口暂不可用（后端 onboarding API 未就绪）' }
  }
}

async function complete(): Promise<void> {
  state.loading = true
  try {
    try {
      await onboardingApi.complete()
      state.source = 'api'
    } catch {
      // 后端未就绪：仅本地完成，保留 mock 标记
      state.source = 'mock'
    }
    state.completed = true
    persistLocal()
  } finally {
    state.loading = false
  }
}

/** 重置引导（调试页 / 重跑引导用；后端接口就绪后由调试页调 reset API）。 */
function reset(): void {
  state.completed = false
  state.steps = { model: false, persona: false, wechat: false }
  persistLocal()
}

export function useOnboardingStore() {
  return {
    state,
    completed: computed(() => state.completed),
    bootstrap,
    markStep,
    testModel,
    complete,
    reset,
  }
}
