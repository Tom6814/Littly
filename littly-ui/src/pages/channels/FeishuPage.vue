<script setup lang="ts">
import ChannelConfigPage from '@/components/ChannelConfigPage.vue'

const fields = [
  { key: 'appId', label: 'App ID', description: '飞书开放平台应用 App ID' },
  { key: 'appSecret', label: 'App Secret', description: '应用密钥', secret: true },
  { key: 'encryptKey', label: 'Encrypt Key', description: '事件加密密钥（可空）', secret: true },
  { key: 'verificationToken', label: 'Verification Token', description: '事件校验 token（可空）', secret: true },
  { key: 'region', label: 'Region', description: 'feishu 或 lark', placeholder: 'feishu' },
  { key: 'inboundMode', label: '接入模式', description: 'websocket 或 webhook', placeholder: 'websocket' },
]
</script>

<template>
  <ChannelConfigPage
    channel="feishu"
    title="飞书"
    description="让她通过飞书机器人与你聊天。"
    :fields="fields"
    bind-hint="应用发布后，在飞书里私聊她发送绑定码。"
  />
</template>
