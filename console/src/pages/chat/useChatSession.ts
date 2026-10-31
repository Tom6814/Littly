/**
 * 对话状态层（ChatPage 重写，2026-10）。
 *
 * 单一消息列表 + 去重/稳定排序 + 乐观发送 + SSE 合并 + 断线重连同步 + 服务端游标分页。
 * 分页走已上线的 chatApi.messagesPage（before/beforeId 双游标，返回 hasMore）：
 * 首屏最近一页，上滑用当前最旧一条作 before 拉更早一页，prepend 后由列表保持滚动位置。
 */
import { computed, ref, type Ref } from 'vue'
import { ApiError } from '@/api/client'
import { chatApi } from '@/api/endpoints'
import type { ChatMessage, ChatResponse, StreamToolCall } from '@/api/types'
import { useBots } from '@/stores/bots'

export type StreamState = 'connecting' | 'open' | 'offline'

const PAGE_SIZE = 50 // 首屏 / 每次「加载更早」的消息条数
const RECENT_LIMIT = 100 // 断线重连补齐时的最近条数

export interface SendOutcome {
  ok: boolean
  error: string
}

function timeOf(iso: string | undefined): number {
  if (!iso) return 0
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : 0
}

function compareMessages(a: ChatMessage, b: ChatMessage): number {
  const ta = timeOf(a.createdAt)
  const tb = timeOf(b.createdAt)
  if (ta !== tb) return ta - tb
  return a.id.localeCompare(b.id)
}

function normalizeText(text: string | undefined): string {
  return String(text ?? '').trim()
}

function errorText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return e.message
  if (e instanceof Error) return e.message
  return fallback
}

export function useChatSession(botId: Ref<string>, sender: Ref<string>) {
  const bots = useBots()

  const messages = ref<ChatMessage[]>([])
  const hasMore = ref(false)
  const loading = ref(false)
  const loadingEarlier = ref(false)
  const historyError = ref('')
  const historyDenied = ref(false)

  const sending = ref(false)
  const sendError = ref('')
  const lastFailedText = ref('')

  const streamState = ref<StreamState>('connecting')
  const agentStatus = ref('')
  const toolCalls = ref<StreamToolCall[]>([])
  const buffer = ref<{ buffered: boolean; count: number }>({ buffered: false, count: 0 })
  const silentNotice = ref(false)

  let es: EventSource | null = null
  let silentTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let offlinePollTimer: ReturnType<typeof setInterval> | null = null
  let reconnectAttempt = 0
  let hadOpen = false
  let disposed = false

  const canLoadEarlier = computed(() => hasMore.value)
  const hasContent = computed(() => messages.value.length > 0)

  /* ---------------- 合并 / 去重 ---------------- */

  /**
   * 把服务端消息并入单一列表：
   * - 按 id 去重（SSE 与 /api/chat 响应经常回推同一条）；
   * - 服务端确认的 user 消息按文本对掉本地乐观气泡（去重根因）；
   * - 稳定排序（createdAt 相同用 id 兜底）；
   * - 追加消息时同步放大窗口，保证顶部可见起点不因 slice(-window) 而漂移。
   */
  function mergeMessages(incoming: ChatMessage[]): void {
    if (incoming.length === 0) return
    const confirmedText = new Set(
      incoming.filter((m) => m.role === 'user').map((m) => normalizeText(m.text)),
    )
    const byId = new Map<string, ChatMessage>()
    for (const m of messages.value) {
      if (m.pending === true && confirmedText.has(normalizeText(m.text))) continue
      byId.set(m.id, m)
    }
    for (const m of incoming) byId.set(m.id, m)
    messages.value = [...byId.values()].sort(compareMessages)

    // 收到回复后收掉「输入中/工具中」提示
    if (!sending.value && incoming.some((m) => m.role === 'assistant' && m.pending !== true)) {
      agentStatus.value = ''
      toolCalls.value = []
    }
  }

  function removeLocal(id: string): void {
    messages.value = messages.value.filter((m) => m.id !== id)
  }

  /** 全量重置（切换 bot / 会话对象时）。 */
  function reset(): void {
    messages.value = []
    hasMore.value = false
    historyError.value = ''
    historyDenied.value = false
    sendError.value = ''
    lastFailedText.value = ''
    agentStatus.value = ''
    toolCalls.value = []
    buffer.value = { buffered: false, count: 0 }
    silentNotice.value = false
  }

  function clearSendError(): void {
    sendError.value = ''
    lastFailedText.value = ''
  }

  /* ---------------- 历史 ---------------- */

  async function loadHistory(): Promise<void> {
    if (botId.value === '' || sender.value === '') return
    loading.value = true
    historyError.value = ''
    historyDenied.value = false
    try {
      const page = await chatApi.messagesPage({
        botId: botId.value,
        sender: sender.value,
        limit: PAGE_SIZE,
      })
      messages.value = [...page.messages].sort(compareMessages)
      hasMore.value = page.hasMore
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        historyDenied.value = true
        messages.value = []
      } else {
        historyError.value = errorText(e, '加载消息失败')
      }
    } finally {
      loading.value = false
    }
  }

  /** 断线重连 / 窗口聚焦后补齐「离线期间的消息」：只合并现有列表，不重置滚动。 */
  async function resyncRecent(): Promise<void> {
    if (botId.value === '' || sender.value === '') return
    try {
      const page = await chatApi.messagesPage({
        botId: botId.value,
        sender: sender.value,
        limit: RECENT_LIMIT,
      })
      mergeMessages(page.messages)
    } catch {
      /* 同步失败静默：下次重连/轮询再试 */
    }
  }

  /** 上滑加载更早一页（before/beforeId 双游标）；返回是否有新增。 */
  async function loadEarlier(): Promise<boolean> {
    if (!canLoadEarlier.value || loadingEarlier.value) return false
    const oldest = messages.value[0]
    if (oldest === undefined) return false
    loadingEarlier.value = true
    try {
      const page = await chatApi.messagesPage({
        botId: botId.value,
        sender: sender.value,
        limit: PAGE_SIZE,
        before: { createdAt: oldest.createdAt, id: oldest.id },
      })
      const before = messages.value.length
      mergeMessages(page.messages)
      hasMore.value = page.hasMore
      return messages.value.length > before
    } catch {
      return false
    } finally {
      loadingEarlier.value = false
    }
  }

  /* ---------------- 发送 / 重生成 / 删除 ---------------- */

  async function send(text: string): Promise<SendOutcome> {
    const trimmed = text.trim()
    if (trimmed === '' || sending.value) return { ok: false, error: '' }
    if (sender.value === '') return { ok: false, error: '登录状态已失效，请重新登录' }

    clearSendError()
    silentNotice.value = false
    toolCalls.value = []
    agentStatus.value = 'thinking'
    sending.value = true

    const optimistic: ChatMessage = {
      id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      sender: sender.value,
      botId: botId.value,
      createdAt: new Date().toISOString(),
      text: trimmed,
      pieces: [{ type: 'text', text: trimmed }],
      pending: true,
    }
    messages.value = [...messages.value, optimistic].sort(compareMessages)

    try {
      const res = await chatApi.send({ botId: botId.value, text: trimmed, sender: sender.value })
      // 空库首聊：后端在 /api/chat 里播种默认 bot，响应消息里带 botId。
      if (botId.value === '') {
        const inferred = res.messages.find((m) => m.botId !== '')?.botId
        if (inferred !== undefined) bots.adopt(inferred)
        else await bots.refresh()
      }
      removeLocal(optimistic.id)
      applyChatResponse(res)
      return { ok: true, error: '' }
    } catch (e) {
      removeLocal(optimistic.id)
      // 网络响应丢失但 SSE 已把消息落库：按成功处理，不误报失败。
      if (messages.value.some((m) => m.role === 'user' && normalizeText(m.text) === trimmed)) {
        return { ok: true, error: '' }
      }
      const message = errorText(e, '发送失败，请稍后再试')
      sendError.value = message
      lastFailedText.value = trimmed
      return { ok: false, error: message }
    } finally {
      sending.value = false
      agentStatus.value = ''
    }
  }

  function applyChatResponse(res: ChatResponse): void {
    mergeMessages(res.messages)
    if (res.silent) {
      silentNotice.value = true
      if (silentTimer !== null) clearTimeout(silentTimer)
      silentTimer = setTimeout(() => {
        silentNotice.value = false
      }, 6000)
    }
  }

  async function regenerate(): Promise<boolean> {
    if (sending.value || botId.value === '') return false
    sending.value = true
    sendError.value = ''
    agentStatus.value = 'thinking'
    toolCalls.value = []
    silentNotice.value = false

    // 后端 regenerate 会删除「最后一条用户消息及其后」再重跑；本地同步裁掉旧气泡，
    // 失败时完整回滚，避免旧消息 + 新回复重复显示。
    const lastUserIndex = messages.value.map((m) => m.role).lastIndexOf('user')
    const removedTail = lastUserIndex >= 0 ? messages.value.slice(lastUserIndex) : []
    if (lastUserIndex >= 0) messages.value = messages.value.slice(0, lastUserIndex)
    try {
      const res = await chatApi.regenerate({ botId: botId.value, sender: sender.value })
      applyChatResponse(res)
      return true
    } catch (e) {
      messages.value = [...messages.value, ...removedTail].sort(compareMessages)
      sendError.value = errorText(e, '重新生成失败')
      return false
    } finally {
      sending.value = false
      agentStatus.value = ''
    }
  }

  async function removeMessage(id: string): Promise<boolean> {
    if (id.startsWith('local-')) return false
    try {
      await chatApi.removeMessage(id)
      removeLocal(id)
      return true
    } catch (e) {
      sendError.value = errorText(e, '删除失败')
      return false
    }
  }

  /** 删除最近一条落库消息（顶部菜单用）。 */
  async function removeLastMessage(): Promise<boolean> {
    const last = [...messages.value].reverse().find((m) => m.pending !== true)
    if (last === undefined) return false
    return removeMessage(last.id)
  }

  /* ---------------- SSE ---------------- */

  function stopOfflinePoll(): void {
    if (offlinePollTimer !== null) {
      clearInterval(offlinePollTimer)
      offlinePollTimer = null
    }
  }

  function startOfflinePoll(): void {
    if (offlinePollTimer !== null) return
    offlinePollTimer = setInterval(() => {
      if (streamState.value === 'open' || disposed) return
      void resyncRecent()
    }, 8000)
  }

  function clearReconnect(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function scheduleReconnect(): void {
    if (disposed || reconnectTimer !== null) return
    const delay = Math.min(30_000, 2000 * 2 ** Math.min(reconnectAttempt, 4))
    reconnectAttempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }

  function connect(): void {
    disconnectStream()
    if (disposed || botId.value === '' || sender.value === '') return
    streamState.value = 'connecting'
    const url = chatApi.streamUrl({ botId: botId.value, sender: sender.value })
    const source = new EventSource(url, { withCredentials: true })
    es = source

    source.addEventListener('open', () => {
      if (es !== source) return
      const recovering = streamState.value === 'offline'
      streamState.value = 'open'
      reconnectAttempt = 0
      clearReconnect()
      stopOfflinePoll()
      // 第一次连接不需要补（历史刚拉过）；断线重连必须补离线期间漏掉的消息。
      if (recovering || hadOpen) void resyncRecent()
      hadOpen = true
    })

    source.addEventListener('message', (ev: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(ev.data) as ChatMessage
        if (msg !== null && typeof msg === 'object' && typeof msg.id === 'string') mergeMessages([msg])
      } catch {
        /* 单条事件解析失败不影响流 */
      }
    })

    source.addEventListener('buffer', (ev: MessageEvent<string>) => {
      try {
        const data = JSON.parse(ev.data) as { buffered?: boolean; count?: number }
        buffer.value = { buffered: data.buffered === true, count: Number(data.count ?? 0) }
      } catch {
        /* ignore */
      }
    })

    source.addEventListener('agent-status', (ev: MessageEvent<string>) => {
      try {
        const data = JSON.parse(ev.data) as { status?: string }
        agentStatus.value = data.status ?? ''
        if (agentStatus.value !== '') silentNotice.value = false
      } catch {
        /* ignore */
      }
    })

    source.addEventListener('tool-call', (ev: MessageEvent<string>) => {
      try {
        const data = JSON.parse(ev.data) as StreamToolCall
        if (typeof data.id !== 'string' || data.id === '') return
        const idx = toolCalls.value.findIndex((t) => t.id === data.id)
        if (idx >= 0) toolCalls.value[idx] = data
        else toolCalls.value = [...toolCalls.value, data]
      } catch {
        /* ignore */
      }
    })

    source.addEventListener('error', () => {
      if (es !== source) return
      streamState.value = 'offline'
      try {
        source.close()
      } catch {
        /* ignore */
      }
      es = null
      startOfflinePoll()
      scheduleReconnect()
    })
  }

  function disconnectStream(): void {
    clearReconnect()
    stopOfflinePoll()
    if (es !== null) {
      try {
        es.close()
      } catch {
        /* ignore */
      }
      es = null
    }
  }

  function dispose(): void {
    disposed = true
    disconnectStream()
    if (silentTimer !== null) {
      clearTimeout(silentTimer)
      silentTimer = null
    }
  }

  const statusText = computed(() => {
    if (sending.value) return '正在发送…'
    if (agentStatus.value === 'thinking') return '她在想…'
    if (agentStatus.value === 'tool' || toolCalls.value.some((t) => t.status === 'running')) return '她在用工具…'
    if (buffer.value.buffered) return `她在等你把话说完（${buffer.value.count}）`
    if (streamState.value === 'offline') return '实时连接断开，正在重连…'
    return ''
  })

  return {
    messages,
    hasMore,
    canLoadEarlier,
    loadingEarlier,
    hasContent,
    loading,
    historyError,
    historyDenied,
    sending,
    sendError,
    lastFailedText,
    streamState,
    agentStatus,
    toolCalls,
    buffer,
    silentNotice,
    statusText,
    loadHistory,
    resyncRecent,
    loadEarlier,
    send,
    regenerate,
    removeMessage,
    removeLastMessage,
    clearSendError,
    reset,
    connect,
    disconnectStream,
    dispose,
  }
}
