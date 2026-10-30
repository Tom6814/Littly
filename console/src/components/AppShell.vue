<script setup lang="ts">
/**
 * AppShell —— 侧边栏 + 内容区的应用外壳（唯一实现）。
 * 桌面（≥md）：左侧固定侧栏，可折叠为纯图标。
 * 移动（<md）：顶部紧凑栏 + Sheet 抽屉（复用同一份 AppNav / BotSwitcher / AccountFooter），
 * 保证手机上任何页面都能导航到全部功能。
 * 视觉只用 @felinic/ui 的 token 与组件：导航行是 RouterLink 组成的行（非按钮控件），
 * 选中态用库的 `[data-ui-selected]` 载体，hover 用中性 overlay 阶梯（bg-accent）。
 */
import { computed, ref } from 'vue'
import {
  Button,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@felinic/ui'
import { Heart, Menu, PanelLeftClose, PanelLeftOpen } from 'lucide-vue-next'
import AppNav from './AppNav.vue'
import AccountFooter from './AccountFooter.vue'
import BotSwitcher from './BotSwitcher.vue'
import { useBots } from '@/stores/bots'
import { useUiStore } from '@/stores/ui'

const ui = useUiStore()
const bots = useBots()
const mobileNavOpen = ref(false)

const collapsed = computed(() => ui.state.navCollapsed)
const currentBotName = computed(() => bots.currentBot.value?.name ?? '')
</script>

<template>
  <div class="flex h-dvh w-full flex-col overflow-hidden bg-background text-foreground">
    <!-- 移动端顶部栏：菜单入口 + 品牌 + 当前她 -->
    <header class="flex h-12 shrink-0 items-center gap-2 border-b border-border px-2 md:hidden">
      <Sheet v-model:open="mobileNavOpen">
        <SheetTrigger as-child>
          <Button variant="ghost" size="icon-sm" aria-label="打开导航">
            <Menu />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" class="w-72 p-0">
          <!-- 抽屉是导航 surface：标题/描述给屏幕阅读器，视觉上由品牌区承担。 -->
          <SheetTitle class="sr-only">导航</SheetTitle>
          <SheetDescription class="sr-only">全站导航、当前 bot 与账户操作</SheetDescription>
          <div class="flex h-full flex-col">
            <div class="flex min-h-14 items-center gap-2 px-3 pr-10">
              <div class="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent text-foreground">
                <Heart class="size-4" />
              </div>
              <div class="min-w-0">
                <div class="truncate text-control font-semibold">Littly</div>
                <div class="truncate text-caption text-muted-foreground">她在这里</div>
              </div>
            </div>
            <BotSwitcher />
            <AppNav @navigate="mobileNavOpen = false" />
            <AccountFooter />
          </div>
        </SheetContent>
      </Sheet>
      <div class="flex min-w-0 items-center gap-2">
        <Heart class="size-4 shrink-0 text-muted-foreground" />
        <span class="truncate text-control font-semibold">Littly</span>
        <span v-if="currentBotName" class="truncate text-caption text-muted-foreground">
          · {{ currentBotName }}
        </span>
      </div>
    </header>

    <div class="flex min-h-0 flex-1 overflow-hidden">
      <!-- 桌面侧边栏 -->
      <aside
        class="flex h-full shrink-0 flex-col border-r border-border bg-card transition-[width] duration-200 max-md:hidden"
        :class="collapsed ? 'w-14' : 'w-60'"
      >
        <div class="flex min-h-14 items-center gap-2 px-3">
          <div class="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent text-foreground">
            <Heart class="size-4" />
          </div>
          <div v-if="!collapsed" class="min-w-0">
            <div class="truncate text-control font-semibold">Littly</div>
            <div class="truncate text-caption text-muted-foreground">她在这里</div>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            class="ml-auto"
            :aria-label="collapsed ? '展开侧边栏' : '收起侧边栏'"
            @click="ui.toggleNav()"
          >
            <PanelLeftOpen v-if="collapsed" />
            <PanelLeftClose v-else />
          </Button>
        </div>

        <BotSwitcher :collapsed="collapsed" />
        <AppNav :collapsed="collapsed" />
        <AccountFooter :collapsed="collapsed" />
      </aside>

      <!-- 内容区：滚动容器归主区所有（滚动条槽位稳定） -->
      <main class="min-w-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]">
        <slot />
      </main>
    </div>
  </div>
</template>
