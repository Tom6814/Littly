<script setup lang="ts">
/**
 * 世界书页 —— 关键词触发条目（SillyTavern World Info 范式）。
 *
 * 行为基线：旧 React WorldbookPage（列表 + 编辑器 + 命中测试 + 删除确认）。
 * 命中测试与正式对话共用后端 evaluateWorldEntry（纯函数，不掷概率），所以
 * 这里的「运行测试」结果是确定的，不是模拟。
 *
 * 本版取舍：旧页用 chip 输入法录入 keys；这里用逗号分隔的单行输入 + 解析，
 * 能力等价（正则 `/pattern/flags` 也走同一个字符串），少一个自造控件。
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
import { Pencil, Plus, Play, Target, Trash2 } from 'lucide-vue-next'
import { errText } from './shared/format'
import { useBots } from '@/stores/bots'
import { worldbookApi, type WorldEntry, type WorldEntryInput } from './api'

const bots = useBots()
const botId = computed(() => bots.currentBotId.value ?? '')

/** 后端 WI_LOGIC 只有这四个；旧 UI 的 OR_ANY 在后端不存在，已剔除。 */
const LOGIC_OPTIONS = [
  { value: 'AND_ANY', label: '任一主关键词 + 任一次级（AND ANY）' },
  { value: 'AND_ALL', label: '全部主关键词 + 全部次级（AND ALL）' },
  { value: 'NOT_ALL', label: '全部主关键词且次级不全命中（NOT ALL）' },
  { value: 'NOT_ANY', label: '全部主关键词且次级全不命中（NOT ANY）' },
] as const

const entries = ref<WorldEntry[]>([])
const loading = ref(false)
const loadError = ref('')

const matchedIds = ref<string[]>([])

interface EntryForm {
  id: string | null
  keysText: string
  secondKeysText: string
  logic: string
  probability: number
  priority: number
  position: 'before' | 'after'
  constant: boolean
  enabled: boolean
  content: string
  comment: string
}

function emptyForm(): EntryForm {
  return {
    id: null,
    keysText: '',
    secondKeysText: '',
    logic: 'AND_ANY',
    probability: 85,
    priority: 100,
    position: 'after',
    constant: false,
    enabled: true,
    content: '',
    comment: '',
  }
}

const form = ref<EntryForm | null>(null)
const saving = ref(false)
const deleteTarget = ref<WorldEntry | null>(null)
const deleting = ref(false)

const testOpen = ref(false)
const testText = ref('')
const testing = ref(false)
const testResult = ref<string[] | null>(null)

function splitKeys(raw: string): string[] {
  return raw
    .split(/[,，、]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function formFromEntry(e: WorldEntry): EntryForm {
  return {
    id: e.id,
    keysText: e.keys.join('、'),
    secondKeysText: e.secondKeys.join('、'),
    logic: e.logic,
    probability: e.probability,
    priority: e.priority,
    position: e.position === 'before' ? 'before' : 'after',
    constant: e.constant,
    enabled: e.enabled,
    content: e.content,
    comment: e.comment,
  }
}

async function load(): Promise<void> {
  if (!botId.value) {
    entries.value = []
    return
  }
  loading.value = true
  loadError.value = ''
  try {
    entries.value = await worldbookApi.list(botId.value)
    matchedIds.value = []
  } catch (e) {
    entries.value = []
    loadError.value = errText(e)
  } finally {
    loading.value = false
  }
}

function openCreate(): void {
  form.value = emptyForm()
}

function openEdit(entry: WorldEntry): void {
  form.value = formFromEntry(entry)
}

function toInput(f: EntryForm): WorldEntryInput {
  return {
    botId: botId.value,
    keys: splitKeys(f.keysText),
    secondKeys: splitKeys(f.secondKeysText),
    logic: f.logic,
    probability: Number.isFinite(f.probability) ? Math.min(100, Math.max(0, Math.round(f.probability))) : 85,
    priority: Number.isFinite(f.priority) ? Math.round(f.priority) : 100,
    position: f.position,
    constant: f.constant,
    enabled: f.enabled,
    content: f.content,
    comment: f.comment,
  }
}

async function save(): Promise<void> {
  const f = form.value
  if (!f || !botId.value) return
  if (splitKeys(f.keysText).length === 0) {
    toast.error('至少填一个主关键词')
    return
  }
  saving.value = true
  try {
    const input = toInput(f)
    if (f.id) await worldbookApi.update(f.id, input)
    else await worldbookApi.create(input)
    form.value = null
    toast.success(f.id ? '词条已保存' : '词条已创建')
    await load()
  } catch (e) {
    toast.error(errText(e))
  } finally {
    saving.value = false
  }
}

async function confirmDelete(): Promise<void> {
  const target = deleteTarget.value
  if (!target) return
  deleting.value = true
  try {
    await worldbookApi.remove(target.id)
    deleteTarget.value = null
    toast.success('词条已删除')
    await load()
  } catch (e) {
    toast.error(errText(e))
  } finally {
    deleting.value = false
  }
}

async function runTest(): Promise<void> {
  if (!botId.value || !testText.value.trim()) return
  testing.value = true
  try {
    testResult.value = await worldbookApi.test(botId.value, testText.value.trim())
    matchedIds.value = testResult.value
  } catch (e) {
    toast.error(errText(e))
  } finally {
    testing.value = false
  }
}

function logicLabel(value: string): string {
  return LOGIC_OPTIONS.find((o) => o.value === value)?.label ?? value
}

function preview(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat
}

const hitEntries = computed(() => entries.value.filter((e) => (testResult.value ?? []).includes(e.id)))

watch(botId, () => void load())
onMounted(() => {
  void bots.bootstrap()
  void load()
})
</script>

<template>
  <PageShell
    title="世界书"
    description="她所知道的世界，按关键词注入。命中测试与正式对话共用同一套判定。"
  >
    <template #actions>
      <Button
        variant="outline"
        :disabled="!botId || entries.length === 0"
        @click="testOpen = true"
      >
        <Target />
        命中测试
      </Button>
      <Button
        :disabled="!botId"
        @click="openCreate"
      >
        <Plus />
        新增词条
      </Button>
    </template>

    <Empty v-if="!botId">
      <EmptyHeader>
        <EmptyTitle>还没有可用的「她」</EmptyTitle>
        <EmptyDescription>先完成引导或创建一个角色卡，世界书才有注入对象。</EmptyDescription>
      </EmptyHeader>
    </Empty>

    <template v-else>
      <CalloutBanner
        v-if="loadError"
        tone="destructive"
        title="世界书加载失败"
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
        v-else-if="loading && entries.length === 0"
        surface="tab"
        size="md"
      >
        正在读取世界书…
      </InlineLoadingRow>

      <Empty v-else-if="entries.length === 0">
        <EmptyHeader>
          <EmptyTitle>世界书还是空的</EmptyTitle>
          <EmptyDescription>添加第一批词条，让她了解你的世界。</EmptyDescription>
        </EmptyHeader>
        <Button
          variant="outline"
          @click="openCreate"
        >
          <Plus />
          新增词条
        </Button>
      </Empty>

      <SettingsSection
        v-else
        title="词条"
      >
        <template #actions>
          <span class="text-caption text-muted-foreground">
            {{ entries.length }} / 16（单轮最多注入 16 条）
          </span>
        </template>

        <SettingsRow
          v-for="(entry, index) in entries"
          :key="entry.id"
          align="start"
          :divider="index < entries.length - 1"
        >
          <template #content>
            <div class="min-w-0 space-y-1.5">
              <div class="flex flex-wrap items-center gap-1.5">
                <Badge
                  v-for="key in entry.keys"
                  :key="key"
                  variant="outline"
                >
                  {{ key }}
                </Badge>
                <Badge
                  v-for="key in entry.secondKeys"
                  :key="`second-${key}`"
                  variant="secondary"
                >
                  {{ key }}
                </Badge>
                <Badge
                  v-if="matchedIds.includes(entry.id)"
                  variant="success"
                >
                  本轮命中
                </Badge>
                <Badge
                  v-if="!entry.enabled"
                  variant="warning"
                >
                  已停用
                </Badge>
                <Badge
                  v-if="entry.constant"
                  variant="info"
                >
                  常驻
                </Badge>
              </div>
              <p class="text-caption text-muted-foreground">
                {{ logicLabel(entry.logic) }} · 概率 {{ entry.probability }}% · 优先级
                {{ entry.priority }} · 注入在角色卡{{ entry.position === 'before' ? '之前' : '之后' }}
              </p>
              <p class="text-body text-foreground">
                {{ preview(entry.content) || '（空内容）' }}
              </p>
              <p
                v-if="entry.comment"
                class="text-caption text-muted-foreground"
              >
                备注：{{ entry.comment }}
              </p>
            </div>
          </template>

          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="编辑词条"
            @click="openEdit(entry)"
          >
            <Pencil />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="删除词条"
            @click="deleteTarget = entry"
          >
            <Trash2 />
          </Button>
        </SettingsRow>
      </SettingsSection>
    </template>

    <!-- 词条编辑器 -->
    <Dialog
      :open="form !== null"
      @update:open="(open) => { if (!open) form = null }"
    >
      <DialogPanel
        width="2xl"
        footer
      >
        <DialogHeader>
          <DialogTitle>{{ form?.id ? '编辑词条' : '新增词条' }}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <FormStack v-if="form">
            <FieldStack
              label="主关键词"
              help="逗号分隔；支持 /正则/flags。任一/全部命中按下面的逻辑判定。"
            >
              <Input v-model="form.keysText" />
            </FieldStack>
            <FieldStack
              label="次级关键词"
              help="可选。配合逻辑做「且不含 / 且不全含」这类附加条件。"
            >
              <Input v-model="form.secondKeysText" />
            </FieldStack>
            <div class="grid gap-4 sm:grid-cols-2">
              <FieldStack label="命中逻辑">
                <Select v-model="form.logic">
                  <SelectTrigger class="w-full">
                    <SelectValue placeholder="选择逻辑" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem
                      v-for="option in LOGIC_OPTIONS"
                      :key="option.value"
                      :value="option.value"
                    >
                      {{ option.label }}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </FieldStack>
              <FieldStack label="注入位置">
                <Select v-model="form.position">
                  <SelectTrigger class="w-full">
                    <SelectValue placeholder="选择位置" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="before">角色卡之前</SelectItem>
                    <SelectItem value="after">角色卡之后</SelectItem>
                  </SelectContent>
                </Select>
              </FieldStack>
              <FieldStack
                label="触发概率（0-100）"
                help="命中后再按概率决定是否注入；常驻词条不受概率影响。"
              >
                <Input
                  v-model.number="form.probability"
                  type="number"
                  min="0"
                  max="100"
                  step="5"
                />
              </FieldStack>
              <FieldStack
                label="优先级"
                help="数字越大越优先；超出预算时先裁低优先级。"
              >
                <Input
                  v-model.number="form.priority"
                  type="number"
                />
              </FieldStack>
            </div>
            <div class="flex flex-wrap items-center gap-x-6 gap-y-2">
              <label class="flex items-center gap-2 text-label">
                <Switch v-model="form.constant" />
                常驻（每轮必注入）
              </label>
              <label class="flex items-center gap-2 text-label">
                <Switch v-model="form.enabled" />
                启用
              </label>
            </div>
            <FieldStack label="内容">
              <Textarea
                v-model="form.content"
                :rows="6"
                placeholder="命中后注入给她的世界设定文本"
              />
            </FieldStack>
            <FieldStack label="备注">
              <Input
                v-model="form.comment"
                placeholder="给自己看的说明，不会注入"
              />
            </FieldStack>
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
            :disabled="!form || splitKeys(form.keysText).length === 0"
            @click="save"
          >
            保存
          </Button>
        </DialogFooter>
      </DialogPanel>
    </Dialog>

    <!-- 命中测试 -->
    <Dialog
      :open="testOpen"
      @update:open="(open) => { testOpen = open; if (!open) { testResult = null; matchedIds = [] } }"
    >
      <DialogPanel width="xl">
        <DialogHeader>
          <DialogTitle>命中测试</DialogTitle>
        </DialogHeader>
        <DialogBody class="space-y-4">
          <FieldStack
            label="模拟一段对话文本"
            help="粘贴一句话或一段消息，看看哪些词条会被注入。"
          >
            <Textarea
              v-model="testText"
              :rows="4"
              placeholder="例如：我明天要坐飞机去出差，老板又让我加班…"
            />
          </FieldStack>
          <div class="flex items-center gap-2">
            <Button
              :loading="testing"
              :disabled="!testText.trim()"
              @click="runTest"
            >
              <Play />
              运行测试
            </Button>
            <span
              v-if="testResult !== null"
              class="text-caption text-muted-foreground"
            >
              命中 {{ testResult.length }} 条
            </span>
          </div>
          <SettingsSection
            v-if="testResult !== null"
            title="命中结果"
          >
            <SettingsRow
              v-for="(entry, index) in hitEntries"
              :key="entry.id"
              :label="entry.keys.join('、') || '（无主关键词）'"
              :description="preview(entry.content) || '（空内容）'"
              align="start"
              :divider="index < hitEntries.length - 1"
            >
              <Badge variant="success">
                注入
              </Badge>
            </SettingsRow>
            <div
              v-if="hitEntries.length === 0"
              class="px-4 py-6 text-center text-body text-muted-foreground"
            >
              这段文本没有命中任何词条。
            </div>
          </SettingsSection>
        </DialogBody>
        <DialogFooter>
          <Button
            variant="outline"
            @click="testOpen = false"
          >
            关闭
          </Button>
        </DialogFooter>
      </DialogPanel>
    </Dialog>

    <ConfirmDeleteDialog
      :open="deleteTarget !== null"
      title="删除这条词条？"
      :description="deleteTarget ? deleteTarget.keys.join('、') : ''"
      cancel-label="取消"
      confirm-label="删除"
      :loading="deleting"
      @update:open="(open) => { if (!open) deleteTarget = null }"
      @confirm="confirmDelete"
    />
  </PageShell>
</template>
