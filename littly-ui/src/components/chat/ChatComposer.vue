<script setup lang="ts">
/**
 * 输入区：自动增高（上限约 10 行）、Enter 发送 / Shift+Enter 换行、
 * 中文输入法组合态不误发（isComposing + compositionend 双保险）、发送中态、
 * 移动端安全区（env(safe-area-inset-bottom)）。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { Button, Spinner, Textarea } from '@felinic/ui'
import { SendHorizontal } from 'lucide-vue-next'

const props = withDefaults(defineProps<{
  modelValue: string
  sending: boolean
  statusText: string
  offline: boolean
  placeholder?: string
}>(), {
  placeholder: '和她说点什么…',
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'send'): void
}>()

const textareaRef = ref<InstanceType<typeof Textarea> | null>(null)
const composing = ref(false)
const coarsePointer = ref(
  typeof window !== 'undefined' && window.matchMedia !== undefined
    ? window.matchMedia('(pointer: coarse)').matches
    : false,
)

const draft = computed({
  get: () => props.modelValue,
  set: (value: string) => emit('update:modelValue', value),
})

const canSend = computed(() => !props.sending && props.modelValue.trim() !== '')
const hint = computed(() => {
  if (props.statusText !== '') return props.statusText
  if (props.offline) return '实时连接断开：消息仍会发出，恢复后自动同步'
  return coarsePointer.value ? '发送后自动同步' : 'Enter 发送 · Shift+Enter 换行'
})

function nativeTextarea(): HTMLTextAreaElement | null {
  const component = textareaRef.value
  if (component === null) return null
  const withEl = component as unknown as { $el?: unknown }
  const el = withEl.$el
  return el instanceof HTMLTextAreaElement ? el : null
}

function autosize(): void {
  const el = nativeTextarea()
  if (el === null) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`
}

function resetHeight(): void {
  const el = nativeTextarea()
  if (el === null) return
  el.style.height = 'auto'
}

function focus(): void {
  void nextTick(() => nativeTextarea()?.focus())
}

function submit(): void {
  if (!canSend.value) return
  emit('send')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey) return
  // 中文输入法：组合态回车用于选词，不能发送（isComposing / keyCode 229 双保险）
  if (event.isComposing || composing.value || event.keyCode === 229) return
  event.preventDefault()
  submit()
}

function onCompositionStart(): void {
  composing.value = true
}

function onCompositionEnd(): void {
  composing.value = false
  void nextTick(autosize)
}

onMounted(autosize)

watch(
  () => props.modelValue,
  () => {
    void nextTick(autosize)
  },
)

defineExpose({ focus, resetHeight })
</script>

<template>
  <div
    class="shrink-0 border-t border-border bg-background px-3 pt-3 md:px-6"
    style="padding-bottom: calc(0.75rem + env(safe-area-inset-bottom))"
  >
    <div class="mx-auto w-full max-w-3xl">
      <div
        class="flex items-end gap-2 rounded-2xl border border-border bg-section-card p-1.5 focus-within:ring-2 focus-within:ring-ring"
      >
        <Textarea
          ref="textareaRef"
          v-model="draft"
          data-testid="chat-composer"
          rows="1"
          :placeholder="placeholder"
          class="max-h-40 min-h-9 flex-1 resize-none border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:ring-0"
          @keydown="onKeydown"
          @compositionstart="onCompositionStart"
          @compositionend="onCompositionEnd"
          @input="autosize"
        />
        <Button
          variant="brand"
          size="icon"
          data-testid="chat-send"
          aria-label="发送"
          :disabled="!canSend"
          @click="submit"
        >
          <Spinner v-if="sending" class="size-4" />
          <SendHorizontal v-else class="size-4" />
        </Button>
      </div>
      <div class="mt-1 flex items-center justify-between gap-2 px-1 text-caption text-muted-foreground">
        <span class="truncate">{{ hint }}</span>
        <span v-if="draft.trim() !== ''" class="shrink-0 tabular-nums">{{ draft.length }}</span>
      </div>
    </div>
  </div>
</template>
