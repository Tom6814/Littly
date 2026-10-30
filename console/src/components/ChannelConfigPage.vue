<script setup lang="ts">
/**
 * 渠道配置页的共享骨架（telegram / discord 共用）。
 * - 配置：GET /api/bots/:id/channels + PUT（admin；密钥打码回显、打码值不回写）
 * - 绑定：账号绑定区块已抽到 components/AccountBindSection.vue（各渠道页共用）；
 *   配置用的 `channel` 与绑定用的渠道 key 不一定同名（telegram → tg），用 bindChannel 覆盖。
 * 页面只负责布局，渠道字段由各页以 props 传入（单一实现，避免多份同形异码）。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import {
  Button,
  CalloutBanner,
  Input,
  PageShell,
  SettingsRow,
  SettingsSection,
  Spinner,
  Switch,
  toast,
} from '@felinic/ui'
import { botsApi } from '@/api/endpoints'
import { ApiError } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useBots } from '@/stores/bots'
import AccountBindSection from '@/components/AccountBindSection.vue'

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
  /** 绑定渠道 key（默认与 channel 相同；telegram 的绑定 key 是 tg）。 */
  bindChannel?: string
}>()

const auth = useAuthStore()
const bots = useBots()
const isAdmin = computed(() => auth.state.user?.role === 'admin')

const loading = ref(true)
const error = ref('')
const denied = ref(false)
const saving = ref(false)

const enabled = ref(false)
const values = reactive<Record<string, string>>({})
const secretSet = reactive<Record<string, boolean>>({})

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

/** 配置 channel → 绑定 channel；目前只有 Telegram 两者不同（配置组 telegram / 身份 tg）。 */
const bindChannelKey = computed(() => props.bindChannel ?? (props.channel === 'telegram' ? 'tg' : props.channel))
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

        <AccountBindSection
          v-if="bindable !== false"
          :channel="bindChannelKey"
          :hint="bindHint"
        />
      </template>
    </div>
  </PageShell>
</template>
