<script setup lang="ts">
/**
 * 记忆检查器 —— 记忆是提示，不是证据；拿不准的事，回原话里看。
 *
 * 行为基线：旧 React MemoriesPage（联系人/类别/「含已淡忘」过滤、台账、新建/编辑、
 * 淡忘/恢复、整理预览+落库）。旧页的「检索账本占位」区块**没有搬**：后端仍没有
 * 检索账本数据，留一个假面板比没有更糟；台账（explain）里已有召回理由。
 *
 * 语义：DELETE 是软删=淡忘，永不物理删除；列表默认只返回未淡忘，开关打开后
 * 同时返回已淡忘（后端 includeDeleted=true 的语义）。
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
import { WandSparkles, Plus, ScrollText, Pencil, RotateCcw, Trash2 } from 'lucide-vue-next'
import { errText, fmtAgo, fmtDateTime, fromLocalInput, toLocalInput } from '@/pages/her/shared/format'
import { contactsApi, type Contact } from '@/pages/contacts/api'
import { useAuthStore } from '@/stores/auth'
import { useBots } from '@/stores/bots'
import {
  MEMORY_CATEGORIES,
  memoriesApi,
  type ConsolidatePreview,
  type ConsolidateResult,
  type Memory,
  type MemoryExplain,
} from './api'

const auth = useAuthStore()
const bots = useBots()
const botId = computed(() => bots.currentBotId.value ?? '')
const selfId = computed(() => auth.state.user?.id ?? '')

const contacts = ref<Contact[]>([])
const memories = ref<Memory[]>([])
const loading = ref(false)
const loadError = ref('')

const senderFilter = ref('__all__')
const categoryFilter = ref('__all__')
const includeDeleted = ref(false)

interface MemoryForm {
  id: string | null
  sender: string
  content: string
  category: string
  importance: number
  provenance: string
  tagsText: string
  validUntil: string
}

const form = ref<MemoryForm | null>(null)
const saving = ref(false)
const forgetTarget = ref<Memory | null>(null)
const forgetting = ref(false)

const ledgerId = ref<string | null>(null)
const ledger = ref<MemoryExplain | undefined>(undefined)
const ledgerLoading = ref(false)
const ledgerError = ref('')

const consolidateOpen = ref(false)
const consolidatePhase = ref<'dry' | 'applied'>('dry')
const consolidateLoading = ref(false)
const consolidatePreview = ref<ConsolidatePreview | null>(null)
const consolidateResult = ref<ConsolidateResult | null>(null)
const consolidateSender = ref('')

const senderOptions = computed(() => {
  const options = contacts.value.map((c) => ({ value: c.id, label: c.name }))
  if (selfId.value && !options.some((o) => o.value === selfId.value)) {
    options.unshift({ value: selfId.value, label: '我（网页端）' })
  }
  return options
})

function categoryLabel(value: string): string {
  const found = MEMORY_CATEGORIES.find((c) => c.value === value)
  return found?.label ?? (value || '未分类')
}

function provenanceLabel(value: string): string {
  if (value === 'user-stated') return '对方说过'
  if (value === 'observed') return '她的观察'
  if (value === 'inferred') return '她的推断'
  return value || '未标注'
}

function senderName(sender: string): string {
  return contacts.value.find((c) => c.id === sender)?.name ?? sender
}

async function loadContacts(): Promise<void> {
  if (!botId.value) {
    contacts.value = []
    return
  }
  try {
    contacts.value = await contactsApi.list(botId.value)
  } catch {
    // 联系人只是下拉补充；失败不阻塞记忆列表
    contacts.value = []
  }
}

async function load(): Promise<void> {
  if (!botId.value) {
    memories.value = []
    return
  }
  loading.value = true
  loadError.value = ''
  try {
    memories.value = await memoriesApi.list(botId.value, {
      sender: senderFilter.value === '__all__' ? undefined : senderFilter.value,
      includeDeleted: includeDeleted.value,
    })
  } catch (e) {
    memories.value = []
    loadError.value = errText(e)
  } finally {
    loading.value = false
  }
}

function defaultSender(): string {
  return (senderFilter.value !== '__all__' ? senderFilter.value : '') || contacts.value[0]?.id || selfId.value
}

function openCreate(): void {
  const sender = defaultSender()
  if (!sender) {
    toast.error('先选择一个联系人或登录会话')
    return
  }
  form.value = {
    id: null,
    sender,
    content: '',
    category: 'fact',
    importance: 3,
    provenance: 'user-stated',
    tagsText: '',
    validUntil: '',
  }
}

function openEdit(memory: Memory): void {
  form.value = {
    id: memory.id,
    sender: memory.sender,
    content: memory.content,
    category: memory.category || 'fact',
    importance: memory.importance || 3,
    provenance: memory.provenance || 'user-stated',
    tagsText: memory.tags.join('、'),
    validUntil: toLocalInput(memory.validUntil),
  }
}

async function save(): Promise<void> {
  const f = form.value
  if (!f) return
  if (!f.content.trim()) {
    toast.error('记忆内容不能为空')
    return
  }
  saving.value = true
  try {
    const importance = Number.isFinite(f.importance) ? Math.min(5, Math.max(1, Math.round(f.importance))) : 3
    if (f.id) {
      await memoriesApi.update(f.id, {
        content: f.content.trim(),
        category: f.category,
        importance,
        tags: f.tagsText
          .split(/[,，、]/)
          .map((t) => t.trim())
          .filter(Boolean),
        validUntil: fromLocalInput(f.validUntil) ?? null,
      })
      toast.success('记忆已更新')
    } else {
      const result = await memoriesApi.create({
        botId: botId.value,
        sender: f.sender,
        content: f.content.trim(),
        category: f.category,
        importance,
        provenance: f.provenance,
        validUntil: fromLocalInput(f.validUntil),
      })
      toast.success(result.dupSkipped ? '这条记忆已经存在，未重复写入' : '记忆已写入')
    }
    form.value = null
    await load()
  } catch (e) {
    toast.error(errText(e))
  } finally {
    saving.value = false
  }
}

async function confirmForget(): Promise<void> {
  const target = forgetTarget.value
  if (!target) return
  forgetting.value = true
  try {
    await memoriesApi.forget(target.id)
    forgetTarget.value = null
    toast.success('已淡忘（进淡忘池，可恢复）')
    await load()
  } catch (e) {
    toast.error(errText(e))
  } finally {
    forgetting.value = false
  }
}

async function restore(memory: Memory): Promise<void> {
  try {
    await memoriesApi.restore(memory.id)
    toast.success('已恢复')
    await load()
  } catch (e) {
    toast.error(errText(e))
  }
}

async function openLedger(memory: Memory): Promise<void> {
  ledgerId.value = memory.id
  ledger.value = undefined
  ledgerError.value = ''
  ledgerLoading.value = true
  try {
    ledger.value = await memoriesApi.explain(botId.value, memory.id)
    if (!ledger.value) ledgerError.value = '后端没有返回台账数据'
  } catch (e) {
    ledgerError.value = errText(e)
  } finally {
    ledgerLoading.value = false
  }
}

function openConsolidate(): void {
  const sender = (senderFilter.value !== '__all__' ? senderFilter.value : '') || contacts.value[0]?.id || selfId.value
  if (!sender) {
    toast.error('整理按联系人为单位，先选择一个联系人')
    return
  }
  consolidateSender.value = sender
  consolidateOpen.value = true
  consolidatePreview.value = null
  consolidateResult.value = null
  void runConsolidateDry()
}

async function runConsolidateDry(): Promise<void> {
  consolidatePhase.value = 'dry'
  consolidateLoading.value = true
  try {
    const result = await memoriesApi.consolidate(botId.value, consolidateSender.value, true)
    consolidatePreview.value = result as ConsolidatePreview
  } catch (e) {
    toast.error(errText(e))
  } finally {
    consolidateLoading.value = false
  }
}

async function runConsolidateApply(): Promise<void> {
  consolidateLoading.value = true
  try {
    const result = await memoriesApi.consolidate(botId.value, consolidateSender.value, false)
    consolidateResult.value = result as ConsolidateResult
    consolidatePhase.value = 'applied'
    await load()
  } catch (e) {
    toast.error(errText(e))
  } finally {
    consolidateLoading.value = false
  }
}

const canApply = computed(() => (consolidatePreview.value?.pending ?? 0) >= 10)

const ledgerContent = computed(() => String(ledger.value?.memory['content'] ?? ''))

watch([botId], () => {
  void loadContacts()
  void load()
})
watch([senderFilter, categoryFilter, includeDeleted], () => void load())

onMounted(() => {
  void bots.bootstrap()
  void loadContacts()
  void load()
})
</script>

<template>
  <PageShell
    title="记忆检查器"
    description="记忆保真优先于风格——永不物理删除，只淡忘。每条记忆都能追溯到出处、时间与召回理由。"
  >
    <template #actions>
      <Button
        variant="outline"
        :disabled="!botId"
        @click="openConsolidate"
      >
        <WandSparkles />
        触发整理
      </Button>
      <Button
        :disabled="!botId"
        @click="openCreate"
      >
        <Plus />
        新建记忆
      </Button>
    </template>

    <Empty v-if="!botId">
      <EmptyHeader>
        <EmptyTitle>还没有可用的「她」</EmptyTitle>
        <EmptyDescription>先完成引导或创建一个角色卡，记忆才有归属。</EmptyDescription>
      </EmptyHeader>
    </Empty>

    <template v-else>
      <div class="space-y-6">
      <CalloutBanner
        v-if="loadError"
        tone="destructive"
        title="记忆加载失败"
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

      <!-- 过滤 -->
      <div class="flex flex-wrap items-end gap-4">
        <div class="w-48">
          <FieldStack label="联系人">
            <Select v-model="senderFilter">
              <SelectTrigger class="w-full">
                <SelectValue placeholder="全部联系人" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">全部联系人</SelectItem>
                <SelectItem
                  v-for="option in senderOptions"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </SelectItem>
              </SelectContent>
            </Select>
          </FieldStack>
        </div>
        <div class="w-40">
          <FieldStack label="类别">
            <Select v-model="categoryFilter">
              <SelectTrigger class="w-full">
                <SelectValue placeholder="全部类别" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">全部类别</SelectItem>
                <SelectItem
                  v-for="category in MEMORY_CATEGORIES"
                  :key="category.value"
                  :value="category.value"
                >
                  {{ category.label }}
                </SelectItem>
              </SelectContent>
            </Select>
          </FieldStack>
        </div>
        <label class="flex min-h-9 items-center gap-2 text-label">
          <Switch v-model="includeDeleted" />
          包含已淡忘
        </label>
      </div>

      <InlineLoadingRow
        v-if="loading && memories.length === 0"
        surface="tab"
        size="md"
      >
        正在读取记忆…
      </InlineLoadingRow>

      <Empty
        v-else-if="memories.length === 0"
      >
        <EmptyHeader>
          <EmptyTitle>{{ includeDeleted ? '淡忘池是空的' : '还没有记忆' }}</EmptyTitle>
          <EmptyDescription>
            {{ includeDeleted ? '还没有任何被淡忘的记忆。' : '多聊几次，她会自己记；也可以手动写入一条。' }}
          </EmptyDescription>
        </EmptyHeader>
        <Button
          variant="outline"
          @click="openCreate"
        >
          <Plus />
          新建记忆
        </Button>
      </Empty>

      <SettingsSection
        v-else
        :title="`记忆（${memories.length}）`"
      >
        <template #actions>
          <span class="text-caption text-muted-foreground">
            最近 5 条为硬保护，整理时不会被删
          </span>
        </template>
        <SettingsRow
          v-for="(memory, index) in memories"
          :key="memory.id"
          align="start"
          :divider="index < memories.length - 1"
        >
          <template #content>
            <div class="min-w-0 space-y-1.5">
              <div class="flex flex-wrap items-center gap-1.5">
                <Badge
                  v-if="memory.protected"
                  variant="info"
                >
                  硬保护
                </Badge>
                <Badge
                  v-if="memory.deleted"
                  variant="warning"
                >
                  已淡忘
                </Badge>
                <Badge
                  v-if="memory.supersededBy"
                  variant="secondary"
                >
                  已被取代
                </Badge>
                <Badge variant="outline">
                  {{ categoryLabel(memory.category) }}
                </Badge>
              </div>
              <p class="whitespace-pre-wrap text-body text-foreground">
                {{ memory.content }}
              </p>
              <p class="text-caption text-muted-foreground">
                {{ senderName(memory.sender) }} · 重要度 {{ memory.importance }} · {{ provenanceLabel(memory.provenance) }} · 记于 {{ fmtAgo(memory.recordedAt) }}
              </p>
              <p
                v-if="memory.tags.length > 0"
                class="text-caption text-muted-foreground"
              >
                标签：{{ memory.tags.join('、') }}
              </p>
              <p
                v-if="memory.deleted && memory.deletedReason"
                class="text-caption text-muted-foreground"
              >
                淡忘原因：{{ memory.deletedReason }}（{{ fmtDateTime(memory.deletedAt) }}）
              </p>
            </div>
          </template>

          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="查看记忆台账"
            @click="openLedger(memory)"
          >
            <ScrollText />
          </Button>
          <Button
            v-if="!memory.deleted"
            variant="ghost"
            size="icon-sm"
            aria-label="编辑记忆"
            @click="openEdit(memory)"
          >
            <Pencil />
          </Button>
          <Button
            v-if="!memory.deleted"
            variant="ghost"
            size="icon-sm"
            aria-label="淡忘这条记忆"
            @click="forgetTarget = memory"
          >
            <Trash2 />
          </Button>
          <Button
            v-else
            variant="ghost"
            size="icon-sm"
            aria-label="恢复这条记忆"
            @click="restore(memory)"
          >
            <RotateCcw />
          </Button>
        </SettingsRow>
      </SettingsSection>
      </div>
    </template>

    <!-- 台账 -->
    <Dialog
      :open="ledgerId !== null"
      @update:open="(open) => { if (!open) ledgerId = null }"
    >
      <DialogPanel width="2xl">
        <DialogHeader>
          <DialogTitle>记忆台账</DialogTitle>
        </DialogHeader>
        <DialogBody class="space-y-5">
          <InlineLoadingRow
            v-if="ledgerLoading"
            size="sm"
          >
            读取台账…
          </InlineLoadingRow>
          <CalloutBanner
            v-else-if="ledgerError"
            tone="destructive"
            title="台账读取失败"
            :description="ledgerError"
          />
          <template v-else-if="ledger">
            <SettingsSection title="内容">
              <SettingsRow
                label="记忆"
                :description="ledgerContent"
                align="start"
              >
                <Badge
                  v-if="ledger.protected"
                  variant="info"
                >
                  硬保护
                </Badge>
              </SettingsRow>
              <SettingsRow
                label="出处"
                :description="ledger.provenance.note"
                :divider="false"
              >
                <Badge variant="outline">
                  {{ provenanceLabel(ledger.provenance.kind) }}
                </Badge>
              </SettingsRow>
            </SettingsSection>

            <SettingsSection title="三层时间">
              <SettingsRow
                label="发生"
                :description="ledger.timing.eventTime || '（未标注）'"
              >
                <span class="text-caption text-muted-foreground">{{ ledger.timing.eventTimeRaw }}</span>
              </SettingsRow>
              <SettingsRow
                label="记录"
                :description="ledger.timing.recordedAt || '（无）'"
              />
              <SettingsRow
                label="最后核验"
                :description="ledger.timing.lastVerified || '（从未核验）'"
                :divider="false"
              />
              <div class="px-4 pb-3 text-caption text-muted-foreground">
                半衰期 {{ ledger.timing.halfLifeDays }} 天 · 波动性 {{ ledger.timing.volatility || '—' }} · 衰减按发生时间
              </div>
            </SettingsSection>

            <SettingsSection title="取代与墓碑">
              <SettingsRow label="已淡忘">
                <span class="text-body text-foreground">{{ ledger.tombstone.deleted ? '是' : '否' }}</span>
              </SettingsRow>
              <SettingsRow
                v-if="ledger.tombstone.deleted"
                label="淡忘原因"
                :description="ledger.tombstone.deletedReason"
                :divider="false"
              />
              <SettingsRow
                v-if="ledger.tombstone.supersededBy"
                label="被取代为"
                :description="ledger.tombstone.supersededByContent"
                :divider="false"
              />
              <SettingsRow
                v-for="(from, index) in ledger.tombstone.supersededFrom"
                :key="from.id"
                label="它取代了"
                :description="from.content"
                :divider="index < ledger.tombstone.supersededFrom.length - 1"
              />
            </SettingsSection>

            <SettingsSection title="召回理由">
              <SettingsRow label="命中通道">
                <Badge variant="secondary">
                  {{ ledger.retrieval.matchedBy || '—' }}
                </Badge>
              </SettingsRow>
              <SettingsRow label="总分">
                <span class="text-body text-foreground">{{ ledger.retrieval.score.toFixed(3) }}</span>
              </SettingsRow>
              <SettingsRow
                label="相关 / 重要 / 新近"
                :divider="false"
              >
                <span class="text-caption text-muted-foreground">
                  {{ ledger.retrieval.signals.relevance.toFixed(2) }} / {{ ledger.retrieval.signals.importance.toFixed(2) }} / {{ ledger.retrieval.signals.recency.toFixed(2) }}
                </span>
              </SettingsRow>
            </SettingsSection>
          </template>
        </DialogBody>
        <DialogFooter>
          <Button
            variant="outline"
            @click="ledgerId = null"
          >
            关闭
          </Button>
        </DialogFooter>
      </DialogPanel>
    </Dialog>

    <!-- 新建/编辑 -->
    <Dialog
      :open="form !== null"
      @update:open="(open) => { if (!open) form = null }"
    >
      <DialogPanel width="2xl" footer>
        <DialogHeader>
          <DialogTitle>{{ form?.id ? '编辑记忆' : '新建记忆' }}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <FormStack v-if="form">
            <div
              v-if="!form.id"
              class="grid gap-4 sm:grid-cols-2"
            >
              <FieldStack
                label="属于谁"
                help="记忆按 (她, 联系人) 隔离；整理也按这个单位进行。"
              >
                <Select v-model="form.sender">
                  <SelectTrigger class="w-full">
                    <SelectValue placeholder="选择联系人" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem
                      v-for="option in senderOptions"
                      :key="option.value"
                      :value="option.value"
                    >
                      {{ option.label }}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </FieldStack>
              <FieldStack
                label="出处"
                help="对方说过的记忆最可靠；推断类记忆会随核验衰减。"
              >
                <Select v-model="form.provenance">
                  <SelectTrigger class="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="user-stated">对方说过</SelectItem>
                    <SelectItem value="observed">她的观察</SelectItem>
                    <SelectItem value="inferred">她的推断</SelectItem>
                  </SelectContent>
                </Select>
              </FieldStack>
            </div>
            <div class="grid gap-4 sm:grid-cols-2">
              <FieldStack label="类别">
                <Select v-model="form.category">
                  <SelectTrigger class="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem
                      v-for="category in MEMORY_CATEGORIES"
                      :key="category.value"
                      :value="category.value"
                    >
                      {{ category.label }}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </FieldStack>
              <FieldStack
                label="重要度（1-5）"
                help="数字越大衰减越慢、越容易被想起。"
              >
                <Input
                  v-model.number="form.importance"
                  type="number"
                  min="1"
                  max="5"
                />
              </FieldStack>
            </div>
            <FieldStack label="内容">
              <Textarea
                v-model="form.content"
                :rows="4"
                placeholder="一条事实性、可追溯的记忆"
              />
            </FieldStack>
            <div class="grid gap-4 sm:grid-cols-2">
              <FieldStack
                v-if="form.id"
                label="标签"
                help="逗号分隔。"
              >
                <Input
                  v-model="form.tagsText"
                  placeholder="例如：家人、工作"
                />
              </FieldStack>
              <FieldStack
                label="有效期至"
                help="可选。过期的记忆不再参与召回，但保留可查。"
              >
                <Input
                  v-model="form.validUntil"
                  type="datetime-local"
                />
              </FieldStack>
            </div>
          </FormStack>
        </DialogBody>
        <DialogFooter>
          <Button
            variant="outline"
            @click="form = null"
          >
            取消
          </Button>
          <Button
            :loading="saving"
            :disabled="!form || !form.content.trim()"
            @click="save"
          >
            保存
          </Button>
        </DialogFooter>
      </DialogPanel>
    </Dialog>

    <!-- 整理 -->
    <Dialog
      :open="consolidateOpen"
      @update:open="(open) => { consolidateOpen = open }"
    >
      <DialogPanel width="xl" footer>
        <DialogHeader>
          <DialogTitle>整理记忆</DialogTitle>
        </DialogHeader>
        <DialogBody class="space-y-4">
          <p class="text-body text-muted-foreground">
            整理对象：{{ senderName(consolidateSender) }}。先预览活跃记忆规模，再决定是否让 AI 整理（最近 5 条受硬保护，不会被删）。
          </p>
          <InlineLoadingRow
            v-if="consolidateLoading"
            size="sm"
          >
            处理中…
          </InlineLoadingRow>
          <template v-else-if="consolidatePhase === 'dry'">
            <CalloutBanner
              v-if="consolidatePreview"
              tone="neutral"
              title="预览结果"
              :description="consolidatePreview.note"
            />
          </template>
          <template v-else-if="consolidateResult">
            <SettingsSection title="整理完成">
              <SettingsRow label="整理前">
                <span class="text-body text-foreground">{{ consolidateResult.before }} 条</span>
              </SettingsRow>
              <SettingsRow label="删除">
                <span class="text-body text-foreground">{{ consolidateResult.deleted }} 条</span>
              </SettingsRow>
              <SettingsRow label="合并">
                <span class="text-body text-foreground">{{ consolidateResult.compressed }} 条</span>
              </SettingsRow>
              <SettingsRow label="保留">
                <span class="text-body text-foreground">{{ consolidateResult.kept }} 条</span>
              </SettingsRow>
              <SettingsRow
                label="硬保护"
                :divider="false"
              >
                <span class="text-body text-foreground">{{ consolidateResult.recentProtected }} 条</span>
              </SettingsRow>
            </SettingsSection>
          </template>
        </DialogBody>
        <DialogFooter>
          <Button
            variant="outline"
            @click="consolidateOpen = false"
          >
            关闭
          </Button>
          <Button
            v-if="consolidatePhase === 'dry'"
            :disabled="!canApply"
            :loading="consolidateLoading"
            @click="runConsolidateApply"
          >
            正式执行
          </Button>
          <Button
            v-else
            @click="consolidateOpen = false"
          >
            完成
          </Button>
        </DialogFooter>
      </DialogPanel>
    </Dialog>

    <ConfirmDeleteDialog
      :open="forgetTarget !== null"
      title="淡忘这条记忆？"
      description="记忆永不物理删除——淡忘只是移入可恢复的淡忘池。"
      cancel-label="取消"
      confirm-label="淡忘"
      :loading="forgetting"
      @update:open="(open) => { if (!open) forgetTarget = null }"
      @confirm="confirmForget"
    />
  </PageShell>
</template>
