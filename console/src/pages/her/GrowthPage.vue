<script setup lang="ts">
/**
 * 成长页 —— 成长档案需审批（提议-审批制，永不静默生效）。
 *
 * 行为基线：旧 React GrowthPage（维度、待批提案的四种裁决、复审窗口、版本
 * 历史+回滚、成长报告、触发评估、三铁律脚注）。
 *
 * 与旧版的差异（有意修正）：
 * - 「改后批准」旧页把 summary 文本当 changes 传给后端（后端只读 `changes` 数组，
 *   旧请求等于静默丢弃编辑）。本版编辑的是结构化 changes JSON，提交 `changes`。
 * - 进度条用库的 Progress（不手写宽度 div）。
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
  PageShell,
  Progress,
  SettingsRow,
  SettingsSection,
  Textarea,
  toast,
} from '@felinic/ui'
import { CircleCheck, CircleX, FileText, Play, RotateCcw, Sparkles, XCircle } from 'lucide-vue-next'
import { DASH, errText, fmtDateTime } from './shared/format'
import { useBots } from '@/stores/bots'
import { growthApi, type GrowthData, type GrowthProposal } from './api'

const bots = useBots()
const botId = computed(() => bots.currentBotId.value ?? '')

const data = ref<GrowthData | null>(null)
const loading = ref(false)
const loadError = ref('')
const evaluating = ref(false)

const reportOpen = ref(false)
const editTarget = ref<GrowthProposal | null>(null)
const editChanges = ref('')
const editError = ref('')
const deciding = ref(false)
const decideId = ref('')
const rollbackVersion = ref<number | null>(null)

const dimensions = computed(() => data.value?.dimensions ?? [])
const proposals = computed(() => data.value?.proposals ?? [])
const versions = computed(() => data.value?.versions ?? [])

async function load(): Promise<void> {
  if (!botId.value) {
    data.value = null
    return
  }
  loading.value = true
  loadError.value = ''
  try {
    data.value = await growthApi.get(botId.value)
  } catch (e) {
    data.value = null
    loadError.value = errText(e)
  } finally {
    loading.value = false
  }
}

function levelPercent(level: number, max: number | undefined): number | undefined {
  if (max === undefined || max <= 0) return undefined
  return Math.min(100, Math.round((level / max) * 100))
}

async function evaluate(): Promise<void> {
  if (!botId.value) return
  evaluating.value = true
  try {
    await growthApi.action(botId.value, 'evaluate')
    toast.success('已触发一次成长评估')
    await load()
  } catch (e) {
    toast.error(errText(e))
  } finally {
    evaluating.value = false
  }
}

async function decide(proposal: GrowthProposal, decision: 'approve' | 'reject' | 'cancel'): Promise<void> {
  deciding.value = true
  decideId.value = proposal.id
  try {
    await growthApi.decide(proposal.id, decision)
    toast.success(decision === 'approve' ? '提案已批准' : decision === 'reject' ? '提案已驳回' : '提案已取消')
    await load()
  } catch (e) {
    toast.error(errText(e))
  } finally {
    deciding.value = false
    decideId.value = ''
  }
}

function openEdit(proposal: GrowthProposal): void {
  editTarget.value = proposal
  editError.value = ''
  editChanges.value = JSON.stringify(proposal.changesParsed ?? [], null, 2)
}

async function approveEdited(): Promise<void> {
  const proposal = editTarget.value
  if (!proposal) return
  let parsed: unknown
  try {
    parsed = JSON.parse(editChanges.value)
  } catch {
    editError.value = '不是合法的 JSON'
    return
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    editError.value = 'changes 必须是非空数组'
    return
  }
  deciding.value = true
  try {
    await growthApi.decide(proposal.id, 'approve_edited', parsed)
    editTarget.value = null
    toast.success('已按修改后的内容批准')
    await load()
  } catch (e) {
    toast.error(errText(e))
  } finally {
    deciding.value = false
  }
}

async function confirmRollback(): Promise<void> {
  if (!botId.value || rollbackVersion.value === null) return
  deciding.value = true
  try {
    await growthApi.action(botId.value, 'rollback', rollbackVersion.value)
    rollbackVersion.value = null
    toast.success('已回滚成长档案')
    await load()
  } catch (e) {
    toast.error(errText(e))
  } finally {
    deciding.value = false
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
    title="成长"
    description="她的变化，每一步都要有证据。成长档案需审批，永不静默生效。"
  >
    <template #actions>
      <Button
        variant="outline"
        :disabled="!botId"
        :loading="evaluating"
        @click="evaluate"
      >
        <Play />
        触发评估
      </Button>
      <Button
        variant="outline"
        :disabled="!data?.profile?.report"
        @click="reportOpen = true"
      >
        <FileText />
        成长报告
      </Button>
    </template>

    <Empty v-if="!botId">
      <EmptyHeader>
        <EmptyTitle>还没有可用的「她」</EmptyTitle>
        <EmptyDescription>先完成引导或创建一个角色卡，成长才有主体。</EmptyDescription>
      </EmptyHeader>
    </Empty>

    <template v-else>
      <CalloutBanner
        v-if="loadError"
        tone="destructive"
        title="成长档案加载失败"
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
        v-else-if="loading && data === null"
        surface="tab"
        size="md"
      >
        正在读取成长档案…
      </InlineLoadingRow>

      <template v-else>
        <div class="space-y-6">
        <!-- 成长维度 -->
        <SettingsSection title="成长维度">
          <template #actions>
            <Badge
              v-if="data?.profile?.version !== undefined"
              variant="outline"
            >
              v{{ data.profile.version }}
            </Badge>
            <span
              v-if="data?.profile?.lifeStage"
              class="text-caption text-muted-foreground"
            >
              {{ data.profile.lifeStage }}
            </span>
          </template>
          <div
            v-if="dimensions.length === 0"
            class="px-4 py-8 text-center"
          >
            <p class="text-body text-muted-foreground">
              还没有成长档案。触发一次评估后，她会慢慢长出自己的样子。
            </p>
          </div>
          <SettingsRow
            v-for="(dim, index) in dimensions"
            :key="dim.name"
            :label="dim.name"
            :description="dim.description"
            :divider="index < dimensions.length - 1"
            stack="sm"
          >
            <div class="flex items-center gap-3">
              <Progress
                v-if="levelPercent(dim.level, dim.max) !== undefined"
                :model-value="levelPercent(dim.level, dim.max)"
                class="w-28"
              />
              <Badge variant="info">
                等级 {{ dim.level }}{{ dim.max !== undefined ? ` / ${dim.max}` : '' }}
              </Badge>
            </div>
          </SettingsRow>
        </SettingsSection>

        <!-- 待审批提议 -->
        <SettingsSection :title="`待审批提议（${proposals.length}）`">
          <div
            v-if="proposals.length === 0"
            class="px-4 py-8 text-center"
          >
            <p class="text-body text-muted-foreground">
              没有待审批的成长提议。有证据链的提议才会出现在这里。
            </p>
          </div>
          <SettingsRow
            v-for="(proposal, index) in proposals"
            :key="proposal.id"
            align="start"
            stack="always"
            :divider="index < proposals.length - 1"
          >
            <div class="space-y-2">
              <div class="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">
                  {{ proposal.trigger || '成长提议' }}
                </Badge>
                <span class="text-caption text-muted-foreground">
                  {{ fmtDateTime(proposal.createdAt) }}
                </span>
                <span
                  v-if="proposal.basedVersion !== undefined"
                  class="text-caption text-muted-foreground"
                >
                  基于 v{{ proposal.basedVersion }}
                </span>
                <span
                  v-if="proposal.expiresAt"
                  class="text-caption text-muted-foreground"
                >
                  · {{ fmtDateTime(proposal.expiresAt) }} 过期
                </span>
              </div>
              <p class="text-body font-medium text-foreground">
                {{ proposal.majorEvents || proposal.summary || '（无摘要）' }}
              </p>
              <div v-if="proposal.evidence.length > 0">
                <p class="text-caption text-muted-foreground">
                  证据链（{{ proposal.evidence.length }} 条）：
                </p>
                <ul class="mt-1 list-disc space-y-0.5 pl-5">
                  <li
                    v-for="(item, evidenceIndex) in proposal.evidence"
                    :key="evidenceIndex"
                    class="text-body text-muted-foreground"
                  >
                    {{ item }}
                  </li>
                </ul>
              </div>
              <div class="flex flex-wrap items-center gap-2 pt-1">
                <Button
                  size="sm"
                  :loading="deciding && decideId === proposal.id"
                  @click="decide(proposal, 'approve')"
                >
                  <CircleCheck />
                  批准
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  :disabled="deciding"
                  @click="openEdit(proposal)"
                >
                  <Sparkles />
                  改后批准
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  :disabled="deciding"
                  @click="decide(proposal, 'reject')"
                >
                  <CircleX />
                  驳回
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  :disabled="deciding"
                  @click="decide(proposal, 'cancel')"
                >
                  <XCircle />
                  取消
                </Button>
              </div>
            </div>
          </SettingsRow>
        </SettingsSection>

        <!-- 复审窗口 -->
        <SettingsSection title="复审窗口">
          <SettingsRow label="上次复审">
            <span class="text-body text-foreground">{{ fmtDateTime(data?.window?.lastAt) }}</span>
          </SettingsRow>
          <SettingsRow
            label="下次复审"
            :divider="false"
          >
            <span class="text-body text-foreground">
              {{ data?.window?.nextAt ? fmtDateTime(data.window.nextAt) : (data?.nextReviewAt ? fmtDateTime(data.nextReviewAt) : DASH) }}
            </span>
          </SettingsRow>
          <div
            v-if="data?.window?.reason || data?.nextReviewText"
            class="px-4 pb-3 text-caption text-muted-foreground"
          >
            {{ data?.window?.reason || data?.nextReviewText }}
          </div>
          <div
            v-if="data?.reviewWindowOpen"
            class="px-4 pb-3"
          >
            <Badge variant="success">
              评审窗口已开启
            </Badge>
          </div>
        </SettingsSection>

        <!-- 版本历史 -->
        <SettingsSection title="版本历史">
          <div
            v-if="versions.length === 0"
            class="px-4 py-6 text-center text-body text-muted-foreground"
          >
            还没有版本记录。
          </div>
          <SettingsRow
            v-for="(version, index) in versions"
            :key="`${version.version ?? index}`"
            :label="`v${version.version ?? '?'}`"
            :description="version.summary || ''"
            :divider="index < versions.length - 1"
          >
            <span class="text-caption text-muted-foreground">{{ fmtDateTime(version.createdAt) }}</span>
            <Button
              variant="outline"
              size="sm"
              :disabled="deciding"
              @click="rollbackVersion = version.version ?? null"
            >
              <RotateCcw />
              回滚
            </Button>
          </SettingsRow>
        </SettingsSection>

        <p class="px-2 text-caption text-muted-foreground">
          三铁律：证据链 ≥ 2 条 · 单维 ≤ ±1 级 · 总位移 ≤ 6 级 · 价值禁区不可逾越。
        </p>
        </div>
      </template>
    </template>

    <!-- 成长报告 -->
    <Dialog
      :open="reportOpen"
      @update:open="(open) => { reportOpen = open }"
    >
      <DialogPanel width="2xl">
        <DialogHeader>
          <DialogTitle>成长报告</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p class="whitespace-pre-wrap text-body leading-relaxed text-foreground">
            {{ data?.profile?.report || '暂无报告' }}
          </p>
        </DialogBody>
        <DialogFooter>
          <Button @click="reportOpen = false">
            关闭
          </Button>
        </DialogFooter>
      </DialogPanel>
    </Dialog>

    <!-- 改后批准 -->
    <Dialog
      :open="editTarget !== null"
      @update:open="(open) => { if (!open) editTarget = null }"
    >
      <DialogPanel width="xl" footer>
        <DialogHeader>
          <DialogTitle>改后批准</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <FormStack>
            <p class="text-body text-muted-foreground">
              直接修改结构化变更集（JSON 数组）。后端会重新跑三铁律硬校验，不通过会返回具体原因。
            </p>
            <FieldStack
              label="changes"
              :help="editError || '必须是 JSON 数组，元素形如 { dimension, from, to, evidenceIds }。'"
            >
              <Textarea
                v-model="editChanges"
                :rows="12"
                class="font-mono text-caption"
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
            :loading="deciding"
            @click="approveEdited"
          >
            批准
          </Button>
        </DialogFooter>
      </DialogPanel>
    </Dialog>

    <ConfirmDeleteDialog
      :open="rollbackVersion !== null"
      :title="rollbackVersion !== null ? `回滚到 v${rollbackVersion}？` : '回滚成长档案？'"
      description="回滚后当前档案将被撤销，历史版本保留、可再次前滚。"
      cancel-label="取消"
      confirm-label="回滚"
      :loading="deciding"
      @update:open="(open) => { if (!open) rollbackVersion = null }"
      @confirm="confirmRollback"
    />
  </PageShell>
</template>
