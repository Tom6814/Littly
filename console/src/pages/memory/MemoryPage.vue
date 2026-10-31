<script setup lang="ts">
/**
 * 记忆 —— vault 浏览器（Markdown 真相 + 派生索引 + 暂存区整理）。
 *
 * 契约：/tmp/memory-system-spec.md §6（routes-memory-vault.ts，bugfix 并行实现）。
 *   GET  /api/memory/profile?botId&contactId（&rebuild=true 重建）
 *   GET  /api/memory/domains、/api/memory/entries、/api/memory/entries/:entryId
 *   PUT  /api/memory/entries/:entryId（admin 编辑/标记失效）
 *   GET  /api/memory/search、/api/memory/staging、/api/memory/dream/status
 *   POST /api/memory/staging/consolidate（admin）、/api/memory/migrate（admin）
 *   GET  /api/memories?includeDeleted=true（旧表，「淡忘池」tab 保留）
 * 每个 bot × 每个人一个 vault；对话中的淡忘池仍是旧 memories 表（迁移前只读过渡）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import {
  Badge,
  Button,
  CalloutBanner,
  ConfirmPopover,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Input,
  PageShell,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingsRow,
  SettingsSection,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  Spinner,
  StatusDot,
  SurfaceCard,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  toast,
} from '@felinic/ui'
import { ChevronLeft, RefreshCw, Search, Sparkles, WandSparkles } from 'lucide-vue-next'
import { fmtAgo, fmtDateTime } from '@/pages/her/shared/format'
import MarkdownView from './MarkdownView.vue'
import { contactsApi, type Contact } from '@/pages/contacts/api'
import { memoriesApi, type Memory } from './api'
import { useAuthStore } from '@/stores/auth'
import { useBots } from '@/stores/bots'
import {
  memoryVaultApi,
  type MemoryDreamStatus,
  type MemoryVaultDomain,
  type MemoryVaultEntry,
  type MemoryVaultEntryDetail,
  type MemoryVaultHit,
  type MemoryVaultProfile,
  type MemoryVaultStagingItem,
} from '@/api/endpoints'

const auth = useAuthStore()
const bots = useBots()
const isAdmin = computed(() => auth.state.user?.role === 'admin')

const TABS = [
  { value: 'profile', label: '档案' },
  { value: 'domains', label: '域' },
  { value: 'staging', label: '暂存' },
  { value: 'tombs', label: '墓碑' },
  { value: 'timeline', label: '时间线' },
] as const

const DOMAIN_LABELS: Record<string, string> = {
  'about-user': '关于你',
  interests: '兴趣',
  projects: '项目',
  life: '生活',
  relationships: '关系',
  feedback: '相处偏好',
  notes: '推断笔记',
  health: '健康',
  history: '历史墓碑',
}
const DOMAIN_ORDER = [
  'about-user',
  'interests',
  'projects',
  'life',
  'relationships',
  'feedback',
  'notes',
  'health',
  'history',
]

function domainLabel(domain: string): string {
  return DOMAIN_LABELS[domain] ?? domain
}

function kindLabel(kind: string): string {
  switch (kind) {
    case 'about-user':
      return '事实'
    case 'agent-note':
      return '推断（非事实）'
    case 'rule':
      return '规则'
    case 'manual':
      return '手记'
    default:
      return kind
  }
}

function provenanceLabel(provenance: string): string {
  switch (provenance) {
    case 'user-stated':
      return '用户原话'
    case 'observed':
      return '观察'
    case 'inferred':
      return '推断'
    default:
      return provenance
  }
}

/* ---------------- 选择器 ---------------- */
const botsList = computed(() => bots.state.bots)
const botId = ref('')
const contacts = ref<Contact[]>([])
const contactsLoading = ref(false)
const contactId = ref('')
const activeTab = ref('profile')
const vaultAvailable = ref(true)

/* ---------------- 数据 ---------------- */
const loading = ref(false)
const loadError = ref('')

const profile = ref<MemoryVaultProfile | null>(null)
const profileLoading = ref(false)
const rebuilding = ref(false)

const domains = ref<MemoryVaultDomain[]>([])
const domainsLoading = ref(false)
const activeDomain = ref('')
const entries = ref<MemoryVaultEntry[]>([])
const entriesLoading = ref(false)
const entriesError = ref('')

const timeline = ref<MemoryVaultEntry[]>([])
const timelineLoading = ref(false)
const timelineError = ref('')

const tombstones = ref<MemoryVaultEntry[]>([])
const tombsLoading = ref(false)
const tombsError = ref('')

const staging = ref<MemoryVaultStagingItem[]>([])
const stagingLoading = ref(false)
const stagingError = ref('')
const consolidating = ref(false)
const migrating = ref(false)
const dream = ref<MemoryDreamStatus | null>(null)

const searchQuery = ref('')
const searchHits = ref<MemoryVaultHit[]>([])
const searching = ref(false)
const searchDone = ref(false)

const forgotten = ref<Memory[]>([])
const forgottenLoading = ref(false)
const forgottenError = ref('')

/* 条目详情 Drawer */
const detailOpen = ref(false)
const detailLoading = ref(false)
const detail = ref<MemoryVaultEntryDetail | null>(null)
const detailError = ref('')
const editing = ref(false)
const editContent = ref('')
const editTags = ref('')
const editImportance = ref(1)
const savingEdit = ref(false)

onMounted(async () => {
  await bots.bootstrap()
  botId.value = bots.state.currentBotId ?? ''
  await loadContacts()
  if (botId.value !== '' && contactId.value !== '') await refreshAll()
})

watch(botId, async (value) => {
  if (value !== bots.state.currentBotId) bots.setCurrent(value)
  activeDomain.value = ''
  resetData()
  await loadContacts()
  if (botId.value !== '' && contactId.value !== '') await refreshAll()
})

watch(contactId, async () => {
  activeDomain.value = ''
  resetData()
  if (botId.value !== '' && contactId.value !== '') await refreshAll()
})

watch(activeTab, async (tab) => {
  if (!vaultAvailable.value) return
  if (tab === 'domains' && domains.value.length === 0) await loadDomains()
  if (tab === 'staging') await loadStaging()
  if (tab === 'tombs' && tombstones.value.length === 0) await loadTombs()
  if (tab === 'timeline' && timeline.value.length === 0) await loadTimeline()
  if (tab === 'forgotten' && forgotten.value.length === 0) await loadForgotten()
})

function resetData(): void {
  profile.value = null
  domains.value = []
  activeDomain.value = ''
  entries.value = []
  timeline.value = []
  tombstones.value = []
  staging.value = []
  forgotten.value = []
  searchHits.value = []
  searchDone.value = false
  searchQuery.value = ''
  dream.value = null
}

async function refreshAll(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    await loadProfile()
    await Promise.all([loadDomains(), loadDream()])
    if (activeTab.value === 'staging') await loadStaging()
    if (activeTab.value === 'timeline') await loadTimeline()
    if (activeTab.value === 'tombs') await loadTombs()
    if (activeTab.value === 'forgotten') await loadForgotten()
  } finally {
    loading.value = false
  }
}

async function loadContacts(): Promise<void> {
  if (botId.value === '') {
    contacts.value = []
    contactId.value = ''
    return
  }
  contactsLoading.value = true
  try {
    contacts.value = await contactsApi.list(botId.value)
    if (contacts.value.length === 0) {
      contactId.value = ''
      return
    }
    const current = contacts.value.find((c) => c.id === contactId.value)
    if (current === undefined) {
      const owner = contacts.value.find((c) => c.isOwner)
      contactId.value = (owner ?? contacts.value[0] ?? { id: '' }).id
    }
  } catch {
    contacts.value = []
  } finally {
    contactsLoading.value = false
  }
}

/* ---------------- 档案 ---------------- */
async function loadProfile(): Promise<void> {
  if (botId.value === '' || contactId.value === '') return
  profileLoading.value = true
  try {
    const out = await memoryVaultApi.profile(botId.value, contactId.value)
    vaultAvailable.value = out.available
    profile.value = out.available ? out : null
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : '读取档案失败'
  } finally {
    profileLoading.value = false
  }
}

async function rebuildProfile(): Promise<void> {
  if (botId.value === '' || contactId.value === '') return
  rebuilding.value = true
  try {
    profile.value = await memoryVaultApi.rebuildProfile(botId.value, contactId.value)
    toast.success('档案已按索引重建')
    await loadDomains()
  } catch (e) {
    toast.error(e instanceof Error ? e.message : '重建失败')
  } finally {
    rebuilding.value = false
  }
}

/* ---------------- 域 / 条目 ---------------- */
async function loadDomains(): Promise<void> {
  if (botId.value === '' || contactId.value === '') return
  domainsLoading.value = true
  try {
    const out = await memoryVaultApi.domains(botId.value, contactId.value)
    if (!out.available) {
      vaultAvailable.value = false
      domains.value = []
      return
    }
    domains.value = [...out.domains].sort((a, b) => {
      const ai = DOMAIN_ORDER.indexOf(a.domain)
      const bi = DOMAIN_ORDER.indexOf(b.domain)
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi)
    })
  } finally {
    domainsLoading.value = false
  }
}

async function openDomain(domain: string): Promise<void> {
  activeDomain.value = domain
  entries.value = []
  entriesError.value = ''
  entriesLoading.value = true
  try {
    const out = await memoryVaultApi.entries({
      botId: botId.value,
      contactId: contactId.value,
      domain,
      limit: 100,
    })
    if (!out.available) {
      vaultAvailable.value = false
      return
    }
    entries.value = out.entries
  } catch (e) {
    entriesError.value = e instanceof Error ? e.message : '读取条目失败'
  } finally {
    entriesLoading.value = false
  }
}

function backToDomainCards(): void {
  activeDomain.value = ''
  entries.value = []
}

/* ---------------- 时间线 / 墓碑 ---------------- */
async function loadTimeline(): Promise<void> {
  timelineLoading.value = true
  timelineError.value = ''
  try {
    const out = await memoryVaultApi.entries({
      botId: botId.value,
      contactId: contactId.value,
      timeline: true,
      limit: 100,
    })
    if (!out.available) {
      vaultAvailable.value = false
      return
    }
    timeline.value = [...out.entries].sort((a, b) => {
      const at = Date.parse(a.eventTime || a.recordTime)
      const bt = Date.parse(b.eventTime || b.recordTime)
      return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0)
    })
  } catch (e) {
    timelineError.value = e instanceof Error ? e.message : '读取时间线失败'
  } finally {
    timelineLoading.value = false
  }
}

async function loadTombs(): Promise<void> {
  tombsLoading.value = true
  tombsError.value = ''
  try {
    const out = await memoryVaultApi.entries({
      botId: botId.value,
      contactId: contactId.value,
      domain: 'history',
      limit: 100,
    })
    if (!out.available) {
      vaultAvailable.value = false
      return
    }
    tombstones.value = out.entries
  } catch (e) {
    tombsError.value = e instanceof Error ? e.message : '读取墓碑失败'
  } finally {
    tombsLoading.value = false
  }
}

/* ---------------- 搜索 ---------------- */
async function runSearch(): Promise<void> {
  const q = searchQuery.value.trim()
  if (q === '') return
  searching.value = true
  try {
    const out = await memoryVaultApi.search({
      botId: botId.value,
      contactId: contactId.value,
      q,
      ...(activeDomain.value !== '' ? { domain: activeDomain.value } : {}),
      limit: 30,
    })
    if (!out.available) {
      vaultAvailable.value = false
      return
    }
    searchHits.value = out.hits
    searchDone.value = true
  } catch (e) {
    toast.error(e instanceof Error ? e.message : '检索失败')
  } finally {
    searching.value = false
  }
}

/* ---------------- 暂存 / 整理 ---------------- */
async function loadStaging(): Promise<void> {
  stagingLoading.value = true
  stagingError.value = ''
  try {
    const out = await memoryVaultApi.staging(botId.value, contactId.value)
    if (!out.available) {
      vaultAvailable.value = false
      return
    }
    staging.value = out.items
  } catch (e) {
    stagingError.value = e instanceof Error ? e.message : '读取暂存区失败'
  } finally {
    stagingLoading.value = false
  }
}

async function loadDream(): Promise<void> {
  try {
    dream.value = await memoryVaultApi.dreamStatus(botId.value, contactId.value)
  } catch {
    dream.value = null
  }
}

async function consolidate(): Promise<void> {
  consolidating.value = true
  try {
    const out = await memoryVaultApi.consolidate(botId.value, contactId.value)
    if (!out.ok) {
      toast.error('整理失败：查看整理状态里的最近错误')
      return
    }
    const r = out.report
    toast.success(
      r === null
        ? '已触发整理'
        : `整理完成：新增 ${r.added}、合并 ${r.merged}、失效 ${r.invalidated}、归档 ${r.archived}`,
    )
    await Promise.all([loadStaging(), loadDream(), loadProfile(), loadDomains()])
  } catch (e) {
    toast.error(e instanceof Error ? e.message : '整理失败')
  } finally {
    consolidating.value = false
  }
}

async function migrateOld(): Promise<void> {
  migrating.value = true
  try {
    await memoryVaultApi.migrate(botId.value, contactId.value)
    toast.success('已提交迁移；旧 memories 表保留只读过渡')
    await Promise.all([loadProfile(), loadDomains(), loadDream()])
  } catch (e) {
    toast.error(e instanceof Error ? e.message : '迁移失败')
  } finally {
    migrating.value = false
  }
}

/* ---------------- 条目详情 ---------------- */
async function openEntry(entryId: string): Promise<void> {
  detailOpen.value = true
  detailLoading.value = true
  detail.value = null
  detailError.value = ''
  editing.value = false
  try {
    const out = await memoryVaultApi.entry(entryId, botId.value, contactId.value)
    if (out === null) {
      detailError.value = '条目详情不可用（后端尚未就绪或条目不存在）'
      return
    }
    detail.value = out
  } catch (e) {
    detailError.value = e instanceof Error ? e.message : '读取条目失败'
  } finally {
    detailLoading.value = false
  }
}

function startEdit(): void {
  if (detail.value === null) return
  editing.value = true
  editContent.value = detail.value.body
  editTags.value = detail.value.tags.join(', ')
  editImportance.value = detail.value.importance || 1
}

async function saveEdit(): Promise<void> {
  if (detail.value === null) return
  savingEdit.value = true
  try {
    await memoryVaultApi.update(
      detail.value.entryId,
      {
        content: editContent.value,
        tags: editTags.value
          .split(/[,，]/)
          .map((t) => t.trim())
          .filter((t) => t !== ''),
        importance: editImportance.value,
      },
      botId.value,
      contactId.value,
    )
    toast.success('条目已保存（人工编辑会记入审计）')
    editing.value = false
    await openEntry(detail.value.entryId)
    await refreshAfterMutation()
  } catch (e) {
    toast.error(e instanceof Error ? e.message : '保存失败')
  } finally {
    savingEdit.value = false
  }
}

async function invalidateEntry(): Promise<void> {
  if (detail.value === null) return
  const entryId = detail.value.entryId
  try {
    await memoryVaultApi.invalidate(entryId, botId.value, contactId.value)
    // 防御：§6 契约未定义 invalidate 语义；后端若忽略 invalid 字段则这里能发现而不是假成功。
    const fresh = await memoryVaultApi.entry(entryId, botId.value, contactId.value)
    if (fresh !== null && fresh.tombstone !== true && fresh.valid !== false) {
      toast.error('后端未把条目标记为失效（契约缺口：PUT 需支持 invalid:true 或专用 forget 端点）')
    } else {
      toast.success('已标记失效（进 _history 墓碑，不物理删除）')
    }
    await openEntry(entryId)
    await refreshAfterMutation()
  } catch (e) {
    toast.error(e instanceof Error ? e.message : '标记失效失败')
  }
}

async function refreshAfterMutation(): Promise<void> {
  await loadProfile()
  await loadDomains()
  if (activeDomain.value !== '') await openDomain(activeDomain.value)
  if (activeTab.value === 'timeline') await loadTimeline()
  if (activeTab.value === 'tombs') await loadTombs()
}

/* ---------------- 淡忘池（旧表） ---------------- */
async function loadForgotten(): Promise<void> {
  forgottenLoading.value = true
  forgottenError.value = ''
  try {
    const all = await memoriesApi.list(botId.value, { sender: contactId.value, includeDeleted: true })
    forgotten.value = all.filter((memory) => memory.deleted)
  } catch (e) {
    forgottenError.value = e instanceof Error ? e.message : '读取淡忘池失败'
  } finally {
    forgottenLoading.value = false
  }
}

async function restoreForgotten(memory: Memory): Promise<void> {
  try {
    await memoriesApi.restore(memory.id)
    toast.success('已从淡忘池恢复')
    await loadForgotten()
  } catch (e) {
    toast.error(e instanceof Error ? e.message : '恢复失败')
  }
}

/* ---------------- 展示助手 ---------------- */
function relativeLabel(iso: string): string {
  if (iso === '') return '—'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  const now = new Date()
  const then = new Date(t)
  const months = (now.getFullYear() - then.getFullYear()) * 12 + (now.getMonth() - then.getMonth())
  const ym = `${then.getFullYear()}-${String(then.getMonth() + 1).padStart(2, '0')}`
  if (months >= 2) return `${months} 个月前（${ym}）`
  if (months === 1) return `上个月（${ym}）`
  const days = Math.floor((Date.now() - t) / 86400000)
  if (days >= 14) return `${Math.floor(days / 7)} 周前（${ym}）`
  if (days >= 2) return `${days} 天前（${ym}）`
  if (days === 1) return `昨天（${ym}）`
  return `今天（${ym}）`
}

function entryTimeLabel(entry: MemoryVaultEntry): string {
  return entry.timeLabel !== '' ? entry.timeLabel : relativeLabel(entry.eventTime || entry.recordTime)
}

function domainCountTotal(): number {
  return domains.value.reduce((sum, d) => sum + d.count, 0)
}

const domainCards = computed(() => {
  if (domains.value.length > 0) return domains.value
  return DOMAIN_ORDER.map((domain) => ({
    domain,
    label: domainLabel(domain),
    description: '',
    count: 0,
    recentTitle: '',
    recentTimeLabel: '',
    updatedAt: '',
  }))
})

const dreamStatusLabel = computed(() => {
  if (dream.value === null) return '未知'
  if (dream.value.running) return '整理中'
  return '空闲'
})
</script>

<template>
  <PageShell
    title="记忆"
    description="每个角色 × 每个人一个 vault：Markdown 是真相，索引可重建，整理不阻塞聊天。"
  >
    <div class="space-y-8">
      <!-- 顶部：角色 + 联系人 + 整理状态 -->
      <SurfaceCard padding="row" class="flex flex-wrap items-center gap-3">
        <div class="flex min-w-40 flex-1 flex-col gap-1">
          <span class="text-caption text-muted-foreground">角色（bot）</span>
          <Select v-model="botId">
            <SelectTrigger class="w-full">
              <SelectValue placeholder="选择角色" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="bot in botsList" :key="bot.id" :value="bot.id">{{ bot.name }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div class="flex min-w-40 flex-1 flex-col gap-1">
          <span class="text-caption text-muted-foreground">联系人（人）</span>
          <Select v-model="contactId">
            <SelectTrigger class="w-full">
              <SelectValue :placeholder="contactsLoading ? '读取中…' : '选择联系人'" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-if="contacts.length === 0" value="__none__" disabled>还没有联系人</SelectItem>
              <SelectItem v-for="contact in contacts" :key="contact.id" :value="contact.id">
                {{ contact.name }}{{ contact.isOwner ? '（主人格）' : '' }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div class="flex flex-col gap-1">
          <span class="text-caption text-muted-foreground">整理</span>
          <div class="flex items-center gap-2">
            <Badge :variant="dream?.running ? 'info' : 'outline'" size="sm">{{ dreamStatusLabel }}</Badge>
            <Button variant="ghost" size="icon-sm" aria-label="刷新" @click="refreshAll">
              <RefreshCw />
            </Button>
          </div>
        </div>
      </SurfaceCard>

      <CalloutBanner
        v-if="!vaultAvailable"
        tone="warning"
        title="vault 后端接口尚未就绪"
        description="routes-memory-vault.ts 正在实现中；本页已按契约对接。旧「淡忘池」tab 仍可用。"
      />
      <CalloutBanner v-if="loadError" tone="destructive" :description="loadError" size="sm" />
      <div v-if="botId === '' || contactId === ''" class="flex items-center gap-2 py-4 text-label text-muted-foreground">
        <Spinner class="size-4" />
        {{
          botId === ''
            ? '还没有角色（bot）'
            : contactsLoading
              ? '正在读取联系人…'
              : '这个角色还没有联系人，先从对话开始吧'
        }}
      </div>

      <Tabs v-else v-model="activeTab" class="space-y-6">
        <TabsList variant="underline">
          <TabsTrigger v-for="tab in TABS" :key="tab.value" :value="tab.value">{{ tab.label }}</TabsTrigger>
          <TabsTrigger value="forgotten">淡忘池</TabsTrigger>
        </TabsList>

        <!-- ================= 档案 ================= -->
        <TabsContent value="profile" class="space-y-4">
          <SettingsSection title="档案 PROFILE.md">
            <template #actions>
              <div class="flex items-center gap-2">
                <Badge v-if="profile?.autoGenerated" variant="secondary" size="sm">自动生成</Badge>
                <Button variant="outline" size="sm" :loading="rebuilding" :disabled="!isAdmin" @click="rebuildProfile">
                  <WandSparkles />
                  重建
                </Button>
              </div>
            </template>
            <div v-if="profileLoading" class="flex items-center gap-2 px-4 py-6 text-label text-muted-foreground">
              <Spinner class="size-4" />
              正在读取档案…
            </div>
            <template v-else-if="profile">
              <div class="mx-4 border-b border-border py-2 text-caption text-muted-foreground">
                更新时间：{{ profile.updatedAt ? fmtDateTime(profile.updatedAt) : '未知' }}
                <span v-if="profile.entryCount > 0"> · 约 {{ profile.entryCount }} 条记忆</span>
              </div>
              <CalloutBanner
                v-if="profile.truncated"
                tone="warning"
                size="sm"
                title="档案超出预算被截断"
                description="PROFILE.md 有 2000 字硬预算：超预算部分显式标注截断，完整信息请到「域」里查看。"
              />
              <div class="p-4">
                <MarkdownView :source="profile.content" empty-text="档案还没有生成：点右上「重建」。" />
              </div>
            </template>
            <div v-else class="px-4 py-6">
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>还没有档案</EmptyTitle>
                  <EmptyDescription>聊几句后，后台整理会生成 PROFILE.md；也可以立即点「重建」。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            </div>
            <template #footer>
              <p class="text-caption text-muted-foreground">
                Markdown 是唯一真相；档案由后台整理生成，可在自动生成区间外人工修改（重建不会覆盖区间外内容）。
              </p>
            </template>
          </SettingsSection>
        </TabsContent>

        <!-- ================= 域 ================= -->
        <TabsContent value="domains" class="space-y-4">
          <template v-if="activeDomain === ''">
            <div class="flex flex-wrap items-center justify-between gap-2 px-2">
              <h2 class="text-label font-medium text-muted-foreground">9 个记忆域（{{ domainCountTotal() }} 条）</h2>
              <div class="flex items-center gap-2">
                <Input
                  v-model="searchQuery"
                  placeholder="跨域检索（如：考研 / 工作）"
                  class="w-56"
                  @keydown.enter="runSearch"
                />
                <Button variant="outline" size="sm" :loading="searching" @click="runSearch">
                  <Search />
                  检索
                </Button>
              </div>
            </div>
            <div v-if="domainsLoading" class="flex items-center gap-2 px-2 py-6 text-label text-muted-foreground">
              <Spinner class="size-4" />
              正在读取域…
            </div>
            <div v-else class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <SurfaceCard
                v-for="domain in domainCards"
                :key="domain.domain"
                :data-testid="`domain-card-${domain.domain}`"
                padding="lg"
                class="cursor-pointer space-y-1.5 transition-colors hover:bg-accent"
                @click="openDomain(domain.domain)"
              >
                <div class="flex items-center justify-between gap-2">
                  <span class="text-control font-medium text-foreground">{{ domainLabel(domain.domain) }}</span>
                  <Badge variant="outline" size="sm">{{ domain.count }} 条</Badge>
                </div>
                <p class="line-clamp-2 text-caption text-muted-foreground">
                  {{ domain.description || '（域 README 尚未填写）' }}
                </p>
                <p v-if="domain.recentTitle" class="truncate text-caption text-muted-foreground">
                  最近：{{ domain.recentTitle }}
                  <span v-if="domain.recentTimeLabel"> · {{ domain.recentTimeLabel }}</span>
                </p>
                <p v-else class="text-caption text-muted-foreground">暂无条目</p>
              </SurfaceCard>
            </div>

            <div v-if="searchDone" class="space-y-2">
              <div class="flex items-center justify-between px-2">
                <h3 class="text-label font-medium text-muted-foreground">
                  检索「{{ searchQuery }}」命中 {{ searchHits.length }} 条
                </h3>
                <Button variant="ghost" size="sm" @click="searchDone = false; searchHits = []">收起</Button>
              </div>
              <SettingsSection title="检索结果">
                <SettingsRow v-for="hit in searchHits" :key="hit.entryId">
                  <template #content>
                    <div class="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" size="sm">{{ domainLabel(hit.domain) }}</Badge>
                      <span class="truncate text-control font-medium text-foreground">{{ hit.title }}</span>
                    </div>
                    <p class="mt-0.5 text-caption text-muted-foreground">
                      {{ hit.timeLabel || '—' }}
                      <span v-if="hit.matchedLayer"> · 命中 {{ hit.matchedLayer }}</span>
                      <span v-if="hit.score > 0"> · 分数 {{ hit.score.toFixed(2) }}</span>
                    </p>
                  </template>
                  <Button variant="outline" size="sm" @click="openEntry(hit.entryId)">查看</Button>
                </SettingsRow>
                <SettingsRow v-if="searchHits.length === 0">
                  <template #content>
                    <p class="text-control text-muted-foreground">没有命中（可换关键词，或确认 vault 里已有条目）。</p>
                  </template>
                </SettingsRow>
              </SettingsSection>
            </div>
          </template>

          <template v-else>
            <div class="flex items-center gap-2 px-2">
              <Button variant="ghost" size="sm" @click="backToDomainCards">
                <ChevronLeft />
                返回域
              </Button>
              <h2 class="text-label font-medium text-muted-foreground">{{ domainLabel(activeDomain) }}</h2>
            </div>
            <SettingsSection :title="`${domainLabel(activeDomain)} 条目`">
              <template #actions>
                <Badge variant="outline" size="sm">{{ entries.length }} 条</Badge>
              </template>
              <div v-if="entriesLoading" class="flex items-center gap-2 px-4 py-6 text-label text-muted-foreground">
                <Spinner class="size-4" />
                正在读取条目…
              </div>
              <SettingsRow v-for="entry in entries" v-else :key="entry.entryId">
                <template #content>
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="truncate text-control font-medium text-foreground">{{ entry.title }}</span>
                    <Badge v-if="!entry.valid" variant="outline" size="sm">已失效</Badge>
                    <Badge v-else variant="secondary" size="sm">有效</Badge>
                    <Badge v-if="entry.kind === 'agent-note'" variant="warning" size="sm">推断</Badge>
                  </div>
                  <p class="mt-0.5 text-caption text-muted-foreground">发生：{{ entryTimeLabel(entry) }}</p>
                </template>
                <Button
                  variant="outline"
                  size="sm"
                  :aria-label="`查看条目：${entry.title}`"
                  @click="openEntry(entry.entryId)"
                >
                  查看
                </Button>
              </SettingsRow>
              <SettingsRow v-if="!entriesLoading && entries.length === 0">
                <template #content>
                  <p class="text-control text-muted-foreground">这个域还没有条目。</p>
                </template>
              </SettingsRow>
              <CalloutBanner v-if="entriesError" tone="destructive" size="sm" :description="entriesError" />
            </SettingsSection>
          </template>
        </TabsContent>

        <!-- ================= 暂存 ================= -->
        <TabsContent value="staging" class="space-y-4">
          <SettingsSection title="整理状态">
            <SettingsRow label="状态" description="暂存区累计 ≥25 条且距上次 ≥30min 会自动整理；也可立即整理">
              <div class="flex items-center gap-2">
                <StatusDot :status="dream?.running ? 'warning' : 'success'" />
                <span class="text-control text-foreground">{{ dreamStatusLabel }}</span>
              </div>
            </SettingsRow>
            <SettingsRow label="上次整理" description="通过 Dream 流程写入条目、重建 PROFILE 与索引">
              <span class="text-control text-foreground">{{ dream?.lastRunAt ? fmtAgo(dream.lastRunAt) : '—' }}</span>
            </SettingsRow>
            <SettingsRow label="下次整理" description="定时任务（每天 03:00）或达到阈值触发">
              <span class="text-control text-foreground">{{ dream?.nextRunAt ? fmtDateTime(dream.nextRunAt) : '—' }}</span>
            </SettingsRow>
            <div v-if="dream?.lastError" class="mx-4 border-b border-border py-3 text-caption text-destructive">
              {{ dream.lastError }}
            </div>
            <template #footer>
              <Button :loading="consolidating" :disabled="!isAdmin || consolidating" @click="consolidate">
                <Sparkles />
                立即整理
              </Button>
              <Button variant="outline" :disabled="!isAdmin" :loading="migrating" @click="migrateOld">
                迁移旧记忆
              </Button>
            </template>
          </SettingsSection>

          <SettingsSection title="最近一次整理报告">
            <template v-if="dream?.lastReport">
              <SettingsRow label="新增 / 合并">
                <span class="text-control text-foreground">{{ dream.lastReport.added }} / {{ dream.lastReport.merged }}</span>
              </SettingsRow>
              <SettingsRow label="失效 / 归档">
                <span class="text-control text-foreground">
                  {{ dream.lastReport.invalidated }} / {{ dream.lastReport.archived }}
                </span>
              </SettingsRow>
              <SettingsRow label="耗时" :description="dream.lastReport.at ? fmtDateTime(dream.lastReport.at) : ''">
                <span class="text-control text-foreground">
                  {{ dream.lastReport.durationMs > 0 ? `${(dream.lastReport.durationMs / 1000).toFixed(1)} s` : '—' }}
                </span>
              </SettingsRow>
              <div v-if="dream.lastReport.error" class="mx-4 border-b border-border py-3 text-caption text-destructive">
                {{ dream.lastReport.error }}
              </div>
            </template>
            <SettingsRow v-else>
              <template #content>
                <p class="text-control text-muted-foreground">还没有整理报告。</p>
              </template>
            </SettingsRow>
          </SettingsSection>

          <SettingsSection title="暂存区 _staging">
            <template #actions>
              <Badge variant="outline" size="sm">{{ staging.length }} 条候选</Badge>
            </template>
            <div v-if="stagingLoading" class="flex items-center gap-2 px-4 py-6 text-label text-muted-foreground">
              <Spinner class="size-4" />
              正在读取暂存区…
            </div>
            <SettingsRow v-for="item in staging" v-else :key="item.id">
              <template #content>
                <p class="whitespace-pre-wrap text-control text-foreground">{{ item.content }}</p>
                <p class="mt-0.5 text-caption text-muted-foreground">
                  {{ item.createdAt ? fmtAgo(item.createdAt) : '—' }}
                  <span v-if="item.sourceRef"> · 来源 {{ item.sourceRef }}</span>
                </p>
              </template>
            </SettingsRow>
            <SettingsRow v-if="!stagingLoading && staging.length === 0">
              <template #content>
                <p class="text-control text-muted-foreground">
                  暂存区是空的。聊天里她先写候选到这里，再由后台整理成正式条目。
                </p>
              </template>
            </SettingsRow>
            <CalloutBanner v-if="stagingError" tone="destructive" size="sm" :description="stagingError" />
          </SettingsSection>
        </TabsContent>

        <!-- ================= 墓碑 ================= -->
        <TabsContent value="tombs" class="space-y-4">
          <SettingsSection title="墓碑 _history">
            <template #actions>
              <Badge variant="outline" size="sm">{{ tombstones.length }} 条</Badge>
            </template>
            <p class="mx-4 py-2 text-caption text-muted-foreground">
              被取代或过期的条目保留「曾经是真的」，不物理删除；正文与取代链可点开查看。
            </p>
            <div v-if="tombsLoading" class="flex items-center gap-2 px-4 py-6 text-label text-muted-foreground">
              <Spinner class="size-4" />
              正在读取墓碑…
            </div>
            <SettingsRow v-for="entry in tombstones" v-else :key="entry.entryId">
              <template #content>
                <div class="flex flex-wrap items-center gap-2">
                  <span class="truncate text-control font-medium text-muted-foreground">{{ entry.title }}</span>
                  <Badge variant="outline" size="sm">墓碑</Badge>
                </div>
                <p class="mt-0.5 text-caption text-muted-foreground">
                  {{ entryTimeLabel(entry) }}
                  <span v-if="entry.supersededBy"> · 被 {{ entry.supersededBy }} 取代</span>
                </p>
              </template>
              <Button
                variant="outline"
                size="sm"
                :aria-label="`查看墓碑：${entry.title}`"
                @click="openEntry(entry.entryId)"
              >
                查看
              </Button>
            </SettingsRow>
            <SettingsRow v-if="!tombsLoading && tombstones.length === 0">
              <template #content>
                <p class="text-control text-muted-foreground">还没有墓碑：没有任何条目被取代或过期。</p>
              </template>
            </SettingsRow>
            <CalloutBanner v-if="tombsError" tone="destructive" size="sm" :description="tombsError" />
          </SettingsSection>
        </TabsContent>

        <!-- ================= 时间线 ================= -->
        <TabsContent value="timeline" class="space-y-4">
          <SettingsSection title="时间线">
            <template #actions>
              <div class="flex items-center gap-2">
                <Badge variant="outline" size="sm">{{ timeline.length }} 条 · 按发生时间倒序</Badge>
                <Button variant="ghost" size="sm" :loading="timelineLoading" @click="loadTimeline">
                  <RefreshCw />
                  刷新
                </Button>
              </div>
            </template>
            <div v-if="timelineLoading" class="flex items-center gap-2 px-4 py-6 text-label text-muted-foreground">
              <Spinner class="size-4" />
              正在读取时间线…
            </div>
            <SettingsRow v-for="entry in timeline" v-else :key="entry.entryId">
              <template #content>
                <div class="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" size="sm">{{ domainLabel(entry.domain) }}</Badge>
                  <span
                    class="truncate text-control font-medium"
                    :class="entry.valid ? 'text-foreground' : 'text-muted-foreground line-through'"
                  >
                    {{ entry.title }}
                  </span>
                  <Badge v-if="!entry.valid" variant="outline" size="sm">过期/失效</Badge>
                </div>
                <p class="mt-0.5 text-caption text-muted-foreground">
                  发生：{{ entryTimeLabel(entry) }} · 记录：{{ relativeLabel(entry.recordTime) }}
                </p>
              </template>
              <Button
                variant="outline"
                size="sm"
                :aria-label="`查看时间线条目：${entry.title}`"
                @click="openEntry(entry.entryId)"
              >
                查看
              </Button>
            </SettingsRow>
            <SettingsRow v-if="!timelineLoading && timeline.length === 0">
              <template #content>
                <p class="text-control text-muted-foreground">vault 里还没有条目。</p>
              </template>
            </SettingsRow>
            <CalloutBanner v-if="timelineError" tone="destructive" size="sm" :description="timelineError" />
          </SettingsSection>
        </TabsContent>

        <!-- ================= 淡忘池（旧表） ================= -->
        <TabsContent value="forgotten" class="space-y-4">
          <SettingsSection title="淡忘池（旧 memories 表）">
            <template #actions>
              <Button variant="ghost" size="sm" :loading="forgottenLoading" @click="loadForgotten">
                <RefreshCw />
                刷新
              </Button>
            </template>
            <p class="mx-4 py-2 text-caption text-muted-foreground">
              淡忘是软删：记忆永不物理删除；迁移到 vault 后，这里保留旧表的可恢复视图。
            </p>
            <div v-if="forgottenLoading" class="flex items-center gap-2 px-4 py-6 text-label text-muted-foreground">
              <Spinner class="size-4" />
              正在读取淡忘池…
            </div>
            <SettingsRow v-for="memory in forgotten" v-else :key="memory.id">
              <template #content>
                <p class="whitespace-pre-wrap text-control text-foreground">{{ memory.content }}</p>
                <p class="mt-0.5 text-caption text-muted-foreground">
                  {{ memory.category }} · 淡忘于 {{ memory.deletedAt ? fmtDateTime(memory.deletedAt) : '未知' }}
                  <span v-if="memory.deletedReason"> · {{ memory.deletedReason }}</span>
                </p>
              </template>
              <Button variant="outline" size="sm" :disabled="!isAdmin" @click="restoreForgotten(memory)">恢复</Button>
            </SettingsRow>
            <SettingsRow v-if="!forgottenLoading && forgotten.length === 0">
              <template #content>
                <p class="text-control text-muted-foreground">淡忘池是空的。</p>
              </template>
            </SettingsRow>
            <CalloutBanner v-if="forgottenError" tone="destructive" size="sm" :description="forgottenError" />
          </SettingsSection>
        </TabsContent>
      </Tabs>

      <!-- 条目详情 Drawer -->
      <Sheet v-model:open="detailOpen">
        <SheetContent side="right" class="w-[min(46rem,92vw)] p-0">
          <SheetTitle class="sr-only">记忆条目详情</SheetTitle>
          <SheetDescription class="sr-only">条目正文、时间、取代链、来源与 related/thread。</SheetDescription>
          <div class="flex h-full flex-col">
            <div class="flex min-h-14 items-center justify-between gap-3 border-b border-border px-4 pr-12">
              <div class="min-w-0">
                <p class="truncate text-control font-medium text-foreground">{{ detail?.title ?? '条目详情' }}</p>
                <p v-if="detail" class="mt-0.5 text-caption text-muted-foreground">
                  {{ domainLabel(detail.domain) }} · {{ kindLabel(detail.kind) }}
                  <span v-if="detail.tombstone"> · 墓碑</span>
                </p>
              </div>
              <div class="flex items-center gap-2">
                <Button v-if="isAdmin && detail && !editing" variant="outline" size="sm" @click="startEdit">编辑</Button>
                <ConfirmPopover
                  v-if="isAdmin && detail && !detail.tombstone"
                  title="标记失效？"
                  message="条目会进入 _history 墓碑（保留「曾经是真的」），不做物理删除。"
                  confirm-text="标记失效"
                  cancel-text="取消"
                  variant="destructive"
                  @confirm="invalidateEntry"
                >
                  <template #trigger>
                    <Button variant="ghost" size="sm">标记失效</Button>
                  </template>
                </ConfirmPopover>
              </div>
            </div>
            <div class="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
              <div v-if="detailLoading" class="flex items-center gap-2 text-label text-muted-foreground">
                <Spinner class="size-4" />
                正在读取条目…
              </div>
              <CalloutBanner v-else-if="detailError" tone="destructive" size="sm" :description="detailError" />
              <template v-else-if="detail">
                <div class="grid gap-2 sm:grid-cols-2">
                  <p class="text-caption text-muted-foreground">
                    发生时间：{{ entryTimeLabel(detail) }}
                    <span v-if="detail.eventRaw" class="block">原话：{{ detail.eventRaw }}</span>
                  </p>
                  <p class="text-caption text-muted-foreground">
                    记录时间：{{ relativeLabel(detail.recordTime) }}
                    <span class="block">
                      校验时间：{{ detail.lastVerified ? relativeLabel(detail.lastVerified) : '—' }}
                    </span>
                  </p>
                  <p class="text-caption text-muted-foreground">
                    来源：{{ detail.sources.length > 0 ? detail.sources.join('、') : '—' }}
                  </p>
                  <p class="text-caption text-muted-foreground">
                    溯源：{{ provenanceLabel(detail.provenance) }} · 重要度 {{ detail.importance }}
                  </p>
                  <p v-if="detail.supersededBy" class="text-caption text-muted-foreground">
                    被取代：{{ detail.supersededBy }}
                  </p>
                  <p v-if="detail.supersedes.length > 0" class="text-caption text-muted-foreground">
                    取代了：{{ detail.supersedes.join('、') }}
                  </p>
                  <p v-if="detail.thread" class="text-caption text-muted-foreground">线索：{{ detail.thread }}</p>
                  <p v-if="detail.related.length > 0" class="text-caption text-muted-foreground">
                    related：{{ detail.related.join('、') }}
                  </p>
                  <p v-if="detail.tags.length > 0" class="text-caption text-muted-foreground">
                    tags：{{ detail.tags.join('、') }}
                  </p>
                  <p v-if="detail.tombstoneReason" class="text-caption text-destructive">
                    墓碑原因：{{ detail.tombstoneReason }}
                  </p>
                </div>
                <div v-if="editing" class="space-y-3">
                  <label class="block space-y-1.5">
                    <span class="text-label font-medium text-foreground">正文（Markdown）</span>
                    <Textarea v-model="editContent" :rows="10" />
                  </label>
                  <label class="block space-y-1.5">
                    <span class="text-label font-medium text-foreground">tags（逗号分隔）</span>
                    <Input v-model="editTags" placeholder="睡眠, 加班" />
                  </label>
                  <label class="block space-y-1.5">
                    <span class="text-label font-medium text-foreground">重要度</span>
                    <Input v-model.number="editImportance" type="number" min="0" max="5" />
                  </label>
                  <div class="flex items-center gap-2">
                    <Button :loading="savingEdit" @click="saveEdit">保存</Button>
                    <Button variant="outline" @click="editing = false">取消</Button>
                  </div>
                </div>
                <div v-else class="rounded-md border border-border bg-card p-3">
                  <MarkdownView :source="detail.body" empty-text="（这条记忆没有正文）" />
                </div>
              </template>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  </PageShell>
</template>
