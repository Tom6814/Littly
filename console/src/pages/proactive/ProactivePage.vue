<script setup lang="ts">
/**
 * 主动页 —— 把「主动消息（预约/承诺）」与「心声回响（心跳）」合并为一张页。
 *
 * 行为基线：
 * - 旧 定时消息页：列表、新建（时间 + 内容 + 严格度）、取消确认。
 * - 旧 设置页的 proactive 组：主动性开关、心跳开关、静默时段、每日上限、最小间隔。
 * 合并依据 SPEC §4 新 IA（主动 = 她主动找你的两条线）。
 *
 * 设置写的是 `PATCH /api/bots/:id`（后端 admin 门禁）；非管理员只读+提示，
 * 避免出现「点了没反应」。
 */
import { computed, onMounted, ref, watch } from 'vue'
import {
  Badge,
  Button,
  CalloutBanner,
  ConfirmDeleteDialog,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  FieldStack,
  FormStack,
  InlineLoadingRow,
  Input,
  PageShell,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingsRow,
  SettingsSection,
  Switch,
  Textarea,
  toast,
} from '@felinic/ui'
import { Plus, Send, X } from 'lucide-vue-next'
import { errText, fmtDateTime, fmtSeconds, fromLocalInput, toLocalInput } from '@/pages/her/shared/format'
import { useAuthStore } from '@/stores/auth'
import { useBots } from '@/stores/bots'
import {
  proactiveSettingsApi,
  scheduledApi,
  type ProactiveSettings,
  type ScheduledMessage,
} from './api'

const auth = useAuthStore()
const bots = useBots()
const botId = computed(() => bots.currentBotId.value ?? '')
const isAdmin = computed(() => auth.state.user?.role === 'admin')

const messages = ref<ScheduledMessage[]>([])
const settings = ref<ProactiveSettings | null>(null)
const loading = ref(false)
const loadError = ref('')
const savingSettings = ref(false)

const createOpen = ref(false)
const createForm = ref({ fireAt: toLocalInput(new Date(Date.now() + 3_600_000).toISOString()), prompt: '', strictness: '3' })
const creating = ref(false)
const cancelTarget = ref<ScheduledMessage | null>(null)
const cancelling = ref(false)

const STATUS_LABEL: Record<string, string> = {
  pending: '待触发',
  fired: '已发送',
  sent: '已发送',
  cancelled: '已取消',
  failed: '失败',
}
const STRICTNESS_LABEL: Record<number, string> = {
  1: '必须发生',
  2: '尽量发生',
  3: '可以错过',
}

async function load(): Promise<void> {
  if (!botId.value) {
    messages.value = []
    settings.value = null
    return
  }
  loading.value = true
  loadError.value = ''
  try {
    const [list, proactive] = await Promise.all([
      scheduledApi.list(botId.value),
      proactiveSettingsApi.get(botId.value),
    ])
    messages.value = list
    settings.value = proactive
  } catch (e) {
    loadError.value = errText(e)
  } finally {
    loading.value = false
  }
}

async function saveSetting<K extends keyof ProactiveSettings>(key: K, value: ProactiveSettings[K]): Promise<void> {
  if (!settings.value || !botId.value || !isAdmin.value) return
  const previous = settings.value[key]
  settings.value = { ...settings.value, [key]: value }
  savingSettings.value = true
  try {
    await proactiveSettingsApi.save(botId.value, { [key]: value } as Partial<ProactiveSettings>)
  } catch (e) {
    settings.value = { ...settings.value, [key]: previous }
    toast.error(errText(e))
  } finally {
    savingSettings.value = false
  }
}

function openCreate(): void {
  createForm.value = {
    fireAt: toLocalInput(new Date(Date.now() + 3_600_000).toISOString()),
    prompt: '',
    strictness: '3',
  }
  createOpen.value = true
}

async function createMessage(): Promise<void> {
  if (!botId.value) return
  const fireAt = fromLocalInput(createForm.value.fireAt)
  if (!fireAt) {
    toast.error('请选择触发时间')
    return
  }
  if (!createForm.value.prompt.trim()) {
    toast.error('写一句她想说的话')
    return
  }
  creating.value = true
  try {
    await scheduledApi.create({
      botId: botId.value,
      fireAt,
      prompt: createForm.value.prompt.trim(),
      strictness: Number(createForm.value.strictness),
      origin: 'console',
    })
    createOpen.value = false
    toast.success('已创建定时消息')
    await load()
  } catch (e) {
    toast.error(errText(e))
  } finally {
    creating.value = false
  }
}

async function confirmCancel(): Promise<void> {
  const target = cancelTarget.value
  if (!target) return
  cancelling.value = true
  try {
    await scheduledApi.cancel(target.id)
    cancelTarget.value = null
    toast.success('已取消')
    await load()
  } catch (e) {
    toast.error(errText(e))
  } finally {
    cancelling.value = false
  }
}

function statusBadge(status: string): 'warning' | 'success' | 'destructive' | 'secondary' {
  if (status === 'pending') return 'warning'
  if (status === 'failed') return 'destructive'
  if (status === 'cancelled') return 'secondary'
  return 'success'
}

const HOURS = Array.from({ length: 24 }, (_, i) => i)

watch(botId, () => void load())
onMounted(() => {
  void bots.bootstrap()
  void load()
})
</script>

<template>
  <PageShell
    title="主动"
    description="她主动找你的两条线：预约好的话，和静下来时想起你的心声。"
  >
    <template #actions>
      <Button
        :disabled="!botId"
        @click="openCreate"
      >
        <Plus />
        新建定时消息
      </Button>
    </template>

    <Empty v-if="!botId">
      <EmptyHeader>
        <EmptyTitle>还没有可用的「她」</EmptyTitle>
        <EmptyDescription>先完成引导或创建一个角色卡，主动线才有主体。</EmptyDescription>
      </EmptyHeader>
    </Empty>

    <template v-else>
      <CalloutBanner
        v-if="loadError"
        tone="destructive"
        title="主动线加载失败"
        :description="loadError"
      >
        <Button
          variant="outline"
          size="sm"
          @click="load"
        >
          重试
        </Button>
      </CalloutBanner>

      <InlineLoadingRow
        v-else-if="loading && settings === null"
        surface="tab"
        size="md"
      >
        正在读取主动线…
      </InlineLoadingRow>

      <template v-else>
        <div class="space-y-6">
        <CalloutBanner
          v-if="settings === null"
          tone="warning"
          title="读取不到角色设置"
          description="主动线设置未返回（可能没有可用的 bot 配置）。定时消息仍可管理。"
        >
          <Button
            variant="outline"
            size="sm"
            @click="load"
          >
            重试
          </Button>
        </CalloutBanner>

        <!-- 主动消息 -->
        <SettingsSection title="主动消息">
          <template #actions>
            <span class="text-caption text-muted-foreground">{{ messages.length }} 条</span>
          </template>
          <div
            v-if="messages.length === 0"
            class="px-4 py-8 text-center"
          >
            <p class="text-body text-muted-foreground">
              没有定时消息。安排一件她想在某个时刻对你说的事。
            </p>
          </div>
          <SettingsRow
            v-for="(message, index) in messages"
            :key="message.id"
            align="start"
            :label="fmtDateTime(message.fireAt)"
            :description="message.prompt"
            :divider="index < messages.length - 1"
          >
            <div class="flex items-center gap-2">
              <Badge :variant="statusBadge(message.status)">
                {{ STATUS_LABEL[message.status] ?? message.status }}
              </Badge>
              <Button
                v-if="message.status === 'pending'"
                variant="ghost"
                size="icon-sm"
                aria-label="取消定时消息"
                @click="cancelTarget = message"
              >
                <X />
              </Button>
            </div>
          </SettingsRow>
          <div
            v-if="messages.length > 0"
            class="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-caption text-muted-foreground"
          >
            <span>履约等级：
              <template
                v-for="(label, level) in STRICTNESS_LABEL"
                :key="level"
              >
                {{ level }}={{ label }}<template v-if="Number(level) < 3"> · </template>
              </template>
            </span>
          </div>
        </SettingsSection>

        <!-- 心声回响 -->
        <SettingsSection title="心声回响">
          <template #actions>
            <span
              v-if="savingSettings"
              class="text-caption text-muted-foreground"
            >
              保存中…
            </span>
          </template>
          <CalloutBanner
            v-if="!isAdmin"
            tone="warning"
            title="需要管理员权限"
            description="主动线设置写的是角色级配置，只有管理员可以修改；下面为当前生效值，只读。"
          />
          <SettingsRow
            label="允许主动"
            description="总开关。关闭后她不会在非回复场景下主动开口。"
          >
            <Switch
              :model-value="settings?.enabled ?? false"
              :disabled="!isAdmin"
              aria-label="允许主动"
              @update:model-value="(value) => saveSetting('enabled', value === true)"
            />
          </SettingsRow>
          <SettingsRow
            label="心声回响"
            description="安静时她会想起你，按指数退避决定要不要开口；静默扫描不打扰。"
          >
            <Switch
              :model-value="settings?.heartbeatEnabled ?? false"
              :disabled="!isAdmin"
              aria-label="心声回响"
              @update:model-value="(value) => saveSetting('heartbeatEnabled', value === true)"
            />
          </SettingsRow>
          <SettingsRow
            label="静默时段"
            description="这段时间里不主动打扰；跨午夜按自然理解（例如 23 点至 8 点）。"
            stack="sm"
          >
            <div class="flex items-center gap-2">
              <div class="w-20">
                <Select
                  :model-value="String(settings?.quietStart ?? 23)"
                  :disabled="!isAdmin"
                  @update:model-value="(value) => saveSetting('quietStart', Number(value))"
                >
                  <SelectTrigger class="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem
                      v-for="hour in HOURS"
                      :key="`start-${hour}`"
                      :value="String(hour)"
                    >
                      {{ String(hour).padStart(2, '0') }}:00
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <span class="text-body text-muted-foreground">至</span>
              <div class="w-20">
                <Select
                  :model-value="String(settings?.quietEnd ?? 8)"
                  :disabled="!isAdmin"
                  @update:model-value="(value) => saveSetting('quietEnd', Number(value))"
                >
                  <SelectTrigger class="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem
                      v-for="hour in HOURS"
                      :key="`end-${hour}`"
                      :value="String(hour)"
                    >
                      {{ String(hour).padStart(2, '0') }}:00
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </SettingsRow>
          <SettingsRow
            label="每日上限"
            description="一天最多主动开口几次。"
          >
            <div class="w-20">
              <Input
                :model-value="settings?.dailyLimit ?? 8"
                type="number"
                min="0"
                :disabled="!isAdmin"
                @change="(event: Event) => saveSetting('dailyLimit', Math.max(0, Math.round(Number((event.target as HTMLInputElement).value) || 0)))"
              />
            </div>
          </SettingsRow>
          <SettingsRow
            label="最小间隔"
            description="两次主动之间至少间隔多久（秒）。"
            :divider="false"
            stack="sm"
          >
            <div class="flex items-center gap-2">
              <div class="w-28">
                <Input
                  :model-value="settings?.minInterval ?? 7200"
                  type="number"
                  min="600"
                  step="600"
                  :disabled="!isAdmin"
                  @change="(event: Event) => saveSetting('minInterval', Math.max(60, Math.round(Number((event.target as HTMLInputElement).value) || 0)))"
                />
              </div>
              <span class="text-caption text-muted-foreground">
                约 {{ fmtSeconds(settings?.minInterval) }}
              </span>
            </div>
          </SettingsRow>
        </SettingsSection>
        </div>
      </template>
    </template>

    <!-- 新建定时消息 -->
    <Dialog
      :open="createOpen"
      @update:open="(open) => { createOpen = open }"
    >
      <DialogPanel width="lg" footer>
        <DialogHeader>
          <DialogTitle>新建定时消息</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <FormStack>
            <FieldStack label="触发时间">
              <Input
                v-model="createForm.fireAt"
                type="datetime-local"
              />
            </FieldStack>
            <FieldStack
              label="她想说什么"
              help="到点时她会围绕这句话开口，而不是逐字复述。"
            >
              <Textarea
                v-model="createForm.prompt"
                :rows="4"
                placeholder="例如：问问 TA 今天加班到几点，提醒 TA 吃饭"
              />
            </FieldStack>
            <FieldStack
              label="履约等级"
              help="1 必须发生（重要承诺）· 2 尽量发生 · 3 可以错过（默认，允许她自己判断）。"
            >
              <Select v-model="createForm.strictness">
                <SelectTrigger class="w-full">
                  <SelectValue placeholder="选择等级" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 · 必须发生</SelectItem>
                  <SelectItem value="2">2 · 尽量发生</SelectItem>
                  <SelectItem value="3">3 · 可以错过</SelectItem>
                </SelectContent>
              </Select>
            </FieldStack>
          </FormStack>
        </DialogBody>
        <DialogFooter>
          <Button
            variant="outline"
            @click="createOpen = false"
          >
            取消
          </Button>
          <Button
            :loading="creating"
            :disabled="!createForm.prompt.trim()"
            @click="createMessage"
          >
            <Send />
            创建
          </Button>
        </DialogFooter>
      </DialogPanel>
    </Dialog>

    <ConfirmDeleteDialog
      :open="cancelTarget !== null"
      title="取消这条定时消息？"
      :description="cancelTarget?.prompt || ''"
      cancel-label="保留"
      confirm-label="取消消息"
      :loading="cancelling"
      @update:open="(open) => { if (!open) cancelTarget = null }"
      @confirm="confirmCancel"
    />
  </PageShell>
</template>
