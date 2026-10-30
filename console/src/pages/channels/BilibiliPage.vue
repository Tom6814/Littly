<script setup lang="ts">
/**
 * Bilibili —— 通过 sidecar 代理接入（console-api 已代理 /api/bili/*）。
 * sidecar 未启动时是「没连上」，不是接口坏了：页面区分 connected / logined / 未连接。
 * 流程：GET /api/bili/status → POST /api/bili/qr/start → 轮询 GET /api/bili/qr/status。
 */
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import {
  Button,
  CalloutBanner,
  PageShell,
  SettingsRow,
  SettingsSection,
  Spinner,
  StatusDot,
  toast,
} from '@felinic/ui'
import { biliApi } from '@/api/endpoints'

const loading = ref(true)
const error = ref('')
const status = reactive({
  connected: false,
  logined: false,
  username: '',
  mid: '',
  hint: '',
})

const qr = reactive({
  sessionId: '',
  dataUrl: '',
  status: '' as string,
  message: '',
  qrUrl: '',
})
const busy = ref(false)
let pollTimer: ReturnType<typeof setInterval> | null = null

onMounted(async () => {
  await loadStatus()
  loading.value = false
})

onBeforeUnmount(() => stopPoll())

function toRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
}

async function loadStatus(): Promise<void> {
  error.value = ''
  try {
    const out = toRecord(await biliApi.status())
    status.connected = out.connected === true
    status.logined = out.logined === true
    status.username = typeof out.username === 'string' ? out.username : ''
    status.mid = typeof out.mid === 'string' ? out.mid : ''
    status.hint = typeof out.hint === 'string' ? out.hint : ''
    if (typeof out.error === 'string') error.value = out.error
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取 Bilibili 状态失败'
  }
}

async function startQr(): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    const out = toRecord(await biliApi.qrStart())
    qr.sessionId = typeof out.sessionId === 'string' ? out.sessionId : ''
    qr.dataUrl = typeof out.qrImage === 'string' ? out.qrImage : ''
    qr.status = typeof out.status === 'string' ? out.status : ''
    qr.message = typeof out.message === 'string' ? out.message : ''
    qr.qrUrl = typeof out.qrUrl === 'string' ? out.qrUrl : ''
    stopPoll()
    if (qr.sessionId) pollTimer = setInterval(() => void pollQr(), 2000)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '启动扫码失败'
  } finally {
    busy.value = false
  }
}

async function pollQr(): Promise<void> {
  if (!qr.sessionId) return
  try {
    const out = toRecord(await biliApi.qrStatus(qr.sessionId))
    qr.status = typeof out.status === 'string' ? out.status : qr.status
    if (typeof out.qrImage === 'string' && out.qrImage !== '') qr.dataUrl = out.qrImage
    qr.message = typeof out.message === 'string' ? out.message : qr.message
    if (qr.status === 'success' || qr.status === 'confirmed' || qr.status === 'logined') {
      stopPoll()
      toast.success('Bilibili 登录成功')
      await loadStatus()
    } else if (qr.status === 'expired' || qr.status === 'failed') {
      stopPoll()
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
</script>

<template>
  <PageShell title="Bilibili" description="通过本地 sidecar 接入 Bilibili（需要 sidecar 正在运行）。">
    <div class="space-y-8">
      <CalloutBanner
        v-if="error"
        :tone="status.connected ? 'destructive' : 'warning'"
        :title="status.connected ? undefined : 'Sidecar 未连接'"
        :description="status.hint || error"
      />
      <div v-if="loading" class="flex items-center gap-2 py-8 text-label text-muted-foreground">
        <Spinner class="size-4" />
        正在读取 Bilibili 状态…
      </div>

      <template v-else>
        <SettingsSection title="登录状态">
          <SettingsRow label="Sidecar" description="本地 sidecar 进程">
            <div class="flex items-center gap-2 text-control text-foreground">
              <StatusDot :status="status.connected ? 'success' : 'error'" />
              {{ status.connected ? '已连接' : '未连接' }}
            </div>
          </SettingsRow>
          <SettingsRow label="Bilibili 账号" description="扫码登录后的账号">
            <div class="flex items-center gap-2 text-control text-foreground">
              <StatusDot :status="status.logined ? 'success' : 'idle'" />
              {{ status.logined ? status.username || status.mid || '已登录' : '未登录' }}
            </div>
          </SettingsRow>
          <template #footer>
            <Button variant="outline" @click="loadStatus">重新读取状态</Button>
          </template>
        </SettingsSection>

        <section class="space-y-2.5">
          <h2 class="px-2 text-label font-medium text-muted-foreground">扫码登录</h2>
          <div class="rounded-menu-shell bg-section-card p-6">
            <div v-if="!qr.dataUrl" class="flex flex-col items-center gap-3 py-4 text-center">
              <p class="text-label text-muted-foreground">
                用 Bilibili App 扫码登录，登录后侧边栏显示账号状态。
              </p>
              <Button :loading="busy" :disabled="!status.connected" @click="startQr">获取登录二维码</Button>
            </div>
            <div v-else class="flex flex-col items-center gap-3">
              <div class="rounded-md bg-card p-3">
                <img :src="qr.dataUrl" alt="Bilibili 登录二维码" class="size-56 object-contain" />
              </div>
              <p class="text-control text-foreground">{{ qr.message || qr.status }}</p>
              <div class="flex items-center gap-2">
                <Button variant="ghost" size="sm" :loading="busy" @click="startQr">刷新二维码</Button>
                <Button v-if="qr.qrUrl" variant="outline" size="sm" as="a" :href="qr.qrUrl" target="_blank">
                  在浏览器打开
                </Button>
              </div>
            </div>
          </div>
        </section>
      </template>
    </div>
  </PageShell>
</template>
