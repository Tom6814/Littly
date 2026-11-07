<script setup lang="ts">
/**
 * 日记页 —— 她自己的生活记录。
 *
 * 行为基线：旧 React DiaryPage（按日期列表、查看全文、手动写入、删除）。
 * 写入是模型调用（可能 10s+）→ 按钮 loading + 成功后刷新；“今天已写过”是幂等的
 * 正常结果（alreadyWritten），不是错误。
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
  InlineLoadingRow,
  PageShell,
  SettingsRow,
  SettingsSection,
  toast,
} from '@felinic/ui'
import { BookOpen, NotebookPen, Trash2 } from 'lucide-vue-next'
import { errText, fmtDate } from './shared/format'
import { useBots } from '@/stores/bots'
import { diaryApi, type Diary } from './api'

const bots = useBots()
const botId = computed(() => bots.currentBotId.value ?? '')

const diaries = ref<Diary[]>([])
const loading = ref(false)
const loadError = ref('')
const writing = ref(false)

const viewing = ref<Diary | null>(null)
const viewContent = ref('')
const viewLoading = ref(false)
const deleteTarget = ref<Diary | null>(null)
const deleting = ref(false)
const writeOpen = ref(false)

async function load(): Promise<void> {
  if (!botId.value) {
    diaries.value = []
    return
  }
  loading.value = true
  loadError.value = ''
  try {
    diaries.value = await diaryApi.list(botId.value)
  } catch (e) {
    diaries.value = []
    loadError.value = errText(e)
  } finally {
    loading.value = false
  }
}

async function openDiary(diary: Diary): Promise<void> {
  viewing.value = diary
  viewContent.value = diary.content
  viewLoading.value = true
  try {
    const full = await diaryApi.get(diary.id)
    if (full?.content) viewContent.value = full.content
  } catch {
    // 列表已带 content，全文请求失败就退回列表内容，不打断阅读
  } finally {
    viewLoading.value = false
  }
}

async function writeToday(): Promise<void> {
  if (!botId.value) return
  writing.value = true
  try {
    const result = await diaryApi.write(botId.value)
    writeOpen.value = false
    toast.success(result.alreadyWritten ? '今天已经写过了' : '她写下了一篇今天的日记')
    await load()
  } catch (e) {
    toast.error(errText(e))
  } finally {
    writing.value = false
  }
}

async function confirmDelete(): Promise<void> {
  const target = deleteTarget.value
  if (!target) return
  deleting.value = true
  try {
    await diaryApi.remove(target.id)
    deleteTarget.value = null
    if (viewing.value?.id === target.id) viewing.value = null
    toast.success('日记已删除')
    await load()
  } catch (e) {
    toast.error(errText(e))
  } finally {
    deleting.value = false
  }
}

/** 从阅读器里删除：先关阅读器再弹确认，避免两个 Dialog 叠加抢焦点。 */
function deleteFromViewer(): void {
  if (!viewing.value) return
  deleteTarget.value = viewing.value
  viewing.value = null
}

function preview(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  if (!flat) return '（空）'
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat
}

watch(botId, () => void load())
onMounted(() => {
  void bots.bootstrap()
  void load()
})
</script>

<template>
  <PageShell
    title="日记"
    description="她过自己的生活，也有自己的记录。日记由她在合适的时候写，也可以在这里让她现在写一篇。"
  >
    <template #actions>
      <Button
        :disabled="!botId"
        :loading="writing"
        @click="writeOpen = true"
      >
        <NotebookPen />
        手动写入
      </Button>
    </template>

    <Empty v-if="!botId">
      <EmptyHeader>
        <EmptyTitle>还没有可用的「她」</EmptyTitle>
        <EmptyDescription>先完成引导或创建一个角色卡，日记才有作者。</EmptyDescription>
      </EmptyHeader>
    </Empty>

    <template v-else>
      <CalloutBanner
        v-if="loadError"
        tone="destructive"
        title="日记加载失败"
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
        v-else-if="loading && diaries.length === 0"
        surface="tab"
        size="md"
      >
        正在读取日记…
      </InlineLoadingRow>

      <Empty v-else-if="diaries.length === 0">
        <EmptyHeader>
          <EmptyTitle>还没有日记</EmptyTitle>
          <EmptyDescription>让她现在写一篇，或等她自己在合适的时候写。</EmptyDescription>
        </EmptyHeader>
        <Button
          variant="outline"
          @click="writeOpen = true"
        >
          <NotebookPen />
          让她写今天
        </Button>
      </Empty>

      <SettingsSection
        v-else
        title="日记"
      >
        <SettingsRow
          v-for="(diary, index) in diaries"
          :key="diary.id"
          :label="fmtDate(diary.date)"
          :description="preview(diary.content)"
          :divider="index < diaries.length - 1"
        >
          <Badge
            v-if="diary.mood"
            variant="secondary"
          >
            {{ diary.mood }}
          </Badge>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="阅读日记"
            @click="openDiary(diary)"
          >
            <BookOpen />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="删除日记"
            @click="deleteTarget = diary"
          >
            <Trash2 />
          </Button>
        </SettingsRow>
      </SettingsSection>
    </template>

    <!-- 阅读全文 -->
    <Dialog
      :open="viewing !== null"
      @update:open="(open) => { if (!open) viewing = null }"
    >
      <DialogPanel width="2xl">
        <DialogHeader>
          <DialogTitle>{{ viewing ? fmtDate(viewing.date) : '日记' }}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <InlineLoadingRow
            v-if="viewLoading"
            size="sm"
          >
            读取全文…
          </InlineLoadingRow>
          <p class="whitespace-pre-wrap text-body leading-relaxed text-foreground">
            {{ viewContent || '（空）' }}
          </p>
        </DialogBody>
        <DialogFooter>
          <Button
            v-if="viewing"
            variant="outline"
            @click="deleteFromViewer"
          >
            <Trash2 />
            删除
          </Button>
          <Button @click="viewing = null">
            关闭
          </Button>
        </DialogFooter>
      </DialogPanel>
    </Dialog>

    <!-- 手动写入确认 -->
    <Dialog
      :open="writeOpen"
      @update:open="(open) => { if (!open) writeOpen = false }"
    >
      <DialogPanel width="lg" footer>
        <DialogHeader>
          <DialogTitle>让她现在写一篇日记？</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p class="text-body text-muted-foreground">
            她会根据最近的经历写今天的日记，需要调用一次模型、可能要等十几秒。今天已经写过时不会重复写入。
          </p>
        </DialogBody>
        <DialogFooter>
          <Button
            variant="outline"
            @click="writeOpen = false"
          >
            取消
          </Button>
          <Button
            :loading="writing"
            @click="writeToday"
          >
            写入
          </Button>
        </DialogFooter>
      </DialogPanel>
    </Dialog>

    <ConfirmDeleteDialog
      :open="deleteTarget !== null"
      title="删除这篇日记？"
      :description="deleteTarget ? `${fmtDate(deleteTarget.date)} 的日记会永久删除。` : ''"
      cancel-label="取消"
      confirm-label="删除"
      :loading="deleting"
      @update:open="(open) => { if (!open) deleteTarget = null }"
      @confirm="confirmDelete"
    />
  </PageShell>
</template>
