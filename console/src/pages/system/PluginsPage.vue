<script setup lang="ts">
/**
 * 插件 —— 已安装插件 / MCP / 工具 / 技能 的清单与启停。
 * GET /api/plugins；启停 POST /api/plugins/enable（admin；bundle 需重启 harness）。
 */
import { computed, onMounted, ref } from 'vue'
import {
  CalloutBanner,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  PageShell,
  SettingsRow,
  SettingsSection,
  Spinner,
  StatusDot,
  Switch,
  toast,
} from '@felinic/ui'
import { systemApi } from '@/api/endpoints'
import { ApiError } from '@/api/client'
import { useAuthStore } from '@/stores/auth'

interface PluginRow {
  id?: string
  name: string
  title: string
  description: string
  enabled: boolean
}
interface McpRow {
  name: string
  transport: string
  status: string
  tools: number
  enabled: boolean
  error?: string
}
interface ToolRow {
  name: string
  description?: string
}

const auth = useAuthStore()
const loading = ref(true)
const error = ref('')
const installed = ref<PluginRow[]>([])
const bundles = ref<Array<Record<string, unknown>>>([])
const mcp = ref<McpRow[]>([])
const tools = ref<ToolRow[]>([])
const skills = ref<Array<{ name: string; description?: string; source?: string }>>([])
const busy = ref('')

const isAdmin = computed(() => auth.state.user?.role === 'admin')

onMounted(async () => {
  await load()
})

function toBool(v: unknown): boolean {
  return v === true
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const data = await systemApi.plugins()
    installed.value = (data.installed ?? []).map((p) => ({
      id: typeof p.id === 'string' ? p.id : undefined,
      name: String(p.name ?? ''),
      title: String(p.title ?? p.name ?? ''),
      description: String(p.description ?? ''),
      enabled: toBool(p.enabled),
    }))
    bundles.value = data.bundles ?? []
    mcp.value = (data.mcp ?? []).map((m) => ({
      name: String(m.name ?? ''),
      transport: String(m.transport ?? ''),
      status: String(m.status ?? ''),
      tools: Number(m.tools ?? 0),
      enabled: toBool(m.enabled),
      error: typeof m.error === 'string' ? m.error : undefined,
    }))
    tools.value = (data.tools ?? []).map((t) => ({
      name: String(t.name ?? ''),
      description: typeof t.description === 'string' ? t.description : undefined,
    }))
    skills.value = (data.skills ?? []).map((sk) => ({
      name: String(sk.name ?? ''),
      description: typeof sk.description === 'string' ? sk.description : undefined,
      source: typeof sk.source === 'string' ? sk.source : undefined,
    }))
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载插件列表失败'
  } finally {
    loading.value = false
  }
}

async function togglePlugin(plugin: PluginRow, enabled: boolean): Promise<void> {
  if (!plugin.id) {
    toast.error('该条目没有可操作的插件 id')
    return
  }
  busy.value = plugin.id
  try {
    await systemApi.setPluginEnabled({ id: plugin.id, enabled })
    plugin.enabled = enabled
    toast.success(enabled ? '已启用（部分插件需重启 harness 生效）' : '已停用（部分插件需重启 harness 生效）')
    await load()
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '操作失败')
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <PageShell title="插件" description="已安装的能力、MCP 服务与工具清单。">
    <div class="space-y-8">
      <CalloutBanner v-if="error" tone="destructive" :description="error" size="sm" />
      <div v-if="loading" class="flex items-center gap-2 py-8 text-label text-muted-foreground">
        <Spinner class="size-4" />
        正在载入插件…
      </div>

      <template v-else>
        <SettingsSection title="已安装插件">
          <div v-if="installed.length === 0">
            <Empty>
              <EmptyHeader>
                <EmptyTitle>没有已安装的插件</EmptyTitle>
                <EmptyDescription>插件在 profile 装配时加载，安装后需要重启 harness。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
          <SettingsRow
            v-for="plugin in installed"
            :key="plugin.id ?? plugin.name"
            :label="plugin.title || plugin.name"
            :description="plugin.description || plugin.name"
            align="start"
          >
            <Switch
              :model-value="plugin.enabled"
              :disabled="!isAdmin || busy === plugin.id"
              :aria-label="`启用 ${plugin.title || plugin.name}`"
              @update:model-value="(v: boolean) => togglePlugin(plugin, v)"
            />
          </SettingsRow>
        </SettingsSection>

        <SettingsSection v-if="mcp.length > 0" title="MCP 服务">
          <SettingsRow
            v-for="server in mcp"
            :key="server.name"
            :label="server.name"
            :description="`${server.transport} · ${server.tools} 个工具`"
          >
            <div class="flex items-center gap-2 text-control text-foreground">
              <StatusDot :status="server.status === 'connected' ? 'success' : server.error ? 'error' : 'idle'" />
              {{ server.enabled ? server.status : '已停用' }}
            </div>
          </SettingsRow>
        </SettingsSection>

        <SettingsSection v-if="skills.length > 0" title="技能">
          <SettingsRow v-for="skill in skills" :key="skill.name" :label="skill.name" :description="skill.description || skill.source || ''" />
        </SettingsSection>

        <SettingsSection v-if="tools.length > 0" title="工具">
          <SettingsRow v-for="tool in tools" :key="tool.name" :label="tool.name" :description="tool.description || ''" />
        </SettingsSection>
      </template>
    </div>
  </PageShell>
</template>
