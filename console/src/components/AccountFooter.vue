<script setup lang="ts">
/**
 * 账户区（桌面侧栏 + 移动抽屉共用）：当前用户、主题切换、退出登录。
 */
import { useRouter } from 'vue-router'
import { Button } from '@felinic/ui'
import { LogOut, Moon, Sun } from 'lucide-vue-next'
import { useAuthStore } from '@/stores/auth'
import { useBots } from '@/stores/bots'
import { useUiStore } from '@/stores/ui'

const props = withDefaults(defineProps<{ collapsed?: boolean }>(), { collapsed: false })

const router = useRouter()
const auth = useAuthStore()
const bots = useBots()
const ui = useUiStore()

async function logout(): Promise<void> {
  await auth.logout()
  bots.reset()
  await router.push('/login')
}
</script>

<template>
  <div class="border-t border-border p-2">
    <div v-if="!props.collapsed" class="flex items-center gap-2 px-2 py-1.5">
      <div class="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-caption font-medium text-foreground">
        {{ (auth.state.user?.username ?? '?').slice(0, 1).toUpperCase() }}
      </div>
      <div class="min-w-0 flex-1">
        <div class="truncate text-label font-medium">{{ auth.state.user?.username ?? '未登录' }}</div>
        <div class="truncate text-caption text-muted-foreground">
          {{ auth.state.user?.role === 'admin' ? '管理员' : '成员' }}
        </div>
      </div>
    </div>
    <div class="flex items-center gap-1" :class="props.collapsed ? 'flex-col' : ''">
      <Button variant="ghost" size="icon-sm" aria-label="切换深色模式" @click="ui.toggleTheme()">
        <Sun v-if="ui.state.theme === 'dark'" />
        <Moon v-else />
      </Button>
      <Button
        v-if="!props.collapsed"
        variant="ghost"
        size="sm"
        class="flex-1 justify-start"
        @click="logout"
      >
        <LogOut />
        退出登录
      </Button>
      <Button v-else variant="ghost" size="icon-sm" aria-label="退出登录" @click="logout">
        <LogOut />
      </Button>
    </div>
  </div>
</template>
