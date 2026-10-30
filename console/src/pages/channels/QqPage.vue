<script setup lang="ts">
/**
 * QQ —— 双通道：SnowLuma（OneBot v11，推荐）+ 官方 QQBot。
 * 后端契约（/tmp/qq-spec2.md §1.3，@littly/channel-qq 基于 dsh-lane-bridge）：
 *   GET  /api/qq/status（required）→ {snowluma:{enabled,connected,selfId?,lastError?,lastEventAt?}, qqbot:{…}}
 *   PUT  /api/qq/snowluma（admin）{enabled, wsUrl?, token?}
 *   PUT  /api/qq/qqbot（admin）{enabled, appId, appSecret?}   ← secret 空 = 不修改
 *   POST /api/qq/probe（required）{kind:'snowluma'|'qqbot'}
 *   GET  /api/qq/logs?tail=N（admin，后端脱敏）
 * SnowLuma 由用户自行安装运行（非商业自托管）：本页只做连接/状态，不代装、不代启、不做扫码。
 * 接口未就绪（404）时整页静默降级为「等待后端」，不伪装成未启用。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import {
  Badge,
  Button,
  CalloutBanner,
  CodePanel,
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
import { RefreshCw, ScrollText, Wifi } from 'lucide-vue-next'
import AccountBindSection from '@/components/AccountBindSection.vue'
import { qqApi, type QqStatus } from '@/api/endpoints'
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
    if (document.visibilityState === 'visible') void loadStatus(true)
  }, 8000)
})

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
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
  </PageShell>
</template>
