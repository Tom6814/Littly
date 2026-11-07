<script setup lang="ts">
/**
 * Bilibili —— 基于 bilibili-cli 的智能认证与预览（/tmp/bili-spec.md §2）。
 * 后端契约（console-api routes-bili.ts，channels-voice 并行实现）：
 *   GET  /api/bili/status               → 登录状态 + 账号（未登录不报错）
 *   POST /api/bili/qr/start             → {sessionId, qrDataUrl(PNG), link, expiresInMs}
 *   GET  /api/bili/qr/status?sessionId= → wait | scaned | confirmed | expired
 *   POST /api/bili/extract-cookie       (admin) → 从运行本服务的机器浏览器提取 Cookie
 *   POST /api/bili/logout               (admin)
 *   POST /api/bili/cmd                  → {argv, dryRun?} 预览（写命令受开关限制）
 * 未就绪（404/501）时整页静默降级为「等待后端」，不伪装成未登录。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  Button,
  CalloutBanner,
  CodePanel,
  ConfirmPopover,
  Input,
  PageShell,
  SegmentedControl,
  SettingsRow,
  SettingsSection,
  Spinner,
  StatusDot,
  SurfaceCard,
  Switch,
  toast,
} from '@felinic/ui'
import { Bell, ExternalLink, KeyRound, QrCode, RefreshCw, Search, UserRound } from 'lucide-vue-next'
import { biliApi, type BiliStatus } from '@/api/endpoints'
import { ApiError } from '@/api/client'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const isAdmin = computed(() => auth.state.user?.role === 'admin')

const loading = ref(true)
const unavailable = ref(false)
const error = ref('')
const status = ref<BiliStatus | null>(null)

/* ---------------- 扫码登录 ---------------- */
const qr = reactive({
  open: false,
  sessionId: '',
  dataUrl: '',
  link: '',
  status: '' as string,
  message: '',
  starting: false,
  /** 过期自动刷新次数（防御后端异常时无限循环）。 */
  autoRefreshes: 0,
})
let qrTimer: ReturnType<typeof setInterval> | null = null
/** 扫码面板：打开后滚动到可见区域（面板块在页面下半部分）。 */
const qrPanel = ref<HTMLElement | null>(null)

/* ---------------- 浏览器 Cookie / 登出 / 写开关 ---------------- */
const extracting = ref(false)
const writeAllowed = ref(false)
const writeSaving = ref(false)
const writeApiAvailable = ref(true)

/* ---------------- 预览 ---------------- */
const preview = reactive({
  mode: 'detail' as 'detail' | 'hot' | 'rank' | 'search',
  bv: '',
  query: '',
  running: false,
  output: '',
  error: '',
})

onMounted(async () => {
  await loadStatus()
  loading.value = false
})

onBeforeUnmount(() => stopQrPoll())

/* ---------------- 状态 ---------------- */
async function loadStatus(): Promise<void> {
  error.value = ''
  try {
    const out = await biliApi.status()
    status.value = out
    unavailable.value = !out.available
    if (out.allowWrites !== undefined) writeAllowed.value = out.allowWrites
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      unavailable.value = true
      status.value = null
    } else {
      error.value = e instanceof Error ? e.message : '读取 Bilibili 状态失败'
    }
  }
}

const authenticated = computed(() => status.value?.authenticated === true)
const accountLabel = computed(() => {
  const s = status.value
  if (!s) return '未就绪'
  if (!s.available) return '接口未就绪'
  if (!s.authenticated) return '未登录'
  return s.username || (s.mid ? `UID ${s.mid}` : '已登录')
})
const avatarInitial = computed(() => (status.value?.username || 'B').slice(0, 1).toUpperCase())
const levelLabel = computed(() => {
  const level = status.value?.level ?? ''
  if (level === '') return '—'
  return /^\d+$/.test(level) ? `Lv.${level}` : level
})
const lastLoginLabel = computed(() => relativeTime(status.value?.lastLoginAt ?? ''))

function relativeTime(iso: string): string {
  if (iso === '') return '—'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  const minutes = Math.max(0, Math.round((Date.now() - t) / 60000))
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

/* ---------------- 扫码登录（2s 轮询四态，过期自动刷新） ---------------- */
async function startQr(auto = false): Promise<void> {
  qr.starting = true
  qr.open = true
  error.value = ''
  try {
    const out = await biliApi.qrStart()
    if (!out.available) {
      unavailable.value = true
      qr.open = false
      toast.error('Bilibili 后端接口尚未就绪')
      return
    }
    qr.sessionId = out.sessionId
    qr.dataUrl = out.qrDataUrl
    qr.link = out.link
    qr.status = 'wait'
    qr.message = '请用 Bilibili App 扫码'
    qr.autoRefreshes = auto ? qr.autoRefreshes : 0
    stopQrPoll()
    if (qr.sessionId !== '') qrTimer = setInterval(() => void pollQr(), 2000)
    await nextTick()
    qrPanel.value?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  } catch (e) {
    error.value = e instanceof Error ? e.message : '获取二维码失败'
  } finally {
    qr.starting = false
  }
}

async function pollQr(): Promise<void> {
  if (qr.sessionId === '') return
  try {
    const out = await biliApi.qrPoll(qr.sessionId)
    if (!out.available) return
    qr.status = out.status
    if (out.status === 'wait') {
      qr.message = '请用 Bilibili App 扫码'
    } else if (out.status === 'scaned' || out.status === 'scanned') {
      qr.message = '已扫码，请在手机上确认登录'
    } else if (out.status === 'confirmed' || out.status === 'success' || out.status === 'logined') {
      qr.message = out.username ? `登录成功：${out.username}` : '登录成功'
      stopQrPoll()
      toast.success(qr.message)
      await loadStatus()
      window.setTimeout(() => {
        qr.open = false
        qr.dataUrl = ''
      }, 1200)
    } else if (out.status === 'expired') {
      qr.message = '二维码已过期，正在自动刷新…'
      stopQrPoll()
      if (qr.autoRefreshes < 3) {
        qr.autoRefreshes += 1
        await startQr(true)
      } else {
        qr.status = 'expired'
        qr.message = '二维码多次过期，请手动点击「刷新二维码」'
      }
    } else if (out.status === 'failed' || out.status === 'error') {
      qr.message = out.message || '扫码失败，请重试'
      stopQrPoll()
    } else if (out.message !== '') {
      qr.message = out.message
    }
  } catch {
    stopQrPoll()
  }
}

function stopQrPoll(): void {
  if (qrTimer) {
    clearInterval(qrTimer)
    qrTimer = null
  }
}

function closeQr(): void {
  stopQrPoll()
  qr.open = false
  qr.dataUrl = ''
  qr.sessionId = ''
  qr.status = ''
  qr.message = ''
}

const qrBadge = computed(() => {
  switch (qr.status) {
    case 'confirmed':
    case 'success':
    case 'logined':
      return { label: '登录成功', variant: 'success' as const }
    case 'scaned':
    case 'scanned':
      return { label: '已扫码待确认', variant: 'info' as const }
    case 'expired':
      return { label: '已过期', variant: 'warning' as const }
    case 'failed':
    case 'error':
      return { label: '失败', variant: 'destructive' as const }
    default:
      return { label: '等待扫码', variant: 'outline' as const }
  }
})

/* ---------------- 浏览器 Cookie 提取 ---------------- */
async function extractCookie(): Promise<void> {
  extracting.value = true
  error.value = ''
  try {
    const out = await biliApi.extractCookie()
    if (!out.available) {
      toast.error('Bilibili 后端接口尚未就绪')
      return
    }
    status.value = out
    unavailable.value = !out.available
    if (out.authenticated) toast.success(`已从本机浏览器提取 Cookie${out.username ? `：${out.username}` : ''}`)
    else toast.error('未能在本机浏览器中找到有效登录（请先在浏览器登录 B 站，或改用扫码登录）')
    await loadStatus()
  } catch (e) {
    toast.error(
      e instanceof ApiError && e.status === 403
        ? '需要管理员权限才能提取浏览器 Cookie'
        : e instanceof Error
          ? e.message
          : '提取失败',
    )
  } finally {
    extracting.value = false
  }
}

/* ---------------- 登出 ---------------- */
async function logout(): Promise<void> {
  try {
    await biliApi.logout()
    toast.success('已退出 Bilibili 登录')
    qr.open = false
    await loadStatus()
  } catch (e) {
    toast.error(
      e instanceof ApiError && e.status === 403
        ? '需要管理员权限才能登出'
        : e instanceof Error
          ? e.message
          : '登出失败',
    )
  }
}

/* ---------------- 写开关 ---------------- */
async function saveWriteSwitch(value: boolean | 'indeterminate'): Promise<void> {
  const next = value === true
  writeSaving.value = true
  try {
    const out = await biliApi.saveSettings(next)
    if (!out.available) {
      writeApiAvailable.value = false
      writeAllowed.value = !next
      toast.error('后端未提供写操作开关接口，切换暂不生效')
      return
    }
    writeAllowed.value = next
    toast.success(next ? '已允许写操作（点赞/投币/三连等会真实执行）' : '已关闭写操作（写命令只会预演）')
  } catch (e) {
    writeAllowed.value = !next
    toast.error(
      e instanceof ApiError && e.status === 403
        ? '需要管理员权限才能修改写开关'
        : e instanceof Error
          ? e.message
          : '保存失败',
    )
  } finally {
    writeSaving.value = false
  }
}

/* ---------------- 预览 ---------------- */
function previewArgv(): string[] | null {
  switch (preview.mode) {
    case 'detail':
      return preview.bv.trim() === '' ? null : ['video', preview.bv.trim()]
    case 'hot':
      return ['hot', '--max', '10']
    case 'rank':
      return ['rank', '--max', '10']
    case 'search':
      return preview.query.trim() === '' ? null : ['search', preview.query.trim(), '--max', '10']
    default:
      return null
  }
}

async function runPreview(): Promise<void> {
  const argv = previewArgv()
  if (argv === null) {
    preview.error = preview.mode === 'detail' ? '先输入 BV 号（例如 BV1xx411c7mD）' : '先输入搜索关键词'
    return
  }
  preview.running = true
  preview.error = ''
  preview.output = ''
  try {
    const out = await biliApi.cmd(argv)
    if (!out.ok) {
      preview.error = out.error || '读取失败'
      return
    }
    preview.output = out.output
  } catch (e) {
    preview.error =
      e instanceof ApiError && e.status === 404
        ? 'Bilibili 预览接口尚未就绪'
        : e instanceof Error
          ? e.message
          : '读取失败'
  } finally {
    preview.running = false
  }
}
</script>

<template>
  <PageShell title="Bilibili" description="扫码登录或自动提取本机浏览器 Cookie，让她能用你的 B 站账号。">
    <template #actions>
      <Badge :variant="unavailable ? 'warning' : authenticated ? 'success' : 'outline'">
        {{ unavailable ? '接口未就绪' : authenticated ? '已登录' : '未登录' }}
      </Badge>
      <Button variant="outline" :loading="extracting" :disabled="unavailable" @click="startQr()">
        <QrCode />
        扫码登录
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="刷新状态" :disabled="unavailable" @click="loadStatus()">
        <RefreshCw />
      </Button>
    </template>

    <div class="space-y-8">
      <CalloutBanner
        v-if="unavailable"
        tone="warning"
        title="Bilibili 后端接口尚未就绪"
        description="服务端的 bilibili-cli 重写与 /api/bili/* 正在实现中。本页已按契约对接，接口上线后无需改前端。"
      />
      <CalloutBanner v-if="error" tone="destructive" :description="error" size="sm" />
      <CalloutBanner
        v-if="!isAdmin"
        tone="neutral"
        title="只读模式"
        description="扫码登录与预览可用；提取浏览器 Cookie、登出与写开关需要管理员账号。"
      />
      <div v-if="loading" class="flex items-center gap-2 py-8 text-label text-muted-foreground">
        <Spinner class="size-4" />
        正在读取 Bilibili 状态…
      </div>

      <template v-else>
        <!-- 状态卡 -->
        <SettingsSection title="账号">
          <SettingsRow label="登录状态" description="bilibili-cli 的凭证状态">
            <div class="flex items-center gap-2 text-control text-foreground">
              <StatusDot :status="authenticated ? 'success' : unavailable ? 'warning' : 'idle'" />
              {{ accountLabel }}
            </div>
          </SettingsRow>
          <SettingsRow label="账号" description="扫码或提取 Cookie 后显示">
            <div class="flex items-center gap-2">
              <Avatar>
                <AvatarImage v-if="status?.avatarUrl" :src="status.avatarUrl" :alt="accountLabel" />
                <AvatarFallback class="bg-muted-soft text-caption text-muted-foreground">
                  {{ avatarInitial }}
                </AvatarFallback>
              </Avatar>
              <div class="flex flex-col">
                <span class="text-control text-foreground">
                  {{ authenticated ? status?.username || '已登录' : '—' }}
                </span>
                <span v-if="status?.mid" class="text-caption text-muted-foreground">UID {{ status.mid }}</span>
              </div>
            </div>
          </SettingsRow>
          <SettingsRow label="等级 / 会员">
            <div class="flex items-center gap-2">
              <span class="text-control text-foreground">{{ levelLabel }}</span>
              <Badge v-if="status?.vip" variant="warning" size="sm">{{ status.vip }}</Badge>
            </div>
          </SettingsRow>
          <SettingsRow label="最近登录" description="最近一次登录记录（后端提供时显示）">
            <span class="text-control text-foreground">{{ lastLoginLabel }}</span>
          </SettingsRow>
          <div v-if="status?.hint" class="mx-4 border-b border-border py-3 text-caption text-muted-foreground">
            {{ status.hint }}
          </div>
          <div v-if="status?.lastError" class="mx-4 border-b border-border py-3 text-caption text-destructive">
            {{ status.lastError }}
          </div>
          <template #footer>
            <ConfirmPopover
              title="退出 Bilibili 登录？"
              message="会清除 bilibili-cli 保存的凭证，她之后无法再使用你的 B 站账号。"
              confirm-text="退出登录"
              cancel-text="取消"
              variant="destructive"
              @confirm="logout"
            >
              <template #trigger>
                <Button variant="destructive" :disabled="!isAdmin || !authenticated || unavailable">
                  <UserRound />
                  退出登录
                </Button>
              </template>
            </ConfirmPopover>
          </template>
        </SettingsSection>

        <!-- 认证方式 -->
        <SettingsSection title="登录方式">
          <SettingsRow
            label="扫码登录"
            description="用 Bilibili App 扫码；二维码过期会自动刷新（2s 轮询）"
          >
            <Button variant="outline" :disabled="unavailable" @click="startQr()">
              <QrCode />
              {{ qr.open ? '刷新二维码' : '获取登录二维码' }}
            </Button>
          </SettingsRow>
          <SettingsRow
            label="自动提取浏览器 Cookie"
            description="在运行本服务的机器上有效（读取该机器浏览器已登录的 B 站 Cookie）"
          >
            <Button :disabled="!isAdmin || unavailable" :loading="extracting" @click="extractCookie">
              <KeyRound />
              提取 Cookie
            </Button>
          </SettingsRow>
          <SettingsRow label="写操作" description="默认关闭；关闭时点赞/投币/三连等写命令只会预演">
            <div class="flex items-center gap-2">
              <Switch
                :model-value="writeAllowed"
                :disabled="!isAdmin || unavailable || writeSaving"
                @update:model-value="saveWriteSwitch"
              />
              <span class="text-caption text-muted-foreground">{{ writeAllowed ? '已允许' : '已关闭' }}</span>
            </div>
          </SettingsRow>
          <div v-if="!writeApiAvailable" class="px-4 py-3 text-caption text-muted-foreground">
            后端未提供写操作开关接口（契约 §1.3 未列）；当前开关仅界面态，无法持久化。
          </div>
        </SettingsSection>

        <!-- 扫码面板 -->
        <section v-if="qr.open" ref="qrPanel" class="space-y-2.5">
          <div class="flex items-center justify-between px-2">
            <h2 class="text-label font-medium text-muted-foreground">扫码登录</h2>
            <div class="flex items-center gap-2">
              <Badge :variant="qrBadge.variant">{{ qrBadge.label }}</Badge>
              <Button variant="ghost" size="sm" @click="closeQr">收起</Button>
            </div>
          </div>
          <SurfaceCard padding="lg" class="flex flex-col items-center gap-3">
            <div v-if="qr.dataUrl" class="rounded-md border border-border bg-card p-3">
              <img :src="qr.dataUrl" alt="Bilibili 登录二维码" class="size-56 object-contain" />
            </div>
            <p v-else class="flex items-center gap-2 py-4 text-label text-muted-foreground">
              <Spinner class="size-4" />
              正在获取二维码…
            </p>
            <p class="text-control text-foreground">{{ qr.message }}</p>
            <div class="flex items-center gap-2">
              <Button variant="ghost" size="sm" :loading="qr.starting" @click="startQr()">
                <RefreshCw />
                刷新二维码
              </Button>
              <Button v-if="qr.link" variant="outline" size="sm" as="a" :href="qr.link" target="_blank">
                <ExternalLink />
                在浏览器打开
              </Button>
            </div>
          </SurfaceCard>
        </section>

        <!-- 只读预览 -->
        <SettingsSection title="预览">
          <SettingsRow label="类型" description="通过 /api/bili/cmd 读取；写命令受上方开关限制" stack="sm">
            <SegmentedControl
              :model-value="preview.mode"
              :items="[
                { value: 'detail', label: '视频详情' },
                { value: 'hot', label: '热门' },
                { value: 'rank', label: '排行' },
                { value: 'search', label: '搜索' },
              ]"
              aria-label="Bilibili 预览类型"
              @update:model-value="(v: string | number) => (preview.mode = v as typeof preview.mode)"
            />
          </SettingsRow>
          <SettingsRow v-if="preview.mode === 'detail'" label="BV 号" stack="sm">
            <div class="flex w-full items-center gap-2">
              <Input v-model="preview.bv" placeholder="例如 BV1xx411c7mD" class="flex-1" @keydown.enter="runPreview" />
              <Button variant="outline" :loading="preview.running" :disabled="unavailable" @click="runPreview">
                <Search />
                查询
              </Button>
            </div>
          </SettingsRow>
          <SettingsRow v-if="preview.mode === 'search'" label="关键词" stack="sm">
            <div class="flex w-full items-center gap-2">
              <Input v-model="preview.query" placeholder="例如 猫猫" class="flex-1" @keydown.enter="runPreview" />
              <Button variant="outline" :loading="preview.running" :disabled="unavailable" @click="runPreview">
                <Search />
                搜索
              </Button>
            </div>
          </SettingsRow>
          <template v-if="preview.mode === 'hot' || preview.mode === 'rank'" #actions>
            <Button variant="ghost" size="sm" :loading="preview.running" :disabled="unavailable" @click="runPreview">
              <Bell />
              读取{{ preview.mode === 'hot' ? '热门' : '排行' }}
            </Button>
          </template>
        </SettingsSection>

        <SurfaceCard padding="lg" class="space-y-2">
          <h2 class="text-label font-medium text-muted-foreground">预览结果</h2>
          <CalloutBanner v-if="preview.error" tone="destructive" size="sm" :description="preview.error" />
          <p v-else-if="!preview.output" class="text-label text-muted-foreground">
            选择类型后点查询/读取；结果以 JSON 展示（CodePanel 可复制）。
          </p>
          <CodePanel
            v-else
            :code="preview.output"
            width="full"
            copy-label="复制结果"
            copied-label="已复制"
            copy-failed-message="复制失败"
            class="max-h-96 overflow-y-auto"
          />
        </SurfaceCard>
      </template>
    </div>
  </PageShell>
</template>
