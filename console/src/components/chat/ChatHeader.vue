<script setup lang="ts">
/** 对话顶部角色栏：头像/名字/连接状态 + 通话 / 更多菜单（重新生成、删除最近一条、刷新、接入微信）。 */
import { computed } from 'vue'
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  StatusDot,
} from '@felinic/ui'
import { MessageCircle, MoreHorizontal, Phone, RefreshCw, Trash2, WifiOff } from 'lucide-vue-next'
import { initialOf } from '@/pages/chat/format'
import type { StreamState } from '@/pages/chat/useChatSession'

const props = withDefaults(defineProps<{
  botName: string
  botAvatar: string
  statusText: string
  streamState: StreamState
  canCall: boolean
  sending: boolean
  hasMessages: boolean
}>(), {
  botAvatar: '',
})

const emit = defineEmits<{
  (e: 'call'): void
  (e: 'regenerate'): void
  (e: 'delete-last'): void
  (e: 'refresh'): void
  (e: 'bind-wechat'): void
}>()

const connectionLabel = computed(() => {
  if (props.streamState === 'offline') return '实时连接断开，正在重连…'
  if (props.streamState === 'connecting') return '连接中…'
  return '在线，随时可以说话'
})

const dotStatus = computed<'success' | 'warning' | 'idle'>(() => {
  if (props.streamState === 'open') return 'success'
  if (props.streamState === 'connecting') return 'warning'
  return 'idle'
})
</script>

<template>
  <header
    class="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-4 py-2 md:px-6"
  >
    <div class="flex min-w-0 items-center gap-3">
      <Avatar class="size-9 shrink-0">
        <AvatarImage v-if="botAvatar !== ''" :src="botAvatar" :alt="botName" />
        <AvatarFallback class="text-label">{{ initialOf(botName) }}</AvatarFallback>
      </Avatar>
      <div class="min-w-0">
        <div class="flex items-center gap-2">
          <h1 class="truncate text-control font-semibold text-foreground">{{ botName }}</h1>
          <WifiOff v-if="streamState === 'offline'" class="size-3.5 shrink-0 text-muted-foreground" />
          <StatusDot v-else :status="dotStatus" />
        </div>
        <p class="truncate text-caption text-muted-foreground">
          {{ statusText || connectionLabel }}
        </p>
      </div>
    </div>

    <div class="flex shrink-0 items-center gap-1.5">
      <Button
        variant="ghost"
        size="sm"
        data-testid="chat-call"
        aria-label="语音通话"
        :disabled="!canCall"
        @click="emit('call')"
      >
        <Phone class="size-4" />
        <span class="hidden sm:inline">通话</span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="icon-sm" aria-label="更多操作">
            <MoreHorizontal class="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem :disabled="sending || !hasMessages" @select="emit('regenerate')">
            <RefreshCw class="size-3.5" />
            重新生成
          </DropdownMenuItem>
          <DropdownMenuItem :disabled="sending || !hasMessages" @select="emit('delete-last')">
            <Trash2 class="size-3.5" />
            删除最近一条
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem @select="emit('refresh')">刷新对话</DropdownMenuItem>
          <DropdownMenuItem @select="emit('bind-wechat')">
            <MessageCircle class="size-3.5" />
            接入微信
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </header>
</template>
