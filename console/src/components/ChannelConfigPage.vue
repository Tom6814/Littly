<script setup lang="ts">
/**
 * 渠道配置页的共享骨架（telegram / qq / discord 共用）。
 * - 配置：GET /api/bots/:id/channels + PUT（admin；密钥打码回显、打码值不回写）
 * - 绑定：POST /api/bind/:channel/code、GET /api/bind/status、POST /api/bind/unbind
 * 页面只负责布局，渠道字段由各页以 props 传入（单一实现，避免三份同形异码）。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import {
  Button,
  CalloutBanner,
  ConfirmPopover,
  CopyButton,
  FieldStack,
  Input,
  PageShell,
  SettingsRow,
  SettingsSection,
  Spinner,
  Switch,
  toast,
} from '@felinic/ui'
import { channelsApi, botsApi } from '@/api/endpoints'
import { ApiError } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useBots } from '@/stores/bots'
import type { BindIdentity } from '@/api/endpoints'

const props = defineProps<{
  channel: string
  title: string
  description: string
  fields: Array<{
    key: string
    label: string
    description?: string
    placeholder?: string
    secret?: boolean
    help?: string
  }>
  /** 是否提供「账号绑定码」区块（bilibili 等扫码渠道不需要）。 */
  bindable?: boolean
  bindHint?: string
}>()

const auth = useAuthStore()
const bots = useBots()
const isAdmin = computed(() => auth.state.user?.role === 'admin')

const loading = ref(true)
const error = ref('')
const denied = ref(false)
const saving = ref(false)
const binding = ref(false)
const unbinding = ref('')

const enabled = ref(false)
const values = reactive<Record<string, string>>({})
const secretSet = reactive<Record<string, boolean>>({})

const identities = ref<BindIdentity[]>([])
const code = ref('')
const instruction = ref('')
const expiresAt = ref('')

onMounted(async () => {
  await bots.bootstrap()
  await loadAll()
})

async function loadAll(): Promise<void> {
  loading.value = true
  error.value = ''
  const botId = bots.state.currentBotId
  if (!botId) {
    error.value = '还没有可配置的 bot'
    loading.value = false
    return
  }
  try {
    const channels = await botsApi.channels(botId)
    const cfg = (channels[props.channel] ?? {}) as Record<string, unknown>
    enabled.value = cfg.enabled === true
    for (const f of props.fields) {
      const raw = cfg[f.key]
      secretSet[f.key] = f.secret === true && (cfg.hasToken === true || (typeof raw === 'string' && raw !== ''))
      values[f.key] = typeof raw === 'string' && !(f.secret && raw.includes('•')) ? raw : ''
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) denied.value = true
    else error.value = e instanceof Error ? e.message : '加载渠道配置失败'
  }
  try {
    const status = await channelsApi.bindStatus()
    identities.value = status.identities.filter((i) => i.channel === props.channel)
  } catch {
    /* 绑定状态读取失败不阻塞配置展示 */
  }
  loading.value = false
}

async function save(): Promise<void> {
  const botId = bots.state.currentBotId
  if (!botId) return
  saving.value = true
  try {
    const payload: Record<string, unknown> = { enabled: enabled.value }
    for (const f of props.fields) {
      const v = values[f.key] ?? ''
      // 只提交用户真的改过 / 非空的字段：打码串不落库，空密钥保持原值。
      if (f.secret === true) {
        if (v !== '' && !v.includes('•')) payload[f.key] = v
      } else {
        payload[f.key] = v
      }
    }
    await botsApi.saveChannels(botId, { [props.channel]: payload })
    toast.success('渠道配置已保存')
    await loadAll()
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '保存失败')
  } finally {
    saving.value = false
  }
}

async function createCode(): Promise<void> {
  binding.value = true
  error.value = ''
  try {
    const out = await channelsApi.bindCode(props.channel, bots.state.currentBotId ?? undefined)
    code.value = out.code
    instruction.value = String(out.instruction ?? '')
    expiresAt.value = String(out.expiresAt ?? '')
  } catch (e) {
    error.value = e instanceof Error ? e.message : '生成绑定码失败'
  } finally {
    binding.value = false
  }
}

async function unbind(identity: BindIdentity): Promise<void> {
  unbinding.value = identity.externalId
  try {
    await channelsApi.unbind(identity.channel, identity.externalId)
    toast.success('已解绑（历史与记忆保留）')
    await loadAll()
  } catch (e) {
    toast.error(e instanceof Error ? e.message : '解绑失败')
  } finally {
    unbinding.value = ''
  }
}
</script>

<template>
  <PageShell :title="title" :description="description">
    <div class="space-y-8">
      <CalloutBanner
        v-if="denied"
        tone="neutral"
        title="需要管理员账号"
        description="渠道配置只有管理员可读写；当前账号可以查看绑定状态。"
      />
      <CalloutBanner v-if="error" tone="destructive" :description="error" size="sm" />
      <div v-if="loading" class="flex items-center gap-2 py-8 text-label text-muted-foreground">
        <Spinner class="size-4" />
        正在载入渠道配置…
      </div>

      <template v-else>
        <SettingsSection title="连接配置">
          <SettingsRow label="启用该渠道" description="关闭后她不会在该渠道收发消息">
            <Switch v-model="enabled" :disabled="!isAdmin" />
          </SettingsRow>
          <SettingsRow
            v-for="field in fields"
            :key="field.key"
            :label="field.label"
            :description="field.description || ''"
            stack="sm"
          >
            <Input
              v-model="values[field.key]"
              :type="field.secret ? 'password' : 'text'"
              :placeholder="field.secret && secretSet[field.key] ? '已设置，留空表示不修改' : field.placeholder || ''"
              :disabled="!isAdmin"
            />
          </SettingsRow>
          <template #footer>
            <Button :loading="saving" :disabled="!isAdmin" @click="save">保存配置</Button>
          </template>
        </SettingsSection>

        <SettingsSection v-if="bindable !== false" title="账号绑定">
          <SettingsRow
            label="生成绑定码"
            :description="bindHint || '在渠道里私聊她，发送「绑定 <码>」完成绑定。'"
            stack="sm"
          >
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
            <p v-if="expiresAt" class="mt-0.5 text-caption text-muted-foreground">过期时间：{{ expiresAt }}</p>
          </div>

          <div v-if="identities.length === 0" class="px-4 py-6 text-center text-label text-muted-foreground">
            还没有绑定该渠道的账号。
          </div>
          <SettingsRow
            v-for="identity in identities"
            :key="identity.externalId"
            :label="identity.externalId"
            :description="`绑定于 ${identity.createdAt}`"
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
    </div>
  </PageShell>
</template>
