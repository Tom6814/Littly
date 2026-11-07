<script setup lang="ts">
/**
 * 铁律页 —— 唯一的硬约束层，每轮完整注入、永不裁剪。
 *
 * 行为基线：旧 React RulesPage（读、编辑、启用开关、脏状态保存/撤销、字数）。
 * 页面类型是 root page → 按 SKILL §8，Save 放 PageShell #actions（不是卡片 footer）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import {
  Button,
  CalloutBanner,
  InlineLoadingRow,
  PageShell,
  SettingsRow,
  SettingsSection,
  Switch,
  Textarea,
  toast,
} from '@felinic/ui'
import { Gavel } from 'lucide-vue-next'
import { errText } from './shared/format'
import { useBots } from '@/stores/bots'
import { rulesApi } from './api'

const bots = useBots()
const botId = computed(() => bots.currentBotId.value ?? '')

const content = ref('')
const enabled = ref(true)
const savedContent = ref('')
const savedEnabled = ref(true)
const loading = ref(false)
const loadError = ref('')
const saving = ref(false)

const dirty = computed(() => content.value !== savedContent.value || enabled.value !== savedEnabled.value)
const charCount = computed(() => content.value.length)

async function load(): Promise<void> {
  if (!botId.value) {
    return
  }
  loading.value = true
  loadError.value = ''
  try {
    const rules = await rulesApi.get(botId.value)
    content.value = rules.content
    enabled.value = rules.enabled
    savedContent.value = rules.content
    savedEnabled.value = rules.enabled
  } catch (e) {
    loadError.value = errText(e)
  } finally {
    loading.value = false
  }
}

function revert(): void {
  content.value = savedContent.value
  enabled.value = savedEnabled.value
}

async function save(): Promise<void> {
  if (!botId.value || !dirty.value) return
  saving.value = true
  try {
    await rulesApi.put(botId.value, { content: content.value, enabled: enabled.value })
    savedContent.value = content.value
    savedEnabled.value = enabled.value
    toast.success('铁律已保存')
  } catch (e) {
    toast.error(errText(e))
  } finally {
    saving.value = false
  }
}

watch(botId, () => void load())
onMounted(() => {
  void bots.bootstrap()
  void load()
})
</script>

<template>
  <PageShell
    title="铁律"
    description="唯一的硬约束层：安全阀也写在这里。系统提示词每轮完整注入，铁律永不裁剪。"
  >
    <template #actions>
      <Button
        variant="outline"
        :disabled="!dirty || saving"
        @click="revert"
      >
        撤销
      </Button>
      <Button
        :loading="saving"
        :disabled="!dirty || !botId"
        @click="save"
      >
        <Gavel />
        保存修改
      </Button>
    </template>

    <div class="space-y-6">
    <CalloutBanner
      v-if="loadError"
      tone="destructive"
      title="铁律加载失败"
      :description="loadError"
    >
      <Button
        variant="outline"
        size="sm"
        @click="load"
      >
        重试
      </Button>
    </CalloutBanner>

    <InlineLoadingRow
      v-else-if="loading"
      surface="tab"
      size="md"
    >
      正在读取铁律…
    </InlineLoadingRow>

    <template v-else-if="botId">
      <CalloutBanner
        title="用「她是谁」的句式书写"
        description="铁律不是行为指令，而是身份与底线：她可以拒绝、有自己的生活节奏；当对方流露求死或自伤念头时，她必须开口——这是唯一例外。"
      />

      <SettingsSection title="铁律">
        <SettingsRow
          label="启用"
          description="停用后这一层不再注入。除排查问题外不建议关闭。"
        >
          <Switch
            v-model="enabled"
            aria-label="启用铁律"
          />
        </SettingsRow>

        <SettingsRow
          label="铁律内容"
          description="每轮完整注入，永不裁剪；改动在保存后立即生效。"
          stack="always"
          :divider="false"
        >
          <div class="w-full space-y-2">
            <Textarea
              v-model="content"
              :rows="14"
              placeholder="她有自己的生活节奏。&#10;她可以拒绝。&#10;当对方流露求死或自伤念头时，她必须开口——这是唯一例外。"
            />
            <div class="flex items-center justify-between">
              <span class="text-caption text-muted-foreground">
                {{ enabled ? '已启用' : '已停用（不推荐）' }}
              </span>
              <span class="text-caption text-muted-foreground">{{ charCount }} 字</span>
            </div>
          </div>
        </SettingsRow>
      </SettingsSection>
    </template>
    </div>
  </PageShell>
</template>
