<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Badge, Button, Input, PageShell, Textarea } from '@felinic/ui'

const API = '/littly/api'
const files = ref<Array<{ name: string; dir: boolean; size?: number }>>([])
const path = ref('home')
const filePath = ref('')
const content = ref('')
const term = ref('')
const termOut = ref('')
const browserUrl = ref('https://example.com')
const browserText = ref('')
const browserShot = ref('')
const shots = ref<Array<{ id: string; bytes: number; created_at: string }>>([])
const artifacts = ref<Array<{ id: string; title: string; kind: string; path: string; bytes: number; created_at: string }>>([])
const activities = ref<Array<{ id: string; title: string; status: string; kind: string; summary?: string }>>([])
const busy = ref('')

async function api<T>(p: string, init?: RequestInit): Promise<T> {
  const r = await fetch(API + p, { headers: { 'Content-Type': 'application/json' }, ...init })
  const text = await r.text()
  const data = text ? JSON.parse(text) : null
  if (!r.ok) throw new Error((data && (data.detail || data.error)) || 'HTTP ' + r.status)
  return data as T
}
async function loadFiles() {
  const d = await api<any>('/files?path=' + encodeURIComponent(path.value))
  files.value = Array.isArray(d) ? d : []
}
async function openFile(name: string) {
  const p = (path.value ? path.value + '/' : '') + name
  const d = await api<any>('/files/content?path=' + encodeURIComponent(p))
  filePath.value = p
  content.value = d.content || ''
}
async function saveFile() {
  if (!filePath.value) return
  busy.value = 'save'
  try { await api('/files/content', { method: 'PUT', body: JSON.stringify({ path: filePath.value, content: content.value }) }); await refresh() }
  finally { busy.value = '' }
}
async function runTerminal() {
  busy.value = 'term'
  try {
    const d = await api<any>('/terminal', { method: 'POST', body: JSON.stringify({ command: term.value }) })
    termOut.value = d.output || ''
  } catch (e: any) { termOut.value = e.message }
  finally { busy.value = '' }
}
async function openBrowser() {
  busy.value = 'browser'
  try {
    const d = await api<any>('/browser', { method: 'POST', body: JSON.stringify({ url: browserUrl.value, screenshot: true }) })
    browserText.value = (d.text || '').slice(0, 4000)
    browserShot.value = d.screenshot || ''
    await refresh()
  } catch (e: any) { browserText.value = e.message }
  finally { busy.value = '' }
}
async function snapshot() {
  busy.value = 'snap'
  try { await api('/snapshots', { method: 'POST' }); await refresh() } finally { busy.value = '' }
}
async function refresh() {
  const [s, a, ac] = await Promise.all([api<any>('/snapshots'), api<any>('/artifacts'), api<any>('/activities')])
  shots.value = s.snapshots || []
  artifacts.value = a.artifacts || []
  activities.value = (ac.activities || []).slice(-20).reverse()
  await loadFiles()
}
onMounted(() => { void refresh() })
</script>

<template>
  <PageShell title="工作台" description="她的电脑：文件、终端、浏览器、快照与产出。">
    <div class="space-y-8">
      <section class="space-y-2.5">
        <h2 class="px-2 text-label font-medium text-muted-foreground">文件</h2>
        <div class="rounded-menu-shell bg-section-card p-4">
          <div class="flex gap-2">
            <Input v-model="path" class="max-w-sm" placeholder="相对路径，例如 home/notes" @keyup.enter="loadFiles" />
            <Button variant="outline" @click="loadFiles">打开目录</Button>
          </div>
          <div class="mt-3 divide-y divide-border rounded-md border border-border">
            <button v-for="f in files" :key="f.name" class="flex w-full items-center justify-between px-3 py-2 text-left text-control hover:bg-accent/40" @click="f.dir ? (path = (path ? path + '/' : '') + f.name, loadFiles()) : openFile(f.name)">
              <span>{{ f.dir ? '📁' : '📄' }} {{ f.name }}</span>
              <span class="text-caption text-muted-foreground">{{ f.size ? Math.round(f.size / 1024) + ' KB' : '' }}</span>
            </button>
            <div v-if="files.length === 0" class="px-3 py-6 text-center text-label text-muted-foreground">空目录</div>
          </div>
          <div v-if="filePath" class="mt-4">
            <div class="mb-2 text-label text-muted-foreground">{{ filePath }}</div>
            <Textarea v-model="content" class="min-h-48 font-mono text-caption" />
            <div class="mt-2"><Button :disabled="busy === 'save'" @click="saveFile">保存文件</Button></div>
          </div>
        </div>
      </section>

      <section class="space-y-2.5">
        <h2 class="px-2 text-label font-medium text-muted-foreground">终端</h2>
        <div class="rounded-menu-shell bg-section-card p-4">
          <div class="flex gap-2"><Input v-model="term" class="font-mono" placeholder="ls; pwd; cat home/notes/x.md" @keyup.enter="runTerminal" /><Button :disabled="busy === 'term'" @click="runTerminal">执行</Button></div>
          <pre v-if="termOut" class="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-background p-3 text-caption font-mono">{{ termOut }}</pre>
          <p class="mt-2 text-caption text-muted-foreground">危险命令会进入待主人批准队列。</p>
        </div>
      </section>

      <section class="space-y-2.5">
        <h2 class="px-2 text-label font-medium text-muted-foreground">浏览器</h2>
        <div class="rounded-menu-shell bg-section-card p-4">
          <div class="flex gap-2"><Input v-model="browserUrl" class="font-mono" placeholder="https://example.com" @keyup.enter="openBrowser" /><Button :disabled="busy === 'browser'" @click="openBrowser">打开并截图</Button></div>
          <pre v-if="browserText" class="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-background p-3 text-caption">{{ browserText }}</pre>
          <img v-if="browserShot" :src="API + '/files/raw?path=' + encodeURIComponent(browserShot)" class="mt-3 max-h-96 rounded-md border border-border" alt="browser screenshot" />
        </div>
      </section>

      <section class="space-y-2.5">
        <h2 class="px-2 text-label font-medium text-muted-foreground">快照</h2>
        <div class="rounded-menu-shell bg-section-card p-4">
          <Button :disabled="busy === 'snap'" @click="snapshot">拍快照</Button>
          <div class="mt-3 divide-y divide-border rounded-md border border-border">
            <div v-for="s in shots" :key="s.id" class="flex items-center justify-between px-3 py-2 text-control">
              <span class="font-mono text-caption">{{ s.id }}</span>
              <span class="text-caption text-muted-foreground">{{ Math.round((s.bytes || 0) / 1024) }} KB</span>
            </div>
            <div v-if="shots.length === 0" class="px-3 py-6 text-center text-label text-muted-foreground">还没有快照</div>
          </div>
        </div>
      </section>

      <div class="grid gap-8 sm:grid-cols-2">
        <section class="space-y-2.5">
          <h2 class="px-2 text-label font-medium text-muted-foreground">产出</h2>
          <div class="divide-y divide-border rounded-md border border-border bg-section-card">
            <div v-for="a in artifacts.slice(0, 12)" :key="a.id" class="px-3 py-2">
              <div class="flex items-center gap-2"><Badge variant="outline" size="sm">{{ a.kind }}</Badge><span class="truncate text-control">{{ a.title }}</span></div>
              <div class="mt-0.5 truncate font-mono text-caption text-muted-foreground">{{ a.path }}</div>
            </div>
          </div>
        </section>
        <section class="space-y-2.5">
          <h2 class="px-2 text-label font-medium text-muted-foreground">活动</h2>
          <div class="divide-y divide-border rounded-md border border-border bg-section-card">
            <div v-for="a in activities" :key="a.id" class="px-3 py-2">
              <div class="text-control">{{ a.title }} <Badge variant="outline" size="sm">{{ a.status }}</Badge></div>
              <div class="mt-0.5 text-caption text-muted-foreground">{{ a.kind }} · {{ a.summary }}</div>
            </div>
          </div>
        </section>
      </div>
    </div>
  </PageShell>
</template>
