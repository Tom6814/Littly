/** 全局 UI 状态：浅色/深色主题 + 侧边栏折叠。 */
import { reactive } from 'vue'

export type ThemeMode = 'light' | 'dark'

const THEME_KEY = 'littly.theme'
const NAV_KEY = 'littly.nav.collapsed'

function readTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem(THEME_KEY)
    if (saved === 'dark' || saved === 'light') return saved
  } catch {
    /* ignore */
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function readNav(): boolean {
  try {
    return localStorage.getItem(NAV_KEY) === '1'
  } catch {
    return false
  }
}

const state = reactive({
  theme: readTheme() as ThemeMode,
  navCollapsed: readNav(),
})

function applyTheme(): void {
  document.documentElement.classList.toggle('dark', state.theme === 'dark')
  document.documentElement.style.colorScheme = state.theme
}

function toggleTheme(): void {
  state.theme = state.theme === 'dark' ? 'light' : 'dark'
  try {
    localStorage.setItem(THEME_KEY, state.theme)
  } catch {
    /* ignore */
  }
  applyTheme()
}

function toggleNav(): void {
  state.navCollapsed = !state.navCollapsed
  try {
    localStorage.setItem(NAV_KEY, state.navCollapsed ? '1' : '0')
  } catch {
    /* ignore */
  }
}

/** 应用启动时调用一次。 */
export function initUi(): void {
  applyTheme()
}

export function useUiStore() {
  return {
    state,
    initUi,
    applyTheme,
    toggleTheme,
    toggleNav,
  }
}
