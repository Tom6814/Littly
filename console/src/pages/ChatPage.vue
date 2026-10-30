<script setup lang="ts">
/**
 * 对话页 —— 与她直接聊天。
 * - 历史：GET /api/messages?botId&sender
 * - 发送：POST /api/chat（响应含本轮落库消息 + 回复/工具/思考/沉默）
 * - 实时：GET /api/stream SSE（message / buffer / agent-status / tool-call）
 * - 重生成：POST /api/chat/regenerate；删除：DELETE /api/messages/:id
 * 页面只做布局 + 业务编排；气泡、按钮、确认框全部来自 @felinic/ui。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  Button,
  CalloutBanner,
  ConfirmPopover,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Spinner,
  Textarea,
} from '@felinic/ui'
import { MoreHorizontal, Phone, RefreshCw, SendHorizontal, Trash2, WifiOff } from 'lucide-vue-next'
import { chatApi } from '@/api/endpoints'
import type { ChatMessage, StreamToolCall } from '@/api/types'
import { useAuthStore } from '@/stores/auth'
import { useBots } from '@/stores/bots'
import CallOverlay from '@/components/call/CallOverlay.vue'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const bots = useBots()

const messages = ref<ChatMessage[]>([])
const loading = ref(false)
const sending = ref(false)
const error = ref('')
const draft = ref('')
const agentStatus = ref('')
const buffer = ref<{ buffered: boolean; count: number }>({ buffered: false, count: 0 })
const toolCalls = ref<StreamToolCall[]>([])
const silentNotice = ref(false)
const streamState = ref<'connecting' | 'open' | 'offline'>('connecting')
/** 语音通话浮层开关（token/WS/麦克风全部由 CallOverlay 自包含处理）。 */
const callOpen = ref(false)

// 联系人页通过 /chat?sender=<id> 打开某人的会话；缺省用当前登录用户。
const routeSender = computed(() => (typeof route.query.sender === 'string' ? route.query.sender : ''))
const sender = computed(() => routeSender.value || auth.state.user?.id || '')
const botId = computed(() => bots.state.currentBotId ?? '')
const botName = computed(() => bots.currentBot.value?.name ?? '她')
const hasContent = computed(() => messages.value.length > 0)

const scroller = ref<HTMLElement | null>(null)

// 触屏没有物理 Enter/Shift+Enter 语义：提示语按指针类型切换，避免给手机用户
// 一条做不到的按键说明（布局与行为不变）。
const coarsePointer = ref(
  typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(pointer: coarse)').matches : false,
)
const composerPlaceholder = computed(() =>
  coarsePointer.value
    ? '和她说点什么…'
    : '和她说点什么…（Enter 发送，Shift+Enter 换行）',
)
let es: EventSource | null = null
let silentTimer: ReturnType<typeof setTimeout> | null = null

/* ---------------- 数据加载 ---------------- */
async function loadHistory(): Promise<void> {
  if (!botId.value) return
  loading.value = true
  error.value = ''
  try {
    messages.value = await chatApi.messages({ botId: botId.value, sender: sender.value })
    await scrollToBottom()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载消息失败'
  } finally {
    loading.value = false
  }
}

/** 合并消息：按 id 去重，保持已有顺序，新消息追加。 */
function mergeMessages(incoming: ChatMessage[]): void {
  const byId = new Map(messages.value.map((m) => [m.id, m]))
  for (const m of incoming) byId.set(m.id, m)
  messages.value = [...byId.values()].sort((a, b) => {
    if (a.createdAt === b.createdAt) return a.id.localeCompare(b.id)
    return a.createdAt.localeCompare(b.createdAt)
  })
  void scrollToBottom()
}

async function scrollToBottom(): Promise<void> {
  await nextTick()
  const el = scroller.value
  if (el) el.scrollTop = el.scrollHeight
}

/* ---------------- SSE ---------------- */
function connectStream(): void {
  disconnectStream()
  if (!botId.value || !sender.value) return
  streamState.value = 'connecting'
  const url = chatApi.streamUrl({ botId: botId.value, sender: sender.value })
  es = new EventSource(url, { withCredentials: true })

  es.addEventListener('open', () => {
    streamState.value = 'open'
  })
  es.addEventListener('message', (ev: MessageEvent<string>) => {
    try {
      const msg = JSON.parse(ev.data) as ChatMessage
      if (msg?.id) mergeMessages([msg])
    } catch {
      /* 单条事件解析失败不影响流 */
    }
  })
  es.addEventListener('buffer', (ev: MessageEvent<string>) => {
    try {
      const data = JSON.parse(ev.data) as { buffered?: boolean; count?: number }
      buffer.value = { buffered: Boolean(data.buffered), count: Number(data.count ?? 0) }
    } catch {
      /* ignore */
    }
  })
  es.addEventListener('agent-status', (ev: MessageEvent<string>) => {
    try {
      const data = JSON.parse(ev.data) as { status?: string }
      agentStatus.value = data.status ?? ''
      if (agentStatus.value !== '') silentNotice.value = false
    } catch {
      /* ignore */
    }
  })
  es.addEventListener('tool-call', (ev: MessageEvent<string>) => {
    try {
      const data = JSON.parse(ev.data) as StreamToolCall
      if (!data.id) return
      const idx = toolCalls.value.findIndex((t) => t.id === data.id)
      if (idx >= 0) toolCalls.value[idx] = data
      else toolCalls.value.push(data)
    } catch {
      /* ignore */
    }
  })
  es.addEventListener('error', () => {
    streamState.value = 'offline'
  })
}

function disconnectStream(): void {
  if (es) {
    es.close()
    es = null
  }
}

/* ---------------- 发送 / 重生成 / 删除 ---------------- */
async function send(): Promise<void> {
  const text = draft.value.trim()
  if (text === '' || sending.value) return
  if (!sender.value) {
    error.value = '登录状态已失效，请重新登录'
    return
  }
  error.value = ''
  silentNotice.value = false
  toolCalls.value = []
  agentStatus.value = 'thinking'
  sending.value = true
  draft.value = ''

  const optimistic: ChatMessage = {
    id: `local-${Date.now()}`,
    role: 'user',
    sender: sender.value,
    botId: botId.value,
    createdAt: new Date().toISOString(),
    text,
    pieces: [{ type: 'text', text }],
    pending: true,
  }
  messages.value.push(optimistic)
  void scrollToBottom()

  try {
    const res = await chatApi.send({ botId: botId.value, text, sender: sender.value })
    // 空库首聊：后端在 /api/chat 里播种默认 bot，响应之后才有 botId；
    // 刷新列表让外壳的「当前她」、SSE 与后续接口都拿到它。
    if (botId.value === '') await bots.refresh()
    messages.value = messages.value.filter((m) => m.pending !== true)
    mergeMessages(res.messages)
    if (res.silent) {
      silentNotice.value = true
      if (silentTimer) clearTimeout(silentTimer)
      silentTimer = setTimeout(() => {
        silentNotice.value = false
      }, 6000)
    }
  } catch (e) {
    messages.value = messages.value.filter((m) => m.pending !== true)
    draft.value = text
    error.value = e instanceof Error ? e.message : '发送失败，请稍后再试'
  } finally {
    sending.value = false
    agentStatus.value = ''
  }
}

async function regenerate(): Promise<void> {
  if (sending.value || !botId.value) return
  sending.value = true
  error.value = ''
  agentStatus.value = 'thinking'
  try {
    const res = await chatApi.regenerate({ botId: botId.value, sender: sender.value })
    mergeMessages(res.messages)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '重生成失败'
  } finally {
    sending.value = false
    agentStatus.value = ''
  }
}

async function removeMessage(id: string): Promise<void> {
  try {
    await chatApi.removeMessage(id)
    messages.value = messages.value.filter((m) => m.id !== id)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '删除失败'
  }
}

/* ---------------- 生命周期 ---------------- */
onMounted(async () => {
  await bots.bootstrap()
  await loadHistory()
  connectStream()
})

watch(
  () => botId.value,
  async (next, prev) => {
    if (next === prev || next === '') return
    await loadHistory()
    connectStream()
  },
)

// 切换会话对象（联系人 → 去聊天）时重载历史并重连 SSE；通话中的对象变了先挂断。
watch(sender, async (next, prev) => {
  if (next === prev || next === '') return
  callOpen.value = false
  await loadHistory()
  connectStream()
})

watch(botId, async (next, prev) => {
  callOpen.value = false
  // 首次播种后 botId 由 '' 变为默认 bot：重新对齐历史与实时流。
  if (next === '' || next === prev) return
  await loadHistory()
  connectStream()
})

onBeforeUnmount(() => {
  callOpen.value = false
  disconnectStream()
  if (silentTimer) clearTimeout(silentTimer)
})

/** 通话需要已知的 bot 与会话发送方；缺一不可，避免点了才报错。 */
const canCall = computed(() => botId.value !== '' && sender.value !== '')

function onComposerKeydown(e: KeyboardEvent): void {
  // Enter 发送，Shift+Enter 换行（中文输入法组合态不触发）。
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    void send()
  }
}

const statusText = computed(() => {
  if (agentStatus.value === 'thinking') return '她在想…'
  if (agentStatus.value === 'tool' || toolCalls.value.length > 0) return '她在用工具…'
  if (buffer.value.buffered) return '正在输入…'
  return ''
})

function goBindWechat(): void {
  void router.push('/channels/wechat')
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <!-- 对话头部 -->
    <header class="flex min-h-14 shrink-0 items-center justify-between gap-4 border-b border-border px-6">
      <div class="min-w-0">
        <div class="flex items-center gap-2">
          <h1 class="truncate text-control font-semibold text-foreground">{{ botName }}</h1>
          <span
            v-if="streamState === 'offline'"
            class="flex items-center gap-1 text-caption text-muted-foreground"
            title="实时连接已断开"
          >
            <WifiOff class="size-3" />
            离线
          </span>
        </div>
        <div class="truncate text-caption text-muted-foreground">
          {{ statusText || (streamState === 'open' ? '在线，随时可以说话' : '连接中…') }}
        </div>
      </div>
      <div class="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          data-testid="chat-call"
          aria-label="语音通话"
          :disabled="!canCall"
          @click="callOpen = true"
        >
          <Phone />
          通话
        </Button>
        <Button variant="ghost" size="sm" :disabled="sending || !hasContent" @click="regenerate">
          <RefreshCw />
          重新生成
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button variant="ghost" size="icon-sm" aria-label="更多操作">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem @select="goBindWechat">接入微信</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled>导出对话（后续支持）</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>

    <!-- 消息区 -->
    <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
      <div class="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 md:px-6">
        <CalloutBanner v-if="error" tone="destructive" :description="error" size="sm" />

        <!-- 加载占位：保持消息区框架，不让页面塌陷 -->
        <div v-if="loading" class="flex items-center gap-2 py-10 text-label text-muted-foreground">
          <Spinner class="size-4" />
          正在载入对话…
        </div>

        <!-- 空态：仍是同一个对话框架，只是没有行 -->
        <div v-else-if="!hasContent" class="flex flex-col items-center gap-3 py-16 text-center">
          <div class="flex size-10 items-center justify-center rounded-full bg-accent text-foreground">
            <SendHorizontal class="size-4" />
          </div>
          <p class="text-control font-medium text-foreground">还没有对话</p>
          <p class="max-w-sm text-label text-muted-foreground">
            说点什么吧。她记得你们之前聊过的一切。
          </p>
        </div>

        <!-- 消息行 -->
        <div
          v-for="message in messages"
          :key="message.id"
          data-testid="chat-message"
          :data-role="message.role"
          class="group flex w-full gap-3"
          :class="message.role === 'user' ? 'flex-row-reverse' : ''"
        >
          <div class="min-w-0 max-w-[85%]">
            <div class="mb-1 flex items-center gap-2" :class="message.role === 'user' ? 'justify-end' : ''">
              <span class="text-caption text-muted-foreground">
                {{ message.role === 'user' ? '你' : botName }}
              </span>
              <span v-if="message.pending" class="text-caption text-muted-foreground">发送中…</span>
              <span v-if="message.deliveryStatus === 'failed'" class="text-caption text-destructive">
                投递失败
              </span>
            </div>
            <div
              class="rounded-xl px-4 py-2.5 text-control leading-relaxed whitespace-pre-wrap"
              :class="
                message.role === 'user'
                  ? 'bg-accent text-foreground'
                  : 'bg-section-card text-foreground'
              "
            >{{ message.text }}</div>

            <!-- 思考过程（默认折叠） -->
            <details v-if="message.reasoning" class="mt-1 text-caption text-muted-foreground">
              <summary class="cursor-pointer select-none">思考过程</summary>
              <p class="mt-1 whitespace-pre-wrap">{{ message.reasoning }}</p>
            </details>

            <!-- 消息操作 -->
            <div
              class="mt-1 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
              :class="message.role === 'user' ? 'justify-end' : ''"
            >
              <ConfirmPopover
                title="删除这条消息？"
                message="删除后对话历史里不再显示。"
                confirm-text="删除"
                cancel-text="取消"
                variant="destructive"
                @confirm="removeMessage(message.id)"
              >
                <template #trigger>
                  <Button variant="ghost" size="icon-sm" aria-label="删除消息">
                    <Trash2 />
                  </Button>
                </template>
              </ConfirmPopover>
            </div>
          </div>
        </div>

        <!-- 工具调用（实时） -->
        <div v-if="toolCalls.length > 0" class="flex flex-wrap gap-2">
          <span
            v-for="tool in toolCalls"
            :key="tool.id"
            class="rounded-sm bg-muted-soft px-2 py-1 text-caption text-muted-foreground"
          >
            {{ tool.status === 'running' ? '正在执行' : '已执行' }} · {{ tool.name }}
          </span>
        </div>

        <!-- 沉默态：她选择不回复 -->
        <div v-if="silentNotice" data-testid="chat-silent" class="flex items-center gap-2 text-caption text-muted-foreground">
          <span class="size-1.5 rounded-full bg-muted-foreground" />
          她这次没有回复（沉默）。
        </div>
      </div>
    </div>

    <!-- 输入区 -->
    <div class="shrink-0 border-t border-border bg-background px-4 py-3 md:px-6">
      <div class="mx-auto w-full max-w-3xl">
        <div class="flex items-end gap-2">
          <Textarea
            v-model="draft"
            data-testid="chat-composer"
            rows="1"
            :placeholder="composerPlaceholder"
            class="max-h-40 min-h-9 flex-1 resize-none"
            @keydown="onComposerKeydown"
          />
          <Button
            variant="brand"
            size="icon"
            data-testid="chat-send"
            aria-label="发送"
            :disabled="sending || draft.trim() === ''"
            @click="send"
          >
            <Spinner v-if="sending" class="size-4" />
            <SendHorizontal v-else />
          </Button>
        </div>
        <div class="mt-1 flex items-center justify-between text-caption text-muted-foreground">
          <span>{{ buffer.buffered ? `她在等你把话说完（${buffer.count}/…）` : statusText }}</span>
          <span v-if="streamState === 'offline'">实时连接断开，消息仍会通过刷新同步</span>
        </div>
      </div>
    </div>

    <!-- 语音通话浮层：组件内部自管 token/WS/麦克风/播放，open=false 或卸载即释放资源。 -->
    <CallOverlay
      :bot-id="botId"
      :sender="sender"
      :open="callOpen"
      @close="callOpen = false"
    />
  </div>
</template>
