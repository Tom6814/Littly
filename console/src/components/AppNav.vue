<script setup lang="ts">
/**
 * 导航列表（桌面侧栏 + 移动抽屉共用，单一实现）。
 * 选中态用库的 `[data-ui-selected]` 载体；hover 用中性 overlay 阶梯（bg-accent）。
 */
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { NAV_GROUPS } from './nav'

const props = withDefaults(
  defineProps<{
    /** 桌面折叠态：只显示图标。抽屉里永远展开。 */
    collapsed?: boolean
  }>(),
  { collapsed: false },
)

const emit = defineEmits<{ navigate: [] }>()
const route = useRoute()
const groups = computed(() => NAV_GROUPS)

function isActive(to: string): boolean {
  return route.path === to || route.path.startsWith(`${to}/`)
}
</script>

<template>
  <nav class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 pb-4">
    <div v-for="group in groups" :key="group.label" class="pt-4 first:pt-2">
      <div
        v-if="!props.collapsed"
        class="px-2 pb-1 text-caption font-medium tracking-tight text-muted-foreground"
      >
        {{ group.label }}
      </div>
      <ul class="space-y-0.5">
        <li v-for="item in group.items" :key="item.to">
          <RouterLink
            :to="item.to"
            class="flex h-9 items-center gap-2 rounded-md px-2 text-control text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground [&_svg]:size-4 [&_svg]:shrink-0"
            :class="[isActive(item.to) ? 'font-medium text-foreground' : '', props.collapsed ? 'justify-center' : '']"
            :data-ui-selected="isActive(item.to) ? '' : undefined"
            :title="props.collapsed ? item.label : undefined"
            @click="emit('navigate')"
          >
            <component :is="item.icon" />
            <span v-if="!props.collapsed" class="truncate">{{ item.label }}</span>
          </RouterLink>
        </li>
      </ul>
    </div>
  </nav>
</template>
