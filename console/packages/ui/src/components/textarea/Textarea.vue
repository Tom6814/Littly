<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { useVModel } from '@vueuse/core'
import { computed, onMounted, ref, watch } from 'vue'
import { cn } from '#/lib/utils'

const props = withDefaults(defineProps<{
  class?: HTMLAttributes['class']
  defaultValue?: string | number
  modelValue?: string | number
  size?: 'sm' | 'default' | 'lg'
}>(), {
  size: 'default',
})

const emits = defineEmits<{
  (e: 'update:modelValue', payload: string | number): void
}>()

const modelValue = useVModel(props, 'modelValue', emits, {
  passive: true,
  defaultValue: props.defaultValue,
})

// Safari < 18.2 不支持 CSS field-sizing；这里有 JS 兜底，保证 textarea 仍能自动增高。
const el = ref<HTMLTextAreaElement | null>(null)
const nativeFieldSizing =
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content')

function autosize(): void {
  const node = el.value
  if (!node || nativeFieldSizing) return
  node.style.height = 'auto'
  node.style.height = `${node.scrollHeight}px`
}

onMounted(autosize)
watch(modelValue, () => {
  // 等 DOM 更新后再量高度
  queueMicrotask(autosize)
})

const sizeClass = computed(() => ({
  sm: 'min-h-14 px-2.5 py-1.5 text-body',
  default: 'min-h-16 px-3 py-2 text-label',
  lg: 'min-h-20 px-3.5 py-2.5 text-control',
}[props.size]))
</script>

<template>
  <textarea
    ref="el"
    v-model="modelValue"
    data-slot="textarea"
    :data-size="props.size"
    :class="cn(
      'flex field-sizing-content w-full rounded-md tracking-[0.01em] text-foreground',
      sizeClass,
      'outline-none resize-none',
      'disabled:cursor-not-allowed disabled:opacity-40',
      props.class
    )"
  />
</template>
