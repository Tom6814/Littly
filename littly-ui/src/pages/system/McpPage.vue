<script setup lang="ts">
/**
 * MCP 管理 —— Cursor 格式（`{"mcpServers": {...}}`）的 MCP 服务器管理页。
 * 后端契约（/tmp/mcp-spec.md §1.2，routes-mcp.ts）：
 *   GET    /api/mcp/servers            required → 列表（env/headers 仅键名）
 *   POST   /api/mcp/servers            admin → upsert
 *   PATCH  /api/mcp/servers/:name      admin → 局部更新（改名=删除+新增）
 *   DELETE /api/mcp/servers/:name      admin
 *   POST   /api/mcp/import             admin → Cursor 配置批量导入（部分成功）
 *   GET    /api/mcp/export             admin → Cursor 配置导出（含真实值）
 *   POST   /api/mcp/servers/:name/test admin → 连接 + listTools
 *   GET    /api/mcp/tools              required → 已启用服务器的工具聚合
 * 接口未就绪（404/501）时静默降级；写操作全部 admin 门禁。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import {
  Badge,
  Button,
  CalloutBanner,
  CodePanel,
  ConfirmPopover,
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
  Input,
  PageShell,
  SegmentedControl,
  SettingsRow,
  SettingsSection,
  Spinner,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  toast,
} from '@felinic/ui'
import { Download, FlaskConical, Pencil, Plus, RefreshCw, Trash2, Upload } from 'lucide-vue-next'
import { mcpApi, type McpImportResult, type McpServer, type McpTestResult } from '@/api/endpoints'
import { ApiError } from '@/api/client'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const isAdmin = computed(() => auth.state.user?.role === 'admin')

const loading = ref(true)
const unavailable = ref(false)
const error = ref('')
const servers = ref<McpServer[]>([])
const toggling = ref('')

/* 添加 / 编辑对话框（双 Tab：粘贴 Cursor 配置 / 手动填写） */
const form = reactive({
  open: false,
  mode: 'add' as 'add' | 'edit',
  tab: 'paste' as 'paste' | 'manual',
  name: '',
  transport: 'stdio' as 'stdio' | 'streamable-http',
  command: '',
  argsText: '',
  url: '',
  envText: '',
  headersText: '',
  saving: false,
  importing: false,
  error: '',
  pasteText: '',
  importResult: null as McpImportResult | null,
})

/* 导出对话框 */
const exportDialog = reactive({ open: false, loading: false, json: '', error: '' })

/* 测试连接对话框 */
const testDialog = reactive({
  open: false,
  name: '',
  loading: false,
  result: null as McpTestResult | null,
})

onMounted(async () => {
  await loadServers()
  loading.value = false
})

async function loadServers(): Promise<void> {
  error.value = ''
  try {
    const out = await mcpApi.servers()
    servers.value = out.servers
    unavailable.value = !out.available
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 501)) {
      unavailable.value = true
      servers.value = []
    } else {
      error.value = e instanceof Error ? e.message : '读取 MCP 服务器失败'
    }
  }
}

/* ---------------- 展示助手 ---------------- */
function transportLabel(server: McpServer): string {
  return server.transport === 'stdio' ? 'stdio' : 'http'
}

function describeServer(server: McpServer): string {
  if (server.transport === 'stdio') {
    return [server.command, ...server.args].filter(Boolean).join(' ') || '（未配置 command）'
  }
  return server.url || '（未配置 url）'
}

function parseKvLines(text: string, label: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const idx = line.indexOf('=')
    if (idx <= 0) throw new Error(`${label} 第 "${line}" 行不是 KEY=VALUE 格式`)
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (key === '') throw new Error(`${label} 存在空键名`)
    out[key] = value
  }
  return out
}

function parseLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/* ---------------- 打开表单 ---------------- */
function openAdd(tab: 'paste' | 'manual' = 'paste'): void {
  form.mode = 'add'
  form.tab = tab
  form.name = ''
  form.transport = 'stdio'
  form.command = ''
  form.argsText = ''
  form.url = ''
  form.envText = ''
  form.headersText = ''
  form.error = ''
  form.pasteText = ''
  form.importResult = null
  form.open = true
}

function openEdit(server: McpServer): void {
  form.mode = 'edit'
  form.tab = 'manual'
  form.name = server.name
  form.transport = server.transport === 'stdio' ? 'stdio' : 'streamable-http'
  form.command = server.command
  form.argsText = server.args.join('\n')
  form.url = server.url
  form.envText = ''
  form.headersText = ''
  form.error = ''
  form.pasteText = ''
  form.importResult = null
  form.open = true
}

function closeForm(): void {
  form.open = false
}

/* ---------------- 保存（upsert / patch） ---------------- */
async function saveManual(): Promise<void> {
  form.error = ''
  const name = form.name.trim()
  if (form.mode === 'add' && !/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
    form.error = '名称只允许 1-32 位字母/数字/下划线/连字符'
    return
  }
  const stdio = form.transport === 'stdio'
  const command = form.command.trim()
  const url = form.url.trim()
  if (stdio && command === '') {
    form.error = 'stdio 传输必须填写 command'
    return
  }
  if (!stdio && !/^https?:\/\//.test(url)) {
    form.error = 'http 传输必须填写 http(s):// 开头的 url'
    return
  }
  let env: Record<string, string> | undefined
  let headers: Record<string, string> | undefined
  try {
    if (stdio && form.envText.trim() !== '') env = parseKvLines(form.envText, 'env')
    if (!stdio && form.headersText.trim() !== '') headers = parseKvLines(form.headersText, 'headers')
  } catch (e) {
    form.error = e instanceof Error ? e.message : 'KEY=VALUE 格式错误'
    return
  }
  form.saving = true
  try {
    if (form.mode === 'add') {
      await mcpApi.upsert({
        name,
        transport: form.transport,
        ...(stdio
          ? { command, args: parseLines(form.argsText), ...(env !== undefined ? { env } : {}) }
          : { url, ...(headers !== undefined ? { headers } : {}) }),
        enabled: true,
      })
      toast.success(`已添加 MCP 服务器 ${name}`)
    } else {
      await mcpApi.patch(name, {
        ...(stdio
          ? { command, args: parseLines(form.argsText), ...(env !== undefined ? { env } : {}) }
          : { url, ...(headers !== undefined ? { headers } : {}) }),
      })
      toast.success(`已更新 MCP 服务器 ${name}`)
    }
    form.open = false
    await loadServers()
  } catch (e) {
    form.error =
      e instanceof ApiError && e.status === 403
        ? '需要管理员权限'
        : e instanceof Error
          ? e.message
          : '保存失败'
  } finally {
    form.saving = false
  }
}

/* ---------------- 导入 Cursor 配置 ---------------- */
async function importCursor(): Promise<void> {
  form.error = ''
  form.importResult = null
  let parsed: unknown
  try {
    parsed = JSON.parse(form.pasteText)
  } catch {
    form.error = '不是合法 JSON；请粘贴 Cursor 的 mcpServers 配置'
    return
  }
  form.importing = true
  try {
    form.importResult = await mcpApi.importConfig(parsed)
    const { added, updated, errors } = form.importResult
    if (added.length === 0 && updated.length === 0 && errors.length === 0) {
      toast.error('配置里没有可导入的 mcpServers')
    } else {
      toast.success(`已导入：新增 ${added.length}、更新 ${updated.length}${errors.length ? `、失败 ${errors.length}` : ''}`)
    }
    await loadServers()
  } catch (e) {
    form.error =
      e instanceof ApiError && e.status === 403
        ? '需要管理员权限'
        : e instanceof Error
          ? e.message
          : '导入失败'
  } finally {
    form.importing = false
  }
}

/* ---------------- 导出 ---------------- */
async function openExport(): Promise<void> {
  exportDialog.open = true
  exportDialog.loading = true
  exportDialog.json = ''
  exportDialog.error = ''
  try {
    const out = await mcpApi.exportConfig()
    exportDialog.json = JSON.stringify(out, null, 2)
  } catch (e) {
    exportDialog.error = e instanceof Error ? e.message : '导出失败'
  } finally {
    exportDialog.loading = false
  }
}

/* ---------------- 测试连接 ---------------- */
async function runTest(server: McpServer): Promise<void> {
  testDialog.open = true
  testDialog.name = server.name
  testDialog.loading = true
  testDialog.result = null
  try {
    testDialog.result = await mcpApi.test(server.name)
    if (!testDialog.result.ok) toast.error(testDialog.result.error || '连接失败')
  } catch (e) {
    testDialog.result = {
      ok: false,
      tools: [],
      toolCount: 0,
      error: e instanceof Error ? e.message : '测试失败',
    }
  } finally {
    testDialog.loading = false
  }
}

/* ---------------- 启停 / 删除 ---------------- */
async function toggleEnabled(server: McpServer, value: boolean | 'indeterminate'): Promise<void> {
  const enabled = value === true
  toggling.value = server.name
  try {
    await mcpApi.patch(server.name, { enabled })
    toast.success(`${server.name} 已${enabled ? '启用' : '停用'}`)
  } catch (e) {
    toast.error(
      e instanceof ApiError && e.status === 403
        ? '需要管理员权限'
        : e instanceof Error
          ? e.message
          : '切换失败',
    )
  } finally {
    toggling.value = ''
    await loadServers()
  }
}

async function removeServer(server: McpServer): Promise<void> {
  try {
    await mcpApi.remove(server.name)
    toast.success(`已删除 ${server.name}`)
    await loadServers()
  } catch (e) {
    toast.error(
      e instanceof ApiError && e.status === 403
        ? '需要管理员权限'
        : e instanceof Error
          ? e.message
          : '删除失败',
    )
  }
}

const enabledCount = computed(() => servers.value.filter((s) => s.enabled).length)
</script>

<template>
  <PageShell title="MCP" description="用 Cursor 格式管理 MCP 服务器：stdio / http，支持导入导出与连接测试。">
    <template #actions>
      <Button :disabled="!isAdmin || unavailable" @click="openAdd('manual')">
        <Plus />
        添加 MCP
      </Button>
      <Button variant="outline" :disabled="!isAdmin || unavailable" @click="openAdd('paste')">
        <Upload />
        导入 Cursor 配置
      </Button>
      <Button variant="outline" :disabled="!isAdmin || unavailable" @click="openExport">
        <Download />
        导出
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="刷新" :disabled="unavailable" @click="loadServers">
        <RefreshCw />
      </Button>
    </template>

    <div class="space-y-8">
      <CalloutBanner
        v-if="unavailable"
        tone="warning"
        title="MCP 管理后端接口尚未就绪"
        description="服务端 routes-mcp.ts 正在实现中。本页已按契约对接，接口上线后无需改前端。"
      />
      <CalloutBanner v-if="error" tone="destructive" :description="error" size="sm" />
      <CalloutBanner
        v-if="!isAdmin"
        tone="neutral"
        title="只读模式"
        description="添加、编辑、导入导出、测试连接与启停需要管理员账号；当前账号只能查看列表。"
      />

      <p class="px-2 text-label text-muted-foreground">
        Cursor 格式：<span class="font-mono text-caption">{ "mcpServers": { "名称": { "command": "...", "args": [...], "env": {...} } } }</span>；
        http 服务器用 <span class="font-mono text-caption">url</span> + <span class="font-mono text-caption">headers</span>。
        env/headers 的值保存在服务端，列表只显示键名。
      </p>

      <div v-if="loading" class="flex items-center gap-2 py-8 text-label text-muted-foreground">
        <Spinner class="size-4" />
        正在读取 MCP 服务器…
      </div>

      <SettingsSection v-else title="MCP 服务器">
        <template #actions>
          <Badge variant="outline" size="sm">{{ enabledCount }} / {{ servers.length }} 已启用</Badge>
        </template>
        <template #footer>
          <p class="text-caption text-muted-foreground">
            工具数来自最近一次连接测试/连接状态；「测试」会实时重连并列出工具。
          </p>
        </template>

        <SettingsRow v-for="server in servers" :key="server.name">
          <template #content>
            <div class="flex flex-wrap items-center gap-2">
              <span class="truncate text-control font-medium text-foreground">{{ server.name }}</span>
              <Badge size="sm" variant="outline">{{ transportLabel(server) }}</Badge>
              <Badge v-if="server.envKeys.length > 0" size="sm" variant="secondary">
                env {{ server.envKeys.length }}
              </Badge>
              <Badge v-if="server.headerKeys.length > 0" size="sm" variant="secondary">
                headers {{ server.headerKeys.length }}
              </Badge>
            </div>
            <p class="mt-0.5 truncate text-body text-muted-foreground">{{ describeServer(server) }}</p>
            <p class="mt-0.5 text-caption text-muted-foreground">
              <template v-if="server.connected === true">
                已连接 · {{ server.toolCount ?? 0 }} 个工具
              </template>
              <template v-else-if="server.enabled">未连接（点「测试」重连）</template>
              <template v-else>已停用</template>
            </p>
            <p v-if="server.lastError" class="mt-1 text-caption text-destructive">{{ server.lastError.slice(0, 240) }}{{ server.lastError.length > 240 ? '…' : '' }}</p>
          </template>

          <div class="flex items-center gap-2">
            <Switch
              :model-value="server.enabled"
              :disabled="!isAdmin || unavailable || toggling === server.name"
              @update:model-value="(v: boolean | 'indeterminate') => toggleEnabled(server, v)"
            />
            <Button
              variant="ghost"
              size="icon-sm"
              :aria-label="`测试 ${server.name}`"
              :disabled="!isAdmin || unavailable"
              @click="runTest(server)"
            >
              <FlaskConical />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              :aria-label="`编辑 ${server.name}`"
              :disabled="!isAdmin || unavailable"
              @click="openEdit(server)"
            >
              <Pencil />
            </Button>
            <ConfirmPopover
              :title="`删除 ${server.name}？`"
              message="会从 MCP 配置中移除该服务器，正在运行的工具连接会断开。"
              confirm-text="删除"
              cancel-text="取消"
              variant="destructive"
              @confirm="removeServer(server)"
            >
              <template #trigger>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  :aria-label="`删除 ${server.name}`"
                  :disabled="!isAdmin || unavailable"
                >
                  <Trash2 />
                </Button>
              </template>
            </ConfirmPopover>
          </div>
        </SettingsRow>

        <SettingsRow v-if="servers.length === 0">
          <template #content>
            <p class="text-control text-muted-foreground">
              还没有配置 MCP 服务器。点右上「导入 Cursor 配置」粘贴已有配置，或「添加 MCP」手动填写。
            </p>
          </template>
        </SettingsRow>
      </SettingsSection>
    </div>

    <!-- 添加 / 编辑：双 Tab -->
    <Dialog v-model:open="form.open">
      <DialogPanel width="xl" footer>
        <DialogHeader>
          <DialogTitle>{{ form.mode === 'add' ? '添加 MCP 服务器' : `编辑 ${form.name}` }}</DialogTitle>
          <DialogDescription class="sr-only">
            粘贴 Cursor 配置或手动填写 MCP 服务器参数（名称、传输、command 或 url、args/env/headers）。
          </DialogDescription>
        </DialogHeader>
        <DialogBody class="space-y-4">
          <Tabs v-if="form.mode === 'add'" v-model="form.tab" class="space-y-4">
            <TabsList variant="underline">
              <TabsTrigger value="paste">粘贴 Cursor 配置</TabsTrigger>
              <TabsTrigger value="manual">手动填写</TabsTrigger>
            </TabsList>

            <TabsContent value="paste" class="space-y-3">
              <p class="text-label text-muted-foreground">
                直接粘贴 Cursor 的 MCP 配置（可只含 <span class="font-mono text-caption">mcpServers</span> 段）：
              </p>
              <Textarea
                v-model="form.pasteText"
                :rows="10"
                placeholder='{"mcpServers":{"filesystem":{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"]}}}'
                :disabled="form.importing"
              />
              <CalloutBanner
                v-if="form.importResult"
                :tone="form.importResult.errors.length > 0 ? 'warning' : 'neutral'"
                size="sm"
                :description="`导入结果：新增 ${form.importResult.added.length}、更新 ${form.importResult.updated.length}、失败 ${form.importResult.errors.length}`"
              />
              <div v-if="form.importResult?.added.length" class="space-y-1 text-caption text-muted-foreground">
                <p>新增：{{ form.importResult.added.join('、') }}</p>
              </div>
              <div v-if="form.importResult?.updated.length" class="space-y-1 text-caption text-muted-foreground">
                <p>更新：{{ form.importResult.updated.join('、') }}</p>
              </div>
              <div v-if="form.importResult?.errors.length" class="space-y-1">
                <p
                  v-for="item in form.importResult.errors"
                  :key="`${item.name}-${item.error}`"
                  class="break-all text-caption text-destructive line-clamp-3"
                >
                  {{ item.name || '（无名称）' }}：{{ item.error }}
                </p>
              </div>
            </TabsContent>

            <TabsContent value="manual" class="space-y-3">
              <label class="block space-y-1.5">
                <span class="text-label font-medium text-foreground">名称</span>
                <Input v-model="form.name" placeholder="例如 filesystem（1-32 位字母/数字/_/-）" />
              </label>
              <div class="space-y-1.5">
                <span class="text-label font-medium text-foreground">传输</span>
                <SegmentedControl
                  :model-value="form.transport"
                  :items="[
                    { value: 'stdio', label: 'stdio（本地进程）' },
                    { value: 'streamable-http', label: 'http（远程服务）' },
                  ]"
                  aria-label="MCP 传输方式"
                  @update:model-value="(v: string | number) => (form.transport = v as typeof form.transport)"
                />
              </div>
              <template v-if="form.transport === 'stdio'">
                <label class="block space-y-1.5">
                  <span class="text-label font-medium text-foreground">command</span>
                  <Input v-model="form.command" placeholder="npx / node / uvx / python3 / deno / bun / true" />
                </label>
                <label class="block space-y-1.5">
                  <span class="text-label font-medium text-foreground">args（一行一个）</span>
                  <Textarea v-model="form.argsText" :rows="4" placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;/tmp" />
                </label>
                <label class="block space-y-1.5">
                  <span class="text-label font-medium text-foreground">env（KEY=VALUE，一行一个）</span>
                  <Textarea
                    v-model="form.envText"
                    :rows="3"
                    placeholder="已有值不回显；留空表示不修改"
                  />
                </label>
              </template>
              <template v-else>
                <label class="block space-y-1.5">
                  <span class="text-label font-medium text-foreground">url</span>
                  <Input v-model="form.url" placeholder="https://example.com/mcp" />
                </label>
                <label class="block space-y-1.5">
                  <span class="text-label font-medium text-foreground">headers（KEY=VALUE，一行一个）</span>
                  <Textarea
                    v-model="form.headersText"
                    :rows="3"
                    placeholder="已有值不回显；留空表示不修改"
                  />
                </label>
              </template>
            </TabsContent>
          </Tabs>

          <template v-if="form.mode === 'edit'">
            <p class="text-label text-muted-foreground">
              名称与传输类型不可修改（改名/换传输类型 = 删除后重新添加）。
            </p>
            <div class="flex items-center gap-2">
              <span class="text-label text-muted-foreground">传输：</span>
              <Badge size="sm" variant="outline">{{ form.transport === 'stdio' ? 'stdio（本地进程）' : 'http（远程服务）' }}</Badge>
            </div>
            <template v-if="form.transport === 'stdio'">
              <label class="block space-y-1.5">
                <span class="text-label font-medium text-foreground">command</span>
                <Input v-model="form.command" />
              </label>
              <label class="block space-y-1.5">
                <span class="text-label font-medium text-foreground">args（一行一个）</span>
                <Textarea v-model="form.argsText" :rows="4" />
              </label>
              <label class="block space-y-1.5">
                <span class="text-label font-medium text-foreground">env（KEY=VALUE；留空=不修改）</span>
                <Textarea v-model="form.envText" :rows="3" placeholder="已保存的值不回显，留空表示不修改" />
              </label>
            </template>
            <template v-else>
              <label class="block space-y-1.5">
                <span class="text-label font-medium text-foreground">url</span>
                <Input v-model="form.url" />
              </label>
              <label class="block space-y-1.5">
                <span class="text-label font-medium text-foreground">headers（KEY=VALUE；留空=不修改）</span>
                <Textarea v-model="form.headersText" :rows="3" placeholder="已保存的值不回显，留空表示不修改" />
              </label>
            </template>
          </template>

          <CalloutBanner v-if="form.error" tone="destructive" size="sm" :description="form.error" />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" @click="closeForm">取消</Button>
          <template v-if="form.mode === 'add' && form.tab === 'paste'">
            <Button :loading="form.importing" :disabled="form.pasteText.trim() === ''" @click="importCursor">导入</Button>
          </template>
          <template v-else>
            <Button :loading="form.saving" @click="saveManual">保存</Button>
          </template>
        </DialogFooter>
      </DialogPanel>
    </Dialog>

    <!-- 导出 Cursor 配置 -->
    <Dialog v-model:open="exportDialog.open">
      <DialogPanel width="xl" footer>
        <DialogHeader>
          <DialogTitle>导出 Cursor 配置</DialogTitle>
          <DialogDescription class="sr-only">当前全部 MCP 服务器（含 env/headers 真实值，仅管理员可见）。</DialogDescription>
        </DialogHeader>
        <DialogBody class="space-y-3">
          <div v-if="exportDialog.loading" class="flex items-center gap-2 text-label text-muted-foreground">
            <Spinner class="size-4" />
            正在导出…
          </div>
          <CalloutBanner v-else-if="exportDialog.error" tone="destructive" size="sm" :description="exportDialog.error" />
          <CodePanel
            v-else
            :code="exportDialog.json"
            width="full"
            copy-label="复制配置"
            copied-label="已复制"
            copy-failed-message="复制失败"
            class="max-h-96 overflow-y-auto"
          />
          <p class="text-caption text-muted-foreground">
            直接粘贴到 Cursor 的 MCP 配置即可；env/headers 值仅管理员可见，请勿分享。
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" @click="exportDialog.open = false">关闭</Button>
        </DialogFooter>
      </DialogPanel>
    </Dialog>

    <!-- 测试连接结果 -->
    <Dialog v-model:open="testDialog.open">
      <DialogPanel width="lg" footer>
        <DialogHeader>
          <DialogTitle>测试连接 · {{ testDialog.name }}</DialogTitle>
          <DialogDescription class="sr-only">重连该 MCP 服务器并列出其工具。</DialogDescription>
        </DialogHeader>
        <DialogBody class="space-y-3">
          <div v-if="testDialog.loading" class="flex items-center gap-2 text-label text-muted-foreground">
            <Spinner class="size-4" />
            正在连接并列出工具…
          </div>
          <template v-else-if="testDialog.result">
            <CalloutBanner
              v-if="!testDialog.result.ok"
              tone="destructive"
              size="sm"
              title="连接失败"
              :description="testDialog.result.error || '未知错误'"
            />
            <template v-else>
              <p class="text-label text-foreground">
                连接成功，共 {{ testDialog.result.toolCount }} 个工具：
              </p>
              <ul class="max-h-72 space-y-1 overflow-y-auto">
                <li
                  v-for="tool in testDialog.result.tools"
                  :key="tool.name"
                  class="rounded-md border border-border px-3 py-2"
                >
                  <div class="font-mono text-control text-foreground">{{ tool.name }}</div>
                  <p v-if="tool.description" class="mt-0.5 text-caption text-muted-foreground">{{ tool.description }}</p>
                </li>
              </ul>
              <p v-if="testDialog.result.tools.length === 0" class="text-label text-muted-foreground">
                该服务器没有暴露工具。
              </p>
            </template>
          </template>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" @click="testDialog.open = false">关闭</Button>
        </DialogFooter>
      </DialogPanel>
    </Dialog>
  </PageShell>
</template>
