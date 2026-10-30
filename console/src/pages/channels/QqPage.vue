<script setup lang="ts">
import ChannelConfigPage from '@/components/ChannelConfigPage.vue'

const fields = [
  { key: 'appId', label: 'AppID', description: 'QQ 开放平台机器人 AppID', placeholder: '1020xxxx' },
  { key: 'appSecret', label: 'AppSecret', description: '开放平台密钥', secret: true },
  { key: 'accessToken', label: 'Access Token', description: '可选，手动指定时填写', secret: true },
]
</script>

<template>
  <ChannelConfigPage
    channel="qq"
    title="QQ"
    description="通过 QQ 官方机器人接入她（被动回复窗口内生效）。"
    :fields="fields"
    bind-hint="绑定码生成后，在 QQ 里私聊她发送「绑定 <码>」。"
  />
</template>
