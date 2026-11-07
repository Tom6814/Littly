<script setup lang="ts">
/**
 * 微信 —— iLink 协议接入（后端 routes-wechat.ts 实现中，本页按 SPEC §3 契约对接）：
 *   未绑定：大二维码 + 状态轮询 + 过期自动换码
 *   已绑定：状态卡 + 名片二维码（供好友扫码加她）+ 登出
 *   渠道开关：bot channels.wechat（admin）
 * 后端未就绪时页面给出明确提示，不伪装成空数据。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import {
  Button,
  CalloutBanner,
  ConfirmPopover,
  PageShell,
  SettingsRow,
  SettingsSection,
  Spinner,
  StatusDot,
  Switch,
  toast,
} from '@felinic/ui'
import { Download, QrCode, RefreshCw, Smartphone } from 'lucide-vue-next'
import AccountBindSection from '@/components/AccountBindSection.vue'
import { botsApi, wechatApi } from '@/api/endpoints'
import { ApiError } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useBots } from '@/stores/bots'

const auth = useAuthStore()
const bots = useBots()
const isAdmin = computed(() => auth.state.user?.role === 'admin')

const loading = ref(true)
const unavailable = ref(false)
const error = ref('')

const status = reactive({
  bound: false,
  botId: '',
  ilinkBotId: '',
  ilinkUserId: '',
  nickname: '',
  channelStatus: '',
  windowFresh: false,
  lastInboundAt: 0,
  friendQrDataUrl: '',
  friendQrExpiresAt: '',
  note: '',
})

const qr = reactive({
  sessionId: '',
  dataUrl: '',
  status: 'wait' as string,
  expiresAt: '',
})

const friendQr = ref('')
const friendQrNote = ref('')
const friendQrExpiresAt = ref('')

/* 渠道开关（bot channels.wechat，admin） */
const channelEnabled = ref(false)
const friendDisplayEnabled = ref(false)
const savingChannel = ref(false)

const busy = ref(false)
let pollTimer: ReturnType<typeof setInterval> | null = null

onMounted(async () => {
  await bots.bootstrap()
  await loadStatus()
  await loadChannel()
  loading.value = false
})

onBeforeUnmount(() => stopPoll())

async function loadStatus(): Promise<void> {
  try {
    const out = await wechatApi.status()
    status.bound = out.bound
    status.botId = out.botId ?? ''
    status.ilinkBotId = out.ilinkBotId ?? ''
    status.ilinkUserId = out.ilinkUserId ?? ''
    status.nickname = out.nickname ?? ''
    status.channelStatus = out.status ?? ''
    status.windowFresh = out.windowFresh === true
    status.lastInboundAt = out.lastInboundAt ?? 0
    status.friendQrDataUrl = out.friendQrDataUrl ?? ''
    status.friendQrExpiresAt = out.friendQrExpiresAt ?? ''
    status.note = out.note ?? ''
    unavailable.value = false
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      unavailable.value = true
    } else {
      error.value = e instanceof Error ? e.message : '读取微信状态失败'
    }
  }
}

async function loadChannel(): Promise<void> {
  const botId = bots.state.currentBotId
  if (!botId) return
  try {
    const channels = await botsApi.channels(botId)
    const wechat = (channels.wechat ?? {}) as Record<string, unknown>
    channelEnabled.value = wechat.enabled === true
    friendDisplayEnabled.value = wechat.friendDisplayEnabled === true
  } catch {
    /* admin-only */
  }
}

async function saveChannel(): Promise<void> {
  const botId = bots.state.currentBotId
  if (!botId) return
  savingChannel.value = true
  try {
    await botsApi.saveChannels(botId, {
      wechat: { enabled: channelEnabled.value, friendDisplayEnabled: friendDisplayEnabled.value },
    })
    toast.success('微信渠道配置已保存')
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '保存失败')
  } finally {
    savingChannel.value = false
  }
}

/* ---------------- 绑定二维码 ---------------- */
async function startBind(): Promise<void> {
  error.value = ''
  busy.value = true
  try {
    const session = await wechatApi.qr()
    qr.sessionId = session.sessionId
    qr.dataUrl = session.qrDataUrl
    qr.status = 'wait'
    qr.expiresAt = session.expiresAt ?? ''
    unavailable.value = false
    stopPoll()
    if (session.sessionId) {
      pollTimer = setInterval(() => void pollStatus(session.sessionId), 2000)
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) {
      error.value = '需要管理员权限才能生成绑定二维码。'
    } else if (e instanceof ApiError && e.status === 404) {
      unavailable.value = true
      error.value = '微信后端接口尚未就绪（routes-wechat.ts 实现中），页面已按契约准备好。'
    } else {
      error.value = e instanceof Error ? e.message : '生成二维码失败'
    }
  } finally {
    busy.value = false
  }
}

async function pollStatus(sessionId: string): Promise<void> {
  try {
    const out = await wechatApi.qrStatus(sessionId)
    qr.status = out.status
    // 契约：expired 时响应里已经是刷新后的新码，直接替换 img，无需重新 POST。
    if (out.qrDataUrl) qr.dataUrl = out.qrDataUrl
    if (out.expiresAt) qr.expiresAt = out.expiresAt
    if (out.status === 'confirmed') {
      stopPoll()
      toast.success('微信绑定成功')
      qr.dataUrl = ''
      await loadStatus()
    } else if (out.status === 'failed') {
      stopPoll()
      error.value = out.error ?? '绑定失败，请重新生成二维码'
    } else if (out.status === 'expired') {
      qr.status = 'expired'
    }
  } catch {
    stopPoll()
  }
}

function stopPoll(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

async function cancelBind(): Promise<void> {
  stopPoll()
  qr.sessionId = ''
  qr.dataUrl = ''
  qr.status = 'wait'
}

/* ---------------- 名片二维码 ---------------- */
async function loadFriendQr(): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    const out = await wechatApi.friendQr()
    friendQr.value = out.qrDataUrl
    friendQrNote.value = out.note ?? status.note
    friendQrExpiresAt.value = out.expiresAt ?? ''
  } catch (e) {
    error.value =
      e instanceof ApiError && e.status === 403
        ? '需要管理员权限才能获取名片二维码。'
        : e instanceof Error
          ? e.message
          : '获取名片二维码失败'
  } finally {
    busy.value = false
  }
}

/* ---------------- 登出 ---------------- */
async function logoutWechat(): Promise<void> {
  try {
    await wechatApi.logout()
    status.bound = false
    status.botId = ''
    status.ilinkUserId = ''
    status.nickname = ''
    friendQr.value = ''
    toast.success('已退出微信绑定')
    await loadStatus()
  } catch (e) {
    toast.error(
      e instanceof ApiError && e.status === 403
        ? '需要管理员权限才能退出微信绑定'
        : e instanceof Error
          ? e.message
          : '登出失败',
    )
  }
}

const statusText = computed(() => {
  switch (qr.status) {
    case 'wait':
      return '请用微信扫描二维码'
    case 'scanned':
    case 'scaned':
      return '已扫码，请在手机上确认'
    case 'scaned_but_redirect':
      return '正在切换接入节点…'
    case 'confirmed':
      return '绑定成功'
    case 'expired':
      return '二维码已刷新，请用新码扫码'
    case 'failed':
      return '绑定失败，请重新生成二维码'
    default:
      return qr.status
  }
})

/** 渠道运行状态的中文文案（后端 status 字段）。 */
const channelStatusText = computed(() => {
  switch (status.channelStatus) {
    case 'connected':
      return '已连接，可收发消息'
    case 'connecting':
      return '正在连接…'
    case 'session_expired':
      return '会话已过期，请重新扫码'
    case 'error':
      return '连接异常'
    case 'stopped':
      return '未启动'
    default:
      return status.channelStatus || '未知'
  }
})

/** 最近入站时间的相对表述（避免绝对时间戳读起来像日志）。 */
const lastInboundText = computed(() => {
  if (!status.lastInboundAt) return '还没有收到过消息'
  const minutes = Math.max(0, Math.round((Date.now() - status.lastInboundAt) / 60000))
  if (minutes < 1) return '刚刚有消息'
  if (minutes < 60) return `${minutes} 分钟前有消息`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前有消息`
  return `${Math.round(hours / 24)} 天前有消息`
})
</script>

<template>
  <PageShell title="微信" description="扫码把她的微信接入进来，之后就能在微信里找她。" data-testid="wechat-page">
    <div class="space-y-8">
      <CalloutBanner
        v-if="unavailable"
        tone="warning"
        title="微信后端接口尚未就绪"
        description="routes-wechat.ts 正在实现中。本页已按契约（/api/wechat/*）对接，接口上线即可使用。"
      />
      <CalloutBanner v-if="error" tone="destructive" :description="error" size="sm" />
      <div v-if="loading" class="flex items-center gap-2 py-8 text-label text-muted-foreground">
        <Spinner class="size-4" />
        正在读取微信状态…
      </div>

      <template v-else>
        <!-- 已绑定 -->
        <template v-if="status.bound">
          <SettingsSection title="绑定状态">
            <SettingsRow label="连接状态" :description="lastInboundText">
              <div class="flex items-center gap-2 text-control text-foreground">
                <StatusDot :status="status.channelStatus === 'connected' ? 'success' : status.channelStatus === 'error' ? 'error' : 'idle'" />
                {{ channelStatusText }}
              </div>
            </SettingsRow>
            <SettingsRow
              label="24 小时窗口"
              description="iLink 会话窗口决定她能否主动发消息"
            >
              <span class="text-control text-foreground">{{ status.windowFresh ? '可用' : '已过期（等她先发来消息）' }}</span>
            </SettingsRow>
            <SettingsRow v-if="status.nickname" label="微信昵称" :description="status.nickname" />
            <SettingsRow v-if="status.ilinkBotId || status.botId" label="iLink Bot ID" :description="status.ilinkBotId || status.botId" />
            <SettingsRow v-if="status.ilinkUserId" label="iLink 用户 ID" :description="status.ilinkUserId" />
            <div v-if="status.note" class="mx-4 border-b border-border py-3 text-caption text-muted-foreground">
              {{ status.note }}
            </div>
            <template #footer>
              <ConfirmPopover
                title="退出微信绑定？"
                message="退出后她会从微信下线；之后可以重新扫码绑定。"
                confirm-text="退出绑定"
                cancel-text="取消"
                variant="destructive"
                @confirm="logoutWechat"
              >
                <template #trigger>
                  <Button variant="destructive">退出绑定</Button>
                </template>
              </ConfirmPopover>
            </template>
          </SettingsSection>

          <!-- 名片二维码：让好友扫码加她 -->
          <section class="space-y-2.5">
            <h2 class="px-2 text-label font-medium text-muted-foreground">名片二维码</h2>
            <div class="rounded-menu-shell bg-section-card p-5">
              <div class="flex flex-col items-center gap-3 text-center">
                <div
                  v-if="friendQr || status.friendQrDataUrl"
                  class="rounded-md bg-card p-3"
                >
                  <img
                    :src="friendQr || status.friendQrDataUrl"
                    alt="她的微信名片二维码"
                    class="size-56 object-contain"
                  />
                </div>
                <p class="text-label text-muted-foreground">
                  让好友用微信扫码加她；二维码过期可重新获取。
                </p>
                <p v-if="friendQrNote || status.note" class="max-w-md text-caption text-muted-foreground">
                  {{ friendQrNote || status.note }}
                </p>
                <p v-if="friendQrExpiresAt || status.friendQrExpiresAt" class="text-caption text-muted-foreground">
                  有效期至 {{ friendQrExpiresAt || status.friendQrExpiresAt }}
                </p>
                <div class="flex items-center gap-2">
                  <Button variant="outline" :loading="busy" @click="loadFriendQr">
                    <QrCode />
                    {{ friendQr ? '刷新名片码' : '获取名片码' }}
                  </Button>
                  <Button
                    v-if="friendQr || status.friendQrDataUrl"
                    variant="outline"
                    as="a"
                    :href="friendQr || status.friendQrDataUrl"
                    download="littly-wechat-qr.png"
                  >
                    <Download />
                    保存图片
                  </Button>
                </div>
              </div>
            </div>
          </section>
        </template>

        <!-- 未绑定：绑定向导 -->
        <section v-else class="space-y-2.5">
          <h2 class="px-2 text-label font-medium text-muted-foreground">绑定微信</h2>
          <div class="rounded-menu-shell bg-section-card p-6">
            <div v-if="!qr.dataUrl" class="flex flex-col items-center gap-4 py-6 text-center">
              <div class="flex size-12 items-center justify-center rounded-full bg-accent text-foreground">
                <Smartphone class="size-5" />
              </div>
              <div>
                <p class="text-control font-medium text-foreground">扫码即可把她接进微信</p>
                <p class="mt-1 text-label text-muted-foreground">
                  用手机微信扫一扫，确认后她会出现在你的微信里。
                </p>
              </div>
              <Button :loading="busy" @click="startBind">
                <QrCode />
                生成绑定二维码
              </Button>
            </div>

            <div v-else class="flex flex-col items-center gap-3">
              <div class="rounded-md bg-card p-3">
                <img :src="qr.dataUrl" alt="微信绑定二维码" class="size-64 object-contain" />
              </div>
              <p class="text-control text-foreground">{{ statusText }}</p>
              <p v-if="qr.expiresAt" class="text-caption text-muted-foreground">
                二维码有效期至 {{ qr.expiresAt }}
              </p>
              <div class="flex items-center gap-2">
                <Button variant="ghost" size="sm" :loading="busy" @click="startBind">
                  <RefreshCw />
                  刷新二维码
                </Button>
                <Button variant="ghost" size="sm" @click="cancelBind">取消</Button>
              </div>
            </div>
          </div>
        </section>

        <!-- 账号绑定（扫码是主路径；这里是同一微信身份的「绑定码」补充路径） -->
        <AccountBindSection
          channel="wechat"
          hint="扫码是主路径；也可生成一次性绑定码，把微信里的这个号绑到当前控制台账号：在微信里私聊她发送「绑定 <码>」。"
        />

        <!-- 渠道开关 -->
        <SettingsSection title="微信渠道">
          <SettingsRow label="启用微信" description="关闭后她不会在微信收发消息">
            <Switch v-model="channelEnabled" :disabled="!isAdmin" />
          </SettingsRow>
          <SettingsRow label="展示名片二维码" description="允许把她的名片分享给好友">
            <Switch v-model="friendDisplayEnabled" :disabled="!isAdmin" />
          </SettingsRow>
          <template #footer>
            <Button :loading="savingChannel" :disabled="!isAdmin" @click="saveChannel">保存渠道配置</Button>
          </template>
        </SettingsSection>
      </template>
    </div>
  </PageShell>
</template>
