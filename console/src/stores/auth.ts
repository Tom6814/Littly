/** 登录态（模块级单例，组件内直接 useAuthStore()）。 */
import { computed, reactive } from 'vue'
import { authApi } from '@/api/endpoints'
import type { User } from '@/api/types'

const state = reactive({
  user: null as User | null,
  /** 是否已向后端确认过会话（未确认时路由守卫不跳转）。 */
  ready: false,
  loading: false,
})

let bootstrapTask: Promise<void> | null = null

async function bootstrap(): Promise<void> {
  if (state.ready) return
  if (bootstrapTask) return bootstrapTask
  bootstrapTask = (async () => {
    state.loading = true
    try {
      state.user = await authApi.session()
    } catch {
      state.user = null
    } finally {
      state.ready = true
      state.loading = false
      bootstrapTask = null
    }
  })()
  return bootstrapTask
}

async function login(username: string, password: string): Promise<User> {
  state.loading = true
  try {
    const user = await authApi.login(username, password)
    state.user = user
    state.ready = true
    return user
  } finally {
    state.loading = false
  }
}

async function register(username: string, password: string): Promise<User> {
  state.loading = true
  try {
    const user = await authApi.register(username, password)
    state.user = user
    state.ready = true
    return user
  } finally {
    state.loading = false
  }
}

async function logout(): Promise<void> {
  try {
    await authApi.logout()
  } finally {
    state.user = null
  }
}

/** 登录/登出后重置其他 store 的引导缓存。 */
export function useAuthStore() {
  return {
    state,
    user: computed(() => state.user),
    isAdmin: computed(() => state.user?.role === 'admin'),
    bootstrap,
    login,
    register,
    logout,
  }
}
