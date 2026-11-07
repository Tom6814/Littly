<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { Button, CalloutBanner, FieldStack, Input, Spinner } from '@felinic/ui'
import { useAuthStore } from '@/stores/auth'
import { ApiError } from '@/api/client'

const router = useRouter()
const auth = useAuthStore()
const username = ref('')
const password = ref('')
const confirm = ref('')
const error = ref('')

async function submit(): Promise<void> {
  error.value = ''
  if (!username.value.trim() || password.value.length < 6) {
    error.value = '用户名不能为空，密码至少 6 位'
    return
  }
  if (password.value !== confirm.value) {
    error.value = '两次输入的密码不一致'
    return
  }
  try {
    await auth.register(username.value.trim(), password.value)
    await router.replace('/onboarding')
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : '注册失败，请稍后再试'
  }
}
</script>

<template>
  <div class="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
    <div class="w-full max-w-sm">
      <div class="mb-8 text-center">
        <h1 class="text-display font-semibold text-foreground">创建账号</h1>
        <p class="mt-1 text-control text-muted-foreground">先有一个账号，然后开始认识她。</p>
      </div>
      <form class="space-y-4" @submit.prevent="submit">
        <CalloutBanner v-if="error" tone="destructive" :description="error" size="sm" />
        <FieldStack label="用户名" for="reg-username">
          <Input id="reg-username" v-model="username" autocomplete="username" placeholder="请输入用户名" />
        </FieldStack>
        <FieldStack label="密码" for="reg-password" help="至少 6 位">
          <Input id="reg-password" v-model="password" type="password" autocomplete="new-password" placeholder="设置密码" />
        </FieldStack>
        <FieldStack label="确认密码" for="reg-confirm">
          <Input id="reg-confirm" v-model="confirm" type="password" autocomplete="new-password" placeholder="再输入一次密码" />
        </FieldStack>
        <Button type="submit" class="w-full" :disabled="auth.state.loading">
          <Spinner v-if="auth.state.loading" class="size-4" />
          创建并继续
        </Button>
      </form>
      <p class="mt-6 text-center text-label text-muted-foreground">
        已有账号？
        <RouterLink to="/login" class="text-foreground underline underline-offset-4">去登录</RouterLink>
      </p>
    </div>
  </div>
</template>
