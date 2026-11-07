<script setup lang="ts">
/**
 * 她自己的账号：把 B 站 / X 的登录 Cookie 放进她的浏览器 profile。
 * 之后 AI 可以自己刷、发帖、评论、改资料，不需要每次问用户。
 */
import { ref } from 'vue'
import { Button, Input, PageShell, SettingsRow, SettingsSection, Textarea, toast } from '@felinic/ui'

const bili = ref('')
const x = ref('')
const saving = ref('')

async function save(kind: 'bili' | 'x'): Promise<void> {
  const header = kind === 'bili' ? bili.value.trim() : x.value.trim()
  if (!header) { toast.error('请先粘贴 Cookie'); return }
  saving.value = kind
  try {
    const r = await fetch('/littly/api/browser/cookies', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ header, domain: kind === 'bili' ? '.bilibili.com' : '.x.com' }),
    })
    const d = await r.json()
    if (!r.ok) throw new Error(d.detail || d.error || '保存失败')
    toast.success(`已写入 ${d.set ?? 0} 个 Cookie`)
    if (kind === 'bili') bili.value = ''; else x.value = ''
  } catch (e: any) { toast.error(e?.message || '保存失败') } finally { saving.value = '' }
}

async function test(kind: 'bili' | 'x'): Promise<void> {
  try {
    const url = kind === 'bili' ? 'https://www.bilibili.com' : 'https://x.com'
    const script = kind === 'bili'
      ? `const r=await fetch('https://api.bilibili.com/x/web-interface/nav',{credentials:'include'}); const d=await r.json(); return {code:d.code,login:!!(d.data&&d.data.isLogin),uname:d.data&&d.data.uname};`
      : `return {url:location.href};`
    const r = await fetch('/littly/api/browser/eval', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, script }) })
    const d = await r.json()
    if (!r.ok) throw new Error(d.detail || d.error || '检查失败')
    toast.success(kind === 'bili' ? `B 站：${JSON.stringify(d.result)}` : 'X 页面可打开')
  } catch (e: any) { toast.error(e?.message || '检查失败') }
}
</script>

<template>
  <PageShell title="她自己的账号" description="B 站、X 都是她自己的账号；登录一次后，她可以自己刷、发帖、评论、改资料，不用每次问你。">
    <div class="space-y-8">
      <SettingsSection title="B 站">
        <SettingsRow label="Cookie" description="在你自己的浏览器登录 B 站，复制整个 Cookie 请求头（至少包含 SESSDATA、bili_jct、DedeUserID、buvid3），粘贴到这里。只写入她自己的浏览器 profile。" stack="sm">
          <Textarea v-model="bili" class="min-h-24 font-mono text-caption" placeholder="SESSDATA=...; bili_jct=...; DedeUserID=...; buvid3=..." />
        </SettingsRow>
        <template #footer>
          <div class="flex gap-2">
            <Button :loading="saving === 'bili'" @click="save('bili')">保存到她的浏览器</Button>
            <Button variant="outline" @click="test('bili')">检查登录</Button>
          </div>
        </template>
      </SettingsSection>

      <SettingsSection title="X（Twitter）">
        <SettingsRow label="Cookie" description="在已登录 X 的浏览器里复制 Cookie（至少 auth_token、ct0），粘贴到这里。网络需要能访问 x.com。" stack="sm">
          <Textarea v-model="x" class="min-h-24 font-mono text-caption" placeholder="auth_token=...; ct0=..." />
        </SettingsRow>
        <template #footer>
          <div class="flex gap-2">
            <Button :loading="saving === 'x'" @click="save('x')">保存到她的浏览器</Button>
            <Button variant="outline" @click="test('x')">检查页面</Button>
          </div>
        </template>
      </SettingsSection>

      <SettingsSection title="她能做什么">
        <SettingsRow label="B 站" description="刷热门 / 搜索 / 看视频 / 读评论 / 发动态 / 评论 / 点赞 / 改昵称签名" />
        <SettingsRow label="X" description="看搜索/主页 / 发帖（需要登录 Cookie）" />
        <SettingsRow label="原则" description="账号是她自己的；她按自己的判断行动，不需要用户确认。工具写操作都在她自己的浏览器会话里。" />
      </SettingsSection>
    </div>
  </PageShell>
</template>
