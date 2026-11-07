<script setup lang="ts">
/**
 * 对话页（2026-10 重写）—— 与她直接聊天。
 *
 * 数据/状态全部收敛在 useChatSession：
 *   - 单一消息列表（id 去重 + 稳定排序）、乐观发送、SSE 合并、断线重连补齐；
 *   - 首屏最近一页 + 上滑按游标加载更早（chatApi.messagesPage）；
 *   - 失败回滚（草稿恢复 + 重试）、重生成失败回滚、删除同步。
 * 页面本身只做布局、通话浮层与来电轮询。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  Button,
  CalloutBanner,
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
  toast,
} from '@felinic/ui'
import { Phone } from 'lucide-vue-next'
import { callApi, type PendingCall } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { useBots } from '@/stores/bots'
import CallOverlay from '@/components/call/CallOverlay.vue'
import ChatHeader from '@/components/chat/ChatHeader.vue'
import ChatMessageList from '@/components/chat/ChatMessageList.vue'
import ChatComposer from '@/components/chat/ChatComposer.vue'
import { useChatSession } from '@/pages/chat/useChatSession'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const bots = useBots()

// 联系人页通过 /chat?sender=<id> 打开某人的会话；缺省用当前登录用户。
const routeSender = computed(() => (typeof route.query.sender === 'string' ? route.query.sender : ''))
const sender = computed(() => routeSender.value || auth.state.user?.id || '')
const botId = computed(() => bots.state.currentBotId ?? '')
const botName = computed(() => bots.currentBot.value?.name ?? '她')
const botAvatar = computed(() => bots.currentBot.value?.avatarUrl ?? '')
const canCall = computed(() => botId.value !== '' && sender.value !== '')

const session = useChatSession(botId, sender)
const {
  messages,
  loadingEarlier,
  historyError,
  historyDenied,
  sending,
  sendError,
  lastFailedText,
  streamState,
  toolCalls,
  agentStatus,
  buffer,
  silentNotice,
  statusText,
  canLoadEarlier,
} = session

const draft = ref('')
const listRef = ref<InstanceType<typeof ChatMessageList> | null>(null)
const composerRef = ref<InstanceType<typeof ChatComposer> | null>(null)
const deleteLastOpen = ref(false)

/* ---------------- 发送 / 建议 / 删除 ---------------- */
async function handleSend(): Promise<void> {
  const text = draft.value.trim()
  if (text === '' || sending.value) return
  const outcome = await session.send(text)
  if (outcome.ok) {
    draft.value = ''
    composerRef.value?.resetHeight()
    await nextTick()
    listRef.value?.scrollToBottom(false)
  } else if (outcome.error !== '') {
    // 草稿恢复：失败不吞用户输入，保留原文方便重试
    draft.value = text
    composerRef.value?.focus()
  }
}

function retrySend(): void {
  const text = lastFailedText.value
  if (text === '') return
  session.clearSendError()
  draft.value = text
  void handleSend()
}

function onSuggest(text: string): void {
  draft.value = text
  composerRef.value?.focus()
}

function onDelete(id: string): void {
  void session.removeMessage(id)
}

function onRegenerate(): void {
  void session.regenerate().then((ok) => {
    if (ok) void nextTick(() => listRef.value?.scrollToBottom(false))
  })
}

function onRefresh(): void {
  void session.loadHistory().then(() => {
    void nextTick(() => listRef.value?.scrollToBottom(false))
  })
}

function askDeleteLast(): void {
  if (messages.value.length === 0) return
  deleteLastOpen.value = true
}

const lastPreview = computed(() => {
  const last = [...messages.value].reverse().find((m) => m.pending !== true)
  if (last === undefined) return ''
  const text = last.text.trim().replace(/\s+/g, ' ')
  return text.length > 80 ? `${text.slice(0, 80)}…` : text
})

async function confirmDeleteLast(): Promise<void> {
  deleteLastOpen.value = false
  const ok = await session.removeLastMessage()
  if (ok) toast.success('已删除最近一条消息')
}

function goBindWechat(): void {
  void router.push('/channels/wechat')
}

/* ---------------- 语音通话（浮层自包含 / 来电轮询） ---------------- */
const callOpen = ref(false)
const pendingCall = ref<PendingCall | null>(null)
const aiCall = ref<{ id: string; reason: string } | null>(null)
const dismissedCallIds = new Set<string>()
let callPollTimer: ReturnType<typeof setInterval> | null = null

async function pollCalls(): Promise<void> {
  if (botId.value === '' || sender.value === '' || callOpen.value || pendingCall.value !== null) return
  if (document.visibilityState !== 'visible') return
  try {
    const calls = await callApi.requests(botId.value)
    const next = calls.find((c) => !dismissedCallIds.has(c.id))
    if (next !== undefined) pendingCall.value = next
  } catch {
    /* 轮询失败静默：下次再试，不打扰正常聊天 */
  }
}

function declineCall(): void {
  if (pendingCall.value !== null) dismissedCallIds.add(pendingCall.value.id)
  pendingCall.value = null
}

async function acceptCall(): Promise<void> {
  const call = pendingCall.value
  if (call === null) return
  dismissedCallIds.add(call.id)
  try {
    const accepted = await callApi.accept(call.id)
    pendingCall.value = null
    aiCall.value = { id: accepted?.id ?? call.id, reason: accepted?.reason ?? call.reason ?? '' }
    callOpen.value = true
  } catch (e) {
    pendingCall.value = null
    toast.error(e instanceof Error ? e.message : '接听失败，来电可能已过期')
  }
}

/** 通话结束：收起浮层并刷新对话（通话内容会由后端整理成消息/记忆）。 */
function onCallEnd(): void {
  callOpen.value = false
  aiCall.value = null
  onRefresh()
}

/* ---------------- 会话装载 ---------------- */
let conversationKey = ''

async function loadConversation(): Promise<void> {
  if (botId.value === '' || sender.value === '') return
  const key = `${botId.value}::${sender.value}`
  if (key === conversationKey) return
  conversationKey = key
  callOpen.value = false
  pendingCall.value = null
  session.reset()
  await session.loadHistory()
  await nextTick()
  listRef.value?.scrollToBottom(false)
  session.connect()
}

onMounted(async () => {
  await bots.bootstrap()
  await loadConversation()
  callPollTimer = setInterval(() => void pollCalls(), 10_000)
  void pollCalls()
})

watch(
  [botId, sender],
  async ([nextBot, nextSender], [prevBot, prevSender]) => {
    if (nextBot === '' || nextSender === '') return
    if (nextBot === prevBot && nextSender === prevSender) return
    await loadConversation()
  },
)

onBeforeUnmount(() => {
  callOpen.value = false
  if (callPollTimer !== null) clearInterval(callPollTimer)
  session.dispose()
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background">
    <ChatHeader
      :bot-name="botName"
      :bot-avatar="botAvatar"
      :status-text="statusText"
      :stream-state="streamState"
      :can-call="canCall"
      :sending="sending"
      :has-messages="messages.length > 0"
      @call="callOpen = true"
      @regenerate="onRegenerate"
      @delete-last="askDeleteLast"
      @refresh="onRefresh"
      @bind-wechat="goBindWechat"
    />

    <ChatMessageList
      ref="listRef"
      :messages="messages"
      :has-more="canLoadEarlier"
      :load-earlier="session.loadEarlier"
      :loading="session.loading.value"
      :loading-earlier="loadingEarlier"
      :history-error="historyError"
      :history-denied="historyDenied"
      :bot-name="botName"
      :bot-avatar="botAvatar"
      :sending="sending"
      :agent-status="agentStatus"
      :tool-calls="toolCalls"
      :buffered="buffer.buffered"
      :buffer-count="buffer.count"
      :silent-notice="silentNotice"
      @delete="onDelete"
      @suggest="onSuggest"
    />

    <!-- 发送失败：保留草稿并提供重试（不静默吞掉） -->
    <div v-if="sendError !== ''" class="px-3 md:px-6">
      <div class="mx-auto w-full max-w-3xl pb-2">
        <CalloutBanner tone="destructive" size="sm" title="操作没有完成" :description="sendError">
          <Button variant="outline" size="sm" @click="retrySend">重试</Button>
        </CalloutBanner>
      </div>
    </div>

    <ChatComposer
      ref="composerRef"
      v-model="draft"
      :sending="sending"
      :status-text="statusText"
      :offline="streamState === 'offline'"
      @send="handleSend"
    />

    <!-- 语音通话浮层：组件内部自管 token/WS/麦克风/播放，open=false 或卸载即释放资源。 -->
    <CallOverlay
      :bot-id="botId"
      :sender="sender"
      :open="callOpen"
      :ai-call-id="aiCall?.id ?? ''"
      :ai-reason="aiCall?.reason ?? ''"
      @close="onCallEnd"
    />

    <!-- 删除最近一条（顶部菜单入口 + 二次确认） -->
    <Dialog :open="deleteLastOpen" @update:open="(value: boolean) => (deleteLastOpen = value)">
      <DialogPanel width="lg" footer>
        <DialogHeader>
          <DialogTitle>删除最近一条消息？</DialogTitle>
          <DialogDescription class="sr-only">删除后对话历史里不再显示（服务端为软删，可恢复）。</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <p class="text-label text-muted-foreground">最近一条：</p>
          <p class="mt-1 whitespace-pre-wrap break-words text-control text-foreground">
            {{ lastPreview || '（空消息）' }}
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" @click="deleteLastOpen = false">取消</Button>
          <Button variant="destructive" @click="confirmDeleteLast">删除</Button>
        </DialogFooter>
      </DialogPanel>
    </Dialog>

    <!-- 她主动打来电话：接听走 accept（消费 pending），再以 AI 来电模式拨号。 -->
    <Dialog
      :open="pendingCall !== null"
      @update:open="(value: boolean) => { if (!value) declineCall() }"
    >
      <DialogPanel width="lg" footer>
        <DialogHeader>
          <DialogTitle>她打来电话了</DialogTitle>
          <DialogDescription class="sr-only">接听后进入语音通话浮层。</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <p class="text-control text-foreground">
            {{ pendingCall?.reason || '（她没说原因，就是想听听你的声音）' }}
          </p>
          <p v-if="pendingCall?.topic" class="mt-1 text-label text-muted-foreground">
            想聊：{{ pendingCall.topic }}
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" @click="declineCall">挂掉</Button>
          <Button variant="brand" @click="acceptCall">
            <Phone class="size-4" />
            接听
          </Button>
        </DialogFooter>
      </DialogPanel>
    </Dialog>
  </div>
</template>
