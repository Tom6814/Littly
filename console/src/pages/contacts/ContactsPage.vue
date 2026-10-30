<script setup lang="ts">
/**
 * 联系人页 —— 她认识的人、关系网与每个人的记忆速览。
 *
 * 行为基线：旧 React ContactsPage（搜索、改名、详情抽屉、关系创建、去聊天）。
 * 旧页没有「删除联系人」入口（后端 DELETE 是硬删），本版同样不暴露删除。
 * 联系人由各渠道/对话自动出现，没有「新建联系人」——这是数据模型事实，不是缺功能。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  Avatar,
  AvatarFallback,
  Badge,
  Button,
  CalloutBanner,
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
  SurfaceCard,
  toast,
} from '@felinic/ui'
import { MessageCircle, Plus, UserRound } from 'lucide-vue-next'
import { errText, fmtAgo } from '@/pages/her/shared/format'
import { useBots } from '@/stores/bots'
import {
  contactsApi,
  relationsApi,
  memoryPreviewApi,
  type Contact,
  type MemoryPreview,
  type Relation,
} from './api'

const router = useRouter()
const bots = useBots()
const botId = computed(() => bots.currentBotId.value ?? '')

const contacts = ref<Contact[]>([])
const relations = ref<Relation[]>([])
const loading = ref(false)
const loadError = ref('')
const search = ref('')

const detail = ref<Contact | null>(null)
const detailMemories = ref<MemoryPreview[]>([])
const detailLoading = ref(false)

const renameTarget = ref<Contact | null>(null)
const renameText = ref('')
const saving = ref(false)

const relationOpen = ref(false)
const relationForm = ref({ fromId: '', toId: '', type: '', description: '' })
const relationSaving = ref(false)

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return contacts.value
  return contacts.value.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      c.brief.toLowerCase().includes(q) ||
      c.externalId.toLowerCase().includes(q),
  )
})

function relationsOf(sender: string): Relation[] {
  return relations.value.filter((r) => r.fromContactId === sender || r.toContactId === sender)
}

async function load(): Promise<void> {
  if (!botId.value) {
    contacts.value = []
    relations.value = []
    return
  }
  loading.value = true
  loadError.value = ''
  try {
    const [contactList, relationList] = await Promise.all([
      contactsApi.list(botId.value),
      relationsApi.list(botId.value),
    ])
    contacts.value = contactList
    relations.value = relationList
  } catch (e) {
    contacts.value = []
    relations.value = []
    loadError.value = errText(e)
  } finally {
    loading.value = false
  }
}

async function openDetail(contact: Contact): Promise<void> {
  detail.value = contact
  detailMemories.value = []
  detailLoading.value = true
  try {
    const list = await memoryPreviewApi.list(botId.value, contact.id)
    detailMemories.value = list.filter((m) => !m.deleted).slice(0, 8)
  } catch {
    // 记忆速览是补充信息；失败不打断详情阅读（顶部有全局加载错误兜底）
  } finally {
    detailLoading.value = false
  }
}

function openRename(contact: Contact): void {
  renameTarget.value = contact
  renameText.value = contact.name
}

async function saveRename(): Promise<void> {
  const target = renameTarget.value
  const name = renameText.value.trim()
  if (!target) return
  if (!name) {
    toast.error('名字不能为空')
    return
  }
  saving.value = true
  try {
    await contactsApi.update(target.id, botId.value, { name })
    renameTarget.value = null
    toast.success('已保存')
    await load()
  } catch (e) {
    toast.error(errText(e))
  } finally {
    saving.value = false
  }
}

function openRelation(): void {
  if (contacts.value.length < 2) {
    toast.info('至少需要两个联系人才有「关系」')
    return
  }
  relationForm.value = { fromId: '', toId: '', type: '', description: '' }
  relationOpen.value = true
}

async function saveRelation(): Promise<void> {
  const f = relationForm.value
  if (!f.fromId || !f.toId) {
    toast.error('请选择关系两侧的联系人')
    return
  }
  if (f.fromId === f.toId) {
    toast.error('不能和自己建立关系')
    return
  }
  relationSaving.value = true
  try {
    await relationsApi.create(botId.value, {
      fromContactId: f.fromId,
      toContactId: f.toId,
      type: f.type.trim(),
      description: f.description.trim(),
    })
    relationOpen.value = false
    toast.success('关系已保存')
    await load()
  } catch (e) {
    toast.error(errText(e))
  } finally {
    relationSaving.value = false
  }
}

function goChat(contact: Contact): void {
  void router.push({ path: '/chat', query: { sender: contact.id } })
}

function initials(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || '?'
}

function profileEntries(profile: Record<string, unknown> | null): Array<{ key: string; value: string }> {
  if (!profile) return []
  return Object.entries(profile)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => ({
      key,
      value: typeof value === 'object' ? JSON.stringify(value) : String(value),
    }))
}

watch(botId, () => void load())
onMounted(() => {
  void bots.bootstrap()
  void load()
})
</script>

<template>
  <PageShell
    title="联系人"
    description="她认识的人。名字与关系网决定她怎么称呼、怎么对待每个人。"
  >
    <template #actions>
      <Button
        variant="outline"
        :disabled="!botId"
        @click="openRelation"
      >
        <Plus />
        添加关系
      </Button>
    </template>

    <Empty v-if="!botId">
      <EmptyHeader>
        <EmptyTitle>还没有可用的「她」</EmptyTitle>
        <EmptyDescription>先完成引导或创建一个角色卡，联系人属于她的世界。</EmptyDescription>
      </EmptyHeader>
    </Empty>

    <template v-else>
      <div class="space-y-6">
      <CalloutBanner
        v-if="loadError"
        tone="destructive"
        title="联系人加载失败"
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

      <div
        v-else
        class="mb-4 max-w-xs"
      >
        <Input
          v-model="search"
          placeholder="搜索名字、简介或渠道 ID"
          aria-label="搜索联系人"
        />
      </div>

      <InlineLoadingRow
        v-if="loading && contacts.length === 0"
        surface="tab"
        size="md"
      >
        正在读取联系人…
      </InlineLoadingRow>

      <Empty
        v-else-if="contacts.length === 0"
      >
        <EmptyHeader>
          <EmptyTitle>还没有联系人</EmptyTitle>
          <EmptyDescription>
            联系人会在有人通过网页、微信、QQ、Telegram 等渠道和她说话后自动出现。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>

      <Empty
        v-else-if="filtered.length === 0"
      >
        <EmptyHeader>
          <EmptyTitle>没有匹配的联系人</EmptyTitle>
          <EmptyDescription>换个关键词试试。</EmptyDescription>
        </EmptyHeader>
      </Empty>

      <div
        v-else
        class="grid grid-cols-1 gap-4 sm:grid-cols-2"
      >
        <SurfaceCard
          v-for="contact in filtered"
          :key="contact.id"
        >
          <div class="flex items-start gap-3">
            <Avatar class="size-10">
              <AvatarFallback>{{ initials(contact.name) }}</AvatarFallback>
            </Avatar>
            <div class="min-w-0 flex-1 space-y-1">
              <div class="flex flex-wrap items-center gap-2">
                <p class="truncate text-control font-medium text-foreground">
                  {{ contact.name }}
                </p>
                <Badge
                  v-if="contact.isOwner"
                  variant="info"
                >
                  唯一喜欢的人
                </Badge>
                <Badge
                  v-if="contact.blocked"
                  variant="destructive"
                >
                  已屏蔽
                </Badge>
                <Badge
                  v-if="contact.channel"
                  variant="secondary"
                >
                  {{ contact.channel }}
                </Badge>
              </div>
              <p class="line-clamp-2 text-body text-muted-foreground">
                {{ contact.brief || '还没有简介' }}
              </p>
              <p class="text-caption text-muted-foreground">
                最近活跃：{{ fmtAgo(contact.lastActiveAt) }}
              </p>
            </div>
          </div>
          <div class="mt-3 flex flex-wrap items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              @click="openDetail(contact)"
            >
              <UserRound />
              详情
            </Button>
            <Button
              variant="ghost"
              size="sm"
              @click="openRename(contact)"
            >
              改名
            </Button>
            <Button
              variant="ghost"
              size="sm"
              @click="goChat(contact)"
            >
              <MessageCircle />
              去聊天
            </Button>
          </div>
        </SurfaceCard>
      </div>
      </div>
    </template>

    <!-- 详情 -->
    <Dialog
      :open="detail !== null"
      @update:open="(open) => { if (!open) detail = null }"
    >
      <DialogPanel width="2xl">
        <DialogHeader>
          <DialogTitle>{{ detail?.name ?? '联系人' }}</DialogTitle>
        </DialogHeader>
        <DialogBody class="space-y-6">
          <SettingsSection title="资料">
            <SettingsRow label="标识">
              <span class="font-mono text-caption text-muted-foreground">{{ detail?.id }}</span>
            </SettingsRow>
            <SettingsRow
              label="最近活跃"
              :divider="profileEntries(detail?.profile ?? null).length > 0"
            >
              <span class="text-body text-foreground">{{ fmtAgo(detail?.lastActiveAt) }}</span>
            </SettingsRow>
            <SettingsRow
              v-for="(entry, index) in profileEntries(detail?.profile ?? null)"
              :key="entry.key"
              :label="entry.key"
              align="start"
              :divider="index < profileEntries(detail?.profile ?? null).length - 1"
            >
              <span class="max-w-[60%] whitespace-pre-wrap break-words text-body text-muted-foreground">{{ entry.value }}</span>
            </SettingsRow>
            <div
              v-if="profileEntries(detail?.profile ?? null).length === 0"
              class="px-4 pb-3 text-caption text-muted-foreground"
            >
              还没有画像资料。
            </div>
          </SettingsSection>

          <SettingsSection title="记忆速览">
            <InlineLoadingRow
              v-if="detailLoading"
              size="sm"
              surface="card-row"
            >
              读取记忆…
            </InlineLoadingRow>
            <div
              v-else-if="detailMemories.length === 0"
              class="px-4 py-6 text-center text-body text-muted-foreground"
            >
              她和这个人还没有形成长期记忆。
            </div>
            <template v-else>
              <SettingsRow
                v-for="(memory, index) in detailMemories"
                :key="memory.id"
                :label="memory.content"
                :description="`${memory.category} · 重要度 ${memory.importance}`"
                align="start"
                :divider="index < detailMemories.length - 1"
              />
            </template>
          </SettingsSection>

          <SettingsSection title="关系">
            <div
              v-if="detail && relationsOf(detail.id).length === 0"
              class="px-4 py-6 text-center text-body text-muted-foreground"
            >
              还没有记录关系。
            </div>
            <SettingsRow
              v-for="(relation, index) in detail ? relationsOf(detail.id) : []"
              :key="relation.id"
              :label="`${relation.fromName} → ${relation.toName}`"
              :description="[relation.type, relation.description].filter(Boolean).join(' · ')"
              :divider="index < (detail ? relationsOf(detail.id).length : 0) - 1"
            />
          </SettingsSection>
        </DialogBody>
        <DialogFooter>
          <Button
            v-if="detail"
            variant="outline"
            @click="openRename(detail)"
          >
            改名
          </Button>
          <Button
            v-if="detail"
            @click="goChat(detail)"
          >
            <MessageCircle />
            去聊天
          </Button>
          <Button
            variant="outline"
            @click="detail = null"
          >
            关闭
          </Button>
        </DialogFooter>
      </DialogPanel>
    </Dialog>

    <!-- 改名 -->
    <Dialog
      :open="renameTarget !== null"
      @update:open="(open) => { if (!open) renameTarget = null }"
    >
      <DialogPanel width="lg" footer>
        <DialogHeader>
          <DialogTitle>联系人改名</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <FormStack>
            <FieldStack
              label="名字"
              help="她会用这个名字称呼对方；不会改动渠道里的真实昵称。"
            >
              <Input v-model="renameText" />
            </FieldStack>
          </FormStack>
        </DialogBody>
        <DialogFooter>
          <Button
            variant="outline"
            @click="renameTarget = null"
          >
            取消
          </Button>
          <Button
            :loading="saving"
            :disabled="!renameText.trim()"
            @click="saveRename"
          >
            保存
          </Button>
        </DialogFooter>
      </DialogPanel>
    </Dialog>

    <!-- 添加关系 -->
    <Dialog
      :open="relationOpen"
      @update:open="(open) => { relationOpen = open }"
    >
      <DialogPanel width="lg" footer>
        <DialogHeader>
          <DialogTitle>添加关系</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <FormStack>
            <div class="grid gap-4 sm:grid-cols-2">
              <FieldStack label="从">
                <Select v-model="relationForm.fromId">
                  <SelectTrigger class="w-full">
                    <SelectValue placeholder="选择联系人" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem
                      v-for="c in contacts"
                      :key="c.id"
                      :value="c.id"
                    >
                      {{ c.name }}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </FieldStack>
              <FieldStack label="到">
                <Select v-model="relationForm.toId">
                  <SelectTrigger class="w-full">
                    <SelectValue placeholder="选择联系人" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem
                      v-for="c in contacts"
                      :key="c.id"
                      :value="c.id"
                    >
                      {{ c.name }}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </FieldStack>
            </div>
            <FieldStack
              label="关系"
              help="例如：朋友 / 家人 / 同事 / 前任。"
            >
              <Input v-model="relationForm.type" />
            </FieldStack>
            <FieldStack
              label="说明"
              help="可选。她会在合适的话题里想起来。"
            >
              <Input v-model="relationForm.description" />
            </FieldStack>
          </FormStack>
        </DialogBody>
        <DialogFooter>
          <Button
            variant="outline"
            @click="relationOpen = false"
          >
            取消
          </Button>
          <Button
            :loading="relationSaving"
            :disabled="!relationForm.fromId || !relationForm.toId"
            @click="saveRelation"
          >
            保存
          </Button>
        </DialogFooter>
      </DialogPanel>
    </Dialog>
  </PageShell>
</template>
