<script setup lang="ts">
/** 登录页：用户名 + 密码，写 httpOnly Cookie 会话。 */
import { nextTick, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Button, CalloutBanner, FieldStack, Input, Label, Spinner } from '@felinic/ui'
import { useAuthStore } from '@/stores/auth'
import { ApiError } from '@/api/client'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()

const username = ref('')
const password = ref('')
const error = ref('')
const usernameInput = ref<InstanceType<typeof Input> | null>(null)

onMounted(() => {
  const el = document.querySelector<HTMLInputElement>('#login-username')
  el?.focus()
})

async function submit(): Promise<void> {
  error.value = ''
  if (!username.value.trim() || !password.value) {
    error.value = '请输入用户名和密码'
    return
  }
  try {
    await auth.login(username.value.trim(), password.value)
    const next = typeof route.query.next === 'string' ? route.query.next : '/chat'
    await router.replace(next)
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : '登录失败，请稍后再试'
  }
}

async function focusPassword(): Promise<void> {
  await nextTick()
  document.querySelector<HTMLInputElement>('#login-password')?.focus()
}
</script>

<template>
  <div class="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
    <div class="w-full max-w-sm">
      <div class="mb-8 text-center">
        <h1 class="text-display font-semibold text-foreground">Littly</h1>
        <p class="mt-1 text-control text-muted-foreground">她在这里。登录继续。</p>
      </div>

      <form class="space-y-4" @submit.prevent="submit">
        <CalloutBanner v-if="error" tone="destructive" :description="error" size="sm" />

        <FieldStack label="用户名" for="login-username">
          <Input
            id="login-username"
            v-model="username"
            autocomplete="username"
            placeholder="请输入用户名"
            @keydown.enter.prevent="focusPassword"
          />
        </FieldStack>
        <FieldStack label="密码" for="login-password">
          <Input
            id="login-password"
            v-model="password"
            type="password"
            autocomplete="current-password"
            placeholder="请输入密码"
          />
        </FieldStack>

        <Button type="submit" class="w-full" :disabled="auth.state.loading">
          <Spinner v-if="auth.state.loading" class="size-4" />
          登录
        </Button>
      </form>

      <p class="mt-6 text-center text-label text-muted-foreground">
        还没有账号？
        <RouterLink to="/register" class="text-foreground underline underline-offset-4">
          创建账号
        </RouterLink>
      </p>
    </div>
  </div>
</template>
