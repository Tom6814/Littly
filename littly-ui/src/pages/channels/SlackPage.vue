<script setup lang="ts">
import ChannelConfigPage from '@/components/ChannelConfigPage.vue'

const fields = [
  { key: 'botToken', label: 'Bot Token', description: 'Slack Bot OAuth token', secret: true },
  { key: 'appToken', label: 'App Token', description: 'Socket Mode App-Level token（可空）', secret: true },
]
</script>

<template>
  <ChannelConfigPage
    channel="slack"
    title="Slack"
    description="把她接入 Slack 工作区。"
    :fields="fields"
    bind-hint="安装应用后，在 Slack 里私聊她发送绑定码。"
  />
</template>
