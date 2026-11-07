<script setup lang="ts">
/**
 * 消息列表：日期分隔、同角色连发合并、按行分气泡、滚动跟随、加载更早、
 * 空态/骨架/错误横幅/离线提示、思考中/工具/沉默提示、新消息提示。
 * 滚动策略：只有用户贴近底部时才自动跟随；否则累积「有 N 条新消息」。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  CalloutBanner,
  Skeleton,
  Spinner,
} from '@felinic/ui'
import { ArrowDown, ChevronUp, MessageCircle, SendHorizontal, Wrench } from 'lucide-vue-next'
import type { ChatMessage, StreamToolCall } from '@/api/types'
import ChatMessageRow from '@/components/chat/ChatMessageRow.vue'
import { dayKey, formatDayLabel, initialOf } from '@/pages/chat/format'

const props = withDefaults(defineProps<{
  messages: ChatMessage[]
  hasMore: boolean
  /** 加载更早一页（父级走 messagesPage 游标分页）；返回是否新增。 */
  loadEarlier: () => Promise<boolean>
  loading: boolean
  historyError: string
  historyDenied: boolean
  botName: string
  botAvatar: string
  sending: boolean
  agentStatus: string
  toolCalls: StreamToolCall[]
  buffered: boolean
  bufferCount: number
  silentNotice: boolean
}>(), {
  botAvatar: '',
})

const emit = defineEmits<{
  (e: 'delete', id: string): void
  (e: 'suggest', text: string): void
}>()

const scroller = ref<HTMLElement | null>(null)
const atBottom = ref(true)
const newBelow = ref(0)
const suppressNextAppend = ref(false)
const loadingEarlier = ref(false)
let initialized = false

interface DateRow {
  kind: 'date'
  key: string
  label: string
}

interface MessageRow {
  kind: 'message'
  key: string
  message: ChatMessage
  mine: boolean
  groupFirst: boolean
  groupLast: boolean
}

type Row = DateRow | MessageRow

const rows = computed<Row[]>(() => {
  const out: Row[] = []
  const list = props.messages
  for (let i = 0; i < list.length; i += 1) {
    const message = list[i]
    if (message === undefined) continue
    const day = dayKey(message.createdAt)
    const prev = list[i - 1]
    const next = list[i + 1]
    if (prev === undefined || dayKey(prev.createdAt) !== day) {
      out.push({ kind: 'date', key: `date-${day}-${i}`, label: formatDayLabel(message.createdAt) })
    }
    const samePrevDay = prev !== undefined && dayKey(prev.createdAt) === day
    const sameNextDay = next !== undefined && dayKey(next.createdAt) === day
    out.push({
      kind: 'message',
      key: `msg-${message.id}`,
      message,
      mine: message.role === 'user',
      groupFirst: !(samePrevDay && prev?.role === message.role),
      groupLast: !(sameNextDay && next?.role === message.role),
    })
  }
  return out
})

const typingLabel = computed(() => {
  if (props.agentStatus === 'thinking') return '她在想…'
  if (props.agentStatus === 'tool' || props.toolCalls.some((t) => t.status === 'running')) return '她在用工具…'
  if (props.buffered) return `她在等你把话说完（${props.bufferCount}）`
  if (props.sending) return '正在发送…'
  return ''
})

const showTyping = computed(() => typingLabel.value !== '' && !props.loading)
const showEmpty = computed(
  () => !props.loading && props.messages.length === 0 && !props.historyDenied && props.historyError === '',
)
const showSkeleton = computed(() => props.loading && props.messages.length === 0)

const suggestions = ['今天过得怎么样？', '陪我说说话', '我有点累']

/* ---------------- 滚动 ---------------- */
function distanceToBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight
}

function onScroll(): void {
  const el = scroller.value
  if (el === null) return
  atBottom.value = distanceToBottom(el) < 80
  if (atBottom.value) newBelow.value = 0
  // 贴近顶部自动加载更早（保留滚动位置由 handleLoadEarlier 处理）
  if (el.scrollTop < 120 && props.hasMore && !loadingEarlier.value && !props.loading) {
    void handleLoadEarlier()
  }
}

async function scrollToBottom(smooth = false): Promise<void> {
  await nextTick()
  const el = scroller.value
  if (el === null) return
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  atBottom.value = true
  newBelow.value = 0
}

async function handleLoadEarlier(): Promise<void> {
  if (!props.hasMore || loadingEarlier.value) return
  const el = scroller.value
  if (el === null) return
  loadingEarlier.value = true
  suppressNextAppend.value = true
  const beforeHeight = el.scrollHeight
  const beforeTop = el.scrollTop
  const added = await props.loadEarlier()
  await nextTick()
  if (added && el.isConnected) {
    // prepend 后把视口锚回原来的内容位置（不跳变）
    el.scrollTop = beforeTop + (el.scrollHeight - beforeHeight)
  }
  suppressNextAppend.value = false
  loadingEarlier.value = false
}

function onDelete(id: string): void {
  emit('delete', id)
}

onMounted(() => {
  void nextTick(() => {
    void scrollToBottom()
    initialized = true
  })
})

watch(
  () => props.messages.length,
  (next, prev) => {
    if (!initialized) return
    if (suppressNextAppend.value) {
      suppressNextAppend.value = false
      return
    }
    if (prev !== undefined && next > prev) {
      if (atBottom.value) void scrollToBottom()
      else newBelow.value += next - prev
    }
  },
)

watch(
  () => props.loading,
  (loadingNow, wasLoading) => {
    if (wasLoading && !loadingNow) {
      void nextTick(() => {
        if (props.messages.length > 0) void scrollToBottom()
      })
    }
  },
)

defineExpose({ scrollToBottom })
</script>

<template>
  <div class="relative flex min-h-0 flex-1 flex-col">
    <div
      ref="scroller"
      class="min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none [scrollbar-gutter:stable]"
      data-testid="chat-scroller"
      tabindex="0"
      role="log"
      aria-label="消息列表"
      @scroll.passive="onScroll"
    >
      <div class="mx-auto flex w-full max-w-3xl flex-col px-4 py-5 md:px-6">
        <CalloutBanner v-if="historyError" tone="destructive" size="sm" :description="historyError" />
        <CalloutBanner
          v-if="historyDenied"
          tone="neutral"
          size="sm"
          description="当前账号不是这个 bot 的所有者：历史记录与实时同步不可用，但仍可以给她发消息。"
        />

        <!-- 加载更早 -->
        <div v-if="hasMore" class="flex justify-center pb-3">
          <Button variant="ghost" size="sm" :disabled="loadingEarlier" @click="handleLoadEarlier">
            <Spinner v-if="loadingEarlier" class="size-3.5" />
            <ChevronUp v-else class="size-3.5" />
            {{ loadingEarlier ? '正在加载更早…' : '加载更早的消息' }}
          </Button>
        </div>

        <!-- 首屏骨架 -->
        <div v-if="showSkeleton" class="space-y-4 py-4" data-testid="chat-skeleton">
          <div class="flex gap-2.5">
            <Skeleton class="size-8 rounded-full" />
            <div class="flex w-1/2 flex-col gap-2">
              <Skeleton class="h-4 w-24" />
              <Skeleton class="h-9 w-full rounded-2xl" />
              <Skeleton class="h-9 w-4/5 rounded-2xl" />
            </div>
          </div>
          <div class="flex flex-row-reverse gap-2.5">
            <Skeleton class="size-8 rounded-full" />
            <div class="flex w-2/5 flex-col gap-2">
              <Skeleton class="ml-auto h-4 w-16" />
              <Skeleton class="h-9 w-full rounded-2xl" />
            </div>
          </div>
          <div class="flex gap-2.5">
            <Skeleton class="size-8 rounded-full" />
            <div class="flex w-1/3 flex-col gap-2">
              <Skeleton class="h-4 w-20" />
              <Skeleton class="h-9 w-full rounded-2xl" />
            </div>
          </div>
        </div>

        <!-- 空状态 -->
        <div
          v-else-if="showEmpty"
          class="flex flex-col items-center gap-3 py-16 text-center"
          data-testid="chat-empty"
        >
          <div class="flex size-11 items-center justify-center rounded-full bg-accent text-foreground">
            <MessageCircle class="size-5" />
          </div>
          <p class="text-control font-medium text-foreground">还没有对话</p>
          <p class="max-w-sm text-label text-muted-foreground">
            说点什么吧。她记得你们之前聊过的一切。
          </p>
          <div class="mt-2 flex flex-wrap justify-center gap-2">
            <Button
              v-for="suggestion in suggestions"
              :key="suggestion"
              variant="outline"
              size="sm"
              @click="emit('suggest', suggestion)"
            >
              <SendHorizontal class="size-3.5" />
              {{ suggestion }}
            </Button>
          </div>
        </div>

        <!-- 消息行（日期分隔 + 同角色合并 + 按行分气泡） -->
        <template v-else>
          <div
            v-for="row in rows"
            :key="row.key"
            :class="row.kind === 'date' ? 'flex justify-center py-3 first:pt-0' : ''"
          >
            <span
              v-if="row.kind === 'date'"
              class="rounded-full bg-muted-soft px-2.5 py-0.5 text-caption text-muted-foreground"
            >
              {{ row.label }}
            </span>
            <ChatMessageRow
              v-else
              :message="row.message"
              :bot-name="botName"
              :bot-avatar="botAvatar"
              :mine="row.mine"
              :group-first="row.groupFirst"
              :group-last="row.groupLast"
              @delete="onDelete"
            />
          </div>

          <!-- 她在想 / 工具中 / 缓冲中 -->
          <div v-if="showTyping" class="mt-3 flex items-center gap-2.5" data-testid="chat-typing">
            <Avatar class="size-8 shrink-0">
              <AvatarImage v-if="botAvatar !== ''" :src="botAvatar" :alt="botName" />
              <AvatarFallback class="text-caption">{{ initialOf(botName) }}</AvatarFallback>
            </Avatar>
            <div class="flex items-center gap-2 rounded-2xl bg-section-card px-3.5 py-2.5 text-label text-muted-foreground">
              <span class="flex items-center gap-1">
                <span class="size-1.5 animate-pulse rounded-full bg-muted-foreground" />
                <span class="size-1.5 animate-pulse rounded-full bg-muted-foreground [animation-delay:150ms]" />
                <span class="size-1.5 animate-pulse rounded-full bg-muted-foreground [animation-delay:300ms]" />
              </span>
              {{ typingLabel }}
            </div>
          </div>

          <!-- 工具调用 chip -->
          <div v-if="toolCalls.length > 0" class="mt-2 flex flex-wrap gap-1.5 pl-10">
            <span
              v-for="tool in toolCalls"
              :key="tool.id"
              class="inline-flex items-center gap-1 rounded-sm bg-muted-soft px-2 py-1 text-caption text-muted-foreground"
            >
              <Wrench class="size-3" />
              {{ tool.status === 'running' ? '正在执行' : '已执行' }} · {{ tool.name }}
            </span>
          </div>

          <!-- 沉默提示 -->
          <div
            v-if="silentNotice"
            data-testid="chat-silent"
            class="mt-2 flex items-center gap-2 pl-10 text-caption text-muted-foreground"
          >
            <span class="size-1.5 rounded-full bg-muted-foreground" />
            她这次没有回复（沉默）。
          </div>
        </template>

        <div class="h-2" />
      </div>
    </div>

    <!-- 新消息提示（仅不贴底时出现） -->
    <div v-if="!atBottom && newBelow > 0" class="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
      <Button
        variant="default"
        size="sm"
        class="pointer-events-auto shadow-lg"
        data-testid="chat-new-below"
        @click="scrollToBottom(false)"
      >
        <ArrowDown class="size-3.5" />
        有 {{ newBelow }} 条新消息
      </Button>
    </div>

    <!-- 回到底部（贴底时隐藏） -->
    <div v-else-if="!atBottom" class="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
      <Button
        variant="ghost"
        size="icon-sm"
        class="pointer-events-auto bg-background shadow-lg ring-1 ring-border"
        aria-label="回到最新消息"
        @click="scrollToBottom(true)"
      >
        <ArrowDown class="size-4" />
      </Button>
    </div>
  </div>
</template>
