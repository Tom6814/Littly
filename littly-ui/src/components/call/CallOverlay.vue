<script setup lang="ts">
/**
 * 语音通话浮层 —— 完全自包含（不依赖 ChatPage / endpoints.ts），
 * 只依赖 `@/api/client` 的 http 与 `@felinic/ui` 的 owner 组件。
 *
 * 后端契约（2026-10-31 按 console-api routes-chat.ts + voice-call/call-server.ts 核对）：
 *   1. `POST /api/call/token` body `{botId, sender}` → `{token, expiresInMs:120000}`（需登录 Cookie）。
 *   2. WS：`ws(s)://<同源 host>/call?token=<token>`；服务端只信 token 载荷里的 botId/sender，
 *      URL 上不需要再带身份。AI 主动来电可加 `&ai=1&callId=<pendingId>`。
 *   3. 上行：二进制帧 = PCM16 / 16kHz / 单声道；文本帧 `{type:'stop'}` 挂断、`{type:'interrupt'}` 打断 TTS。
 *   4. 下行 JSON：`ready` / `stt_interim{text}` / `stt_final{text}` / `stt_error{message}` /
 *      `ai_thinking` / `ai_text{text}` / `tts_text{text}` / `tts_start` / `tts_chunk{audio:<base64 MP3>}` /
 *      `tts_chunk_end` / `call_end{transcript[]}` / `error{message}`；握手失败会 4401/4403 并先回 `{type:'error'}`。
 *
 * 资源纪律：挂断 / 关闭 / 卸载统一走 teardown() —— 停麦克风轨道、关 AudioContext、
 * 关 WS、回收 MediaSource / Blob URL，避免「关掉浮层麦克风还亮着」。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  Badge,
  Button,
  CalloutBanner,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
  InlineLoadingRow,
} from '@felinic/ui'
import { Ear, Mic, PhoneOff, Sparkles, Volume2 } from 'lucide-vue-next'
import { http } from '@/api/client'

const props = withDefaults(
  defineProps<{
    botId: string
    sender: string
    open: boolean
    /** 接听 AI 主动来电时传入（来自 /api/call/requests 的 id）。 */
    aiCallId?: string
    /** AI 主动来电原因，用于接听页文案。 */
    aiReason?: string
  }>(),
  { aiCallId: '', aiReason: '' },
)

const emit = defineEmits<{ close: [] }>()

type Status = 'idle' | 'connecting' | 'active' | 'ending' | 'ended' | 'error'

interface ServerMessage {
  type: string
  text?: string
  message?: string
  audio?: string
  transcript?: string[]
}

const status = ref<Status>('idle')
const errorMessage = ref('')
const heard = ref('')
const reply = ref('')
const thinking = ref(false)
const ttsRunning = ref(false)
const micReady = ref(false)
/** MSE 不可用（Safari 等）→ 收完整段 MP3 再播放。 */
const ttsFallback = ref(false)

const TARGET_SAMPLE_RATE = 16_000
/** POST /api/call/token 的令牌有效期；连接超时兜底。 */
const CONNECT_TIMEOUT_MS = 15_000

let socket: WebSocket | null = null
let micStream: MediaStream | null = null
let audioCtx: AudioContext | null = null
let processor: ScriptProcessorNode | null = null
let sourceNode: MediaStreamAudioSourceNode | null = null
let sinkGain: GainNode | null = null

let mediaSource: MediaSource | null = null
let sourceBuffer: SourceBuffer | null = null
let audioEl: HTMLAudioElement | null = null
let mediaUrl = ''
let chunkQueue: ArrayBuffer[] = []
let ttsEnded = false
let fallbackChunks: Uint8Array[] = []
let fallbackUrl = ''
let connectTimer: number | undefined
let endTimer: number | undefined
/** 我方主动挂断（等 call_end / onclose 收尾，不再报错）。 */
let closingByUs = false
let tornDown = false

const statusText = computed(() => {
  switch (status.value) {
    case 'connecting':
      return '正在接通…'
    case 'active':
      return thinking.value ? '她正在想…' : ttsRunning.value ? '她正在说…' : '你正在说…'
    case 'ending':
      return '正在挂断…'
    case 'ended':
      return '通话已结束'
    case 'error':
      return '通话未建立'
    default:
      return '待机'
  }
})

const statusVariant = computed<'default' | 'success' | 'warning' | 'destructive'>(() => {
  switch (status.value) {
    case 'active':
      return 'success'
    case 'connecting':
    case 'ending':
      return 'warning'
    case 'error':
      return 'destructive'
    default:
      return 'default'
  }
})

function readableMicError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return '麦克风权限被拒绝。请在浏览器地址栏的权限设置里允许麦克风后再试。'
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return '没有找到可用的麦克风设备。'
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return '麦克风被其它程序占用，先关掉占用它的程序再试。'
  }
  return error instanceof Error ? error.message : '无法访问麦克风。'
}

/* ─────────────── TTS 播放（MediaSource 流式 MP3，兼容降级为整段播放） ─────────────── */

function teardownTts(): void {
  const ms = mediaSource
  mediaSource = null
  sourceBuffer = null
  ttsEnded = false
  chunkQueue = []
  fallbackChunks = []
  if (audioEl) {
    try {
      audioEl.pause()
    } catch {
      /* ignore */
    }
    audioEl.removeAttribute('src')
    audioEl = null
  }
  if (mediaUrl !== '') {
    URL.revokeObjectURL(mediaUrl)
    mediaUrl = ''
  }
  if (fallbackUrl !== '') {
    URL.revokeObjectURL(fallbackUrl)
    fallbackUrl = ''
  }
  if (ms) {
    try {
      ms.endOfStream()
    } catch {
      /* already closed */
    }
  }
}

function drainMp3(): void {
  const sb = sourceBuffer
  if (!sb || sb.updating) return
  const next = chunkQueue.shift()
  if (next !== undefined) {
    try {
      sb.appendBuffer(next)
    } catch {
      /* 坏分片跳过，继续播后面的 */
    }
    return
  }
  if (ttsEnded && mediaSource && mediaSource.readyState === 'open') {
    try {
      mediaSource.endOfStream()
    } catch {
      /* ignore */
    }
  }
}

function initTtsPlayer(): void {
  if (sourceBuffer !== null || ttsFallback.value) return
  if (typeof MediaSource === 'undefined' || typeof Audio === 'undefined') {
    ttsFallback.value = true
    return
  }
  try {
    const ms = new MediaSource()
    const audio = new Audio()
    mediaSource = ms
    audioEl = audio
    mediaUrl = URL.createObjectURL(ms)
    audio.src = mediaUrl
    ms.addEventListener('sourceopen', () => {
      const sb0 = mediaSource
      if (!sb0) return
      try {
        const sb = sb0.addSourceBuffer('audio/mpeg')
        sourceBuffer = sb
        sb.addEventListener('updateend', () => drainMp3())
        drainMp3()
      } catch {
        // 浏览器不支持 audio/mpeg → 降级整段播放
        ttsFallback.value = true
        teardownTts()
      }
    })
    audio.addEventListener('play', () => (ttsRunning.value = true))
    audio.addEventListener('ended', () => (ttsRunning.value = false))
    audio.play().catch(() => {
      /* 首帧未到前 play() 可能 reject，拿到音频后再次 play */
    })
  } catch {
    ttsFallback.value = true
    teardownTts()
  }
}

/** 降级路径：把整段 MP3 收完再播（Safari 等没有 MSE 音频）。 */
function playFallbackAudio(): void {
  if (fallbackChunks.length === 0) return
  const total = fallbackChunks.reduce((n, c) => n + c.length, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of fallbackChunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  fallbackChunks = []
  const blob = new Blob([merged], { type: 'audio/mpeg' })
  if (fallbackUrl !== '') URL.revokeObjectURL(fallbackUrl)
  fallbackUrl = URL.createObjectURL(blob)
  const audio = new Audio(fallbackUrl)
  audio.setAttribute('playsinline', '')
  audio.setAttribute('webkit-playsinline', '')
  audioEl = audio
  audio.addEventListener('play', () => (ttsRunning.value = true))
  audio.addEventListener('ended', () => (ttsRunning.value = false))
  audio.play().catch(() => (ttsRunning.value = false))
}

function pushTtsChunk(base64: string): void {
  let buffer: ArrayBuffer
  try {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    buffer = bytes.buffer
  } catch {
    return
  }
  ttsRunning.value = true
  if (ttsFallback.value) {
    fallbackChunks.push(new Uint8Array(buffer))
    return
  }
  initTtsPlayer()
  chunkQueue.push(buffer)
  drainMp3()
  if (audioEl) audioEl.play().catch(() => {})
}

function endTtsStream(): void {
  if (ttsFallback.value) {
    playFallbackAudio()
    return
  }
  ttsEnded = true
  drainMp3()
}

/** 打断：通知服务端 abort 后，本地立刻静音并清队列（已缓冲的音频不再继续播）。 */
function flushTts(): void {
  chunkQueue = []
  ttsEnded = true
  fallbackChunks = []
  if (audioEl) {
    try {
      audioEl.pause()
      audioEl.currentTime = 0
    } catch {
      /* ignore */
    }
  }
  ttsRunning.value = false
}

/* ─────────────── 麦克风采集（ScriptProcessor 兼容面更大；16k 下采样 + Int16） ─────────────── */

function teardownMic(): void {
  try {
    processor?.disconnect()
    sourceNode?.disconnect()
    sinkGain?.disconnect()
  } catch {
    /* ignore */
  }
  processor = null
  sourceNode = null
  sinkGain = null
  try {
    void audioCtx?.close()
  } catch {
    /* ignore */
  }
  audioCtx = null
  micStream?.getTracks().forEach((track) => track.stop())
  micStream = null
  micReady.value = false
}

function startMicCapture(ws: WebSocket): void {
  if (!micStream || !audioCtx) return
  const ctx = audioCtx
  const source = ctx.createMediaStreamSource(micStream)
  sourceNode = source
  // ScriptProcessor 已废弃但仍是最广兼容的采集路径；静音接到 destination 保证回调运行。
  const proc = ctx.createScriptProcessor(4096, 1, 1)
  processor = proc
  const gain = ctx.createGain()
  gain.gain.value = 0
  sinkGain = gain
  const ratio = ctx.sampleRate / TARGET_SAMPLE_RATE
  proc.onaudioprocess = (event: AudioProcessingEvent) => {
    if (ws.readyState !== WebSocket.OPEN) return
    const input = event.inputBuffer.getChannelData(0)
    const outLength = Math.floor(input.length / ratio)
    if (outLength <= 0) return
    const out = new Int16Array(outLength)
    for (let i = 0; i < outLength; i += 1) {
      // 块平均降采样，比直接抽点更适合语音识别。
      const start = Math.floor(i * ratio)
      const end = Math.min(input.length, Math.floor((i + 1) * ratio))
      let sum = 0
      let count = 0
      for (let j = start; j < end; j += 1) {
        sum += input[j] ?? 0
        count += 1
      }
      const sample = count > 0 ? sum / count : (input[start] ?? 0)
      const clamped = Math.max(-1, Math.min(1, sample))
      out[i] = clamped * 0x7fff
    }
    ws.send(out.buffer)
  }
  source.connect(proc)
  proc.connect(gain)
  gain.connect(ctx.destination)
  micReady.value = true
}

/* ─────────────── 连接生命周期 ─────────────── */

function teardown(): void {
  if (tornDown) return
  tornDown = true
  if (connectTimer !== undefined) {
    window.clearTimeout(connectTimer)
    connectTimer = undefined
  }
  if (endTimer !== undefined) {
    window.clearTimeout(endTimer)
    endTimer = undefined
  }
  teardownMic()
  teardownTts()
  const ws = socket
  socket = null
  if (ws) {
    ws.onopen = null
    ws.onmessage = null
    ws.onerror = null
    ws.onclose = null
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
  }
}

function finishClose(): void {
  teardown()
  status.value = 'ended'
  emit('close')
}

function failWith(message: string): void {
  teardown()
  errorMessage.value = message
  status.value = 'error'
}

function handleServerMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case 'ready':
      status.value = 'active'
      if (connectTimer !== undefined) {
        window.clearTimeout(connectTimer)
        connectTimer = undefined
      }
      if (!micReady.value && socket !== null && socket.readyState === WebSocket.OPEN) {
        try {
          startMicCapture(socket)
        } catch (error) {
          failWith(error instanceof Error ? error.message : '麦克风初始化失败。')
        }
      }
      break
    case 'stt_interim':
      heard.value = msg.text ?? ''
      break
    case 'stt_final':
      heard.value = msg.text ?? ''
      break
    case 'stt_error':
      // 单句识别异常不终止通话，给用户一个可读提示即可。
      errorMessage.value = `语音识别出错：${msg.message ?? '未知原因'}（可以继续说话，或挂断重拨）`
      break
    case 'ai_thinking':
      thinking.value = true
      reply.value = ''
      break
    case 'ai_text':
    case 'tts_text':
      thinking.value = false
      reply.value = msg.text ?? ''
      break
    case 'tts_start':
      ttsEnded = false
      ttsRunning.value = true
      initTtsPlayer()
      break
    case 'tts_chunk':
      if (msg.audio) pushTtsChunk(msg.audio)
      break
    case 'tts_chunk_end':
      endTtsStream()
      break
    case 'call_end':
      finishClose()
      break
    case 'error':
      failWith(msg.message ?? '通话出错，请稍后重试。')
      break
    default:
      break
  }
}

function wsUrl(token: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const base = `${proto}//${window.location.host}/call?token=${encodeURIComponent(token)}`
  if (props.aiCallId) {
    return `${base}&ai=1&callId=${encodeURIComponent(props.aiCallId)}`
  }
  return base
}

async function start(): Promise<void> {
  if (status.value !== 'idle' && status.value !== 'error' && status.value !== 'ended') return
  if (!props.botId || !props.sender) {
    failWith('缺少 botId 或 sender，无法发起通话。')
    return
  }
  tornDown = false
  closingByUs = false
  errorMessage.value = ''
  heard.value = ''
  reply.value = ''
  thinking.value = false
  ttsRunning.value = false
  ttsFallback.value = false
  status.value = 'connecting'

  // 1) 短时令牌（走 httpOnly 会话 Cookie；服务端只信令牌里的身份）。
  let token = ''
  try {
    const data = await http.post<{ token?: string }>('/api/call/token', {
      botId: props.botId,
      sender: props.sender,
    })
    token = data?.token ?? ''
  } catch (error) {
    failWith(error instanceof Error ? error.message : '获取通话令牌失败。')
    return
  }
  if (!token) {
    failWith('服务端没有返回通话令牌。')
    return
  }

  // 2) 麦克风（拿不到就别连 WS，避免消耗额度）。
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
  } catch (error) {
    failWith(readableMicError(error))
    return
  }

  // 3) WS 握手 + 采集。
  let ws: WebSocket
  try {
    ws = new WebSocket(wsUrl(token))
  } catch (error) {
    failWith(error instanceof Error ? error.message : '无法建立通话连接。')
    return
  }
  socket = ws
  ws.binaryType = 'arraybuffer'

  connectTimer = window.setTimeout(() => {
    if (status.value === 'connecting') {
      closingByUs = true
      failWith('连接超时：服务端没有在 15 秒内确认通话（检查后端是否在运行）。')
    }
  }, CONNECT_TIMEOUT_MS)

  ws.onopen = () => {
    // 只建 AudioContext；真正开始上行采集要等服务端 `ready`（鉴权通过），
    // 避免握手失败/未配置密钥时麦克风白开 1~2 秒。
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) {
      failWith('当前浏览器不支持音频采集（缺少 AudioContext）。')
      return
    }
    try {
      audioCtx = new Ctx()
      // Safari/iOS：AudioContext 在用户手势之外创建后可能处于 suspended，必须显式 resume。
      void audioCtx.resume().catch(() => {
        /* 忽略：下一次用户手势再恢复 */
      })
    } catch (error) {
      failWith(error instanceof Error ? error.message : '麦克风初始化失败。')
    }
    initTtsPlayer()
  }

  ws.onmessage = (event: MessageEvent) => {
    if (typeof event.data !== 'string') return
    let msg: ServerMessage
    try {
      msg = JSON.parse(event.data) as ServerMessage
    } catch {
      return
    }
    handleServerMessage(msg)
  }

  ws.onerror = () => {
    if (closingByUs) return
    errorMessage.value = '通话连接出错（网络断开或服务端不可用）。'
  }

  ws.onclose = (event: CloseEvent) => {
    if (closingByUs) {
      finishClose()
      return
    }
    if (status.value === 'active' || status.value === 'connecting') {
      const reason =
        event.code === 4401
          ? '通话鉴权失败（令牌无效或已过期），请重新发起通话。'
          : event.code === 4403
            ? '通话鉴权失败（连接身份与令牌不一致）。'
            : '通话连接已断开。'
      failWith(reason)
    }
  }
}

function hangUp(): void {
  if (status.value === 'error') {
    emit('close')
    return
  }
  closingByUs = true
  status.value = 'ending'
  const ws = socket
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'stop' }))
    } catch {
      /* ignore */
    }
  }
  // 服务端会先回 call_end 再断开；3 秒兜底（网络坏掉时不能卡在「正在挂断」）。
  endTimer = window.setTimeout(() => {
    if (status.value === 'ending') finishClose()
  }, 3_000)
}

function interrupt(): void {
  const ws = socket
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'interrupt' }))
    } catch {
      /* ignore */
    }
  }
  flushTts()
}

function requestClose(): void {
  if (status.value === 'active' || status.value === 'connecting' || status.value === 'ending') {
    hangUp()
    return
  }
  teardown()
  emit('close')
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      void start()
    } else {
      teardown()
      status.value = 'idle'
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => teardown())
</script>

<template>
  <Dialog
    :open="open"
    @update:open="(value: boolean) => { if (!value) requestClose() }"
  >
    <DialogPanel
      width="xl"
      footer
    >
      <DialogHeader>
        <div class="flex flex-wrap items-center gap-2">
          <DialogTitle>语音通话</DialogTitle>
          <Badge :variant="statusVariant">
            {{ statusText }}
          </Badge>
          <Badge
            v-if="micReady"
            variant="outline"
          >
            <Mic />
            麦克风已连接
          </Badge>
        </div>
      </DialogHeader>

      <DialogBody class="space-y-4">
        <CalloutBanner
          v-if="aiReason && status !== 'error'"
          tone="neutral"
          title="她打来电话"
          :description="aiReason"
        />

        <CalloutBanner
          v-if="status === 'error'"
          tone="destructive"
          title="通话未建立"
          :description="errorMessage || '未知错误'"
        />

        <InlineLoadingRow
          v-if="status === 'connecting'"
          size="md"
        >
          正在接通（取令牌 → 连麦克风 → 连通话服务）…
        </InlineLoadingRow>

        <template v-else-if="status === 'active' || status === 'ending'">
          <div class="space-y-1.5">
            <div class="flex items-center gap-1.5 text-caption text-muted-foreground">
              <Ear class="size-3.5" />
              <span>听到的（实时字幕）</span>
            </div>
            <p class="min-h-6 whitespace-pre-wrap text-body text-foreground">
              {{ heard || '（还没听到你说话）' }}
            </p>
          </div>

          <div class="space-y-1.5">
            <div class="flex items-center gap-1.5 text-caption text-muted-foreground">
              <Volume2 class="size-3.5" />
              <span>她说（实时字幕）</span>
            </div>
            <p class="min-h-6 whitespace-pre-wrap text-body text-foreground">
              {{ reply || (thinking ? '她正在想…' : ttsRunning ? '她正在说…' : '（还没开口）') }}
            </p>
          </div>

          <p class="text-caption text-muted-foreground">
            16 kHz 单声道 PCM → 服务端识别；挂断后会自动整理这次通话的记忆。
            <template v-if="ttsFallback">当前浏览器不支持流式播放，语音会整段播放。</template>
          </p>
        </template>

        <p
          v-else-if="status === 'ended'"
          class="text-body text-muted-foreground"
        >
          通话已结束。
        </p>
      </DialogBody>

      <DialogFooter>
        <Button
          v-if="status === 'error'"
          variant="outline"
          @click="requestClose"
        >
          关闭
        </Button>
        <Button
          v-else-if="status === 'active' || status === 'ending'"
          variant="outline"
          :disabled="status === 'ending'"
          @click="interrupt"
        >
          <Sparkles />
          打断她
        </Button>
        <Button
          v-if="status === 'connecting' || status === 'active' || status === 'ending'"
          variant="destructive"
          :loading="status === 'ending'"
          @click="hangUp"
        >
          <PhoneOff />
          挂断
        </Button>
      </DialogFooter>
    </DialogPanel>
  </Dialog>
</template>
