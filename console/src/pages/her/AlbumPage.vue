<script setup lang="ts">
/**
 * 相册页 —— 她看过的世界留下的瞬间。
 *
 * 行为基线：旧 React AlbumPage（多选上传、网格、灯箱、说明/标签编辑、删除确认）。
 * 图片 URL 是后端 `/api/photos/file/...`（同源、长缓存）；本页不代理二进制。
 */
import { computed, onMounted, ref, watch } from 'vue'
import {
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
  SurfaceCard,
  toast,
} from '@felinic/ui'
import { ImagePlus, Pencil, Trash2 } from 'lucide-vue-next'
import { errText } from './shared/format'
import { useBots } from '@/stores/bots'
import { albumApi, type Photo } from './api'

const bots = useBots()
const botId = computed(() => bots.currentBotId.value ?? '')

const photos = ref<Photo[]>([])
const loading = ref(false)
const loadError = ref('')
const uploading = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

const lightbox = ref<Photo | null>(null)
const editTarget = ref<Photo | null>(null)
const editCaption = ref('')
const editTags = ref('')
const saving = ref(false)
const deleteTarget = ref<Photo | null>(null)
const deleting = ref(false)

const MAX_UPLOAD_FILES = 9

async function load(): Promise<void> {
  if (!botId.value) {
    photos.value = []
    return
  }
  loading.value = true
  loadError.value = ''
  try {
    photos.value = await albumApi.list(botId.value)
  } catch (e) {
    photos.value = []
    loadError.value = errText(e)
  } finally {
    loading.value = false
  }
}

function pickFiles(): void {
  fileInput.value?.click()
}

async function onFilesChosen(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? []).slice(0, MAX_UPLOAD_FILES)
  input.value = ''
  if (files.length === 0 || !botId.value) return
  uploading.value = true
  let ok = 0
  try {
    for (const file of files) {
      try {
        await albumApi.upload(botId.value, file)
        ok += 1
      } catch (e) {
        toast.error(`「${file.name}」上传失败：${errText(e)}`)
      }
    }
    if (ok > 0) toast.success(ok === 1 ? '照片已上传' : `已上传 ${ok} 张照片`)
    await load()
  } finally {
    uploading.value = false
  }
}

/** 灯箱里编辑：先关灯箱再开编辑框，避免两个 Dialog 叠加。 */
function editFromLightbox(): void {
  if (!lightbox.value) return
  const target = lightbox.value
  lightbox.value = null
  openEdit(target)
}

function openEdit(photo: Photo): void {
  editTarget.value = photo
  editCaption.value = photo.caption
  editTags.value = photo.tags.join('、')
}

function parseTags(raw: string): string[] {
  return raw
    .split(/[,，、]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

async function saveEdit(): Promise<void> {
  const target = editTarget.value
  if (!target || !botId.value) return
  saving.value = true
  try {
    await albumApi.update(target.id, botId.value, {
      caption: editCaption.value.trim(),
      tags: parseTags(editTags.value),
    })
    editTarget.value = null
    toast.success('照片说明已保存')
    await load()
  } catch (e) {
    toast.error(errText(e))
  } finally {
    saving.value = false
  }
}

async function confirmDelete(): Promise<void> {
  const target = deleteTarget.value
  if (!target || !botId.value) return
  deleting.value = true
  try {
    await albumApi.remove(target.id, botId.value)
    deleteTarget.value = null
    if (lightbox.value?.id === target.id) lightbox.value = null
    toast.success('照片已删除')
    await load()
  } catch (e) {
    toast.error(errText(e))
  } finally {
    deleting.value = false
  }
}

watch(botId, () => void load())
onMounted(() => {
  void bots.bootstrap()
  void load()
})
</script>

<template>
  <PageShell
    title="相册"
    description="她看过的世界，留下的瞬间。上传后可以直接在对话里被她引用。"
  >
    <template #actions>
      <input
        ref="fileInput"
        type="file"
        accept="image/*"
        multiple
        class="hidden"
        @change="onFilesChosen"
      />
      <Button
        :disabled="!botId"
        :loading="uploading"
        @click="pickFiles"
      >
        <ImagePlus />
        上传照片
      </Button>
    </template>

    <Empty v-if="!botId">
      <EmptyHeader>
        <EmptyTitle>还没有可用的「她」</EmptyTitle>
        <EmptyDescription>先完成引导或创建一个角色卡，相册才有归属。</EmptyDescription>
      </EmptyHeader>
    </Empty>

    <template v-else>
      <CalloutBanner
        v-if="loadError"
        tone="destructive"
        title="相册加载失败"
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
        v-else-if="loading && photos.length === 0"
        surface="tab"
        size="md"
      >
        正在读取相册…
      </InlineLoadingRow>

      <Empty v-else-if="photos.length === 0">
        <EmptyHeader>
          <EmptyTitle>相册还是空的</EmptyTitle>
          <EmptyDescription>上传第一张照片，和她分享。</EmptyDescription>
        </EmptyHeader>
        <Button
          variant="outline"
          @click="pickFiles"
        >
          <ImagePlus />
          上传照片
        </Button>
      </Empty>

      <div
        v-else
        class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
      >
        <SurfaceCard
          v-for="photo in photos"
          :key="photo.id"
          padding="none"
        >
          <button
            type="button"
            class="block w-full cursor-zoom-in"
            :aria-label="photo.caption || '查看照片'"
            @click="lightbox = photo"
          >
            <img
              :src="photo.url"
              :alt="photo.caption || '照片'"
              loading="lazy"
              class="aspect-[4/3] w-full object-cover"
            >
          </button>
          <div class="space-y-1 p-3">
            <div class="flex items-start justify-between gap-2">
              <p class="min-w-0 flex-1 truncate text-label font-medium">
                {{ photo.caption || '未命名' }}
              </p>
              <div class="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="编辑照片说明"
                  @click="openEdit(photo)"
                >
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="删除照片"
                  @click="deleteTarget = photo"
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
            <p
              v-if="photo.tags.length > 0"
              class="truncate text-caption text-muted-foreground"
            >
              {{ photo.tags.join('、') }}
            </p>
          </div>
        </SurfaceCard>
      </div>
    </template>

    <!-- 灯箱 -->
    <Dialog
      :open="lightbox !== null"
      @update:open="(open) => { if (!open) lightbox = null }"
    >
      <DialogPanel width="4xl">
        <DialogHeader>
          <DialogTitle>{{ lightbox?.caption || '照片' }}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <img
            v-if="lightbox"
            :src="lightbox.url"
            :alt="lightbox.caption || '照片'"
            class="mx-auto max-h-[72dvh] w-auto max-w-full rounded-md object-contain"
          >
        </DialogBody>
        <DialogFooter>
          <Button
            v-if="lightbox"
            variant="outline"
            @click="editFromLightbox"
          >
            <Pencil />
            编辑说明
          </Button>
          <Button @click="lightbox = null">
            关闭
          </Button>
        </DialogFooter>
      </DialogPanel>
    </Dialog>

    <!-- 编辑说明/标签 -->
    <Dialog
      :open="editTarget !== null"
      @update:open="(open) => { if (!open) editTarget = null }"
    >
      <DialogPanel width="lg" footer>
        <DialogHeader>
          <DialogTitle>编辑照片</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <FormStack>
            <div
              v-if="editTarget"
              class="overflow-hidden rounded-md"
            >
              <img
                :src="editTarget.url"
                :alt="editTarget.caption || '照片'"
                class="max-h-56 w-full object-contain"
              >
            </div>
            <FieldStack label="说明">
              <Input
                v-model="editCaption"
                placeholder="这张照片发生了什么"
              />
            </FieldStack>
            <FieldStack
              label="标签"
              help="逗号分隔，用于检索与回忆。"
            >
              <Input
                v-model="editTags"
                placeholder="例如：海边、日落、第一次旅行"
              />
            </FieldStack>
          </FormStack>
        </DialogBody>
        <DialogFooter>
          <Button
            variant="outline"
            @click="editTarget = null"
          >
            取消
          </Button>
          <Button
            :loading="saving"
            @click="saveEdit"
          >
            保存
          </Button>
        </DialogFooter>
      </DialogPanel>
    </Dialog>

    <ConfirmDeleteDialog
      :open="deleteTarget !== null"
      title="删除这张照片？"
      :description="deleteTarget?.caption || '删除后不可恢复。'"
      cancel-label="取消"
      confirm-label="删除"
      :loading="deleting"
      @update:open="(open) => { if (!open) deleteTarget = null }"
      @confirm="confirmDelete"
    />
  </PageShell>
</template>
