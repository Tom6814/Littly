<script setup lang="ts">
/**
 * 语音通话浮层（浏览器原生语音版）。
 *
 * 原版走 Deepgram STT + Fish TTS 的 /call WebSocket；本实现保留同样的通话 UI，
 * 但用浏览器 SpeechRecognition / SpeechSynthesis 完成「听到你 → 她回复 → 她说出来」，
 * 因此不需要额外语音 API key。回复仍进她的聊天/记忆，挂断后可在对话里看到。
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
} from '@felinic/ui'
import { Ear, Mic, PhoneOff, Volume2 } from 'lucide-vue-next'

const props = withDefaults(defineProps<{
  botId: string
  sender: string
  open: boolean
  aiCallId?: string
  aiReason?: string
}>(), { aiCallId: '', aiReason: '' })
const emit = defineEmits<{ close: [] }>()

type Status = 'idle' | 'connecting' | 'active' | 'ending' | 'ended' | 'error'
const status = ref<Status>('idle')
const errorMessage = ref('')
const heard = ref('')
const reply = ref('')
const thinking = ref(false)
const speaking = ref(false)
const micReady = ref(false)
const unsupported = ref(false)

let recognition: any = null
let active = false
let pending = false
let speakTimer: number | undefined

const statusText = computed(() => {
  if (status.value === 'connecting') return '正在接通…'
  if (status.value === 'active') return thinking.value ? '她正在想…' : speaking.value ? '她正在说…' : '你正在说…'
  if (status.value === 'ending') return '正在挂断…'
  if (status.value === 'ended') return '通话已结束'
  if (status.value === 'error') return '通话未建立'
  return '待机'
})
const statusVariant = computed<'default' | 'success' | 'warning' | 'destructive'>(() =>
  status.value === 'active' ? 'success' : status.value === 'error' ? 'destructive' : status.value === 'idle' ? 'default' : 'warning',
)

function speechRecognitionCtor(): any {
  const w = window as any
  return w.SpeechRecognition || w.webkitSpeechRecognition || null
}

function speak(text: string): void {
  if (!('speechSynthesis' in window) || !text.trim()) { resumeRecognition(); return }
  speaking.value = true
  const u = new SpeechSynthesisUtterance(text)
  u.lang = 'zh-CN'
  u.rate = 1
  u.pitch = 1
  const voices = window.speechSynthesis.getVoices()
  const zh = voices.find((v) => v.lang.toLowerCase().startsWith('zh'))
  if (zh) u.voice = zh
  u.onend = () => { speaking.value = false; resumeRecognition() }
  u.onerror = () => { speaking.value = false; resumeRecognition() }
  window.speechSynthesis.cancel()
  window.speechSynthesis.speak(u)
}

function pauseRecognition(): void {
  try { recognition?.stop() } catch { /* ignore */ }
}
function resumeRecognition(): void {
  if (!active || !recognition || status.value !== 'active') return
  try { recognition.start() } catch { /* already started */ }
}

async function sendToHer(text: string): Promise<void> {
  const value = text.trim()
  if (!value || pending) return
  pending = true
  heard.value = value
  thinking.value = true
  reply.value = ''
  pauseRecognition()
  try {
    const r = await fetch('/littly/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: value }),
    })
    const d = await r.json()
    if (!r.ok) throw new Error(d.detail || d.error || '请求失败')
    thinking.value = false
    reply.value = d.replied ? (d.reply || '') : '这次她没接话。'
    if (d.replied && d.reply) speak(d.reply)
    else resumeRecognition()
  } catch (e: any) {
    thinking.value = false
    errorMessage.value = e?.message || '发送失败'
    resumeRecognition()
  } finally {
    pending = false
  }
}

function createRecognition(): boolean {
  const Ctor = speechRecognitionCtor()
  if (!Ctor) { unsupported.value = true; return false }
  const rec = new Ctor()
  rec.lang = 'zh-CN'
  rec.continuous = true
  rec.interimResults = true
  rec.onstart = () => { micReady.value = true }
  rec.onresult = (event: any) => {
    let interim = ''
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const t = String(event.results[i][0]?.transcript || '')
      if (event.results[i].isFinal) void sendToHer(t)
      else interim += t
    }
    if (interim && !speaking.value) heard.value = interim
  }
  rec.onerror = (event: any) => {
    if (event?.error === 'not-allowed' || event?.error === 'service-not-allowed') {
      fail('麦克风权限被拒绝。请在地址栏允许麦克风后重试。')
    } else if (event?.error === 'no-speech') {
      // 安静一会儿是正常的，重开即可
      resumeRecognition()
    }
  }
  rec.onend = () => { micReady.value = false; if (active && status.value === 'active' && !speaking.value) resumeRecognition() }
  recognition = rec
  return true
}

function fail(message: string): void {
  errorMessage.value = message
  status.value = 'error'
  teardown()
}

function start(): void {
  if (!props.open) return
  errorMessage.value = ''
  heard.value = ''
  reply.value = ''
  thinking.value = false
  speaking.value = false
  unsupported.value = false
  status.value = 'connecting'
  if (!props.botId || !props.sender) { fail('缺少身份，无法发起通话。'); return }
  if (!navigator.mediaDevices?.getUserMedia) { fail('当前浏览器不支持麦克风采集。'); return }
  if (!speechRecognitionCtor()) {
    fail('当前浏览器不支持语音识别（请用 Chrome / Edge 打开）。')
    return
  }
  if (!createRecognition()) { fail('语音识别初始化失败。'); return }
  navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    .then(() => {
      active = true
      status.value = 'active'
      try { recognition.start() } catch { /* ignore */ }
    })
    .catch((e) => fail(e?.name === 'NotAllowedError' ? '麦克风权限被拒绝。请允许后重试。' : (e?.message || '无法访问麦克风。')))
}

function teardown(): void {
  active = false
  if (speakTimer !== undefined) { clearTimeout(speakTimer); speakTimer = undefined }
  try { recognition?.abort() } catch { /* ignore */ }
  recognition = null
  if ('speechSynthesis' in window) window.speechSynthesis.cancel()
  micReady.value = false
  speaking.value = false
}

function hangUp(): void {
  status.value = 'ending'
  teardown()
  status.value = 'ended'
  setTimeout(() => emit('close'), 400)
}
function requestClose(): void {
  if (status.value === 'active' || status.value === 'connecting' || status.value === 'ending') { hangUp(); return }
  teardown()
  status.value = 'idle'
  emit('close')
}
function interrupt(): void {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel()
  speaking.value = false
  resumeRecognition()
}

watch(() => props.open, (open) => { if (open) start(); else { teardown(); status.value = 'idle' } }, { immediate: true })
onBeforeUnmount(teardown)
</script>

<template>
  <Dialog :open="open" @update:open="(value: boolean) => { if (!value) requestClose() }">
    <DialogPanel width="xl" footer>
      <DialogHeader>
        <div class="flex flex-wrap items-center gap-2">
          <DialogTitle>语音通话</DialogTitle>
          <Badge :variant="statusVariant">{{ statusText }}</Badge>
          <Badge v-if="micReady" variant="outline"><Mic class="size-3.5" />麦克风已连接</Badge>
        </div>
      </DialogHeader>
      <DialogBody class="space-y-4">
        <CalloutBanner v-if="aiReason && status !== 'error'" tone="neutral" title="她打来电话" :description="aiReason" />
        <CalloutBanner v-if="status === 'error'" tone="destructive" title="通话未建立" :description="errorMessage || '未知错误'" />
        <div v-if="status === 'connecting'" class="text-body text-muted-foreground">正在接通（麦克风 → 语音识别）…</div>
        <template v-else-if="status === 'active' || status === 'ending'">
          <div class="space-y-1.5">
            <div class="flex items-center gap-1.5 text-caption text-muted-foreground"><Ear class="size-3.5" /><span>听到的（实时字幕）</span></div>
            <p class="min-h-6 whitespace-pre-wrap text-body text-foreground">{{ heard || '（还没听到你说话）' }}</p>
          </div>
          <div class="space-y-1.5">
            <div class="flex items-center gap-1.5 text-caption text-muted-foreground"><Volume2 class="size-3.5" /><span>她说（实时字幕）</span></div>
            <p class="min-h-6 whitespace-pre-wrap text-body text-foreground">{{ reply || (thinking ? '她正在想…' : speaking ? '她正在说…' : '（还没开口）') }}</p>
          </div>
          <p class="text-caption text-muted-foreground">浏览器原生语音识别 + 语音合成；回复会进入她的聊天与记忆。需要麦克风权限，建议 Chrome / Edge。</p>
        </template>
        <p v-else-if="status === 'ended'" class="text-body text-muted-foreground">通话已结束。</p>
      </DialogBody>
      <DialogFooter>
        <Button v-if="status === 'error'" variant="outline" @click="requestClose">关闭</Button>
        <Button v-else-if="status === 'active' || status === 'ending'" variant="outline" :disabled="status === 'ending'" @click="interrupt">打断她</Button>
        <Button v-if="status === 'connecting' || status === 'active' || status === 'ending'" variant="destructive" :loading="status === 'ending'" @click="hangUp"><PhoneOff />挂断</Button>
      </DialogFooter>
    </DialogPanel>
  </Dialog>
</template>
