<script setup lang="ts">
/**
 * X（Twitter）—— 让她使用用户自己的 X 账号。
 * 后端契约（/tmp/x-spec.md §1，后端 @littly/x + routes-x.ts）：
 *   GET  /api/x/status    → {configured, username, loggedInAt, allowWrites, bin, binOk}
 *   POST /api/x/login     (admin) {cookie? | authToken+ct0, proxy?} → status
 *   POST /api/x/logout    (admin) → 清凭据
 *   PUT  /api/x/settings  (admin) {allowWrites?, proxy?}
 *   POST /api/x/probe     → 跑 `twitter status`，{ok, username?, error?}
 *   POST /api/x/cmd       → {argv, dryRun?} 只读预览（写命令默认预演）
 * 接口未就绪（404）时页面整体降级为「等待后端」，不伪装成未登录。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import {
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
  SurfaceCard,
  StatusDot,
  Switch,
  Textarea,
  toast,
} from '@felinic/ui'
import { BadgeCheck, LogOut, RefreshCw, ShieldCheck } from 'lucide-vue-next'
import { xApi, type XStatus } from '@/api/endpoints'
import { ApiError } from '@/api/client'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const isAdmin = computed(() => auth.state.user?.role === 'admin')

const loading = ref(true)
const status = ref<XStatus | null>(null)
const unavailable = ref(false)
const error = ref('')
const probing = ref(false)
const savingLogin = ref(false)
const savingSettings = ref(false)

/* 登录表单：两种凭据输入方式（完整 cookie / auth_token + ct0）。 */
const loginMode = ref<'cookie' | 'token'>('cookie')
const loginForm = reactive({
  cookie: '',
  authToken: '',
  ct0: '',
  proxy: '',
})

/* 设置：写开关 + 代理。 */
const settings = reactive({ allowWrites: false, proxy: '' })

/* 只读预览：feed / search（走 /api/x/cmd，写命令默认预演）。 */
const previewMode = ref<'feed' | 'search'>('feed')
const searchQuery = ref('')
const previewLoading = ref(false)
const previewOutput = ref('')
const previewError = ref('')

onMounted(async () => {
  await loadStatus()
  loading.value = false
})

async function loadStatus(): Promise<void> {
  error.value = ''
  try {
    const out = await xApi.status()
    status.value = out
    unavailable.value = !out.available
    settings.allowWrites = out.allowWrites
    if (out.configured) settings.proxy = settings.proxy || ''
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      unavailable.value = true
      status.value = null
    } else {
      error.value = e instanceof Error ? e.message : '读取 X 状态失败'
    }
  }
}

/* ---------------- 登录 / 登出 ---------------- */
async function submitLogin(): Promise<void> {
  error.value = ''
  const cookie = loginForm.cookie.trim()
  const authToken = loginForm.authToken.trim()
  const ct0 = loginForm.ct0.trim()
  if (loginMode.value === 'cookie' && cookie === '') {
    error.value = '请粘贴浏览器里 X 的完整 cookie'
    return
  }
  if (loginMode.value === 'token' && (authToken === '' || ct0 === '')) {
    error.value = '请同时填写 auth_token 与 ct0'
    return
  }
  savingLogin.value = true
  try {
    const out = await xApi.login({
      ...(loginMode.value === 'cookie' ? { cookie } : { authToken, ct0 }),
      ...(loginForm.proxy.trim() !== '' ? { proxy: loginForm.proxy.trim() } : {}),
    })
    status.value = out
    unavailable.value = !out.available
    loginForm.cookie = ''
    loginForm.authToken = ''
    loginForm.ct0 = ''
    toast.success('凭据已保存，正在验证登录…')
    await probe()
  } catch (e) {
    error.value =
      e instanceof ApiError && e.status === 403
        ? '需要管理员权限才能配置 X 登录。'
        : e instanceof Error
          ? e.message
          : '保存 X 凭据失败'
  } finally {
    savingLogin.value = false
  }
}

async function probe(): Promise<void> {
  probing.value = true
  try {
    const out = await xApi.probe()
    if (out.ok) {
      toast.success(`登录有效${out.username ? `：@${out.username}` : ''}`)
    } else {
      toast.error(out.error ?? '验证失败：凭据可能已过期')
    }
    await loadStatus()
  } catch (e) {
    toast.error(
      e instanceof ApiError && e.status === 404 ? 'X 后端接口尚未就绪' : e instanceof Error ? e.message : '验证失败',
    )
  } finally {
    probing.value = false
  }
}

async function logout(): Promise<void> {
  try {
    await xApi.logout()
    toast.success('已退出 X 登录（本机凭据已清除）')
    loginForm.cookie = ''
    loginForm.authToken = ''
    loginForm.ct0 = ''
    await loadStatus()
  } catch (e) {
    toast.error(e instanceof Error ? e.message : '退出失败')
  }
}

/* ---------------- 设置（写开关 / 代理） ---------------- */
async function saveSettings(): Promise<void> {
  savingSettings.value = true
  try {
    await xApi.saveSettings({
      allowWrites: settings.allowWrites,
      ...(settings.proxy.trim() !== '' ? { proxy: settings.proxy.trim() } : {}),
    })
    toast.success('X 设置已保存')
    await loadStatus()
  } catch (e) {
    toast.error(
      e instanceof ApiError && e.status === 403 ? '需要管理员权限才能修改 X 设置' : '保存失败',
    )
  } finally {
    savingSettings.value = false
  }
}

/* ---------------- 只读预览 ---------------- */
async function loadPreview(): Promise<void> {
  previewLoading.value = true
  previewError.value = ''
  previewOutput.value = ''
  try {
    const argv =
      previewMode.value === 'search'
        ? searchQuery.value.trim() === ''
          ? null
          : ['search', searchQuery.value.trim()]
        : ['feed']
    if (argv === null) {
      previewError.value = '先输入搜索关键词'
      return
    }
    const out = await xApi.cmd(argv)
    if (!out.ok) {
      previewError.value = out.error ?? '读取失败'
      return
    }
    previewOutput.value = out.output
  } catch (e) {
    previewError.value = e instanceof Error ? e.message : '读取失败'
  } finally {
    previewLoading.value = false
  }
}

/* ---------------- 外部展示 ---------------- */
const loggedIn = computed(() => status.value?.configured === true)
const statusDot = computed<'success' | 'warning' | 'idle'>(() => {
  if (!status.value?.available) return 'idle'
  if (status.value.configured) return 'success'
  return 'warning'
})
const statusText = computed(() => {
  if (!status.value) return '未就绪'
  if (!status.value.available) return '接口未就绪'
  if (status.value.configured) {
    return status.value.username ? `已登录 @${status.value.username}` : '凭据已保存（待验证）'
  }
  return '未配置'
})
</script>

<template>
  <PageShell title="X" description="让她用你的 X 账号浏览、搜索与发帖。">
    <template #actions>
      <Button variant="outline" :disabled="probing || unavailable" @click="probe">
        <Spinner v-if="probing" class="size-4" />
        <BadgeCheck v-else />
        验证登录
      </Button>
    </template>

    <div class="space-y-8">
      <CalloutBanner
        v-if="unavailable"
        tone="warning"
        title="X 后端接口尚未就绪"
        description="服务端的 @littly/x 插件与 /api/x/* 正在实现中。本页已按契约对接，接口上线后无需改前端。"
      />
      <CalloutBanner v-if="error" tone="destructive" :description="error" size="sm" />
      <div v-if="loading" class="flex items-center gap-2 py-8 text-label text-muted-foreground">
        <Spinner class="size-4" />
        正在读取 X 状态…
      </div>

      <template v-else>
        <!-- 状态卡 -->
        <SettingsSection title="账号">
          <SettingsRow label="状态" description="登录凭据保存在后端 global_settings，不回传前端">
            <div class="flex items-center gap-2 text-control text-foreground">
              <StatusDot :status="statusDot" />
              {{ statusText }}
            </div>
          </SettingsRow>
          <SettingsRow
            label="twitter-cli"
            description="服务端调用 twitter-cli 执行读写命令"
          >
            <div class="flex items-center gap-2 text-control text-foreground">
              <StatusDot :status="status?.binOk ? 'success' : 'warning'" />
              {{ status?.binOk ? '就绪' : '未就绪' }}
              <span v-if="status?.bin" class="text-caption text-muted-foreground">{{ status.bin }}</span>
            </div>
          </SettingsRow>
          <SettingsRow v-if="status?.loggedInAt" label="最近登录" :description="status.loggedInAt" />
          <SettingsRow label="写操作" description="关闭后，她的发帖/点赞/关注等写命令只会预演，不会真正执行">
            <Switch v-model="settings.allowWrites" :disabled="!isAdmin || unavailable" />
          </SettingsRow>
          <SettingsRow label="代理" description="可选，例如 http://127.0.0.1:7890" stack="sm">
            <Input v-model="settings.proxy" placeholder="http://…（可留空）" :disabled="!isAdmin || unavailable" />
          </SettingsRow>
          <template #footer>
            <Button :loading="savingSettings" :disabled="!isAdmin || unavailable" @click="saveSettings">
              保存设置
            </Button>
            <ConfirmPopover
              title="退出 X 登录？"
              message="会清除服务端保存的 X 凭据，她之后无法再操作 X。"
              confirm-text="退出登录"
              cancel-text="取消"
              variant="destructive"
              @confirm="logout"
            >
              <template #trigger>
                <Button variant="destructive" :disabled="!isAdmin || !loggedIn || unavailable">
                  <LogOut />
                  退出登录
                </Button>
              </template>
            </ConfirmPopover>
          </template>
        </SettingsSection>

        <CalloutBanner
          v-if="!isAdmin"
          tone="neutral"
          title="只读模式"
          description="登录配置、写开关与登出需要管理员账号；当前账号可以查看状态与只读预览。"
        />

        <!-- 登录配置（admin） -->
        <SettingsSection title="登录">
          <SettingsRow
            label="凭据方式"
            description="推荐粘贴浏览器里 X 的完整 cookie；也可以只填 auth_token + ct0"
            stack="sm"
          >
            <SegmentedControl
              :model-value="loginMode"
              :items="[
                { value: 'cookie', label: '完整 cookie' },
                { value: 'token', label: 'auth_token + ct0' },
              ]"
              aria-label="X 凭据方式"
              @update:model-value="(v: string | number) => (loginMode = v as 'cookie' | 'token')"
            />
          </SettingsRow>
          <template v-if="loginMode === 'cookie'">
            <SettingsRow
              label="Cookie"
              description="浏览器开发者工具 → Network → 任意 x.com 请求 → 复制整串 Cookie；会自动提取 auth_token 与 ct0"
              stack="always"
            >
              <Textarea
                id="x-cookie"
                v-model="loginForm.cookie"
                :rows="3"
                placeholder="auth_token=…; ct0=…; …"
                :disabled="!isAdmin || unavailable"
              />
            </SettingsRow>
          </template>
          <template v-else>
            <SettingsRow label="auth_token" description="从浏览器 cookie 的 auth_token 字段复制" stack="sm">
              <Input v-model="loginForm.authToken" type="password" placeholder="auth_token" :disabled="!isAdmin || unavailable" />
            </SettingsRow>
            <SettingsRow label="ct0" description="从浏览器 cookie 的 ct0 字段复制" stack="sm">
              <Input v-model="loginForm.ct0" type="password" placeholder="ct0" :disabled="!isAdmin || unavailable" />
            </SettingsRow>
          </template>
          <SettingsRow label="代理（可选）" description="该凭据单独使用的代理" stack="sm">
            <Input v-model="loginForm.proxy" placeholder="http://127.0.0.1:7890" :disabled="!isAdmin || unavailable" />
          </SettingsRow>
          <template #footer>
            <Button
              variant="outline"
              :disabled="!isAdmin || unavailable"
              :loading="savingLogin"
              @click="submitLogin"
            >
              <ShieldCheck />
              保存并验证
            </Button>
          </template>
        </SettingsSection>

        <!-- 只读预览 -->
        <SettingsSection title="只读预览">
          <SettingsRow
            label="查看方式"
            description="通过 /api/x/cmd 读取；任何写命令都会以后端开关为准做预演"
            stack="sm"
          >
            <SegmentedControl
              :model-value="previewMode"
              :items="[
                { value: 'feed', label: '最近 feed' },
                { value: 'search', label: '搜索' },
              ]"
              aria-label="X 预览方式"
              @update:model-value="(v: string | number) => (previewMode = v as 'feed' | 'search')"
            />
          </SettingsRow>
          <SettingsRow v-if="previewMode === 'search'" label="搜索关键词" stack="sm">
            <div class="flex w-full items-center gap-2">
              <Input v-model="searchQuery" placeholder="例如：littly" class="flex-1" @keydown.enter="loadPreview" />
              <Button variant="outline" :loading="previewLoading" :disabled="unavailable" @click="loadPreview">
                查询
              </Button>
            </div>
          </SettingsRow>
          <template #actions>
            <Button variant="ghost" size="sm" :loading="previewLoading" :disabled="unavailable" @click="loadPreview">
              <RefreshCw />
              刷新
            </Button>
          </template>
        </SettingsSection>

        <!-- 预览结果：独立的表面（不是设置行，不塞进 section footer） -->
        <SurfaceCard padding="lg">
          <div class="mb-2 flex items-center justify-between gap-3">
            <h2 class="text-label font-medium text-muted-foreground">预览结果</h2>
          </div>
          <CalloutBanner v-if="previewError" tone="destructive" :description="previewError" size="sm" />
          <p v-else-if="!previewOutput" class="text-label text-muted-foreground">
            还没有预览内容。点「刷新」查看最近 feed，或切到搜索输入关键词。
          </p>
          <CodePanel
            v-else
            :code="previewOutput"
            width="full"
            copy-label="复制结果"
            copied-label="已复制"
            copy-failed-message="复制失败"
            class="max-h-80 overflow-y-auto"
          />
        </SurfaceCard>
      </template>
    </div>
  </PageShell>
</template>
