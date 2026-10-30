<script setup lang="ts">
/**
 * 调试 —— 系统提示词分层 + 审计日志（只读诊断）。
 * GET /api/debug/system-prompt?botId=  → { layers[], totalChars, compiled }
 * GET /api/debug/audit?botId=          → { entries[{time,category,summary,...}] }
 */
import { computed, onMounted, ref } from 'vue'
import {
  CalloutBanner,
  CodePanel,
  PageShell,
  SegmentedControl,
  SettingsRow,
  SettingsSection,
  Spinner,
} from '@felinic/ui'
import { systemApi } from '@/api/endpoints'
import { useBots } from '@/stores/bots'

interface PromptLayer {
  name: string
  source: string
  content: string
  chars: number
}
interface AuditRow {
  id: string
  time: string
  category: string
  summary: string
  detail: string
}

const bots = useBots()
const loading = ref(true)
const error = ref('')
const layers = ref<PromptLayer[]>([])
const compiled = ref('')
const totalChars = ref(0)
const entries = ref<AuditRow[]>([])
const view = ref<'prompt' | 'audit'>('prompt')

const promptSub = computed(() => `共 ${totalChars.value} 字符 · ${layers.value.length} 层`)

onMounted(async () => {
  await bots.bootstrap()
  await load()
})

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  const botId = bots.state.currentBotId ?? undefined
  try {
    const [prompt, audit] = await Promise.all([
      systemApi.systemPrompt(botId),
      systemApi.audit(botId),
    ])
    layers.value = (prompt.layers ?? []) as PromptLayer[]
    compiled.value = String(prompt.compiled ?? '')
    totalChars.value = Number(prompt.totalChars ?? 0)
    entries.value = audit.map((e) => ({
      id: String(e.id ?? ''),
      time: String(e.time ?? e.createdAt ?? ''),
      category: String(e.category ?? ''),
      summary: String(e.summary ?? e.action ?? ''),
      detail: typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail ?? {}),
    }))
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载调试数据失败'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <PageShell title="调试" description="她此刻的系统提示词与审计记录。">
    <div class="space-y-6">
      <CalloutBanner v-if="error" tone="destructive" :description="error" size="sm" />
      <div class="flex items-center justify-between gap-4">
        <SegmentedControl
          :model-value="view"
          :items="[
            { value: 'prompt', label: '系统提示词' },
            { value: 'audit', label: '审计日志' },
          ]"
          aria-label="调试视图"
          @update:model-value="(v: string | number) => (view = v as 'prompt' | 'audit')"
        />
        <span v-if="view === 'prompt'" class="text-caption text-muted-foreground">{{ promptSub }}</span>
        <span v-else class="text-caption text-muted-foreground">最近 {{ entries.length }} 条</span>
      </div>

      <div v-if="loading" class="flex items-center gap-2 py-8 text-label text-muted-foreground">
        <Spinner class="size-4" />
        正在载入…
      </div>

      <template v-else-if="view === 'prompt'">
        <SettingsSection v-if="layers.length > 0" title="提示词分层">
          <SettingsRow
            v-for="layer in layers"
            :key="layer.name"
            :label="layer.name"
            :description="`${layer.source} · ${layer.chars} 字符`"
            align="start"
          />
        </SettingsSection>
        <CodePanel v-if="compiled" :code="compiled" width="full" copy-label="复制提示词" copied-label="已复制" copy-failed-message="复制失败" />
        <p v-else class="text-label text-muted-foreground">还没有编译后的提示词。</p>
      </template>

      <template v-else>
        <SettingsSection title="审计日志">
          <div v-if="entries.length === 0" class="px-4 py-8 text-center text-label text-muted-foreground">
            还没有审计记录。
          </div>
          <SettingsRow
            v-for="entry in entries.slice(0, 100)"
            :key="entry.id || entry.time + entry.summary"
            :label="entry.summary"
            :description="`${entry.time} · ${entry.category}`"
            align="start"
          />
        </SettingsSection>
      </template>
    </div>
  </PageShell>
</template>
