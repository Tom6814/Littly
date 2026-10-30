<script setup lang="ts">
/**
 * 账号绑定页 —— 绑定一次，网页端与各渠道就是同一个她。
 *
 * 行为基线：旧 React BindPage（5 个渠道生成绑定码、已绑定列表、解绑）。
 * 码一次有效（10 分钟）；同人同渠道只保留最新一条。解绑不删历史与记忆。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import {
  Badge,
  Button,
  CalloutBanner,
  CodePanel,
  ConfirmDeleteDialog,
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
import { Link2 } from 'lucide-vue-next'
import { errText, fmtDateTime } from '@/pages/her/shared/format'
import { bindApi, type BindCode, type BindIdentity, type BindStatus } from './api'

interface ChannelDef {
  key: string
  title: string
  help: string
}

/** key 必须与后端 CHANNEL_KINDS 一致：wechat / qq / qqp / discord / tg。 */
const CHANNELS: ChannelDef[] = [
  { key: 'qqp', title: 'QQ 个人号（SnowLuma）', help: '生成 6 位码后，在 QQ 里私聊她发「绑定 XXXXXX」。' },
  { key: 'tg', title: 'Telegram', help: '生成深链 nonce，把码发到 Telegram（或让对方点开绑定链接）。' },
  { key: 'wechat', title: '微信', help: '生成 6 位码后，在微信里私聊她发「绑定 XXXXXX」。' },
  { key: 'qq', title: 'QQ 官方', help: '生成 6 位码后，在 QQ 官方机器人会话里发「绑定 XXXXXX」。' },
  { key: 'discord', title: 'Discord', help: '生成 6 位码后，在 Discord 私聊她发「绑定 XXXXXX」。' },
]

const status = ref<BindStatus | null>(null)
const loading = ref(false)
const loadError = ref('')
const issuing = ref('')
const codes = reactive<Record<string, BindCode | undefined>>({})
const unbindTarget = ref<BindIdentity | null>(null)
const unbinding = ref(false)

const identities = computed(() => status.value?.identities ?? [])

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    status.value = await bindApi.status()
  } catch (e) {
    status.value = null
    loadError.value = errText(e)
  } finally {
    loading.value = false
  }
}

function channelTitle(key: string): string {
  return CHANNELS.find((c) => c.key === key)?.title ?? key
}

async function issueCode(channel: string): Promise<void> {
  issuing.value = channel
  try {
    const code = await bindApi.createCode(channel)
    codes[channel] = code
    toast.success('绑定码已生成')
    await load()
  } catch (e) {
    toast.error(errText(e))
  } finally {
    issuing.value = ''
  }
}

async function confirmUnbind(): Promise<void> {
  const target = unbindTarget.value
  if (!target) return
  unbinding.value = true
  try {
    const ok = await bindApi.unbind(target.channel, target.externalId)
    unbindTarget.value = null
    if (ok) toast.success('已解绑（历史与记忆保留）')
    else toast.info('这个绑定已经不存在了')
    await load()
  } catch (e) {
    toast.error(errText(e))
  } finally {
    unbinding.value = false
  }
}

onMounted(() => {
  void load()
})
</script>

<template>
  <PageShell
    title="账号绑定"
    description="绑定一次，网页端与各渠道就是同一个她——跨渠道同一条会话线。"
  >
    <CalloutBanner
      v-if="loadError"
      tone="destructive"
      title="绑定状态加载失败"
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
      v-else-if="loading && status === null"
      surface="tab"
      size="md"
    >
      正在读取绑定状态…
    </InlineLoadingRow>

    <template v-else>
      <div class="space-y-6">
      <!-- 已绑定 -->
      <SettingsSection :title="`已绑定的渠道（${identities.length}）`">
        <div
          v-if="identities.length === 0"
          class="px-4 py-8 text-center"
        >
          <p class="text-body text-muted-foreground">
            还没有绑定任何渠道。在下面生成绑定码，然后在对应渠道里发给她。
          </p>
        </div>
        <SettingsRow
          v-for="(identity, index) in identities"
          :key="`${identity.channel}/${identity.externalId}`"
          :label="channelTitle(identity.channel)"
          :divider="index < identities.length - 1"
        >
          <span class="font-mono text-caption text-muted-foreground">{{ identity.externalId }}</span>
          <Button
            variant="outline"
            size="sm"
            @click="unbindTarget = identity"
          >
            解绑
          </Button>
        </SettingsRow>
      </SettingsSection>

      <!-- 生成绑定码 -->
      <SettingsSection title="生成绑定码">
        <template #actions>
          <span class="text-caption text-muted-foreground">一次性 · 10 分钟内有效</span>
        </template>
        <template
          v-for="(channel, index) in CHANNELS"
          :key="channel.key"
        >
          <SettingsRow
            :label="channel.title"
            :description="channel.help"
            :divider="index < CHANNELS.length - 1 || codes[channel.key] !== undefined"
          >
            <Button
              variant="outline"
              size="sm"
              :loading="issuing === channel.key"
              @click="issueCode(channel.key)"
            >
              <Link2 />
              {{ codes[channel.key] ? '重新生成' : '生成码' }}
            </Button>
          </SettingsRow>
          <div
            v-if="codes[channel.key]"
            class="space-y-2 px-4 pb-4"
          >
            <CodePanel
              :code="codes[channel.key]!.code"
              copy-label="复制绑定码"
              copied-label="已复制"
              copy-failed-message="复制失败，请手动选中复制"
              width="fit"
            />
            <p class="text-caption text-muted-foreground">
              {{ codes[channel.key]!.instruction }}
            </p>
            <p
              v-if="codes[channel.key]!.expiresAt"
              class="text-caption text-muted-foreground"
            >
              有效期至 {{ fmtDateTime(codes[channel.key]!.expiresAt) }}（10 分钟）
            </p>
          </div>
        </template>
      </SettingsSection>

      <p class="px-2 text-caption text-muted-foreground">
        绑定码是一次性的，10 分钟内有效；同一人同一渠道只保留最新一个码。解绑不删除历史与记忆。
      </p>
      </div>
    </template>

    <ConfirmDeleteDialog
      :open="unbindTarget !== null"
      title="解绑这个渠道？"
      :description="unbindTarget ? `${channelTitle(unbindTarget.channel)}（${unbindTarget.externalId}）解绑后，该渠道的消息不再进入这条会话线；历史与记忆保留。` : ''"
      cancel-label="取消"
      confirm-label="解绑"
      :loading="unbinding"
      @update:open="(open) => { if (!open) unbindTarget = null }"
      @confirm="confirmUnbind"
    />
  </PageShell>
</template>
