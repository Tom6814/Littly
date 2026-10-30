/**
 * 路由表 —— 路径与页面文件路径已冻结（fe-core 与 Lead 的分工边界）：
 *   fe-core 拥有：/login /register /onboarding /chat /her/character
 *                /channels/*（5） /system/*（4）
 *   Lead 拥有（本骨架只建 stub，不实现）：/her/{worldbook,rules,growth,album,diary}
 *                /memory /proactive /contacts
 * 冻结后不要改路径或文件名 —— 页面实现按此表填充。
 */
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useOnboardingStore } from '@/stores/onboarding'

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/chat' },
  {
    path: '/login',
    name: 'login',
    component: () => import('@/pages/LoginPage.vue'),
    meta: { public: true, title: '登录' },
  },
  {
    path: '/register',
    name: 'register',
    component: () => import('@/pages/RegisterPage.vue'),
    meta: { public: true, title: '注册' },
  },
  {
    path: '/onboarding',
    name: 'onboarding',
    component: () => import('@/pages/OnboardingPage.vue'),
    meta: { onboarding: true, title: '开始使用' },
  },

  // 对话
  { path: '/chat', name: 'chat', component: () => import('@/pages/ChatPage.vue'), meta: { title: '对话' } },

  // 她
  { path: '/her/character', name: 'her-character', component: () => import('@/pages/her/CharacterPage.vue'), meta: { title: '角色卡' } },
  { path: '/her/worldbook', name: 'her-worldbook', component: () => import('@/pages/her/WorldbookPage.vue'), meta: { title: '世界书' } },
  { path: '/her/rules', name: 'her-rules', component: () => import('@/pages/her/RulesPage.vue'), meta: { title: '铁律' } },
  { path: '/her/growth', name: 'her-growth', component: () => import('@/pages/her/GrowthPage.vue'), meta: { title: '成长' } },
  { path: '/her/album', name: 'her-album', component: () => import('@/pages/her/AlbumPage.vue'), meta: { title: '相册' } },
  { path: '/her/diary', name: 'her-diary', component: () => import('@/pages/her/DiaryPage.vue'), meta: { title: '日记' } },

  // 记忆 / 主动
  { path: '/memory', name: 'memory', component: () => import('@/pages/memory/MemoryPage.vue'), meta: { title: '记忆' } },
  { path: '/proactive', name: 'proactive', component: () => import('@/pages/proactive/ProactivePage.vue'), meta: { title: '主动' } },

  // 连接
  { path: '/channels/wechat', name: 'channel-wechat', component: () => import('@/pages/channels/WechatPage.vue'), meta: { title: '微信' } },
  { path: '/channels/telegram', name: 'channel-telegram', component: () => import('@/pages/channels/TelegramPage.vue'), meta: { title: 'Telegram' } },
  { path: '/channels/qq', name: 'channel-qq', component: () => import('@/pages/channels/QqPage.vue'), meta: { title: 'QQ' } },
  { path: '/channels/discord', name: 'channel-discord', component: () => import('@/pages/channels/DiscordPage.vue'), meta: { title: 'Discord' } },
  { path: '/channels/bilibili', name: 'channel-bilibili', component: () => import('@/pages/channels/BilibiliPage.vue'), meta: { title: 'Bilibili' } },
  { path: '/channels/x', name: 'channel-x', component: () => import('@/pages/channels/XPage.vue'), meta: { title: 'X' } },
  { path: '/channels/email', name: 'channel-email', component: () => import('@/pages/channels/EmailPage.vue'), meta: { title: '邮箱' } },
  { path: '/contacts', name: 'contacts', component: () => import('@/pages/contacts/ContactsPage.vue'), meta: { title: '联系人' } },

  // 系统
  { path: '/system/overview', name: 'system-overview', component: () => import('@/pages/system/OverviewPage.vue'), meta: { title: '概览' } },
  { path: '/system/settings', name: 'system-settings', component: () => import('@/pages/system/SettingsPage.vue'), meta: { title: '设置' } },
  { path: '/system/plugins', name: 'system-plugins', component: () => import('@/pages/system/PluginsPage.vue'), meta: { title: '插件' } },
  { path: '/system/mcp', name: 'system-mcp', component: () => import('@/pages/system/McpPage.vue'), meta: { title: 'MCP' } },
  { path: '/system/debug', name: 'system-debug', component: () => import('@/pages/system/DebugPage.vue'), meta: { title: '调试' } },

  { path: '/:pathMatch(.*)*', redirect: '/chat' },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: (_to, _from, saved) => saved ?? { top: 0 },
})

/** 守卫：先确认登录态；未完成引导的用户强制留在 /onboarding。 */
router.beforeEach(async (to) => {
  const auth = useAuthStore()
  await auth.bootstrap()

  if (to.meta.public === true) {
    if (auth.state.user && (to.path === '/login' || to.path === '/register')) {
      return { path: '/chat' }
    }
    return true
  }

  if (!auth.state.user) {
    return { path: '/login', query: { next: to.fullPath } }
  }

  const onboarding = useOnboardingStore()
  await onboarding.bootstrap()
  if (!onboarding.state.completed && to.path !== '/onboarding') {
    return { path: '/onboarding' }
  }
  if (onboarding.state.completed && to.path === '/onboarding') {
    return { path: '/chat' }
  }
  return true
})

router.afterEach((to) => {
  const title = typeof to.meta.title === 'string' ? to.meta.title : ''
  document.title = title ? `${title} · Littly` : 'Littly · 控制台'
})
