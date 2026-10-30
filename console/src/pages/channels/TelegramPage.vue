<script setup lang="ts">
import ChannelConfigPage from '@/components/ChannelConfigPage.vue'

const fields = [
  { key: 'botToken', label: 'Bot Token', description: 'BotFather 签发的 token', secret: true, placeholder: '123456:ABC…' },
  { key: 'webhookSecret', label: 'Webhook Secret', description: '可留空，由后端生成', secret: true },
  { key: 'username', label: 'Bot 用户名', description: '例如 @littly_bot', placeholder: '@your_bot' },
  { key: 'mode', label: '接入模式', description: 'polling 或 webhook', placeholder: 'polling' },
]
</script>

<template>
  <ChannelConfigPage
    channel="telegram"
    title="Telegram"
    description="让她通过 Telegram Bot 与你聊天。"
    :fields="fields"
    bind-hint="绑定码生成后，在 Telegram 里私聊她发送「绑定 <码>」。"
  />
</template>
