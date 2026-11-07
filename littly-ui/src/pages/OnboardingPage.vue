<script setup lang="ts">
/**
 * 首次引导向导（5 步，全屏）：
 *   1 她是谁 → 2 模型连接（真实测试）→ 3 人格 → 4 给她账号（平台卡片，可跳过）→ 5 完成
 * 关键写操作都走后端：模型设置 /api/settings/ai、角色卡 /api/characters、
 * 完成态 /api/onboarding/complete（契约接口未就绪时本地降级，不阻塞流程）。
 * 第 4 步「给她账号」把她的各平台账号接进来：
 *   微信/X 内联快速配置；Bilibili / Telegram / QQ / Discord 跳到 /channels/<x>?from=onboarding。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  Badge,
  Button,
  CalloutBanner,
  FieldStack,
  Input,
  SegmentedControl,
  Spinner,
  SurfaceCard,
  Textarea,
} from '@felinic/ui'
import {
  BookHeart,
  Bot,
  Check,
  Gamepad2,
  Heart,
  Mail,
  MessageCircle,
  Send,
  SkipForward,
  Tv,
  Twitter,
} from 'lucide-vue-next'
import {
  biliApi,
  botsApi,
  channelsApi,
  charactersApi,
  personaApi,
  mailApi,
  qqApi,
  settingsApi,
  wechatApi,
  xApi,
} from '@/api/endpoints'
import { ApiError } from '@/api/client'
import { useBots } from '@/stores/bots'
import { useOnboardingStore } from '@/stores/onboarding'

const router = useRouter()
const onboarding = useOnboardingStore()
const bots = useBots()

const step = ref(1)
const STEP_LABELS = ['她是谁', '模型连接', '人格', '给她账号', '完成'] as const

const saving = ref(false)
const error = ref('')

/* ---------------- 步骤 1：她是谁 ---------------- */
const about = reactive({
  name: '',
  callName: '',
  avatarUrl: '',
})

/* ---------------- 步骤 2：模型连接 ---------------- */
const model = reactive({
  baseUrl: '',
  apiKey: '',
  model: '',
})
const testing = ref(false)
const testResult = ref<{ ok: boolean; latencyMs?: number; error?: string } | null>(null)

/* ---------------- 步骤 3：人格 ---------------- */
const persona = reactive({
  cardId: '',
  characterName: '',
  description: '',
  personality: '',
  scenario: '',
  firstMes: '',
})
const presets = ref<Array<{ id: string; name: string; data: Record<string, unknown> }>>([])
const rules = ref('')

/* ---------------- 步骤 4：给她账号 ---------------- */
type PlatformId = 'wechat' | 'bilibili' | 'telegram' | 'qq' | 'discord' | 'x' | 'email'

interface PlatformView {
  id: PlatformId
  name: string
  icon: typeof MessageCircle
  statusText: string
  badgeVariant: 'success' | 'info' | 'warning' | 'outline'
  actionLabel: string
  actionDisabled: boolean
  /** 已接好（徽标 success）时不再提供配置动作。 */
  connected: boolean
}

const accounts = reactive({
  loading: false,
  loaded: false,
  wechat: { bound: false, nickname: '' },
  bili: { available: true, authenticated: false, username: '' },
  bindings: [] as Array<{ channel: string; externalId: string }>,
  channels: {} as Record<string, { enabled: boolean; hasToken: boolean }>,
  x: { available: true, configured: false, username: '' },
  mail: { available: true, configured: false, address: '' },
  /** QQ 双通道（SnowLuma OneBot / 官方 QQBot），任一启用即算已接。 */
  qq: {
    available: true,
    snowlumaEnabled: false,
    snowlumaConnected: false,
    qqbotEnabled: false,
    qqbotConnected: false,
  },
})
/** 当前展开的内联快速配置（一次只开一个）。 */
const quickPanel = ref<'' | PlatformId>('')

const wechat = reactive({
  loading: false,
  bound: false,
  nickname: '',
  qrDataUrl: '',
  sessionId: '',
  status: 'wait' as string,
  pollTimer: 0 as number | ReturnType<typeof setInterval>,
})

const xForm = reactive({
  mode: 'cookie' as 'cookie' | 'token',
  cookie: '',
  authToken: '',
  ct0: '',
  proxy: '',
  saving: false,
  probing: false,
  error: '',
})

/* ---------------- 生命周期 ---------------- */
onMounted(async () => {
  void bots.bootstrap()
  void loadRules()
  void loadPresets()
  void loadModelSettings()
  void loadAccounts()
})

async function loadRules(): Promise<void> {
  try {
    const botId = bots.state.currentBotId ?? ''
    const out = await personaApi.get(botId)
    rules.value = out.content
  } catch {
    rules.value = ''
  }
}

async function loadPresets(): Promise<void> {
  try {
    const list = await charactersApi.presets()
    presets.value = list.map((p) => {
      const card = (p.card ?? {}) as Record<string, unknown>
      const data = (card.data ?? card) as Record<string, unknown>
      return {
        id: String(p.id ?? ''),
        name: String(p.name ?? data.name ?? '预设'),
        data,
      }
    })
  } catch {
    presets.value = []
  }
}

async function loadModelSettings(): Promise<void> {
  try {
    const ai = await settingsApi.getAi()
    model.baseUrl = String(ai.baseURL ?? ai.baseUrl ?? '')
    model.model = String(ai.chatModel ?? ai.model ?? '')
    model.apiKey = ''
  } catch {
    /* admin-only：普通账号读不到，保留空值手填 */
  }
}

async function loadWechatStatus(): Promise<void> {
  try {
    const status = await wechatApi.status()
    wechat.bound = status.bound
    wechat.nickname = status.nickname ?? ''
    accounts.wechat.bound = status.bound
    accounts.wechat.nickname = status.nickname ?? ''
  } catch {
    /* 接口未就绪（wechat 实现中） */
  }
}

/** 拉齐六个平台的现状（任一接口失败只影响该平台，不阻塞整页）。 */
async function loadAccounts(): Promise<void> {
  accounts.loading = true
  const botId = bots.state.currentBotId ?? ''
  await Promise.all([
    loadWechatStatus(),
    (async () => {
      try {
        const out = await biliApi.status()
        accounts.bili.available = out.available
        accounts.bili.authenticated = out.authenticated
        accounts.bili.username = out.username
      } catch {
        /* B站 sidecar 未连接：保持未配置 */
      }
    })(),
    (async () => {
      try {
        const out = await channelsApi.bindStatus()
        accounts.bindings = out.identities
      } catch {
        accounts.bindings = []
      }
    })(),
    (async () => {
      if (botId === '') return
      try {
        const channels = await botsApi.channels(botId)
        const next: Record<string, { enabled: boolean; hasToken: boolean }> = {}
        // QQ 已改由 SnowLuma 承载，这里只剩 telegram / discord 走 bot 渠道配置。
        for (const key of ['telegram', 'discord']) {
          const cfg = (channels[key] ?? {}) as Record<string, unknown>
          next[key] = { enabled: cfg.enabled === true, hasToken: cfg.hasToken === true }
        }
        accounts.channels = next
      } catch {
        accounts.channels = {}
      }
    })(),
    (async () => {
      try {
        const out = await qqApi.status()
        accounts.qq.available = out.available
        accounts.qq.snowlumaEnabled = out.snowluma.enabled
        accounts.qq.snowlumaConnected = out.snowluma.connected
        accounts.qq.qqbotEnabled = out.qqbot.enabled
        accounts.qq.qqbotConnected = out.qqbot.connected
      } catch {
        accounts.qq.available = false
      }
    })(),
    (async () => {
      try {
        const out = await mailApi.status()
        accounts.mail.available = out.available
        accounts.mail.configured = out.configured
        accounts.mail.address = out.address
      } catch {
        accounts.mail.available = false
      }
    })(),
    (async () => {
      try {
        const out = await xApi.status()
        accounts.x.available = out.available
        accounts.x.configured = out.configured
        accounts.x.username = out.username
      } catch {
        accounts.x.available = false
      }
    })(),
  ])
  accounts.loading = false
  accounts.loaded = true
}

/** 某个渠道是否已绑定（bind/status 的 identities）。 */
function boundTo(channel: string): boolean {
  return accounts.bindings.some((b) => b.channel === channel)
}

/** 渠道在 bot 配置里是否已填好并启用（尚未完成绑定时的「已配置」态）。 */
function configuredChannel(channel: string): boolean {
  return accounts.channels[channel]?.enabled === true || accounts.channels[channel]?.hasToken === true
}

const platforms = computed<PlatformView[]>(() => {
  const list: PlatformView[] = []
  // 微信
  list.push({
    id: 'wechat',
    name: '微信',
    icon: MessageCircle,
    statusText: accounts.wechat.bound ? '已绑定' : '未配置',
    badgeVariant: accounts.wechat.bound ? 'success' : 'outline',
    actionLabel: accounts.wechat.bound ? '已绑定' : quickPanel.value === 'wechat' ? '收起' : '扫码绑定',
    actionDisabled: accounts.wechat.bound,
    connected: accounts.wechat.bound,
  })
  // Bilibili
  list.push({
    id: 'bilibili',
    name: 'Bilibili',
    icon: Tv,
    statusText: !accounts.bili.available
      ? '接口未就绪'
      : accounts.bili.authenticated
        ? accounts.bili.username
          ? `已登录 ${accounts.bili.username}`
          : '已登录'
        : '未登录',
    badgeVariant: accounts.bili.authenticated ? 'success' : accounts.bili.available ? 'outline' : 'warning',
    actionLabel: accounts.bili.authenticated ? '管理 B 站' : '扫码登录',
    actionDisabled: false,
    connected: accounts.bili.authenticated,
  })
  // Telegram / Discord —— 跳转控制台对应页面完成官方渠道配置
  const jumpPlatforms: Array<{ id: PlatformId; name: string; icon: typeof MessageCircle }> = [
    { id: 'telegram', name: 'Telegram', icon: Send },
    { id: 'discord', name: 'Discord', icon: Gamepad2 },
  ]
  for (const p of jumpPlatforms) {
    const bound = boundTo(p.id)
    const configured = configuredChannel(p.id)
    list.push({
      id: p.id,
      name: p.name,
      icon: p.icon,
      statusText: bound ? '已绑定' : configured ? '已配置·待绑定' : '未配置',
      badgeVariant: bound ? 'success' : configured ? 'info' : 'outline',
      actionLabel: bound ? '已绑定' : '去配置',
      actionDisabled: bound,
      connected: bound,
    })
  }
  // QQ —— 双通道（SnowLuma OneBot / 官方 QQBot），状态来自 /api/qq/status；任一启用即算已接。
  const qqEnabled = accounts.qq.snowlumaEnabled || accounts.qq.qqbotEnabled
  const qqConnected = accounts.qq.snowlumaConnected || accounts.qq.qqbotConnected
  const qqEnabledNames = [
    accounts.qq.snowlumaEnabled ? 'SnowLuma' : '',
    accounts.qq.qqbotEnabled ? '官方 Bot' : '',
  ].filter(Boolean)
  const qqConnectedNames = [
    accounts.qq.snowlumaConnected ? 'SnowLuma' : '',
    accounts.qq.qqbotConnected ? '官方 Bot' : '',
  ].filter(Boolean)
  list.push({
    id: 'qq',
    name: 'QQ',
    icon: Bot,
    statusText: !accounts.qq.available
      ? '接口未就绪'
      : qqConnected
        ? `${qqConnectedNames.join(' / ')} 已连接`
        : qqEnabled
          ? `${qqEnabledNames.join(' / ')} 已启用·待连接`
          : '未启用',
    badgeVariant: qqConnected ? 'success' : !accounts.qq.available ? 'warning' : qqEnabled ? 'info' : 'outline',
    actionLabel: qqEnabled ? '管理 QQ' : '配置 QQ',
    actionDisabled: false,
    connected: qqEnabled,
  })
  // 邮箱（IMAP/SMTP）
  list.push({
    id: 'email',
    name: '邮箱',
    icon: Mail,
    statusText: !accounts.mail.available
      ? '接口未就绪'
      : accounts.mail.configured
        ? accounts.mail.address
          ? `已绑定 ${accounts.mail.address}`
          : '已绑定'
        : '未绑定',
    badgeVariant: accounts.mail.configured ? 'success' : accounts.mail.available ? 'outline' : 'warning',
    actionLabel: accounts.mail.configured ? '管理邮箱' : '配置邮箱',
    actionDisabled: false,
    connected: accounts.mail.configured,
  })
  // X
  list.push({
    id: 'x',
    name: 'X',
    icon: Twitter,
    statusText: !accounts.x.available
      ? '接口未就绪'
      : accounts.x.configured
        ? accounts.x.username
          ? `已登录 @${accounts.x.username}`
          : '已配置·待验证'
        : '未配置',
    badgeVariant: accounts.x.configured ? 'success' : accounts.x.available ? 'outline' : 'warning',
    actionLabel: accounts.x.configured ? '更换账号' : '登录 X',
    actionDisabled: !accounts.x.available,
    connected: false,
  })
  return list
})

/** 平台卡片动作：内联配置（微信/B站/X）或跳到控制台对应渠道页。 */
function onPlatformAction(platform: PlatformView): void {
  error.value = ''
  if (platform.id === 'wechat') {
    quickPanel.value = quickPanel.value === 'wechat' ? '' : 'wechat'
    if (quickPanel.value === 'wechat' && wechat.qrDataUrl === '') void startWechatBind()
    return
  }
  if (platform.id === 'bilibili') {
    void router.push('/channels/bilibili?from=onboarding')
    return
  }
  if (platform.id === 'x') {
    quickPanel.value = quickPanel.value === 'x' ? '' : 'x'
    return
  }
  // Telegram / Discord / QQ：去控制台对应渠道页完成配置。
  void router.push(`/channels/${platform.id}?from=onboarding`)
}

function connectedPlatformNames(): string {
  return platforms.value.filter((p) => p.connected).map((p) => p.name).join('、')
}

/* ---------------- 导航 ---------------- */
const canNext = computed(() => {
  if (step.value === 1) return about.name.trim() !== ''
  if (step.value === 2)
    return model.baseUrl.trim() !== '' && model.apiKey.trim() !== '' && model.model.trim() !== ''
  return true
})

function next(): void {
  error.value = ''
  if (!canNext.value) {
    error.value = step.value === 1 ? '给「她」起一个名字再继续' : '请填写 Base URL、API Key 与模型名'
    return
  }
  if (step.value === 1) {
    void ensureCharacter()
  }
  if (step.value === 2) {
    void saveModelSettings()
  }
  if (step.value === 3) {
    void saveCharacter()
  }
  if (step.value === 5) {
    void finish()
    return
  }
  step.value += 1
}

function prev(): void {
  error.value = ''
  if (step.value > 1) step.value -= 1
}

/* ---------------- 写操作 ---------------- */
function buildCard(): Record<string, unknown> {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    name: persona.characterName || about.name,
    description: persona.description,
    personality: persona.personality,
    scenario: persona.scenario,
    first_mes: persona.firstMes,
    tags: ['onboarding'],
    creator: 'littly',
  }
}

/** 步骤 1 → 2：先把「她是谁」落成一张角色卡，步骤 3 再补人格字段。 */
async function ensureCharacter(): Promise<void> {
  if (persona.cardId !== '') return
  persona.characterName = about.name
  try {
    const created = await charactersApi.create({ name: about.name, card: buildCard() })
    if (created?.id) persona.cardId = created.id
  } catch (e) {
    error.value = e instanceof ApiError ? `角色卡保存失败：${e.message}` : '角色卡保存失败'
  }
}

async function saveCharacter(): Promise<void> {
  if (persona.cardId === '') {
    await ensureCharacter()
    return
  }
  try {
    await charactersApi.update(persona.cardId, {
      name: persona.characterName || about.name,
      card: buildCard(),
    })
    onboarding.markStep('persona', true)
  } catch (e) {
    error.value = e instanceof ApiError ? `人格保存失败：${e.message}` : '人格保存失败'
  }
}

async function saveModelSettings(): Promise<void> {
  saving.value = true
  try {
    await settingsApi.saveAi({
      baseURL: model.baseUrl.trim(),
      apiKey: model.apiKey.trim(),
      chatModel: model.model.trim(),
    })
    onboarding.markStep('model', true)
  } catch (e) {
    // 普通账号没有全局设置写权限：保留输入，明确告知而不是静默失败。
    error.value =
      e instanceof ApiError && e.status === 403
        ? '当前账号没有写入全局设置的权限（需要管理员）。配置已保留，可稍后在「系统 → 设置」用管理员账号保存。'
        : `模型设置保存失败：${e instanceof Error ? e.message : '未知错误'}`
    onboarding.markStep('model', true)
  } finally {
    saving.value = false
  }
}

async function testConnection(): Promise<void> {
  error.value = ''
  testResult.value = null
  if (model.baseUrl.trim() === '' || model.apiKey.trim() === '' || model.model.trim() === '') {
    error.value = '先把三项都填好，再测试连接'
    return
  }
  testing.value = true
  try {
    testResult.value = await onboarding.testModel({
      baseUrl: model.baseUrl.trim(),
      apiKey: model.apiKey.trim(),
      model: model.model.trim(),
    })
  } finally {
    testing.value = false
  }
}

/* ---------------- 步骤 4：微信 ---------------- */
async function startWechatBind(): Promise<void> {
  error.value = ''
  wechat.loading = true
  try {
    const session = await wechatApi.qr()
    wechat.sessionId = session.sessionId
    wechat.qrDataUrl = session.qrDataUrl
    wechat.status = 'wait'
    stopWechatPoll()
    wechat.pollTimer = setInterval(() => void pollWechat(session.sessionId), 2000)
  } catch (e) {
    error.value =
      e instanceof ApiError && e.status === 403
        ? '需要管理员权限才能绑定微信。'
        : `微信绑定接口暂不可用：${e instanceof Error ? e.message : '未知错误'}（可先跳过）`
  } finally {
    wechat.loading = false
  }
}

async function pollWechat(sessionId: string): Promise<void> {
  if (sessionId === '') return
  try {
    const out = await wechatApi.qrStatus(sessionId)
    wechat.status = out.status
    if (out.status === 'confirmed') {
      stopWechatPoll()
      wechat.bound = true
      accounts.wechat.bound = true
      onboarding.markStep('wechat', true)
      await loadWechatStatus()
    } else if (out.status === 'expired') {
      stopWechatPoll()
      void startWechatBind()
    }
  } catch {
    stopWechatPoll()
  }
}

function stopWechatPoll(): void {
  if (wechat.pollTimer) {
    clearInterval(wechat.pollTimer as ReturnType<typeof setInterval>)
    wechat.pollTimer = 0
  }
}

/* ---------------- 步骤 4：X 内联登录 ---------------- */
async function submitXLogin(): Promise<void> {
  xForm.error = ''
  const authToken = xForm.authToken.trim()
  const ct0 = xForm.ct0.trim()
  const cookie = xForm.cookie.trim()
  if (xForm.mode === 'cookie' && cookie === '') {
    xForm.error = '请粘贴浏览器里 X 的完整 cookie'
    return
  }
  if (xForm.mode === 'token' && (authToken === '' || ct0 === '')) {
    xForm.error = '请同时填写 auth_token 与 ct0'
    return
  }
  xForm.saving = true
  try {
    await xApi.login({
      ...(xForm.mode === 'cookie' ? { cookie } : { authToken, ct0 }),
      ...(xForm.proxy.trim() !== '' ? { proxy: xForm.proxy.trim() } : {}),
    })
    xForm.cookie = ''
    xForm.authToken = ''
    xForm.ct0 = ''
    await probeX()
  } catch (e) {
    xForm.error =
      e instanceof ApiError && e.status === 403
        ? '需要管理员权限才能保存 X 凭据。'
        : e instanceof Error
          ? e.message
          : '保存 X 凭据失败'
  } finally {
    xForm.saving = false
  }
}

async function probeX(): Promise<void> {
  xForm.probing = true
  xForm.error = ''
  try {
    const out = await xApi.probe()
    if (out.ok) {
      accounts.x.configured = true
      accounts.x.username = out.username ?? accounts.x.username
      await loadAccounts()
    } else {
      xForm.error = out.error ?? '验证失败：凭据可能已过期'
    }
  } catch (e) {
    xForm.error = e instanceof Error ? e.message : '验证失败'
  } finally {
    xForm.probing = false
  }
}

/* ---------------- 步骤 4：跳过 ---------------- */
function stopAccountPolls(): void {
  stopWechatPoll()
}

function skipAccounts(): void {
  stopAccountPolls()
  onboarding.markStep('wechat', accounts.wechat.bound)
  step.value = 5
}

onBeforeUnmount(() => stopAccountPolls())

/* ---------------- 步骤 5：完成 ---------------- */
const summary = computed(() => [
  { label: '名字', value: about.name || '未设置' },
  { label: '模型', value: model.model || '未设置' },
  { label: '人格', value: persona.characterName || about.name },
  {
    label: '账号',
    value: connectedPlatformNames() || '未接入（可稍后在「连接」里配置）',
  },
])

async function finish(): Promise<void> {
  saving.value = true
  stopAccountPolls()
  try {
    await onboarding.complete()
    await router.replace('/chat')
  } finally {
    saving.value = false
  }
}

function applyPreset(presetId: string): void {
  const preset = presets.value.find((p) => p.id === presetId)
  if (!preset) return
  const d = preset.data
  persona.description = String(d.description ?? '')
  persona.personality = String(d.personality ?? '')
  persona.scenario = String(d.scenario ?? '')
  persona.firstMes = String(d.first_mes ?? d.firstMes ?? '')
  if (about.name === '') about.name = String(d.name ?? preset.name)
}

function onPresetChange(e: Event): void {
  const value = (e.target as HTMLSelectElement).value
  if (value) applyPreset(value)
}
</script>

<template>
  <div class="flex min-h-dvh flex-col bg-background">
    <!-- 顶栏：品牌 + 步骤进度 -->
    <header class="mx-auto flex w-full max-w-2xl items-center justify-between gap-4 px-6 pt-8">
      <div class="flex items-center gap-2">
        <div class="flex size-8 items-center justify-center rounded-md bg-accent text-foreground">
          <Heart class="size-4" />
        </div>
        <div>
          <div class="text-control font-semibold text-foreground">Littly</div>
          <div class="text-caption text-muted-foreground">开始之前，先认识她</div>
        </div>
      </div>
      <div class="flex items-center gap-1.5">
        <div
          v-for="(label, i) in STEP_LABELS"
          :key="label"
          class="h-1.5 rounded-full transition-all"
          :class="i + 1 <= step ? 'w-8 bg-foreground' : 'w-4 bg-border'"
          :title="label"
        />
      </div>
    </header>

    <!-- 主体 -->
    <main class="mx-auto flex w-full max-w-xl flex-1 flex-col px-6 py-10">
      <div class="mb-8">
        <div class="text-caption font-medium text-muted-foreground">第 {{ step }} / 5 步</div>
        <h1 class="mt-1 text-display font-semibold text-foreground">{{ STEP_LABELS[step - 1] }}</h1>
      </div>

      <CalloutBanner v-if="error" tone="warning" :description="error" class="mb-6" />

      <!-- 步骤 1：她是谁 -->
      <div v-if="step === 1" class="space-y-6">
        <p class="text-control text-muted-foreground">
          她是你接入的第一个角色。名字与称呼之后都能改。
        </p>
        <div class="space-y-4">
          <FieldStack label="她的名字" for="ob-name" help="会显示在侧边栏与对话里">
            <Input id="ob-name" v-model="about.name" placeholder="例如：小璃" />
          </FieldStack>
          <FieldStack label="她怎么称呼你" for="ob-call" help="留空则由她自己决定">
            <Input id="ob-call" v-model="about.callName" placeholder="例如：老板、学长、你" />
          </FieldStack>
          <FieldStack label="头像链接（可选）" for="ob-avatar">
            <Input id="ob-avatar" v-model="about.avatarUrl" placeholder="https:// 开头的图片地址" />
          </FieldStack>
        </div>
        <div class="flex items-start gap-2 rounded-md bg-muted-soft p-3 text-label text-muted-foreground">
          <BookHeart class="mt-0.5 size-4 shrink-0" />
          <span>她的记忆、聊天与人格都绑定在「当前她」上；之后可以在侧边栏切换。</span>
        </div>
      </div>

      <!-- 步骤 2：模型连接 -->
      <div v-else-if="step === 2" class="space-y-6">
        <p class="text-control text-muted-foreground">
          她的「大脑」需要一个 OpenAI 兼容接口。填好后点「测试连接」验证。
        </p>
        <div class="space-y-4">
          <FieldStack label="Base URL" for="ob-base" help="例如 https://openrouter.ai/api/v1">
            <Input id="ob-base" v-model="model.baseUrl" placeholder="https://…/v1" />
          </FieldStack>
          <FieldStack label="API Key" for="ob-key" help="只写入后端，不会回显明文">
            <Input id="ob-key" v-model="model.apiKey" type="password" placeholder="sk-…" />
          </FieldStack>
          <FieldStack label="模型" for="ob-model" help="例如 openai/gpt-4o-mini">
            <Input id="ob-model" v-model="model.model" placeholder="provider/model" />
          </FieldStack>
        </div>
        <div class="flex items-center gap-3">
          <Button variant="outline" :disabled="testing" @click="testConnection">
            <Spinner v-if="testing" class="size-4" />
            测试连接
          </Button>
          <span v-if="testResult?.ok" class="text-label text-success">
            连接正常 · {{ testResult.latencyMs ?? '—' }} ms
          </span>
          <span v-else-if="testResult && !testResult.ok" class="text-label text-destructive">
            {{ testResult.error ?? '连接失败' }}
          </span>
        </div>
      </div>

      <!-- 步骤 3：人格 -->
      <div v-else-if="step === 3" class="space-y-6">
        <p class="text-control text-muted-foreground">
          选一个预设快速开始，或自己写下她是谁。铁律会自动生效。
        </p>
        <FieldStack label="从预设开始" for="ob-preset">
          <select
            id="ob-preset"
            class="h-9 w-full rounded-md bg-transparent px-3 text-control text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            @change="onPresetChange"
          >
            <option value="">不使用预设</option>
            <option v-for="p in presets" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </FieldStack>
        <div class="space-y-4">
          <FieldStack label="角色设定" for="ob-desc">
            <Textarea
              id="ob-desc"
              v-model="persona.description"
              :rows="4"
              placeholder="她是谁、你们的关系、她的日常…"
            />
          </FieldStack>
          <FieldStack label="性格" for="ob-personality">
            <Input id="ob-personality" v-model="persona.personality" placeholder="温柔、粘人、偶尔傲娇" />
          </FieldStack>
          <FieldStack label="场景" for="ob-scenario">
            <Input id="ob-scenario" v-model="persona.scenario" placeholder="你们已经在一起一段时间了" />
          </FieldStack>
          <FieldStack label="第一句话" for="ob-first">
            <Input id="ob-first" v-model="persona.firstMes" placeholder="回来啦～" />
          </FieldStack>
        </div>
        <div v-if="rules" class="space-y-2">
          <div class="text-label font-medium text-muted-foreground">默认铁律（只读）</div>
          <pre
            class="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted-soft p-3 text-caption text-muted-foreground"
          >{{ rules }}</pre>
        </div>
      </div>

      <!-- 步骤 4：给她账号 -->
      <div v-else-if="step === 4" data-testid="onboarding-accounts" class="space-y-6">
        <p class="text-control text-muted-foreground">
          把她的账号接进来，她才能真正活在你的世界里。可以随时跳过，之后在「连接」里配置。
        </p>

        <div v-if="accounts.loading" class="flex items-center gap-2 py-4 text-label text-muted-foreground">
          <Spinner class="size-4" />
          正在读取各平台状态…
        </div>

        <div v-else data-testid="accounts-grid" class="grid gap-3 sm:grid-cols-2">
          <SurfaceCard
            v-for="platform in platforms"
            :key="platform.id"
            padding="row"
            class="flex flex-col gap-2.5"
          >
            <div class="flex items-center gap-2">
              <component :is="platform.icon" class="size-4 shrink-0 text-foreground" />
              <span class="text-control font-medium text-foreground">{{ platform.name }}</span>
              <Badge :variant="platform.badgeVariant" size="sm" class="ml-auto">
                {{ platform.statusText }}
              </Badge>
            </div>
            <div class="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                :disabled="platform.actionDisabled"
                @click="onPlatformAction(platform)"
              >
                {{ platform.actionLabel }}
              </Button>
              <span
                v-if="platform.id === 'telegram' || platform.id === 'qq' || platform.id === 'discord'"
                class="text-caption text-muted-foreground"
              >
                在控制台里完成配置
              </span>
            </div>
          </SurfaceCard>
        </div>

        <!-- 内联快速配置：微信 -->
        <SurfaceCard v-if="quickPanel === 'wechat'" data-testid="accounts-wechat-panel" padding="lg" class="space-y-3">
          <div class="flex items-center justify-between gap-3">
            <div>
              <div class="text-label font-medium text-foreground">微信扫码绑定</div>
              <div class="mt-0.5 text-caption text-muted-foreground">用手机微信扫码，确认后她就会出现在你的微信里。</div>
            </div>
            <Button variant="ghost" size="sm" @click="quickPanel = ''">收起</Button>
          </div>
          <div v-if="!wechat.qrDataUrl" class="flex items-center gap-3">
            <Button variant="outline" size="sm" :loading="wechat.loading" @click="startWechatBind">
              生成二维码
            </Button>
          </div>
          <div v-else class="flex flex-col items-center gap-3">
            <img
              :src="wechat.qrDataUrl"
              alt="微信绑定二维码"
              class="size-44 rounded-md border border-border bg-card object-contain p-2"
            />
            <div class="text-label text-muted-foreground">
              {{
                wechat.status === 'wait'
                  ? '请用微信扫码'
                  : wechat.status === 'scanned' || wechat.status === 'scaned'
                    ? '已扫码，请在手机上确认'
                    : wechat.status === 'confirmed'
                      ? '绑定成功'
                      : '二维码已刷新，请用新码扫码'
              }}
            </div>
            <Button variant="ghost" size="sm" :loading="wechat.loading" @click="startWechatBind">
              刷新二维码
            </Button>
          </div>
        </SurfaceCard>

        <!-- 内联快速配置：X -->
        <SurfaceCard v-if="quickPanel === 'x'" data-testid="accounts-x-panel" padding="lg" class="space-y-3">
          <div class="flex items-center justify-between gap-3">
            <div>
              <div class="text-label font-medium text-foreground">登录你的 X 账号</div>
              <div class="mt-0.5 text-caption text-muted-foreground">
                凭据只保存在后端，不会回传到页面；建议用完整 cookie。
              </div>
            </div>
            <Button variant="ghost" size="sm" @click="quickPanel = ''">收起</Button>
          </div>
          <CalloutBanner v-if="!accounts.x.available" tone="warning" size="sm" description="X 后端接口尚未就绪；保存/验证按钮暂不可用。" />
          <CalloutBanner v-if="xForm.error" tone="destructive" size="sm" :description="xForm.error" />
          <SegmentedControl
            :model-value="xForm.mode"
            :items="[
              { value: 'cookie', label: '完整 cookie' },
              { value: 'token', label: 'auth_token + ct0' },
            ]"
            aria-label="X 凭据方式"
            @update:model-value="(v: string | number) => (xForm.mode = v as 'cookie' | 'token')"
          />
          <div class="space-y-3">
            <FieldStack v-if="xForm.mode === 'cookie'" label="Cookie" for="ob-x-cookie">
              <Textarea
                id="ob-x-cookie"
                v-model="xForm.cookie"
                :rows="3"
                placeholder="auth_token=…; ct0=…; …"
                :disabled="!accounts.x.available"
              />
            </FieldStack>
            <template v-else>
              <FieldStack label="auth_token" for="ob-x-auth">
                <Input id="ob-x-auth" v-model="xForm.authToken" type="password" placeholder="auth_token" :disabled="!accounts.x.available" />
              </FieldStack>
              <FieldStack label="ct0" for="ob-x-ct0">
                <Input id="ob-x-ct0" v-model="xForm.ct0" type="password" placeholder="ct0" :disabled="!accounts.x.available" />
              </FieldStack>
            </template>
            <FieldStack label="代理（可选）" for="ob-x-proxy">
              <Input id="ob-x-proxy" v-model="xForm.proxy" placeholder="http://127.0.0.1:7890" :disabled="!accounts.x.available" />
            </FieldStack>
          </div>
          <div class="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              :loading="xForm.saving"
              :disabled="!accounts.x.available"
              @click="submitXLogin"
            >
              保存并验证
            </Button>
            <Button variant="ghost" size="sm" :loading="xForm.probing" :disabled="!accounts.x.available" @click="probeX">
              验证登录
            </Button>
          </div>
        </SurfaceCard>
      </div>

      <!-- 步骤 5：完成 -->
      <div v-else class="space-y-6">
        <div class="flex items-center gap-2 text-control text-foreground">
          <Check class="size-4" />
          准备好了
        </div>
        <div class="divide-y divide-border rounded-md bg-section-card">
          <div v-for="item in summary" :key="item.label" class="flex items-center justify-between gap-4 px-4 py-3">
            <span class="text-label text-muted-foreground">{{ item.label }}</span>
            <span class="text-control text-foreground">{{ item.value }}</span>
          </div>
        </div>
        <p class="text-label text-muted-foreground">
          进入对话后可以直接和她说话；所有设置之后都能在左侧导航里调整。
        </p>
      </div>
    </main>

    <!-- 底部导航 -->
    <footer class="mx-auto flex w-full max-w-xl items-center justify-between gap-3 px-6 pb-10">
      <Button variant="ghost" :disabled="step === 1" @click="prev">上一步</Button>
      <div class="flex items-center gap-2">
        <Button v-if="step === 4" variant="ghost" @click="skipAccounts">
          <SkipForward class="size-4" />
          暂时跳过
        </Button>
        <Button :disabled="step !== 4 && step !== 5 ? !canNext : saving" @click="next">
          <Spinner v-if="saving" class="size-4" />
          {{ step === 5 ? '进入对话' : '继续' }}
        </Button>
      </div>
    </footer>
  </div>
</template>
