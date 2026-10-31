<script setup lang="ts">
/**
 * 单条消息行：头像/名字（组内首条）、按行分气泡、附件、思考折叠、时间 hover、复制/删除。
 * 同角色连发的合并由父级 ChatMessageList 通过 groupFirst/groupLast 控制。
 */
import { computed } from 'vue'
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  ConfirmPopover,
  toast,
  useClipboard,
} from '@felinic/ui'
import { Copy, FileText, Image as ImageIcon, Trash2, Volume2 } from 'lucide-vue-next'
import type { ChatMessage, ChatMessagePiece } from '@/api/types'
import { bubblesOf, formatTime, initialOf } from '@/pages/chat/format'

const props = defineProps<{
  message: ChatMessage
  botName: string
  botAvatar: string
  mine: boolean
  groupFirst: boolean
  groupLast: boolean
}>()

const emit = defineEmits<{
  (e: 'delete', id: string): void
}>()

const textLines = computed(() => bubblesOf(props.message.text))
const images = computed(() => props.message.pieces.filter((p) => p.type === 'image' && (p.url ?? '') !== ''))
const files = computed(() => props.message.pieces.filter((p) => p.type === 'file' && (p.url ?? '') !== ''))
const voices = computed(() => props.message.pieces.filter((p) => p.type === 'voice' && (p.url ?? '') !== ''))
const hasAttachments = computed(() => images.value.length + files.value.length + voices.value.length > 0)
const reasoning = computed(() => (props.message.reasoning ?? '').trim())
const isPending = computed(() => props.message.pending === true)
const isFailed = computed(() => props.message.deliveryStatus === 'failed')
const canDelete = computed(() => !isPending.value && !props.message.id.startsWith('local-'))
const timeText = computed(() => formatTime(props.message.createdAt))

function pieceLabel(piece: ChatMessagePiece): string {
  if (piece.type === 'file') return piece.name ?? '文件'
  if (piece.type === 'voice') return piece.text !== undefined && piece.text !== '' ? `语音：${piece.text}` : '语音'
  return ''
}

const { copyText: copy } = useClipboard()

async function copyText(): Promise<void> {
  const text = props.message.text.trim()
  if (text === '') return
  // 走 @felinic/ui 的 clipboard 实现：Safari 下 navigator.clipboard 需要安全上下文/手势，
  // 失败时它内部会退回 execCommand('copy')，避免 Safari 静默失败。
  const ok = await copy(text)
  if (ok) toast.success('已复制')
  else toast.error('复制失败')
}
</script>

<template>
  <div
    class="group/msg flex w-full gap-2.5"
    :class="[mine ? 'flex-row-reverse' : 'flex-row', groupFirst ? 'mt-3' : 'mt-0.5']"
    :data-message-id="message.id"
    data-testid="chat-message"
    :data-role="message.role"
  >
    <!-- 头像：组内首条显示，其余留白对齐 -->
    <Avatar v-if="groupFirst" class="mt-0.5 size-8 shrink-0">
      <AvatarImage v-if="!mine && botAvatar !== ''" :src="botAvatar" :alt="botName" />
      <AvatarFallback class="text-caption">{{ mine ? '你' : initialOf(botName) }}</AvatarFallback>
    </Avatar>
    <div v-else class="size-8 shrink-0" aria-hidden="true" />

    <div class="flex min-w-0 max-w-[min(85%,42rem)] flex-col gap-1" :class="mine ? 'items-end' : 'items-start'">
      <!-- 名字 + 状态（组内首条；时间在气泡下方 hover 显示，保持顶部干净） -->
      <div
        v-if="groupFirst && (!mine || isPending || isFailed)"
        class="flex items-center gap-2 text-caption text-muted-foreground"
        :class="mine ? 'flex-row-reverse' : ''"
      >
        <span v-if="!mine" class="font-medium text-foreground">{{ botName }}</span>
        <span v-if="isPending" aria-live="polite">发送中…</span>
        <span v-else-if="isFailed" class="text-destructive">投递失败</span>
      </div>

      <!-- 附件（图片/文件/语音）：先于文字气泡 -->
      <div v-if="hasAttachments" class="flex flex-col gap-1" :class="mine ? 'items-end' : 'items-start'">
        <a
          v-for="(image, index) in images"
          :key="`img-${index}`"
          :href="image.url"
          target="_blank"
          rel="noreferrer"
          class="block overflow-hidden rounded-xl border border-border"
        >
          <img
            :src="image.url"
            alt="图片消息"
            class="max-h-64 w-auto max-w-full object-contain"
            loading="lazy"
          />
        </a>
        <a
          v-for="(file, index) in files"
          :key="`file-${index}`"
          :href="file.url"
          target="_blank"
          rel="noreferrer"
          class="flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-section-card px-2.5 py-1.5 text-caption text-foreground transition-colors hover:bg-accent"
        >
          <FileText class="size-3.5 shrink-0" />
          <span class="truncate">{{ pieceLabel(file) }}</span>
        </a>
        <a
          v-for="(voice, index) in voices"
          :key="`voice-${index}`"
          :href="voice.url"
          target="_blank"
          rel="noreferrer"
          class="flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-section-card px-2.5 py-1.5 text-caption text-foreground transition-colors hover:bg-accent"
        >
          <Volume2 class="size-3.5 shrink-0" />
          <span class="truncate">{{ pieceLabel(voice) }}</span>
        </a>
      </div>

      <!-- 一条消息按行分气泡：换行即分条，空行只作分隔 -->
      <div class="flex flex-col gap-1" :class="mine ? 'items-end' : 'items-start'">
        <div
          v-for="(line, index) in textLines"
          :key="index"
          class="whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-control leading-relaxed"
          :class="[
            mine ? 'bg-accent text-foreground' : 'bg-section-card text-foreground',
            isPending ? 'opacity-70' : '',
            isFailed ? 'ring-1 ring-destructive' : '',
          ]"
        >{{ line }}</div>
      </div>

      <!-- hover 时间 + 操作 -->
      <div class="flex h-5 items-center gap-1" :class="mine ? 'flex-row-reverse' : ''">
        <span class="text-caption tabular-nums text-muted-foreground opacity-0 transition-opacity group-hover/msg:opacity-100">
          {{ timeText }}
        </span>
        <div class="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100">
          <Button
            v-if="message.text.trim() !== ''"
            variant="ghost"
            size="icon-sm"
            aria-label="复制消息"
            @click="copyText"
          >
            <Copy class="size-3.5" />
          </Button>
          <ConfirmPopover
            v-if="canDelete"
            title="删除这条消息？"
            message="删除后对话历史里不再显示（服务端为软删，可恢复）。"
            confirm-text="删除"
            cancel-text="取消"
            variant="destructive"
            @confirm="emit('delete', message.id)"
          >
            <template #trigger>
              <Button variant="ghost" size="icon-sm" aria-label="删除消息">
                <Trash2 class="size-3.5" />
              </Button>
            </template>
          </ConfirmPopover>
        </div>
      </div>

      <!-- 思考过程（默认折叠，安静展示） -->
      <details v-if="reasoning !== ''" class="w-full text-caption text-muted-foreground">
        <summary class="cursor-pointer select-none rounded-sm px-1 py-0.5 hover:text-foreground">
          思考过程
        </summary>
        <p class="mt-1 whitespace-pre-wrap break-words rounded-lg bg-muted-soft p-2 leading-relaxed">
          {{ reasoning }}
        </p>
      </details>
    </div>
  </div>
</template>
