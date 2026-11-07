<script setup lang="ts">
import ChannelConfigPage from '@/components/ChannelConfigPage.vue'

const fields = [
  { key: 'token', label: 'Bridge Token', description: 'iLink/桥接服务签发的 token', secret: true },
  { key: 'baseUrl', label: 'Base URL', description: '桥接服务地址，默认官方地址', placeholder: 'https://…' },
  { key: 'pollTimeoutSeconds', label: '轮询超时（秒）', description: '长轮询超时，默认 45' },
  { key: 'enableTyping', label: '正在输入状态', description: 'true / false' },
]
</script>

<template>
  <ChannelConfigPage
    channel="weixin"
    title="微信"
    description="通过微信桥接服务接入她。"
    :fields="fields"
    bind-hint="桥接服务绑定后，向她的微信发送绑定码完成身份确认。"
  />
</template>
