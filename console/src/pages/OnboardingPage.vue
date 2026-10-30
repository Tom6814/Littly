<script setup lang="ts">
/**
 * 首次引导向导（5 步，全屏）：
 *   1 她是谁 → 2 模型连接（真实测试）→ 3 人格 → 4 接入微信（可跳过）→ 5 完成
 * 关键写操作都走后端：模型设置 /api/settings/ai、角色卡 /api/characters、
 * 完成态 /api/onboarding/complete（契约接口未就绪时本地降级，不阻塞流程）。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  Button,
  CalloutBanner,
  FieldStack,
  Input,
  Spinner,
  Textarea,
} from '@felinic/ui'
import { BookHeart, Check, Heart, SkipForward } from 'lucide-vue-next'
import { charactersApi, personaApi, settingsApi, wechatApi } from '@/api/endpoints'
import { ApiError } from '@/api/client'
import { useBots } from '@/stores/bots'
import { useOnboardingStore } from '@/stores/onboarding'

const router = useRouter()
const onboarding = useOnboardingStore()
const bots = useBots()

const step = ref(1)
const STEP_LABELS = ['她是谁', '模型连接', '人格', '接入微信', '完成'] as const

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

/* ---------------- 步骤 4：微信 ---------------- */
const wechat = reactive({
  loading: false,
  bound: false,
  nickname: '',
  qrDataUrl: '',
  sessionId: '',
  status: 'wait' as string,
  pollTimer: 0 as number | ReturnType<typeof setInterval>,
})

/* ---------------- 生命周期 ---------------- */
onMounted(async () => {
  void bots.bootstrap()
  void loadRules()
  void loadPresets()
  void loadModelSettings()
  void loadWechatStatus()
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
  } catch {
    /* 接口未就绪（wechat 实现中） */
  }
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
    error.value = `微信绑定接口暂不可用：${e instanceof Error ? e.message : '未知错误'}（可先跳过）`
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

function skipWechat(): void {
  stopWechatPoll()
  onboarding.markStep('wechat', false)
  step.value = 5
}

/* ---------------- 步骤 5：完成 ---------------- */
const summary = computed(() => [
  { label: '名字', value: about.name || '未设置' },
  { label: '模型', value: model.model || '未设置' },
  { label: '人格', value: persona.characterName || about.name },
  {
    label: '微信',
    value: wechat.bound ? `已绑定${wechat.nickname ? `（${wechat.nickname}）` : ''}` : '未绑定（可稍后接入）',
  },
])

async function finish(): Promise<void> {
  saving.value = true
  stopWechatPoll()
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

      <!-- 步骤 4：接入微信 -->
      <div v-else-if="step === 4" class="space-y-6">
        <p class="text-control text-muted-foreground">
          绑定后，她会出现在你的微信里。今晚可以先跳过，之后在「连接 → 微信」随时绑定。
        </p>
        <div class="rounded-md bg-section-card p-3">
          <div class="flex items-center justify-between gap-3">
            <div>
              <div class="text-label font-medium text-foreground">
                {{ wechat.bound ? `已绑定${wechat.nickname ? `：${wechat.nickname}` : ''}` : '微信' }}
              </div>
              <div class="mt-0.5 text-caption text-muted-foreground">
                {{ wechat.bound ? '她会用微信和你聊天。' : '扫码后即可用微信找她。' }}
              </div>
            </div>
            <Button
              v-if="!wechat.bound"
              variant="outline"
              size="sm"
              :disabled="wechat.loading"
              @click="startWechatBind"
            >
              <Spinner v-if="wechat.loading" class="size-4" />
              生成二维码
            </Button>
          </div>

          <div v-if="wechat.qrDataUrl && !wechat.bound" class="mt-4 flex flex-col items-center gap-3">
            <img
              :src="wechat.qrDataUrl"
              alt="微信绑定二维码"
              class="size-48 rounded-md border border-border bg-card object-contain p-2"
            />
            <div class="text-label text-muted-foreground">
              {{
                wechat.status === 'wait'
                  ? '请用微信扫码'
                  : wechat.status === 'scanned' || wechat.status === 'scaned'
                    ? '已扫码，请在手机上确认'
                    : wechat.status === 'confirmed'
                      ? '绑定成功'
                      : '二维码已过期，正在刷新…'
              }}
            </div>
          </div>
        </div>

        <div class="flex items-center justify-between gap-3">
          <Button variant="ghost" @click="skipWechat">
            <SkipForward class="size-4" />
            暂时跳过
          </Button>
          <Button :disabled="!wechat.bound" @click="step = 5">继续</Button>
        </div>
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
      <Button :disabled="step !== 4 && step !== 5 ? !canNext : saving" @click="next">
        <Spinner v-if="saving" class="size-4" />
        {{ step === 5 ? '进入对话' : '继续' }}
      </Button>
    </footer>
  </div>
</template>
