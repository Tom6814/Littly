<script setup lang="ts">
/**
 * 邮箱 —— 给她绑定一个邮箱，用 IMAP/SMTP 收发、阅读与整理邮件。
 * 后端契约（/tmp/mail-spec.md §1.2，routes-mail.ts / @littly/mail）：
 *   GET    /api/mail/status       required → {configured,address,fromName,imap{host,port,secure,hasPassword},smtp{...},allowWrite,verifiedAt?,lastError?}
 *   PUT    /api/mail/account      admin → 绑定/更新（password 空=不修改）
 *   POST   /api/mail/test         admin → {ok, imap, smtp, error?}
 *   POST   /api/mail/cmd          required → {command, params?, dryRun?}（读放行、写默认预演）
 *   PUT    /api/mail/settings     admin → {allowWrite}
 *   DELETE /api/mail/account      admin（二次确认）→ 清空凭据
 * 未就绪（404/501）静默降级；密码/授权码永不回显。
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
  SettingsRow,
  SettingsSection,
  Spinner,
  StatusDot,
  SurfaceCard,
  Switch,
  toast,
} from '@felinic/ui'
import { Inbox, Mail, Paperclip, RefreshCw, Search, Send } from 'lucide-vue-next'
import {
  mailApi,
  mailBodyFrom,
  mailMessagesFrom,
  type MailMessage,
  type MailMessageBody,
  type MailStatus,
  type MailTestResult,
} from '@/api/endpoints'
import { ApiError } from '@/api/client'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const isAdmin = computed(() => auth.state.user?.role === 'admin')

const loading = ref(true)
const unavailable = ref(false)
const error = ref('')
const status = ref<MailStatus | null>(null)

/* 绑定表单（已绑定时用于更新；password 空 = 不修改） */
const form = reactive({
  address: '',
  fromName: '',
  username: '',
  password: '',
  imapHost: '',
  imapPort: 993,
  imapSecure: true,
  smtpHost: '',
  smtpPort: 465,
  smtpSecure: true,
})
const savingAccount = ref(false)
const bindError = ref('')

/* 连接测试 */
const testing = ref(false)
const testResult = ref<MailTestResult | null>(null)

/* 写开关 */
const writeAllowed = ref(false)
const writeSaving = ref(false)

/* 收件箱 */
const messages = ref<MailMessage[]>([])
const inboxLoading = ref(false)
const inboxError = ref('')
const query = ref('')
const searching = ref(false)

/* 读信弹窗 */
const readDialog = reactive({ open: false, loading: false, body: null as MailMessageBody | null, error: '' })

/* 发测试邮件结果 */
const sendDialog = reactive({ open: false, loading: false, dryRun: false, message: '', error: '', preview: '' })
const sending = ref(false)

onMounted(async () => {
  await loadStatus()
  loading.value = false
})

async function loadStatus(): Promise<void> {
  error.value = ''
  try {
    const out = await mailApi.status()
    status.value = out
    unavailable.value = !out.available
    if (!out.available) return
    writeAllowed.value = out.allowWrite
    if (out.configured) {
      form.address = out.address
      form.fromName = out.fromName
      form.imapHost = out.imap.host
      form.imapPort = out.imap.port || 993
      form.imapSecure = out.imap.secure
      form.smtpHost = out.smtp.host
      form.smtpPort = out.smtp.port || 465
      form.smtpSecure = out.smtp.secure
      form.username = form.username || ''
      await loadInbox()
    }
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 501)) {
      unavailable.value = true
      status.value = null
    } else {
      error.value = e instanceof Error ? e.message : '读取邮箱状态失败'
    }
  }
}

const configured = computed(() => status.value?.configured === true)

/* ---------------- 绑定 / 保存 ---------------- */
function validateForm(): string {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.address.trim())) return '发件地址格式不正确'
  if (form.imapHost.trim() === '') return '请填写 IMAP 服务器地址'
  if (form.smtpHost.trim() === '') return '请填写 SMTP 服务器地址'
  if (!Number.isFinite(form.imapPort) || form.imapPort <= 0) return 'IMAP 端口不合法'
  if (!Number.isFinite(form.smtpPort) || form.smtpPort <= 0) return 'SMTP 端口不合法'
  if (!configured.value && form.password.trim() === '') return '首次绑定需要填写密码/授权码'
  return ''
}

async function saveAccount(thenTest = false): Promise<void> {
  bindError.value = ''
  const invalid = validateForm()
  if (invalid !== '') {
    bindError.value = invalid
    return
  }
  savingAccount.value = true
  try {
    const out = await mailApi.saveAccount({
      address: form.address.trim(),
      imapHost: form.imapHost.trim(),
      imapPort: form.imapPort,
      imapSecure: form.imapSecure,
      smtpHost: form.smtpHost.trim(),
      smtpPort: form.smtpPort,
      smtpSecure: form.smtpSecure,
      username: form.username.trim() || form.address.trim(),
      ...(form.password.trim() !== '' ? { password: form.password.trim() } : {}),
      ...(form.fromName.trim() !== '' ? { fromName: form.fromName.trim() } : {}),
    })
    status.value = out
    unavailable.value = !out.available
    form.password = ''
    toast.success('邮箱配置已保存')
    await loadStatus()
    if (thenTest) await testConnection()
  } catch (e) {
    bindError.value =
      e instanceof ApiError && e.status === 403
        ? '需要管理员权限'
        : e instanceof Error
          ? e.message
          : '保存失败'
  } finally {
    savingAccount.value = false
  }
}

/* ---------------- 测试连接 ---------------- */
async function testConnection(): Promise<void> {
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await mailApi.test()
    if (testResult.value.ok) toast.success('IMAP 与 SMTP 均连接成功')
    else toast.error(testResult.value.error || '连接测试失败')
    await loadStatus()
  } catch (e) {
    testResult.value = {
      ok: false,
      imap: false,
      smtp: false,
      error: e instanceof Error ? e.message : '测试失败',
    }
  } finally {
    testing.value = false
  }
}

/* ---------------- 写开关 ---------------- */
async function saveWriteSwitch(value: boolean | 'indeterminate'): Promise<void> {
  const next = value === true
  writeSaving.value = true
  try {
    await mailApi.saveSettings(next)
    writeAllowed.value = next
    toast.success(next ? '已允许写操作（发信/回复/整理会真实执行）' : '已关闭写操作（写命令只会预演）')
  } catch (e) {
    writeAllowed.value = !next
    toast.error(
      e instanceof ApiError && e.status === 403
        ? '需要管理员权限'
        : e instanceof Error
          ? e.message
          : '保存失败',
    )
  } finally {
    writeSaving.value = false
  }
}

/* ---------------- 收件箱 ---------------- */
async function loadInbox(): Promise<void> {
  inboxLoading.value = true
  inboxError.value = ''
  query.value = ''
  try {
    const out = await mailApi.cmd('list', { limit: 10 })
    if (!out.ok) {
      inboxError.value = out.error || '读取收件箱失败'
      return
    }
    messages.value = mailMessagesFrom(out.data)
  } catch (e) {
    inboxError.value = e instanceof Error ? e.message : '读取收件箱失败'
  } finally {
    inboxLoading.value = false
  }
}

async function searchInbox(): Promise<void> {
  const q = query.value.trim()
  if (q === '') {
    await loadInbox()
    return
  }
  searching.value = true
  inboxError.value = ''
  try {
    const out = await mailApi.cmd('search', { query: q, limit: 10 })
    if (!out.ok) {
      inboxError.value = out.error || '搜索失败'
      return
    }
    messages.value = mailMessagesFrom(out.data)
  } catch (e) {
    inboxError.value = e instanceof Error ? e.message : '搜索失败'
  } finally {
    searching.value = false
  }
}

async function openMessage(message: MailMessage): Promise<void> {
  readDialog.open = true
  readDialog.loading = true
  readDialog.body = null
  readDialog.error = ''
  try {
    const out = await mailApi.cmd('read', { uid: message.uid })
    if (!out.ok) {
      readDialog.error = out.error || '读取邮件失败'
      return
    }
    readDialog.body = mailBodyFrom(out.data)
  } catch (e) {
    readDialog.error = e instanceof Error ? e.message : '读取邮件失败'
  } finally {
    readDialog.loading = false
  }
}

/* ---------------- 发测试邮件 ---------------- */
async function sendTestMail(): Promise<void> {
  if (status.value === null) return
  sending.value = true
  try {
    const out = await mailApi.cmd('send', {
      to: status.value.address,
      subject: 'Littly 邮箱连通性测试',
      text: '这是一封来自 Littly 控制台的测试邮件；收到说明发信链路可用。',
    })
    if (!out.ok) {
      sendDialog.open = true
      sendDialog.loading = false
      sendDialog.dryRun = false
      sendDialog.error = out.error || '发送失败'
      sendDialog.preview = ''
      return
    }
    sendDialog.open = true
    sendDialog.loading = false
    sendDialog.dryRun = out.dryRun
    sendDialog.error = ''
    sendDialog.preview = JSON.stringify(out.data, null, 2)
    if (out.dryRun) toast.success('写开关关闭：已生成预演结果（未真正发送）')
    else toast.success('测试邮件已发送到你的邮箱')
  } catch (e) {
    sendDialog.open = true
    sendDialog.loading = false
    sendDialog.error = e instanceof Error ? e.message : '发送失败'
  } finally {
    sending.value = false
  }
}

/* ---------------- 解绑 ---------------- */
async function unbind(): Promise<void> {
  try {
    await mailApi.remove()
    toast.success('已解绑邮箱并清除凭据')
    form.password = ''
    testResult.value = null
    messages.value = []
    await loadStatus()
  } catch (e) {
    toast.error(
      e instanceof ApiError && e.status === 403
        ? '需要管理员权限'
        : e instanceof Error
          ? e.message
          : '解绑失败',
    )
  }
}

/* ---------------- 展示助手 ---------------- */
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

function messageDate(iso: string): string {
  if (iso === '') return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  return new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

const testTone = computed<'warning' | 'neutral' | 'destructive'>(() => {
  const r = testResult.value
  if (!r) return 'neutral'
  if (r.ok) return 'neutral'
  return r.imap || r.smtp ? 'warning' : 'destructive'
})
</script>

<template>
  <PageShell title="邮箱" description="给她绑定你的邮箱，用 IMAP/SMTP 收发、阅读与整理邮件。">
    <template #actions>
      <Badge v-if="status" :variant="configured ? 'success' : 'outline'">
        {{ unavailable ? '接口未就绪' : configured ? '已绑定' : '未绑定' }}
      </Badge>
      <Button variant="ghost" size="icon-sm" aria-label="刷新状态" :disabled="unavailable" @click="loadStatus">
        <RefreshCw />
      </Button>
    </template>

    <div class="space-y-8">
      <CalloutBanner
        v-if="unavailable"
        tone="warning"
        title="邮箱后端接口尚未就绪"
        description="服务端的 @littly/mail 与 /api/mail/* 正在实现中。本页已按契约对接，接口上线后无需改前端。"
      />
      <CalloutBanner v-if="error" tone="destructive" :description="error" size="sm" />
      <CalloutBanner
        v-if="!isAdmin"
        tone="neutral"
        title="只读模式"
        description="绑定、测试、写开关、发信与解绑需要管理员账号；当前账号可以查看状态与收件箱。"
      />
      <div v-if="loading" class="flex items-center gap-2 py-8 text-label text-muted-foreground">
        <Spinner class="size-4" />
        正在读取邮箱状态…
      </div>

      <template v-else-if="status">
        <!-- 未绑定：绑定表单 -->
        <SettingsSection v-if="!configured" title="绑定邮箱">
          <SettingsRow label="发件地址" description="AI 以此地址收发邮件" stack="sm">
            <Input v-model="form.address" placeholder="you@example.com" :disabled="!isAdmin || unavailable" />
          </SettingsRow>
          <SettingsRow label="发件人名称" description="可选，收件人看到的显示名" stack="sm">
            <Input v-model="form.fromName" placeholder="例如 小璃" :disabled="!isAdmin || unavailable" />
          </SettingsRow>
          <SettingsRow label="用户名" description="留空则使用发件地址" stack="sm">
            <Input v-model="form.username" placeholder="you@example.com" :disabled="!isAdmin || unavailable" />
          </SettingsRow>
          <SettingsRow
            label="密码 / 授权码"
            description="QQ/163/Gmail 等需要「授权码」，不是登录密码；保存后不回显"
            stack="sm"
          >
            <Input
              v-model="form.password"
              type="password"
              placeholder="授权码 / 密码"
              :disabled="!isAdmin || unavailable"
            />
          </SettingsRow>
          <SettingsRow label="IMAP 服务器" description="收信（只读预览、阅读、整理）" stack="sm">
            <div class="flex w-full items-center gap-2">
              <Input v-model="form.imapHost" placeholder="imap.qq.com" class="flex-1" :disabled="!isAdmin || unavailable" />
              <Input
                v-model.number="form.imapPort"
                type="number"
                class="w-24"
                placeholder="993"
                :disabled="!isAdmin || unavailable"
              />
              <div class="flex items-center gap-1.5">
                <Switch v-model="form.imapSecure" :disabled="!isAdmin || unavailable" />
                <span class="text-caption text-muted-foreground">TLS</span>
              </div>
            </div>
          </SettingsRow>
          <SettingsRow label="SMTP 服务器" description="发信（发送/回复）" stack="sm">
            <div class="flex w-full items-center gap-2">
              <Input v-model="form.smtpHost" placeholder="smtp.qq.com" class="flex-1" :disabled="!isAdmin || unavailable" />
              <Input
                v-model.number="form.smtpPort"
                type="number"
                class="w-24"
                placeholder="465"
                :disabled="!isAdmin || unavailable"
              />
              <div class="flex items-center gap-1.5">
                <Switch v-model="form.smtpSecure" :disabled="!isAdmin || unavailable" />
                <span class="text-caption text-muted-foreground">TLS</span>
              </div>
            </div>
          </SettingsRow>
          <CalloutBanner v-if="bindError" tone="destructive" size="sm" :description="bindError" />
          <CalloutBanner
            v-if="testResult"
            :tone="testTone"
            size="sm"
            :title="testResult.ok ? '连接测试通过' : '连接测试失败'"
            :description="testResult.error || `IMAP：${testResult.imap ? '成功' : '失败'}；SMTP：${testResult.smtp ? '成功' : '失败'}`"
          />
          <template #footer>
            <Button
              variant="outline"
              :loading="testing || savingAccount"
              :disabled="!isAdmin || unavailable"
              @click="configured ? testConnection() : saveAccount(true)"
            >
              测试连接
            </Button>
            <Button
              variant="outline"
              :loading="savingAccount"
              :disabled="!isAdmin || unavailable"
              @click="saveAccount(true)"
            >
              保存并测试
            </Button>
            <Button :loading="savingAccount" :disabled="!isAdmin || unavailable" @click="saveAccount(false)">
              保存
            </Button>
          </template>
        </SettingsSection>

        <!-- 已绑定：状态卡 -->
        <SettingsSection v-else title="账号状态">
          <SettingsRow label="邮箱地址" :description="status.fromName ? `发件人：${status.fromName}` : '未设置发件人名称'">
            <span class="text-control text-foreground">{{ status.address }}</span>
          </SettingsRow>
          <SettingsRow label="IMAP" :description="`${status.imap.host}:${status.imap.port}${status.imap.secure ? ' (TLS)' : ''}`">
            <div class="flex items-center gap-2 text-control text-foreground">
              <StatusDot :status="status.imap.hasPassword ? 'success' : 'warning'" />
              {{ status.imap.hasPassword ? '已配置凭据' : '缺少密码' }}
            </div>
          </SettingsRow>
          <SettingsRow label="SMTP" :description="`${status.smtp.host}:${status.smtp.port}${status.smtp.secure ? ' (TLS)' : ''}`">
            <div class="flex items-center gap-2 text-control text-foreground">
              <StatusDot :status="status.smtp.hasPassword ? 'success' : 'warning'" />
              {{ status.smtp.hasPassword ? '已配置凭据' : '缺少密码' }}
            </div>
          </SettingsRow>
          <SettingsRow label="最近验证" description="最近一次测试连接通过的时间">
            <span class="text-control text-foreground">{{ relativeTime(status.verifiedAt) }}</span>
          </SettingsRow>
          <div v-if="status.lastError" class="mx-4 border-b border-border py-3 text-caption text-destructive">
            {{ status.lastError }}
          </div>
          <div v-if="testResult" class="mx-4 border-b border-border py-3">
            <CalloutBanner
              :tone="testTone"
              size="sm"
              :title="testResult.ok ? '连接测试通过' : '连接测试失败'"
              :description="testResult.error || `IMAP：${testResult.imap ? '成功' : '失败'}；SMTP：${testResult.smtp ? '成功' : '失败'}`"
            />
          </div>
          <SettingsRow label="写操作" description="默认关闭；关闭时发信/回复/整理只会预演">
            <div class="flex items-center gap-2">
              <Switch
                :model-value="writeAllowed"
                :disabled="!isAdmin || unavailable || writeSaving"
                @update:model-value="saveWriteSwitch"
              />
              <span class="text-caption text-muted-foreground">{{ writeAllowed ? '已允许' : '已关闭' }}</span>
            </div>
          </SettingsRow>
          <template #footer>
            <Button variant="outline" :loading="testing" :disabled="!isAdmin || unavailable" @click="testConnection">
              测试连接
            </Button>
            <Button variant="outline" :loading="sending" :disabled="!isAdmin || unavailable" @click="sendTestMail">
              <Send />
              发测试邮件
            </Button>
            <ConfirmPopover
              title="解绑邮箱？"
              message="会清除服务端保存的邮箱凭据，她之后无法再收发邮件。"
              confirm-text="解绑"
              cancel-text="取消"
              variant="destructive"
              @confirm="unbind"
            >
              <template #trigger>
                <Button variant="destructive" :disabled="!isAdmin || unavailable">解绑</Button>
              </template>
            </ConfirmPopover>
          </template>
        </SettingsSection>

        <!-- 更新配置（已绑定时折叠为可编辑表单） -->
        <SettingsSection v-if="configured" title="连接配置">
          <SettingsRow label="发件地址" stack="sm">
            <Input v-model="form.address" :disabled="!isAdmin || unavailable" />
          </SettingsRow>
          <SettingsRow label="密码 / 授权码" description="留空表示不修改（已保存的值不回显）" stack="sm">
            <Input v-model="form.password" type="password" placeholder="留空=不修改" :disabled="!isAdmin || unavailable" />
          </SettingsRow>
          <SettingsRow label="IMAP" stack="sm">
            <div class="flex w-full items-center gap-2">
              <Input v-model="form.imapHost" class="flex-1" :disabled="!isAdmin || unavailable" />
              <Input v-model.number="form.imapPort" type="number" class="w-24" :disabled="!isAdmin || unavailable" />
              <Switch v-model="form.imapSecure" :disabled="!isAdmin || unavailable" />
            </div>
          </SettingsRow>
          <SettingsRow label="SMTP" stack="sm">
            <div class="flex w-full items-center gap-2">
              <Input v-model="form.smtpHost" class="flex-1" :disabled="!isAdmin || unavailable" />
              <Input v-model.number="form.smtpPort" type="number" class="w-24" :disabled="!isAdmin || unavailable" />
              <Switch v-model="form.smtpSecure" :disabled="!isAdmin || unavailable" />
            </div>
          </SettingsRow>
          <CalloutBanner v-if="bindError" tone="destructive" size="sm" :description="bindError" />
          <template #footer>
            <Button :loading="savingAccount" :disabled="!isAdmin || unavailable" @click="saveAccount(false)">
              保存配置
            </Button>
          </template>
        </SettingsSection>

        <!-- 收件箱预览（仅已绑定） -->
        <SettingsSection v-if="configured" title="收件箱">
          <template #actions>
            <Button variant="ghost" size="sm" :loading="inboxLoading" :disabled="unavailable" @click="loadInbox">
              <RefreshCw />
              刷新
            </Button>
          </template>
          <SettingsRow label="搜索" description="按主题/发件人关键词搜索（最多 10 封）" stack="sm">
            <div class="flex w-full items-center gap-2">
              <Input v-model="query" placeholder="搜索邮件…" class="flex-1" @keydown.enter="searchInbox" />
              <Button variant="outline" :loading="searching" :disabled="unavailable" @click="searchInbox">
                <Search />
                搜索
              </Button>
            </div>
          </SettingsRow>
          <CalloutBanner v-if="inboxError" tone="destructive" size="sm" :description="inboxError" />
          <div v-if="inboxLoading && messages.length === 0" class="flex items-center gap-2 px-4 py-6 text-label text-muted-foreground">
            <Spinner class="size-4" />
            正在读取收件箱…
          </div>
          <SettingsRow v-for="message in messages" :key="message.uid">
            <template #content>
              <div class="flex flex-wrap items-center gap-2">
                <Badge v-if="message.unread" size="sm" variant="info">未读</Badge>
                <span class="truncate text-control font-medium text-foreground">{{ message.subject || '(无主题)' }}</span>
              </div>
              <p class="mt-0.5 truncate text-body text-muted-foreground">{{ message.from || '未知发件人' }}</p>
              <p v-if="message.snippet" class="mt-0.5 truncate text-caption text-muted-foreground">{{ message.snippet }}</p>
            </template>
            <div class="flex items-center gap-3">
              <span class="text-caption text-muted-foreground">{{ messageDate(message.date) }}</span>
              <Button
                variant="outline"
                size="sm"
                :aria-label="`查看邮件：${message.subject || '（无主题）'}`"
                @click="openMessage(message)"
              >
                <Mail />
                查看
              </Button>
            </div>
          </SettingsRow>
          <SettingsRow v-if="!inboxLoading && messages.length === 0">
            <template #content>
              <p class="text-control text-muted-foreground">
                {{ query.trim() === '' ? '收件箱暂时没有邮件。' : '没有匹配的邮件。' }}
              </p>
            </template>
          </SettingsRow>
        </SettingsSection>

        <!-- 服务商提示 -->
        <SurfaceCard v-if="!configured" padding="lg" class="space-y-2">
          <h2 class="text-label font-medium text-muted-foreground">常见服务商提示</h2>
          <ul class="list-disc space-y-1 pl-4 text-label text-muted-foreground">
            <li>QQ 邮箱：imap.qq.com:993 / smtp.qq.com:465，密码处填「授权码」（设置 → 账号 → POP3/IMAP 服务）。</li>
            <li>163 邮箱：imap.163.com:993 / smtp.163.com:465，需在设置里开启 IMAP/SMTP 并使用授权码。</li>
            <li>Gmail：imap.gmail.com:993 / smtp.gmail.com:465，需开启两步验证并生成「应用专用密码」。</li>
          </ul>
          <p class="text-caption text-muted-foreground">
            凭据只保存在服务端（global_settings），不会回传前端；写操作默认关闭，需要时再打开。
          </p>
        </SurfaceCard>
      </template>
    </div>

    <!-- 读信弹窗 -->
    <Dialog v-model:open="readDialog.open">
      <DialogPanel width="xl" footer>
        <DialogHeader>
          <DialogTitle>{{ readDialog.body?.subject || '邮件正文' }}</DialogTitle>
          <DialogDescription class="sr-only">邮件正文与附件列表</DialogDescription>
        </DialogHeader>
        <DialogBody class="space-y-3">
          <div v-if="readDialog.loading" class="flex items-center gap-2 text-label text-muted-foreground">
            <Spinner class="size-4" />
            正在读取邮件…
          </div>
          <CalloutBanner v-else-if="readDialog.error" tone="destructive" size="sm" :description="readDialog.error" />
          <template v-else-if="readDialog.body">
            <div class="space-y-1">
              <p class="text-label text-muted-foreground">发件人：{{ readDialog.body.from || '未知' }}</p>
              <p class="text-label text-muted-foreground">时间：{{ readDialog.body.date || '未知' }}</p>
            </div>
            <pre class="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-card p-3 text-body text-foreground">{{ readDialog.body.text || '（无纯文本正文）' }}</pre>
            <div v-if="readDialog.body.attachments.length > 0" class="space-y-1">
              <p class="flex items-center gap-1 text-label text-muted-foreground">
                <Paperclip class="size-3.5" />
                附件 {{ readDialog.body.attachments.length }} 个
              </p>
              <p
                v-for="file in readDialog.body.attachments"
                :key="file.filename"
                class="text-caption text-muted-foreground"
              >
                {{ file.filename }}（{{ Math.round(file.size / 1024) }} KB）
              </p>
            </div>
          </template>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" @click="readDialog.open = false">关闭</Button>
        </DialogFooter>
      </DialogPanel>
    </Dialog>

    <!-- 发测试邮件结果 -->
    <Dialog v-model:open="sendDialog.open">
      <DialogPanel width="lg" footer>
        <DialogHeader>
          <DialogTitle>{{ sendDialog.dryRun ? '发送预演（未真正发送）' : '发送测试邮件' }}</DialogTitle>
          <DialogDescription class="sr-only">发测试邮件的结果或预演信息。</DialogDescription>
        </DialogHeader>
        <DialogBody class="space-y-3">
          <CalloutBanner v-if="sendDialog.error" tone="destructive" size="sm" :description="sendDialog.error" />
          <template v-else>
            <CalloutBanner
              :tone="sendDialog.dryRun ? 'warning' : 'neutral'"
              size="sm"
              :title="sendDialog.dryRun ? '写开关关闭，命令只做了预演' : '已发送'"
              :description="
                sendDialog.dryRun
                  ? '打开上方的写操作开关后，再点「发测试邮件」即可真正发送。'
                  : '测试邮件已发送到你的绑定地址，稍后可在收件箱预览里确认。'
              "
            />
            <CodePanel
              v-if="sendDialog.preview"
              :code="sendDialog.preview"
              width="full"
              copy-label="复制结果"
              copied-label="已复制"
              copy-failed-message="复制失败"
              class="max-h-64 overflow-y-auto"
            />
          </template>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" @click="sendDialog.open = false">关闭</Button>
        </DialogFooter>
      </DialogPanel>
    </Dialog>
  </PageShell>
</template>
