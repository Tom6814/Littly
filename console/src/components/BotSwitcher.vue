<script setup lang="ts">
/**
 * 「当前她」切换器（桌面侧栏 + 移动抽屉共用）。
 * 选择状态来自 stores/bots（模块级单例），页面与外壳始终同一份数据。
 */
import { computed, onMounted } from 'vue'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@felinic/ui'
import { Bot } from 'lucide-vue-next'
import { useBots } from '@/stores/bots'

const props = withDefaults(defineProps<{ collapsed?: boolean }>(), { collapsed: false })

const bots = useBots()

onMounted(() => {
  void bots.bootstrap()
})

const currentBotId = computed(() => bots.state.currentBotId ?? '')

function onChange(value: unknown): void {
  if (typeof value === 'string' && value !== '') bots.setCurrent(value)
}
</script>

<template>
  <div class="px-2 pb-1">
    <div v-if="!props.collapsed" class="px-2 pb-1 text-caption font-medium tracking-tight text-muted-foreground">
      当前她
    </div>
    <Select :model-value="currentBotId" @update:model-value="onChange">
      <SelectTrigger class="w-full" :class="props.collapsed ? 'justify-center px-2' : ''">
        <span v-if="!props.collapsed" class="truncate">
          <SelectValue :placeholder="bots.state.loading ? '加载中…' : '暂无 bot'" />
        </span>
        <Bot v-if="props.collapsed" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem v-for="b in bots.state.bots" :key="b.id" :value="b.id">
          {{ b.name }}
        </SelectItem>
      </SelectContent>
    </Select>
  </div>
</template>
