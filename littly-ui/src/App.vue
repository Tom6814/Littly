<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import AppShell from '@/components/AppShell.vue'
import { Toaster, TooltipProvider } from '@felinic/ui'

// 全屏且不套壳的路由：登录 / 注册 / 首次引导（引导有自己的全屏向导壳）。
const bareRoutes = new Set(['login', 'register', 'onboarding'])
const route = useRoute()
// 首次导航解析完成前 name 为 undefined：先按裸路由渲染，避免外壳（及其
// /api/bots 探测）在登录页闪现，也避免未登录时的多余 401 请求。
const bare = computed(() => route.name === undefined || bareRoutes.has(String(route.name)))
</script>

<template>
  <TooltipProvider>
    <AppShell v-if="!bare">
      <RouterView />
    </AppShell>
    <RouterView v-else />
    <Toaster />
  </TooltipProvider>
</template>
