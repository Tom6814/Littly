<script setup lang="ts">
/**
 * 设置 —— 模型 / 语音 / 通用 三个 Section（根页面形态：分组卡片 + 节内 Save）。
 * - 模型：GET/PUT /api/settings/ai（admin；密钥打码回显，打码值不回写）
 * - 语音：bot settings voice 组（admin）；GET /api/bots/:id + PATCH /api/bots/:id
 * - 通用：平台注册开关（admin）+ 本地主题/重跑引导（客户端）
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  Button,
  CalloutBanner,
  FieldStack,
  Input,
  PageShell,
  SegmentedControl,
  SettingsRow,
  SettingsSection,
  Spinner,
  Switch,
  toast,
} from '@felinic/ui'
import { botsApi, settingsApi } from '@/api/endpoints'
import { ApiError } from '@/api/client'
import { useBots } from '@/stores/bots'
import { useOnboardingStore } from '@/stores/onboarding'
import { useUiStore, type ThemeMode } from '@/stores/ui'

const router = useRouter()
const bots = useBots()
const onboarding = useOnboardingStore()
const ui = useUiStore()

const loading = ref(true)
const savingModel = ref(false)
const savingVoice = ref(false)
const savingPlatform = ref(false)
const error = ref('')
const denied = ref(false)

const modelKeyMask = ref('')
const editingModelKey = ref(false)
const voiceKeyMask = ref('')
const editingVoiceKey = ref(false)
const model = reactive({
  baseURL: '',
  apiKey: '',
  apiKeySet: false,
  chatModel: '',
  growthModel: '',
  webSearch: '',
})
const voice = reactive({
  enabled: false,
  model: '',
  referenceId: '',
  temperature: 1,
  speed: 1,
  apiKey: '',
  apiKeySet: false,
})
const platform = reactive({ registrationEnabled: true, seeded: false })
const theme = computed<ThemeMode>(() => ui.state.theme)

onMounted(async () => {
  await bots.bootstrap()
  await loadAll()
})

async function loadAll(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const ai = await settingsApi.getAi()
    model.baseURL = String(ai.baseURL ?? '')
    modelKeyMask.value = String(ai.apiKey ?? '')
    model.apiKey = ''
    model.apiKeySet = Boolean(ai.apiKeySet)
    model.chatModel = String(ai.chatModel ?? '')
    model.growthModel = String(ai.growthModel ?? '')
    model.webSearch = String(ai.webSearch ?? '')
    const plat = await settingsApi.getPlatform()
    platform.registrationEnabled = plat.registrationEnabled !== false
    platform.seeded = plat.seeded === true
  } catch (e) {
    // admin-only：普通账号读到 403 → 只读提示，不伪装成空设置
    if (e instanceof ApiError && e.status === 403) denied.value = true
    else error.value = e instanceof Error ? e.message : '加载设置失败'
  }

  const botId = bots.state.currentBotId
  if (botId) {
    try {
      const bot = await botsApi.get(botId)
      const settings = (bot?.settings ?? {}) as Record<string, unknown>
      const v = (settings.voice ?? {}) as Record<string, unknown>
      voice.enabled = Boolean(v.enabled)
      voice.model = String(v.model ?? '')
      voice.referenceId = String(v.referenceId ?? '')
      voice.temperature = Number(v.temperature ?? 1)
      voice.speed = Number(v.speed ?? 1)
      voiceKeyMask.value = String(v.apiKey ?? '')
      voice.apiKey = ''
      voice.apiKeySet = Boolean(v.apiKeySet)
    } catch {
      /* 静默：语音设置读取失败不阻塞页面 */
    }
  }
  loading.value = false
}

/**
 * 打码串不再放进可编辑输入框：只展示「已设置（尾号 abcd）」，点「更换」才出现空输入框。
 * 这样无论用户怎么粘贴/聚焦，都不可能出现「打码占位符 + 新密钥」的混合脏值，
 * 也不会出现「保存后输入框又变回原来那串」的观感问题。
 */
function maskTail(mask: string): string {
  const tail = mask.replace(/[^A-Za-z0-9_-]+/g, '').slice(-4)
  return tail
}
function startEditModelKey(): void {
  editingModelKey.value = true
  model.apiKey = ''
}
function cancelEditModelKey(): void {
  editingModelKey.value = false
  model.apiKey = ''
}
function startEditVoiceKey(): void {
  editingVoiceKey.value = true
  voice.apiKey = ''
}
function cancelEditVoiceKey(): void {
  editingVoiceKey.value = false
  voice.apiKey = ''
}

async function saveModel(): Promise<void> {
  // 编辑态：必须输入完整新密钥；非编辑态：回传打码串 → 后端保持原值。
  const nextKey = editingModelKey.value ? model.apiKey.trim() : modelKeyMask.value
  if (editingModelKey.value && nextKey === '') {
    toast.error('请输入完整的新 API Key，或点「取消」保持原密钥')
    return
  }
  savingModel.value = true
  try {
    await settingsApi.saveAi({
      baseURL: model.baseURL,
      apiKey: nextKey,
      chatModel: model.chatModel,
      growthModel: model.growthModel,
      webSearch: model.webSearch,
    })
    editingModelKey.value = false
    model.apiKey = ''
    await loadAll()
    const tail = maskTail(modelKeyMask.value)
    toast.success(`模型设置已保存${tail !== '' ? `（密钥尾号 ${tail}）` : ''}`)
  } catch (e) {
    toast.error(e instanceof Error ? e.message : '保存失败')
  } finally {
    savingModel.value = false
  }
}

async function saveVoice(): Promise<void> {
  const botId = bots.state.currentBotId
  if (!botId) {
    toast.error('还没有可保存的 bot')
    return
  }
  const nextVoiceKey = editingVoiceKey.value ? voice.apiKey.trim() : voiceKeyMask.value
  if (editingVoiceKey.value && nextVoiceKey === '') {
    toast.error('请输入完整的新语音 API Key，或点「取消」保持原密钥')
    return
  }
  savingVoice.value = true
  try {
    await botsApi.patch(botId, {
      voice: {
        enabled: voice.enabled,
        model: voice.model,
        referenceId: voice.referenceId,
        temperature: voice.temperature,
        speed: voice.speed,
        apiKey: nextVoiceKey,
      },
    })
    editingVoiceKey.value = false
    voice.apiKey = ''
    await loadAll()
    const tail = maskTail(voiceKeyMask.value)
    toast.success(`语音设置已保存${tail !== '' ? `（密钥尾号 ${tail}）` : ''}`)
  } catch (e) {
    toast.error(e instanceof Error ? e.message : '保存失败')
  } finally {
    savingVoice.value = false
  }
}

async function savePlatform(): Promise<void> {
  savingPlatform.value = true
  try {
    await settingsApi.savePlatform({ registrationEnabled: platform.registrationEnabled })
    toast.success('通用设置已保存')
  } catch (e) {
    toast.error(e instanceof Error ? e.message : '保存失败')
  } finally {
    savingPlatform.value = false
  }
}

function changeTheme(value: unknown): void {
  if ((value === 'light' || value === 'dark') && value !== ui.state.theme) ui.toggleTheme()
}

async function rerunOnboarding(): Promise<void> {
  onboarding.reset()
  await router.replace('/onboarding')
}
</script>

<template>
  <PageShell title="设置" description="模型、语音与通用偏好。" data-testid="settings-page">
    <div class="space-y-8">
      <CalloutBanner
        v-if="denied"
        tone="neutral"
        title="需要管理员账号"
        description="模型与语音设置只有管理员可读写；当前账号可以查看导航，下方保存会被拒绝。"
      />
      <CalloutBanner v-if="error" tone="destructive" :description="error" size="sm" />
      <div v-if="loading" class="flex items-center gap-2 py-8 text-label text-muted-foreground">
        <Spinner class="size-4" />
        正在载入设置…
      </div>

      <template v-else>
        <!-- 模型 -->
        <SettingsSection title="模型">
          <SettingsRow label="Base URL" description="OpenAI 兼容接口地址" stack="sm">
            <Input v-model="model.baseURL" placeholder="https://…/v1" />
          </SettingsRow>
          <SettingsRow
            label="API Key"
            :description="model.apiKeySet ? '密钥只显示尾号；点「更换」输入完整新密钥，保存成功后尾号会更新' : '尚未设置，点「更换」粘贴完整密钥'"
            stack="sm"
          >
            <div class="flex w-full items-center gap-2">
              <template v-if="!editingModelKey">
                <span class="flex-1 text-label text-muted-foreground">
                  {{ model.apiKeySet ? `已设置${maskTail(modelKeyMask) !== '' ? `（尾号 ${maskTail(modelKeyMask)}）` : ''}` : '未设置' }}
                </span>
                <Button variant="outline" size="sm" @click="startEditModelKey">更换</Button>
              </template>
              <template v-else>
                <Input v-model="model.apiKey" type="password" placeholder="粘贴完整新密钥" class="flex-1" />
                <Button variant="ghost" size="sm" @click="cancelEditModelKey">取消</Button>
              </template>
            </div>
          </SettingsRow>
          <SettingsRow label="聊天模型" description="她平时对话使用的模型" stack="sm">
            <Input v-model="model.chatModel" placeholder="provider/model" />
          </SettingsRow>
          <SettingsRow label="成长模型" description="成长/记忆整理使用的模型" stack="sm">
            <Input v-model="model.growthModel" placeholder="provider/model" />
          </SettingsRow>
          <SettingsRow label="联网搜索" description="web search 提供方（如 exa / tavily）" stack="sm">
            <Input v-model="model.webSearch" placeholder="例如 exa" />
          </SettingsRow>
          <template #footer>
            <Button :loading="savingModel" @click="saveModel">保存模型设置</Button>
          </template>
        </SettingsSection>

        <!-- 语音 -->
        <SettingsSection title="语音">
          <SettingsRow label="语音回复" description="她可以用语音回你消息">
            <Switch v-model="voice.enabled" />
          </SettingsRow>
          <SettingsRow label="语音模型" description="TTS 模型标识" stack="sm">
            <Input v-model="voice.model" placeholder="例如 fish-speech" />
          </SettingsRow>
          <SettingsRow label="参考音色" description="音色 ID / 参考音频标识" stack="sm">
            <Input v-model="voice.referenceId" placeholder="reference id" />
          </SettingsRow>
          <SettingsRow label="温度" description="语音情绪强度（0–1）" stack="sm">
            <Input v-model.number="voice.temperature" type="number" step="0.1" min="0" max="1" />
          </SettingsRow>
          <SettingsRow label="语速" description="0.5–2.0" stack="sm">
            <Input v-model.number="voice.speed" type="number" step="0.1" min="0.5" max="2" />
          </SettingsRow>
          <SettingsRow
            label="语音 API Key"
            :description="voice.apiKeySet ? '密钥只显示尾号；点「更换」输入完整新密钥' : '尚未设置，点「更换」粘贴完整密钥'"
            stack="sm"
          >
            <div class="flex w-full items-center gap-2">
              <template v-if="!editingVoiceKey">
                <span class="flex-1 text-label text-muted-foreground">
                  {{ voice.apiKeySet ? `已设置${maskTail(voiceKeyMask) !== '' ? `（尾号 ${maskTail(voiceKeyMask)}）` : ''}` : '未设置' }}
                </span>
                <Button variant="outline" size="sm" @click="startEditVoiceKey">更换</Button>
              </template>
              <template v-else>
                <Input v-model="voice.apiKey" type="password" placeholder="粘贴完整新密钥" class="flex-1" />
                <Button variant="ghost" size="sm" @click="cancelEditVoiceKey">取消</Button>
              </template>
            </div>
          </SettingsRow>
          <template #footer>
            <Button :loading="savingVoice" @click="saveVoice">保存语音设置</Button>
          </template>
        </SettingsSection>

        <!-- 通用 -->
        <SettingsSection title="通用">
          <SettingsRow label="开放注册" description="关闭后新用户无法自行注册">
            <Switch v-model="platform.registrationEnabled" />
          </SettingsRow>
          <SettingsRow label="外观" description="浅色 / 深色（仅本机生效）">
            <SegmentedControl
              :model-value="theme"
              :items="[
                { value: 'light', label: '浅色' },
                { value: 'dark', label: '深色' },
              ]"
              @update:model-value="changeTheme"
            />
          </SettingsRow>
          <SettingsRow label="重跑新手引导" description="重新走一遍 5 步引导（不会删除数据）">
            <Button variant="outline" size="sm" @click="rerunOnboarding">重新开始引导</Button>
          </SettingsRow>
          <template #footer>
            <Button :loading="savingPlatform" @click="savePlatform">保存通用设置</Button>
          </template>
        </SettingsSection>
      </template>
    </div>
  </PageShell>
</template>
