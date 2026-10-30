<script setup lang="ts">
/**
 * 角色卡 —— 列表 / 新建 / 编辑 / 导入 PNG / 导出 / 删除。
 * GET/POST /api/characters、PATCH/DELETE /api/characters/:id
 * POST /api/characters/import-png、GET /api/characters/:id/export-png
 * 写操作要求 admin（后端策略），非管理员只读。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import {
  Button,
  CalloutBanner,
  ConfirmPopover,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  FormDialogShell,
  PageShell,
  SettingsRow,
  SettingsSection,
  Spinner,
  toast,
} from '@felinic/ui'
import { Download, FileUp, Pencil, Plus, Trash2 } from 'lucide-vue-next'
import { charactersApi } from '@/api/endpoints'
import { ApiError } from '@/api/client'
import { emptyCharacterForm, type CharacterFormState } from '@/components/character-form'
import CharacterFormFields from '@/components/CharacterFormFields.vue'
import type { Character } from '@/api/types'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const isAdmin = computed(() => auth.state.user?.role === 'admin')

const loading = ref(true)
const error = ref('')
const characters = ref<Character[]>([])

const createForm = reactive<CharacterFormState>(emptyCharacterForm())
const editForm = reactive<CharacterFormState>(emptyCharacterForm())
const createOpen = ref(false)
const editOpen = ref(false)
const editingId = ref('')
const saving = ref(false)
const importing = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

onMounted(async () => {
  await load()
})

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    characters.value = await charactersApi.list()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载角色卡失败'
  } finally {
    loading.value = false
  }
}

function cardOf(character: Character): CharacterFormState {
  const card = (character.card ?? {}) as Record<string, unknown>
  return {
    name: String(card.name ?? character.name ?? ''),
    description: String(card.description ?? ''),
    personality: String(card.personality ?? ''),
    scenario: String(card.scenario ?? ''),
    firstMes: String(card.first_mes ?? card.firstMes ?? character.firstMes ?? ''),
  }
}

function toCard(form: CharacterFormState): Record<string, unknown> {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    name: form.name,
    description: form.description,
    personality: form.personality,
    scenario: form.scenario,
    first_mes: form.firstMes,
    creator: 'littly',
  }
}

async function create(): Promise<void> {
  if (createForm.name.trim() === '') {
    toast.error('角色名不能为空')
    return
  }
  saving.value = true
  try {
    await charactersApi.create({ name: createForm.name.trim(), card: toCard(createForm) })
    toast.success('角色卡已创建')
    createOpen.value = false
    Object.assign(createForm, emptyCharacterForm())
    await load()
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '创建失败')
  } finally {
    saving.value = false
  }
}

/** 打开编辑（Dialog 的 open 变化时同步表单）。 */
function onEditOpenChange(character: Character, open: boolean): void {
  if (!open) {
    editOpen.value = false
    return
  }
  editingId.value = character.id
  Object.assign(editForm, cardOf(character))
  editOpen.value = true
}

async function saveEdit(): Promise<void> {
  if (editingId.value === '') return
  if (editForm.name.trim() === '') {
    toast.error('角色名不能为空')
    return
  }
  saving.value = true
  try {
    await charactersApi.update(editingId.value, { name: editForm.name.trim(), card: toCard(editForm) })
    toast.success('角色卡已保存')
    editOpen.value = false
    await load()
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '保存失败')
  } finally {
    saving.value = false
  }
}

async function remove(character: Character): Promise<void> {
  try {
    await charactersApi.remove(character.id)
    toast.success('角色卡已删除')
    await load()
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '删除失败')
  }
}

function triggerImport(): void {
  fileInput.value?.click()
}

async function onFilePicked(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  importing.value = true
  try {
    await charactersApi.importPng(file)
    toast.success('角色卡已导入')
    await load()
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '导入失败')
  } finally {
    importing.value = false
  }
}

function descriptionOf(character: Character): string {
  const card = (character.card ?? {}) as Record<string, unknown>
  return String(card.description ?? '')
}
</script>

<template>
  <PageShell title="角色卡" description="她的身份、性格与开场白；也是导入/导出角色卡的入口。">
    <template #actions>
      <Button variant="outline" :disabled="importing" @click="triggerImport">
        <Spinner v-if="importing" class="size-4" />
        <FileUp v-else />
        导入 PNG
      </Button>
      <FormDialogShell
        v-model:open="createOpen"
        title="新建角色卡"
        cancel-text="取消"
        submit-text="创建"
        :loading="saving"
        :submit-disabled="createForm.name.trim() === ''"
        @submit="create"
      >
        <template #trigger>
          <Button>
            <Plus />
            新建角色
          </Button>
        </template>
        <template #body>
          <CharacterFormFields :form="createForm" />
        </template>
      </FormDialogShell>
      <input ref="fileInput" type="file" accept="image/png" class="hidden" @change="onFilePicked" />
    </template>

    <div class="space-y-8">
      <CalloutBanner v-if="error" tone="destructive" :description="error" size="sm" />
      <CalloutBanner
        v-if="!isAdmin"
        tone="neutral"
        title="只读模式"
        description="新建、编辑、导入与删除需要管理员账号；当前账号可以查看角色卡。"
      />

      <div v-if="loading" class="flex items-center gap-2 py-8 text-label text-muted-foreground">
        <Spinner class="size-4" />
        正在载入角色卡…
      </div>

      <SettingsSection v-else title="全部角色">
        <div v-if="characters.length === 0">
          <Empty>
            <EmptyHeader>
              <EmptyTitle>还没有角色卡</EmptyTitle>
              <EmptyDescription>新建一张角色卡，或导入 PNG 角色卡文件。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
        <SettingsRow
          v-for="character in characters"
          :key="character.id"
          :label="character.name"
          :description="descriptionOf(character)"
          align="start"
        >
          <div class="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="导出角色卡"
              as="a"
              :href="charactersApi.exportUrl(character.id)"
              download
            >
              <Download />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="编辑角色卡"
              :disabled="!isAdmin"
              @click="onEditOpenChange(character, true)"
            >
              <Pencil />
            </Button>
            <ConfirmPopover
              title="删除这张角色卡？"
              message="删除后不可恢复；对应的对话记录会保留。"
              confirm-text="删除"
              cancel-text="取消"
              variant="destructive"
              @confirm="remove(character)"
            >
              <template #trigger>
                <Button variant="ghost" size="icon-sm" aria-label="删除角色卡" :disabled="!isAdmin">
                  <Trash2 />
                </Button>
              </template>
            </ConfirmPopover>
          </div>
        </SettingsRow>
      </SettingsSection>
    </div>

    <!-- 编辑弹窗（列表行共用；由弹窗 open 状态同步表单） -->
    <FormDialogShell
      v-model:open="editOpen"
      title="编辑角色卡"
      cancel-text="取消"
      submit-text="保存"
      :loading="saving"
      :submit-disabled="editForm.name.trim() === ''"
      @submit="saveEdit"
    >
      <template #body>
        <CharacterFormFields :form="editForm" />
      </template>
    </FormDialogShell>
  </PageShell>
</template>
