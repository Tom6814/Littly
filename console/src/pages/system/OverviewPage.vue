<script setup lang="ts">
/**
 * 系统概览 —— 只回答「她是否在正常运转、最近用了多少」。
 * 数据：GET /api/stats/activity（14 天消息量 + 工具调用 Top + 总量）。
 * 自刷新（20s，页面可见时）—— 状态面板不设置「刷新」按钮。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  CalloutBanner,
  MetricReadout,
  PageShell,
  SettingsSection,
  SettingsRow,
  Spinner,
  StatusDot,
} from '@felinic/ui'
import { systemApi } from '@/api/endpoints'
import { useBots } from '@/stores/bots'

const bots = useBots()
const loading = ref(true)
const error = ref('')
const daily = ref<Array<{ date: string; messages: number }>>([])
const toolCalls = ref<Array<{ name: string; count: number }>>([])
const totals = ref<Record<string, number>>({})

let timer: ReturnType<typeof setInterval> | null = null

const botName = computed(() => bots.currentBot.value?.name ?? '她')
const maxDaily = computed(() => Math.max(1, ...daily.value.map((d) => d.messages)))
const recent14d = computed(() => daily.value.reduce((sum, d) => sum + d.messages, 0))

async function load(): Promise<void> {
  error.value = ''
  try {
    const stats = await systemApi.activity(bots.state.currentBotId ?? undefined)
    daily.value = (stats.daily ?? []) as Array<{ date: string; messages: number }>
    toolCalls.value = (stats.toolCalls ?? []) as Array<{ name: string; count: number }>
    totals.value = (stats.totals ?? {}) as Record<string, number>
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载概览失败'
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await bots.bootstrap()
  await load()
  timer = setInterval(() => {
    if (document.visibilityState === 'visible') void load()
  }, 20_000)
})

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <PageShell title="概览" description="她的运转状态与最近的使用量。">
    <div class="space-y-8">
      <CalloutBanner v-if="error" tone="destructive" :description="error" size="sm" />

      <!-- 状态 + 用量：状态先行，数字在后 -->
      <section class="space-y-2.5">
        <h2 class="px-2 text-label font-medium text-muted-foreground">状态</h2>
        <SettingsSection>
          <SettingsRow label="当前她" :description="`记忆与对话归属：${botName}`">
            <div class="flex items-center gap-2 text-control text-foreground">
              <StatusDot status="success" />
              运行中
            </div>
          </SettingsRow>
          <SettingsRow label="近 14 天消息" :description="`共 ${recent14d} 条`">
            <span class="text-control tabular-nums text-foreground">{{ recent14d }}</span>
          </SettingsRow>
        </SettingsSection>
      </section>

      <!-- 用量瓦片：页面内容层级，不加外层卡片（卡片只包一组行） -->
      <section class="space-y-2.5">
        <h2 class="px-2 text-label font-medium text-muted-foreground">总量</h2>
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MetricReadout label="消息" :value="String(totals.messages ?? '—')" />
          <MetricReadout label="记忆" :value="String(totals.memories ?? '—')" />
          <MetricReadout label="联系人" :value="String(totals.contacts ?? '—')" />
          <MetricReadout label="工具调用" :value="String(toolCalls.reduce((s, t) => s + t.count, 0) || '—')" />
        </div>
      </section>

      <!-- 14 天趋势 -->
      <section class="space-y-2.5">
        <h2 class="px-2 text-label font-medium text-muted-foreground">近 14 天消息</h2>
        <div class="rounded-menu-shell bg-section-card p-4">
          <div v-if="loading" class="flex items-center gap-2 py-8 text-label text-muted-foreground">
            <Spinner class="size-4" />
            正在载入…
          </div>
          <div v-else class="flex h-32 items-end gap-1.5">
            <div
              v-for="day in daily"
              :key="day.date"
              class="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5"
              :title="`${day.date}：${day.messages} 条`"
            >
              <div
                class="w-full rounded-sm bg-accent"
                :style="{ height: `${Math.max(2, (day.messages / maxDaily) * 100)}%` }"
              />
              <span class="text-caption text-muted-foreground">{{ day.date.slice(5) }}</span>
            </div>
          </div>
        </div>
      </section>

      <!-- 工具调用 Top -->
      <section v-if="toolCalls.length > 0" class="space-y-2.5">
        <h2 class="px-2 text-label font-medium text-muted-foreground">工具调用</h2>
        <SettingsSection>
          <SettingsRow v-for="tool in toolCalls.slice(0, 8)" :key="tool.name" :label="tool.name">
            <span class="text-control tabular-nums text-muted-foreground">{{ tool.count }} 次</span>
          </SettingsRow>
        </SettingsSection>
      </section>
    </div>
  </PageShell>
</template>
