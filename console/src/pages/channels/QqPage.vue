<script setup lang="ts">
/**
 * QQ —— 双通道：SnowLuma（OneBot v11，推荐）+ 官方 QQBot。
 * 后端契约（/tmp/qq-spec2.md §1.3，@littly/channel-qq 基于 dsh-lane-bridge）：
 *   GET  /api/qq/status（required）→ {snowluma:{enabled,connected,selfId?,lastError?,lastEventAt?}, qqbot:{…}}
 *   PUT  /api/qq/snowluma（admin）{enabled, wsUrl?, token?}
 *   PUT  /api/qq/qqbot（admin）{enabled, appId, appSecret?}   ← secret 空 = 不修改
 *   POST /api/qq/probe（required）{kind:'snowluma'|'qqbot'}
 *   GET  /api/qq/logs?tail=N（admin，后端脱敏）
 * SnowLuma 一键安装（task-15 / snowluma-install-spec §2，由 @littly/snowluma supervisor 承载）：
 *   GET  /api/snowluma/status（required）→ not_installed|pulling|installed|starting|waiting_scan|connected|error
 *   POST /api/snowluma/install|start|stop|qr|autoconfigure|remove（admin）
 * 安装向导只做「知情同意 → 拉镜像 → 启动 → 引导扫码」；扫码后由后端自动接线（读 SnowLuma 的 OneBot token），
 * 失败才降级到下方手动 ws/token 表单。未就绪（404）时静默降级，不伪装成未安装。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import {
  Badge,
  Button,
  CalloutBanner,
  Checkbox,
  CodePanel,
  ConfirmPopover,
  CopyButton,
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
  Input,
  PageShell,
  SettingsRow,
  SettingsSection,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  Spinner,
  StatusDot,
  SurfaceCard,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from '@felinic/ui'
import { Check, Download, ExternalLink, Monitor, RefreshCw, ScrollText, Square, Terminal, Wifi } from 'lucide-vue-next'
import AccountBindSection from '@/components/AccountBindSection.vue'
import { qqApi, snowlumaInstallApi, type QqStatus, type SnowlumaInstallStatus, type SnowlumaQrInfo } from '@/api/endpoints'
import { ApiError } from '@/api/client'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const isAdmin = computed(() => auth.state.user?.role === 'admin')

const loading = ref(true)
const unavailable = ref(false)
const error = ref('')
const status = ref<QqStatus | null>(null)
const activeTab = ref<'snowluma' | 'qqbot'>('snowluma')

/* 表单（secret 空 = 不修改，由后端掩码写入语义保证） */
const snowForm = reactive({ enabled: false, wsUrl: '', token: '' })
const botForm = reactive({ enabled: false, appId: '', appSecret: '' })

const savingSnow = ref(false)
const savingBot = ref(false)
const probing = ref(false)

const probes = reactive({
  snowluma: { tested: false, ok: false, selfId: '', nickname: '', error: '' },
  qqbot: { tested: false, ok: false, selfId: '', nickname: '', error: '' },
})

/* 日志抽屉 */
const logsOpen = ref(false)
const logsLoading = ref(false)
const logs = ref<string[]>([])

let pollTimer: ReturnType<typeof setInterval> | null = null

onMounted(async () => {
  await loadStatus()
  loading.value = false
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') {
      void loadStatus(true)
      void loadInstallStatus(true)
    }
  }, 8000)
})

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
  stopFastPoll()
})

async function loadStatus(silent = false): Promise<void> {
  if (!silent) error.value = ''
  try {
    const out = await qqApi.status()
    status.value = out
    unavailable.value = !out.available
    if (!out.available) return
    snowForm.enabled = out.snowluma.enabled
    botForm.enabled = out.qqbot.enabled
    // 回填已保存的地址/AppID（用户未改动时），避免每次保存都要重填。
    if (snowForm.wsUrl.trim() === '' && out.snowluma.wsUrl !== '') snowForm.wsUrl = out.snowluma.wsUrl
    if (botForm.appId.trim() === '' && out.qqbot.appId !== '') botForm.appId = out.qqbot.appId
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      unavailable.value = true
      status.value = null
    } else if (!silent) {
      error.value = e instanceof Error ? e.message : '读取 QQ 渠道状态失败'
    }
  }
}

/* ---------------- 渠道状态派生 ---------------- */
const snow = computed(() => status.value?.snowluma ?? null)
const bot = computed(() => status.value?.qqbot ?? null)
const anyConnected = computed(() => snow.value?.connected === true || bot.value?.connected === true)
const anyEnabled = computed(() => snow.value?.enabled === true || bot.value?.enabled === true)
const anyError = computed(
  () => (snow.value?.lastError ?? '') !== '' || (bot.value?.lastError ?? '') !== '',
)

const headerBadge = computed<{ label: string; variant: 'success' | 'info' | 'warning' | 'destructive' | 'outline' }>(() => {
  if (unavailable.value) return { label: '接口未就绪', variant: 'warning' }
  if (anyConnected.value) return { label: '已连接', variant: 'success' }
  if (anyError.value) return { label: '错误', variant: 'destructive' }
  if (anyEnabled.value) return { label: '已启用·等待连接', variant: 'info' }
  return { label: '未启用', variant: 'outline' }
})

function channelState(channel: { enabled: boolean; connected: boolean } | null): {
  text: string
  dot: 'success' | 'warning' | 'idle'
} {
  if (!channel) return { text: '未知', dot: 'idle' }
  if (channel.connected) return { text: '已连接', dot: 'success' }
  if (channel.enabled) return { text: '已启用·等待连接', dot: 'warning' }
  return { text: '未启用', dot: 'idle' }
}

/** 相对时间（最后事件）：分钟/小时/天。 */
function relativeTime(iso: string): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  const minutes = Math.max(0, Math.round((Date.now() - t) / 60000))
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

/** 每个 Tab 顶部的状态徽标（已连接/错误/已启用/未启用）。 */
function channelBadge(channel: { enabled: boolean; connected: boolean; lastError: string } | null): {
  label: string
  variant: 'success' | 'info' | 'destructive' | 'outline'
} {
  if (!channel) return { label: '未知', variant: 'outline' }
  if (channel.connected) return { label: '已连接', variant: 'success' }
  if ((channel.lastError ?? '') !== '') return { label: '错误', variant: 'destructive' }
  if (channel.enabled) return { label: '已启用', variant: 'info' }
  return { label: '未启用', variant: 'outline' }
}

/** 探测结果 → 账号展示文案（未探测显示 —，失败显示未连接）。 */
function probeValue(kind: 'snowluma' | 'qqbot'): string {
  const p = probes[kind]
  if (!p.tested) return '—'
  if (!p.ok) return '未连接'
  return p.nickname || p.selfId || '已连接'
}

const snowAccount = computed(() => {
  if (snow.value?.connected) {
    const name = snow.value.nickname
    const id = snow.value.selfId
    return name && id ? `${name}（${id}）` : name || id || '已连接'
  }
  return probeValue('snowluma')
})

const botAccount = computed(() => {
  if (bot.value?.connected) {
    const name = bot.value.nickname
    const id = bot.value.selfId
    return name && id ? `${name}（${id}）` : name || id || '已连接'
  }
  return probeValue('qqbot')
})

/* ---------------- 保存 ---------------- */
async function saveSnowluma(): Promise<void> {
  if (snowForm.wsUrl.trim() !== '' && !/^wss?:\/\//.test(snowForm.wsUrl.trim())) {
    toast.error('WS 地址必须以 ws:// 或 wss:// 开头')
    return
  }
  savingSnow.value = true
  try {
    await qqApi.saveSnowluma({
      enabled: snowForm.enabled,
      ...(snowForm.wsUrl.trim() !== '' ? { wsUrl: snowForm.wsUrl.trim() } : {}),
      ...(snowForm.token.trim() !== '' ? { token: snowForm.token.trim() } : {}),
    })
    snowForm.token = ''
    toast.success('SnowLuma 渠道配置已保存')
    await loadStatus(true)
  } catch (e) {
    toast.error(
      e instanceof ApiError && e.status === 403
        ? '需要管理员权限才能修改 QQ 渠道配置'
        : e instanceof Error
          ? e.message
          : '保存失败',
    )
  } finally {
    savingSnow.value = false
  }
}

async function saveQqbot(): Promise<void> {
  savingBot.value = true
  try {
    await qqApi.saveQqbot({
      enabled: botForm.enabled,
      appId: botForm.appId.trim(),
      ...(botForm.appSecret.trim() !== '' ? { appSecret: botForm.appSecret.trim() } : {}),
    })
    botForm.appSecret = ''
    toast.success('官方 QQBot 配置已保存')
    await loadStatus(true)
  } catch (e) {
    toast.error(
      e instanceof ApiError && e.status === 403
        ? '需要管理员权限才能修改 QQ 渠道配置'
        : e instanceof Error
          ? e.message
          : '保存失败',
    )
  } finally {
    savingBot.value = false
  }
}

/* ---------------- 探测 ---------------- */
async function probe(kind: 'snowluma' | 'qqbot'): Promise<void> {
  probing.value = true
  const slot = probes[kind]
  slot.tested = true
  try {
    const out = await qqApi.probe(kind)
    slot.ok = out.ok
    slot.selfId = out.selfId
    slot.nickname = out.nickname
    slot.error = out.error
    if (out.ok) toast.success(`连接正常${out.selfId ? `（${out.selfId}）` : ''}`)
    else toast.error(out.error || '探测失败：检查是否已启用并完成登录')
    await loadStatus(true)
  } catch (e) {
    slot.ok = false
    toast.error(e instanceof Error ? e.message : '探测失败')
  } finally {
    probing.value = false
  }
}

/* ---------------- 日志 ---------------- */
async function openLogs(): Promise<void> {
  logsOpen.value = true
  await loadLogs()
}

async function loadLogs(): Promise<void> {
  logsLoading.value = true
  try {
    logs.value = await qqApi.logs(100)
  } catch (e) {
    toast.error(
      e instanceof ApiError && e.status === 403
        ? '需要管理员权限才能查看日志'
        : e instanceof Error
          ? e.message
          : '读取日志失败',
    )
  } finally {
    logsLoading.value = false
  }
}

/* ================= SnowLuma 一键安装向导 ================= */
const sl = reactive({
  available: true,
  status: null as SnowlumaInstallStatus | null,
  dialogOpen: false,
  /** 1 知情同意 → 2 安装中 → 3 扫码登录 → 4 完成 */
  step: 1,
  consent: false,
  busy: false,
  error: '',
  qr: null as SnowlumaQrInfo | null,
  autoTried: false,
  autoDone: false,
  autoId: '',
  autoFailed: false,
  autoError: '',
  logsOpen: false,
  logsLoading: false,
  logs: [] as string[],
})
let slTimer: ReturnType<typeof setInterval> | null = null

const slSteps = ['知情同意', '安装', '扫码登录', '完成'] as const

const slState = computed(() => sl.status?.state ?? (sl.available ? 'not_installed' : 'unavailable'))
const slStateText = computed(() => {
  switch (slState.value) {
    case 'not_installed':
      return '未安装'
    case 'pulling':
      return '正在拉取镜像…'
    case 'installed':
      return '已安装·待启动'
    case 'starting':
      return '正在启动容器…'
    case 'waiting_scan':
      return '等待手机 QQ 扫码登录'
    case 'connected':
      return '已连接'
    case 'error':
      return '安装/启动失败'
    default:
      return '接口未就绪'
  }
})
const slBadge = computed<{ label: string; variant: 'success' | 'info' | 'warning' | 'destructive' | 'outline' }>(() => {
  switch (slState.value) {
    case 'connected':
      return { label: '已连接', variant: 'success' }
    case 'waiting_scan':
      return { label: '等待扫码', variant: 'info' }
    case 'pulling':
    case 'starting':
      return { label: '进行中', variant: 'info' }
    case 'installed':
      return { label: '已安装', variant: 'warning' }
    case 'error':
      return { label: '失败', variant: 'destructive' }
    case 'unavailable':
      return { label: '接口未就绪', variant: 'warning' }
    default:
      return { label: '未安装', variant: 'outline' }
  }
})
const slTransitional = computed(
  () => slState.value === 'pulling' || slState.value === 'starting' || slState.value === 'waiting_scan',
)
/** 免密直连 noVNC（密码来自后端 qrInfo，仅本机 URL） */
const directNovncUrl = computed(() => {
  const base = sl.qr?.novncUrl || sl.status?.novncUrl || 'http://127.0.0.1:6081/vnc.html'
  const pwd = sl.qr?.vncPassword ?? ''
  if (pwd === '') return base
  const sep = base.includes('?') ? '&' : '?'
  return `${base}${sep}autoconnect=1&password=${encodeURIComponent(pwd)}`
})

const slLogsText = computed(() => {
  const tail = sl.status?.logsTail ?? ''
  return tail.trim()
})
const slWizardLabel = computed(() => {
  switch (slState.value) {
    case 'not_installed':
      return '一键安装（推荐）'
    case 'pulling':
      return '查看安装进度'
    case 'installed':
    case 'starting':
      return '启动并扫码'
    case 'waiting_scan':
      return '查看扫码信息'
    case 'connected':
      return '查看安装结果'
    case 'error':
      return '重试安装'
    default:
      return '打开安装向导'
  }
})

async function loadInstallStatus(silent = true): Promise<void> {
  try {
    const out = await snowlumaInstallApi.status()
    sl.status = out
    sl.available = out.available
    if (!silent && !out.available) sl.error = '一键安装接口尚未就绪（@littly/snowluma 未装配）'
  } catch {
    sl.available = false
  }
}

function resetWizardProgress(): void {
  sl.autoTried = false
  sl.autoDone = false
  sl.autoFailed = false
  sl.autoError = ''
  sl.autoId = ''
}

/** 根据服务端状态推进向导步骤（不会回退，避免安装过程中界面跳变）。 */
async function syncWizardStep(): Promise<void> {
  const state = slState.value
  if (state === 'pulling') {
    sl.step = Math.max(sl.step, 2)
    return
  }
  if (state === 'installed' || state === 'starting' || state === 'waiting_scan') {
    sl.step = Math.max(sl.step, 3)
    if (sl.qr === null) await fetchQr()
    return
  }
  if (state === 'connected') {
    sl.step = 4
    if (!sl.autoTried) void runAutoconfigure()
  }
}

async function openWizard(): Promise<void> {
  sl.error = ''
  sl.qr = null
  resetWizardProgress()
  sl.consent = false
  await loadInstallStatus(false)
  if (!sl.available) {
    toast.error('一键安装接口尚未就绪，可先用下方手动配置')
    return
  }
  const state = slState.value
  sl.step = state === 'pulling' ? 2 : state === 'installed' || state === 'starting' || state === 'waiting_scan' ? 3 : state === 'connected' ? 4 : 1
  sl.dialogOpen = true
  startFastPoll()
  await syncWizardStep()
}

function closeWizard(): void {
  sl.dialogOpen = false
  stopFastPoll()
}

function startFastPoll(): void {
  stopFastPoll()
  slTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return
    void (async () => {
      await loadInstallStatus()
      if (sl.dialogOpen) await syncWizardStep()
    })()
  }, 3000)
}

function stopFastPoll(): void {
  if (slTimer) {
    clearInterval(slTimer)
    slTimer = null
  }
}

async function startInstall(): Promise<void> {
  if (!sl.consent) {
    sl.error = '请先勾选知情同意'
    return
  }
  sl.busy = true
  sl.error = ''
  try {
    const out = await snowlumaInstallApi.install(true)
    sl.status = out
    sl.available = out.available
    if (!out.available) {
      sl.error = '后端接口尚未就绪，无法安装'
      return
    }
    sl.step = 2
    startFastPoll()
  } catch (e) {
    sl.error =
      e instanceof ApiError && e.status === 403
        ? '需要管理员权限才能安装 SnowLuma。'
        : e instanceof Error
          ? e.message
          : '安装失败'
  } finally {
    sl.busy = false
  }
}

async function startService(): Promise<void> {
  sl.busy = true
  sl.error = ''
  try {
    const out = await snowlumaInstallApi.start()
    sl.status = out
    resetWizardProgress()
    sl.step = 3
    await fetchQr()
    startFastPoll()
  } catch (e) {
    sl.error =
      e instanceof ApiError && e.status === 403
        ? '需要管理员权限才能启动 SnowLuma。'
        : e instanceof Error
          ? e.message
          : '启动失败'
  } finally {
    sl.busy = false
  }
}

async function fetchQr(): Promise<void> {
  try {
    const info = await snowlumaInstallApi.qr()
    if (info) sl.qr = info
  } catch {
    /* qr 信息拿不到时页面仍显示状态与轮询，不阻塞 */
  }
}

async function runAutoconfigure(): Promise<void> {
  if (sl.autoTried) return
  sl.autoTried = true
  sl.autoError = ''
  try {
    const out = await snowlumaInstallApi.autoconfigure()
    if (out.ok) {
      sl.autoDone = true
      sl.autoFailed = false
      sl.autoId = out.selfId || out.nickname || ''
      toast.success(`已连接${out.selfId ? ` @${out.selfId}` : ''}${out.nickname ? `（${out.nickname}）` : ''}，可以聊天了`)
      await loadStatus(true)
      await loadInstallStatus()
    } else {
      sl.autoFailed = true
      sl.autoError = out.waiting
        ? '仍在等待 QQ 扫码登录完成；登录成功后可点「重试自动配置」。'
        : out.error || '自动配置失败：WS 暂不可达或未登录完成'
    }
  } catch (e) {
    sl.autoFailed = true
    sl.autoError =
      e instanceof ApiError && e.status === 403
        ? '需要管理员权限才能自动配置'
        : e instanceof Error
          ? e.message
          : '自动配置失败'
  }
}

/** 自动接线失败后的重试入口（重新探测 WS 并写 bots 配置）。 */
async function retryAutoconfigure(): Promise<void> {
  sl.autoFailed = false
  sl.autoError = ''
  sl.autoTried = false
  await runAutoconfigure()
}

async function stopService(): Promise<void> {
  try {
    const out = await snowlumaInstallApi.stop()
    sl.status = out
    resetWizardProgress()
    if (sl.step > 2) sl.step = 2
    toast.success('已停止 SnowLuma（登录态与数据卷保留）')
    await loadInstallStatus()
    await loadStatus(true)
  } catch (e) {
    toast.error(
      e instanceof ApiError && e.status === 403
        ? '需要管理员权限才能停止 SnowLuma'
        : e instanceof Error
          ? e.message
          : '停止失败',
    )
  }
}

async function removeService(): Promise<void> {
  try {
    await snowlumaInstallApi.remove(true)
    toast.success('已卸载 SnowLuma 容器（登录数据卷已保留，重新安装后可直接扫码）')
    closeWizard()
    resetWizardProgress()
    sl.step = 1
    sl.qr = null
    await loadInstallStatus()
    await loadStatus(true)
  } catch (e) {
    toast.error(
      e instanceof ApiError && e.status === 403
        ? '需要管理员权限才能卸载'
        : e instanceof Error
          ? e.message
          : '卸载失败',
    )
  }
}

async function openSlLogs(): Promise<void> {
  sl.logsOpen = true
  await loadSlLogs()
}

async function loadSlLogs(): Promise<void> {
  sl.logsLoading = true
  try {
    sl.logs = await snowlumaInstallApi.logs(200)
  } catch (e) {
    toast.error(
      e instanceof ApiError && e.status === 403 ? '需要管理员权限才能查看容器日志' : '读取容器日志失败',
    )
  } finally {
    sl.logsLoading = false
  }
}

onMounted(() => {
  void loadInstallStatus(true)
})

</script>

<template>
  <PageShell title="QQ" description="SnowLuma OneBot v11 与官方 QQBot 双通道；任一启用即可让她在 QQ 上线。">
    <template #actions>
      <Badge :variant="headerBadge.variant">{{ headerBadge.label }}</Badge>
      <Button variant="outline" :loading="probing" :disabled="unavailable" @click="probe(activeTab)">
        <Wifi />
        探测 {{ activeTab === 'snowluma' ? 'SnowLuma' : 'QQBot' }}
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="查看日志" :disabled="!isAdmin || unavailable" @click="openLogs">
        <ScrollText />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="刷新状态" :disabled="unavailable" @click="loadStatus()">
        <RefreshCw />
      </Button>
    </template>

    <div class="space-y-8">
      <CalloutBanner
        v-if="unavailable"
        tone="warning"
        title="QQ 渠道后端接口尚未就绪"
        description="服务端的 @littly/channel-qq 与 /api/qq/* 正在实现中。本页已按契约对接，接口上线后无需改前端。"
      />
      <CalloutBanner v-if="error" tone="destructive" :description="error" size="sm" />
      <CalloutBanner
        v-if="!isAdmin"
        tone="neutral"
        title="只读模式"
        description="启用开关与渠道配置需要管理员账号；当前账号可以查看状态。"
      />
      <div v-if="loading" class="flex items-center gap-2 py-8 text-label text-muted-foreground">
        <Spinner class="size-4" />
        正在读取 QQ 渠道状态…
      </div>

      <Tabs v-else-if="status" v-model="activeTab" class="space-y-6">
        <TabsList variant="underline">
          <TabsTrigger value="snowluma">SnowLuma（推荐）</TabsTrigger>
          <TabsTrigger value="qqbot">官方 QQBot</TabsTrigger>
        </TabsList>

        <!-- ================= SnowLuma（OneBot v11） ================= -->
        <TabsContent value="snowluma" class="space-y-6">
          <!-- 一键安装（推荐）：四步向导入口 + 次要运维操作 -->
          <SurfaceCard padding="lg" class="space-y-3" data-testid="snowluma-install-card">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="space-y-1">
                <h2 class="text-control font-medium text-foreground">一键安装（推荐）</h2>
                <p class="text-label text-muted-foreground">
                  自动安装并启动 SnowLuma、接通 OneBot；你只需要打开远程桌面，用手机 QQ 扫码登录。
                </p>
              </div>
              <Badge :variant="slBadge.variant">{{ slBadge.label }}</Badge>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <Button :disabled="!isAdmin || !sl.available" @click="openWizard">
                <Download />
                {{ slWizardLabel }}
              </Button>
              <Button
                v-if="sl.status?.container.running === true && slState !== 'not_installed'"
                variant="outline"
                :disabled="!isAdmin || !sl.available"
                @click="stopService"
              >
                <Square />
                停止
              </Button>
              <Button variant="outline" :disabled="!isAdmin || !sl.available" @click="openSlLogs">
                <Terminal />
                容器日志
              </Button>
              <ConfirmPopover
                title="卸载 SnowLuma？"
                message="会删除 SnowLuma 容器，默认保留登录数据卷（QQ 登录态）；重新安装后可直接扫码。"
                confirm-text="卸载（保留登录态）"
                cancel-text="取消"
                variant="destructive"
                @confirm="removeService"
              >
                <template #trigger>
                  <Button variant="ghost" :disabled="!isAdmin || !sl.available || slState === 'not_installed'">
                    卸载
                  </Button>
                </template>
              </ConfirmPopover>
            </div>
            <p class="text-caption text-muted-foreground">
              SnowLuma 为第三方非商业自托管软件，需遵守其 EULA；安装前需勾选知情同意。需要本机 Docker。
            </p>
            <CalloutBanner
              v-if="!sl.available"
              tone="warning"
              size="sm"
              title="一键安装接口尚未就绪"
              description="服务端 @littly/snowluma supervisor 正在实现中；可先用下方「手动连接」填写 ws 地址与 token。"
            />
            <CalloutBanner
              v-if="!isAdmin"
              tone="neutral"
              size="sm"
              description="一键安装、启动/停止/卸载与容器日志需要管理员账号。"
            />
          </SurfaceCard>

          <SettingsSection title="连接状态">
            <template #actions>
              <Badge :variant="channelBadge(snow).variant">{{ channelBadge(snow).label }}</Badge>
            </template>
            <SettingsRow label="状态" description="SnowLuma 通过 OneBot v11 正向 WS 接入">
              <div class="flex items-center gap-2 text-control text-foreground">
                <StatusDot :status="channelState(snow).dot" />
                {{ channelState(snow).text }}
              </div>
            </SettingsRow>
            <SettingsRow label="QQ 账号" description="OneBot get_login_info 上报的 self_id / 昵称">
              <span class="text-control text-foreground">
                {{ snowAccount }}
              </span>
            </SettingsRow>
            <SettingsRow label="最后事件" description="最近一次收到 OneBot 事件">
              <span class="text-control text-foreground">{{ relativeTime(snow?.lastEventAt ?? '') }}</span>
            </SettingsRow>
            <div v-if="snow?.lastError" class="mx-4 border-b border-border py-3 text-caption text-destructive">
              {{ snow.lastError }}
            </div>
            <div v-if="probes.snowluma.error" class="mx-4 border-b border-border py-3 text-caption text-destructive">
              探测：{{ probes.snowluma.error }}
            </div>
            <SettingsRow label="启用 SnowLuma" description="关闭后不连接 SnowLuma（不影响已保存的配置）">
              <Switch v-model="snowForm.enabled" :disabled="!isAdmin || unavailable" />
            </SettingsRow>
            <SettingsRow
              label="OneBot WS 地址"
              description="SnowLuma 的 OneBot v11 正向 WS，默认 ws://127.0.0.1:3001"
              stack="sm"
            >
              <Input v-model="snowForm.wsUrl" placeholder="ws://127.0.0.1:3001" :disabled="!isAdmin || unavailable" />
            </SettingsRow>
            <SettingsRow
              label="WS Token"
              description="OneBot 的访问 token（与 SnowLuma WebUI/HTTP token 不是同一个值）；留空表示不修改"
              stack="sm"
            >
              <Input
                v-model="snowForm.token"
                type="password"
                :placeholder="snow?.hasToken ? '已保存（留空不修改）' : 'OneBot token（可留空）'"
                :disabled="!isAdmin || unavailable"
              />
            </SettingsRow>
            <template #footer>
              <Button variant="outline" :loading="probing" :disabled="unavailable" @click="probe('snowluma')">
                探测 WS
              </Button>
              <Button :loading="savingSnow" :disabled="!isAdmin || unavailable" @click="saveSnowluma">
                保存 SnowLuma 配置
              </Button>
            </template>
          </SettingsSection>

          <AccountBindSection
            channel="qqp"
            hint="在 QQ 里私聊她（SnowLuma 通道），发送「绑定 <码>」完成绑定。"
          />

          <SurfaceCard padding="lg" class="space-y-2">
            <h2 class="text-label font-medium text-muted-foreground">自动发现</h2>
            <p class="text-label text-muted-foreground">
              若 SnowLuma 与本服务在同一台机器，后端会从
              <span class="font-mono text-caption">SNOWLUMA_HOME</span>
              （SnowLuma 安装目录）自动发现 OneBot 的 wsUrl 与 token；手动填写的配置优先于自动发现。
            </p>
            <p class="text-caption text-muted-foreground">
              SnowLuma 需自行安装并运行（非商业自托管，遵守其 EULA）；QQ 扫码登录在其 WebUI 中完成，本控制台只建立连接、不代装/不代启。
            </p>
          </SurfaceCard>
        </TabsContent>

        <!-- ================= 官方 QQBot ================= -->
        <TabsContent value="qqbot" class="space-y-6">
          <SettingsSection title="连接状态">
            <template #actions>
              <Badge :variant="channelBadge(bot).variant">{{ channelBadge(bot).label }}</Badge>
            </template>
            <SettingsRow label="状态" description="腾讯官方 QQBot 开放平台（WebSocket 接入）">
              <div class="flex items-center gap-2 text-control text-foreground">
                <StatusDot :status="channelState(bot).dot" />
                {{ channelState(bot).text }}
              </div>
            </SettingsRow>
            <SettingsRow label="Bot 账号" description="连接成功后平台返回的 bot id / 昵称">
              <span class="text-control text-foreground">
                {{ botAccount }}
              </span>
            </SettingsRow>
            <SettingsRow label="最后事件" description="最近一次收到 QQBot 事件">
              <span class="text-control text-foreground">{{ relativeTime(bot?.lastEventAt ?? '') }}</span>
            </SettingsRow>
            <div v-if="bot?.lastError" class="mx-4 border-b border-border py-3 text-caption text-destructive">
              {{ bot.lastError }}
            </div>
            <div v-if="probes.qqbot.error" class="mx-4 border-b border-border py-3 text-caption text-destructive">
              探测：{{ probes.qqbot.error }}
            </div>
            <SettingsRow label="启用官方 QQBot" description="关闭后不建立 QQBot 长连接">
              <Switch v-model="botForm.enabled" :disabled="!isAdmin || unavailable" />
            </SettingsRow>
            <SettingsRow label="AppID" description="QQ 开放平台机器人 AppID" stack="sm">
              <Input v-model="botForm.appId" placeholder="1020xxxx（留空则保留已存值）" :disabled="!isAdmin || unavailable" />
            </SettingsRow>
            <SettingsRow label="AppSecret" description="开放平台密钥；留空表示不修改" stack="sm">
              <Input
                v-model="botForm.appSecret"
                type="password"
                :placeholder="bot?.hasSecret ? '已保存（留空不修改）' : '未保存，请填写 AppSecret'"
                :disabled="!isAdmin || unavailable"
              />
            </SettingsRow>
            <template #footer>
              <Button variant="outline" :loading="probing" :disabled="unavailable" @click="probe('qqbot')">
                探测连接
              </Button>
              <Button :loading="savingBot" :disabled="!isAdmin || unavailable" @click="saveQqbot">
                保存 QQBot 配置
              </Button>
            </template>
          </SettingsSection>

          <AccountBindSection
            channel="qqp"
            hint="在 QQ 里私聊官方机器人发送「绑定 <码>」完成绑定；官方 QQBot 与 SnowLuma 共用同一个 QQ 身份（channel=qqp），绑定一次即可。"
          />

          <SurfaceCard padding="lg" class="space-y-2">
            <h2 class="text-label font-medium text-muted-foreground">被动回复窗口</h2>
            <p class="text-label text-muted-foreground">
              官方 QQBot 只能“被动回复”：在用户发来消息后的 5 分钟内可回复；超出窗口的主动推送受平台限制
              （官方配额约 4 条/月）。若需要更自由的群聊体验，优先使用上面的 SnowLuma 通道。
            </p>
          </SurfaceCard>
        </TabsContent>
      </Tabs>
    </div>

    <!-- 适配器日志抽屉 -->
    <Sheet v-model:open="logsOpen">
      <SheetContent side="right" class="w-[min(46rem,92vw)] p-0">
        <SheetTitle class="sr-only">QQ 渠道日志</SheetTitle>
        <SheetDescription class="sr-only">适配器最近日志（敏感字段已脱敏）</SheetDescription>
        <div class="flex h-full flex-col">
          <div class="flex min-h-14 items-center justify-between gap-3 border-b border-border px-4 pr-12">
            <div class="text-control font-medium text-foreground">QQ 渠道日志（最近 100 行）</div>
            <Button variant="ghost" size="sm" :loading="logsLoading" @click="loadLogs">
              <RefreshCw />
              刷新
            </Button>
          </div>
          <div class="min-h-0 flex-1 overflow-auto p-4">
            <p v-if="logsLoading && logs.length === 0" class="flex items-center gap-2 text-label text-muted-foreground">
              <Spinner class="size-4" />
              正在读取日志…
            </p>
            <CodePanel
              v-else-if="logs.length > 0"
              :code="logs.join('\n')"
              width="full"
              copy-label="复制日志"
              copied-label="已复制"
              copy-failed-message="复制失败"
            />
            <p v-else class="text-label text-muted-foreground">暂无日志。</p>
          </div>
        </div>
      </SheetContent>
    </Sheet>

    <!-- 一键安装向导（四步：同意 → 安装 → 扫码 → 完成） -->
    <Dialog v-model:open="sl.dialogOpen">
      <DialogPanel width="lg" footer>
        <DialogHeader>
          <DialogTitle>一键安装 SnowLuma</DialogTitle>
          <DialogDescription class="sr-only">
            四步完成安装：知情同意、拉取镜像、扫码登录、自动接线。
          </DialogDescription>
        </DialogHeader>
        <DialogBody class="space-y-4">
          <!-- 步骤指示 -->
          <div class="flex items-center gap-2">
            <template v-for="(label, i) in slSteps" :key="label">
              <div class="flex shrink-0 items-center gap-1.5">
                <span
                  class="flex size-5 items-center justify-center rounded-full text-caption font-medium"
                  :class="
                    sl.step > i + 1 || (i === 3 && sl.autoDone)
                      ? 'bg-foreground text-background'
                      : sl.step === i + 1
                        ? 'border border-foreground text-foreground'
                        : 'bg-muted-soft text-muted-foreground'
                  "
                >
                  <Check v-if="sl.step > i + 1 || (i === 3 && sl.autoDone)" class="size-3" :stroke-width="3" />
                  <template v-else>{{ i + 1 }}</template>
                </span>
                <span
                  class="whitespace-nowrap text-caption"
                  :class="sl.step === i + 1 ? 'text-foreground' : 'text-muted-foreground'"
                >
                  {{ label }}
                </span>
              </div>
              <div v-if="i < slSteps.length - 1" class="h-px min-w-3 flex-1 bg-border" />
            </template>
          </div>

          <!-- ① 知情同意 -->
          <div v-if="sl.step === 1" class="space-y-3">
            <ul class="list-disc space-y-1 pl-4 text-label text-muted-foreground">
              <li>SnowLuma 是第三方<strong>非商业自托管</strong>软件，需遵守其 EULA；本控制台只调用官方镜像。</li>
              <li>需要本机已安装并运行 Docker（当前：{{ sl.status?.dockerOk ? '可用' : '未检测到 Docker' }}）。</li>
              <li>会拉取官方镜像并创建容器；QQ 登录态保存在数据卷，卸载默认不删除。</li>
            </ul>
            <label class="flex items-start gap-2">
              <Checkbox id="snowluma-install-consent" v-model="sl.consent" class="mt-0.5" />
              <span class="text-label text-foreground">
                我已知悉 SnowLuma 的第三方非商业自托管 EULA，并同意在本机安装运行。
              </span>
            </label>
            <CalloutBanner v-if="sl.error" tone="destructive" size="sm" :description="sl.error" />
          </div>

          <!-- ② 安装中 -->
          <div v-else-if="sl.step === 2" class="space-y-3">
            <div class="flex items-center gap-2 text-label text-foreground">
              <Spinner class="size-4" />
              {{ slStateText }}
            </div>
            <p v-if="sl.status?.pullProgress" class="font-mono text-caption text-muted-foreground">
              {{ sl.status.pullProgress }}
            </p>
            <p class="text-caption text-muted-foreground">
              首次拉取官方镜像可能需要几分钟；可以先关闭窗口，稍后从顶部卡片继续查看。
            </p>
            <CodePanel
              v-if="slLogsText"
              :code="slLogsText"
              width="full"
              copy-label="复制日志"
              copied-label="已复制"
              copy-failed-message="复制失败"
              class="max-h-40 overflow-y-auto"
            />
            <CalloutBanner
              v-if="sl.error || sl.status?.lastError"
              tone="destructive"
              size="sm"
              :description="sl.error || sl.status?.lastError"
            />
          </div>

          <!-- ③ 启动并扫码 -->
          <div v-else-if="sl.step === 3" class="space-y-3">
            <p class="text-label text-foreground">
              打开远程桌面后用手机 QQ 扫码登录；<strong>扫码后会自动连接</strong>，不需要手动填写 ws 地址或 token。
            </p>
            <div class="flex flex-wrap items-center gap-2">
              <Button
                as="a"
                :href="sl.qr?.novncUrl ?? sl.status?.novncUrl ?? 'http://127.0.0.1:6081/vnc.html'"
                target="_blank"
              >
                <Monitor />
                打开远程桌面（noVNC）
              </Button>
              <Button v-if="sl.qr?.vncPassword" variant="outline" as="a" :href="directNovncUrl" target="_blank">
                <ExternalLink />
                免密直连
              </Button>
              <CopyButton
                v-if="sl.qr?.vncPassword"
                :text="sl.qr.vncPassword"
                label="复制远程桌面密码"
                copied-label="已复制"
                failed-message="复制失败"
              />
            </div>
            <p class="text-caption text-muted-foreground">
              远程桌面密码：<span class="font-mono">{{ sl.qr?.vncPassword || '（后端未返回，可查看容器日志）' }}</span>
            </p>
            <div class="flex flex-wrap items-center gap-2 text-label text-muted-foreground">
              <span>WebUI：</span>
              <a
                class="text-foreground underline decoration-border underline-offset-2"
                :href="sl.qr?.webuiUrl ?? sl.status?.webuiUrl ?? 'http://127.0.0.1:5099'"
                target="_blank"
                rel="noreferrer"
              >
                打开 WebUI
              </a>
              <span v-if="sl.qr?.webuiPassword">临时密码：{{ sl.qr.webuiPassword }}</span>
              <CopyButton
                v-if="sl.qr?.webuiPassword"
                :text="sl.qr.webuiPassword"
                label="复制 WebUI 密码"
                copied-label="已复制"
                failed-message="复制失败"
              />
            </div>
            <CalloutBanner
              v-if="sl.status?.configWarning"
              tone="warning"
              size="sm"
              :description="sl.status.configWarning"
            />
            <ol v-if="sl.qr?.steps.length" class="list-decimal space-y-1 pl-4 text-caption text-muted-foreground">
              <li v-for="line in sl.qr?.steps" :key="line">{{ line }}</li>
            </ol>
            <div class="flex items-center gap-2 text-caption text-muted-foreground">
              <Spinner class="size-3.5" />
              每 3 秒检查登录状态（{{ slStateText }}）…
            </div>
            <CalloutBanner
              v-if="sl.error || sl.status?.lastError"
              tone="destructive"
              size="sm"
              :description="sl.error || sl.status?.lastError"
            />
          </div>

          <!-- ④ 完成 / 自动接线 -->
          <div v-else class="space-y-3">
            <div v-if="sl.autoDone" class="space-y-3">
              <p class="flex items-center gap-2 text-control text-foreground">
                <Check class="size-4" :stroke-width="3" />
                已连接{{ sl.autoId ? ` @${sl.autoId}` : '' }}，可以聊天了。
              </p>
              <p class="text-label text-muted-foreground">
                已自动写入 OneBot WS 配置并启用 SnowLuma 通道；下方「连接状态」会显示账号与最后事件。
              </p>
            </div>
            <div v-else-if="sl.autoFailed" class="space-y-3">
              <CalloutBanner tone="destructive" title="自动接线失败" size="sm" :description="sl.autoError" />
              <p class="text-label text-muted-foreground">
                可以重试自动配置；或在下方「手动连接」表单填写
                <span class="font-mono text-caption">ws://127.0.0.1:3001</span> 与 token 后保存。
              </p>
              <Button variant="outline" @click="retryAutoconfigure">
                <RefreshCw />
                重试自动配置
              </Button>
            </div>
            <div v-else class="flex items-center gap-2 text-label text-muted-foreground">
              <Spinner class="size-4" />
              正在自动接线（读取 OneBot token 并启用通道）…
            </div>
            <p class="text-caption text-muted-foreground">默认路径：扫码后自动连接；手动表单仅在自动接线失败时使用。</p>
          </div>
        </DialogBody>
        <DialogFooter>
          <template v-if="sl.step === 1">
            <Button variant="outline" @click="closeWizard">取消</Button>
            <Button :disabled="!sl.consent || sl.busy" :loading="sl.busy" @click="startInstall">开始安装</Button>
          </template>
          <template v-else-if="sl.step === 2">
            <Button variant="outline" @click="closeWizard">关闭（后台继续）</Button>
            <Button v-if="slState === 'error'" :loading="sl.busy" @click="startInstall">重试安装</Button>
          </template>
          <template v-else-if="sl.step === 3">
            <Button variant="outline" @click="closeWizard">关闭（稍后继续）</Button>
            <Button :loading="sl.busy" :disabled="!isAdmin" @click="startService">启动 SnowLuma</Button>
          </template>
          <template v-else>
            <Button @click="closeWizard">完成</Button>
          </template>
        </DialogFooter>
      </DialogPanel>
    </Dialog>

    <!-- SnowLuma 容器日志抽屉（安装/启动诊断，admin） -->
    <Sheet v-model:open="sl.logsOpen">
      <SheetContent side="right" class="w-[min(46rem,92vw)] p-0">
        <SheetTitle class="sr-only">SnowLuma 容器日志</SheetTitle>
        <SheetDescription class="sr-only">安装/启动诊断日志（密码与令牌已脱敏）</SheetDescription>
        <div class="flex h-full flex-col">
          <div class="flex min-h-14 items-center justify-between gap-3 border-b border-border px-4 pr-12">
            <div class="text-control font-medium text-foreground">SnowLuma 容器日志（最近 200 行）</div>
            <Button variant="ghost" size="sm" :loading="sl.logsLoading" @click="loadSlLogs">
              <RefreshCw />
              刷新
            </Button>
          </div>
          <div class="min-h-0 flex-1 overflow-auto p-4">
            <p v-if="sl.logsLoading && sl.logs.length === 0" class="flex items-center gap-2 text-label text-muted-foreground">
              <Spinner class="size-4" />
              正在读取日志…
            </p>
            <CodePanel
              v-else-if="sl.logs.length > 0"
              :code="sl.logs.join('\n')"
              width="full"
              copy-label="复制日志"
              copied-label="已复制"
              copy-failed-message="复制失败"
            />
            <p v-else class="text-label text-muted-foreground">暂无日志。</p>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  </PageShell>
</template>
