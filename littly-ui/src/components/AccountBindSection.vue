<script setup lang="ts">
/**
 * 「账号绑定」区块 —— 渠道页共用（微信 / Telegram / QQ / Discord）。
 *
 * 行为与旧 `/bind` 页和 ChannelConfigPage 内嵌区块一致：
 * - 生成一次性绑定码（10 分钟内有效；同渠道新码顶掉旧码）+ 复制
 * - 列出当前登录用户在该渠道已绑定的身份 + 解绑二次确认
 * 生成/解绑只需要登录态（后端 `/api/bind/*` 为 `required`，非 admin），
 * 因此本区块不按 admin 隐藏——渠道「配置」才需要 admin。
 */
import { computed, onMounted, ref } from 'vue'
import {
  Button,
  ConfirmPopover,
  CopyButton,
  SettingsRow,
  SettingsSection,
  Spinner,
  toast,
} from '@felinic/ui'
import { bindApi, type BindIdentity } from '@/api/bind'

const props = withDefaults(
  defineProps<{
    /** 绑定用的渠道 key，必须与后端 CHANNEL_KINDS 一致：wechat / qq / qqp / discord / tg。 */
    channel: string
    /** 区块标题，默认「账号绑定」。 */
    title?: string
    /** 生成码一行的说明；不传按渠道给默认文案。 */
    hint?: string
  }>(),
  { title: '账号绑定', hint: '' },
)

const CHANNEL_LABELS: Record<string, string> = {
  wechat: '微信',
  qq: 'QQ（官方 QQBot）',
  qqp: 'QQ（SnowLuma）',
  discord: 'Discord',
  tg: 'Telegram',
}

const label = computed(() => CHANNEL_LABELS[props.channel] ?? props.channel)
const effectiveHint = computed(
  () => props.hint || `在${label.value}里私聊她，发送「绑定 <码>」完成绑定。`,
)

const identities = ref<BindIdentity[]>([])
const loading = ref(true)
const binding = ref(false)
const unbinding = ref('')

const code = ref('')
const instruction = ref('')
const expiresAt = ref('')

onMounted(() => {
  void load()
})

async function load(): Promise<void> {
  loading.value = true
  try {
    const status = await bindApi.status()
    identities.value = status.identities.filter((identity) => identity.channel === props.channel)
  } catch {
    // 绑定状态读不到不阻塞渠道页主体；生成码/解绑会各自报错。
    identities.value = []
  } finally {
    loading.value = false
  }
}

async function createCode(): Promise<void> {
  binding.value = true
  try {
    const out = await bindApi.createCode(props.channel)
    code.value = out.code
    instruction.value = out.instruction
    expiresAt.value = out.expiresAt
    if (out.code === '') toast.error('服务端没有返回绑定码')
  } catch (e) {
    toast.error(e instanceof Error ? e.message : '生成绑定码失败')
  } finally {
    binding.value = false
  }
}

async function unbind(identity: BindIdentity): Promise<void> {
  unbinding.value = identity.externalId
  try {
    await bindApi.unbind(identity.channel, identity.externalId)
    toast.success('已解绑（历史与记忆保留）')
    await load()
  } catch (e) {
    toast.error(e instanceof Error ? e.message : '解绑失败')
  } finally {
    unbinding.value = ''
  }
}

function fmtTime(iso?: string): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}
</script>

<template>
  <SettingsSection :title="title">
    <template #actions>
      <span v-if="loading" class="flex items-center gap-1.5 text-caption text-muted-foreground">
        <Spinner class="size-3.5" />
        读取中…
      </span>
    </template>

    <SettingsRow label="生成绑定码" :description="effectiveHint" stack="sm">
      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" :loading="binding" @click="createCode">生成绑定码</Button>
        <CopyButton
          v-if="code"
          :text="code"
          label="复制绑定码"
          copied-label="已复制"
          failed-message="复制失败，请手动选择复制"
        />
      </div>
    </SettingsRow>

    <div v-if="code" class="mx-4 border-b border-border px-0 py-3">
      <div class="text-caption text-muted-foreground">绑定码（10 分钟内有效）</div>
      <div class="mt-1 font-mono text-control font-medium tracking-wide text-foreground">{{ code }}</div>
      <p v-if="instruction" class="mt-1 text-caption text-muted-foreground">{{ instruction }}</p>
      <p v-if="expiresAt" class="mt-0.5 text-caption text-muted-foreground">
        过期时间：{{ fmtTime(expiresAt) }}
      </p>
    </div>

    <div v-if="identities.length === 0" class="px-4 py-6 text-center text-label text-muted-foreground">
      还没有绑定该渠道的账号。
    </div>
    <SettingsRow
      v-for="identity in identities"
      :key="identity.externalId"
      :label="identity.externalId"
      :description="identity.createdAt ? `绑定于 ${fmtTime(identity.createdAt)}` : '已绑定'"
    >
      <ConfirmPopover
        title="解绑这个渠道账号？"
        message="历史与记忆会保留，但之后无法再通过该渠道聊天。"
        confirm-text="解绑"
        cancel-text="取消"
        variant="destructive"
        :loading="unbinding === identity.externalId"
        @confirm="unbind(identity)"
      >
        <template #trigger>
          <Button variant="outline" size="sm">解绑</Button>
        </template>
      </ConfirmPopover>
    </SettingsRow>
  </SettingsSection>
</template>
