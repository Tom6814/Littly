<script setup lang="ts">
import ChannelConfigPage from '@/components/ChannelConfigPage.vue'

const fields = [
  { key: 'botToken', label: 'Bot Token', description: 'Discord Developer Portal 签发的 bot token', secret: true },
  { key: 'clientId', label: 'Client ID', description: '应用 ID（用于生成邀请链接）', placeholder: '1234567890' },
]
</script>

<template>
  <ChannelConfigPage
    channel="discord"
    title="Discord"
    description="把她的 Discord Bot 邀请进服务器，或直接私聊。"
    :fields="fields"
    bind-hint="绑定码生成后，在 Discord 里私聊她发送「绑定 <码>」。"
  />
</template>
