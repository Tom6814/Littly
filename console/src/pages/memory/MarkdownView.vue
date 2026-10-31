<script setup lang="ts">
/**
 * 轻量 Markdown 渲染（vault 的 PROFILE.md / 条目正文）。
 *
 * 安全策略：**先整体 HTML 转义**，再只把受支持的 Markdown 标记替换成固定 class 的标签；
 * 原文里的任何 HTML/脚本都只会以文本展示。支持：标题、粗体/斜体/行内代码、围栏代码块、
 * 无序/有序列表、引用、水平线、http(s) 链接、段落（单换行→<br>）。
 * 不引入第三方 markdown 依赖（避免供应链与 XSS 面）。
 */
import { computed } from 'vue'

const props = withDefaults(defineProps<{ source: string; emptyText?: string }>(), {
  emptyText: '（空文档）',
})

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const CODE_CLASS = 'rounded-2xs bg-muted-soft px-1 py-0.5 font-mono text-caption text-foreground'
const BOLD_CLASS = 'font-semibold text-foreground'
const LINK_CLASS = 'text-foreground underline decoration-border underline-offset-2'

function inline(text: string): string {
  let out = escapeHtml(text)
  // 行内代码先占位，避免其中内容被后续规则改写
  const codes: string[] = []
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(code)
    return `\u0000CODE${codes.length - 1}\u0000`
  })
  out = out.replace(/\*\*([^*]+)\*\*/g, `<strong class="${BOLD_CLASS}">$1</strong>`)
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em class="italic">$2</em>')
  out = out.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em class="italic">$2</em>')
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    `<a class="${LINK_CLASS}" href="$2" target="_blank" rel="noreferrer">$1</a>`,
  )
  out = out.replace(/\u0000CODE(\d+)\u0000/g, (_m, idx: string) => {
    const code = codes[Number(idx)] ?? ''
    return `<code class="${CODE_CLASS}">${code}</code>`
  })
  return out
}

const headingClass = (level: number): string => {
  switch (level) {
    case 1:
      return 'mt-5 mb-2 text-title font-semibold text-foreground first:mt-0'
    case 2:
      return 'mt-5 mb-2 text-title font-semibold text-foreground first:mt-0'
    case 3:
      return 'mt-4 mb-1.5 text-control font-semibold text-foreground first:mt-0'
    default:
      return 'mt-4 mb-1 text-label font-semibold text-foreground first:mt-0'
  }
}

const html = computed<string>(() => {
  const source = props.source.replace(/\r\n/g, '\n')
  if (source.trim() === '') return ''
  const lines = source.split('\n')
  const chunks: string[] = []
  let paragraph: string[] = []
  let listType: 'ul' | 'ol' | null = null
  let listItems: string[] = []
  let i = 0

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    chunks.push(
      `<p class="my-2 text-body leading-6 text-foreground">${paragraph.map(inline).join('<br />')}</p>`,
    )
    paragraph = []
  }
  const flushList = (): void => {
    if (listType !== null && listItems.length > 0) {
      const cls =
        listType === 'ul'
          ? 'my-2 list-disc space-y-1 pl-5 text-body leading-6 text-foreground'
          : 'my-2 list-decimal space-y-1 pl-5 text-body leading-6 text-foreground'
      chunks.push(
        `<${listType} class="${cls}">${listItems.map((item) => `<li>${inline(item)}</li>`).join('')}</${listType}>`,
      )
    }
    listType = null
    listItems = []
  }

  while (i < lines.length) {
    const line = lines[i] ?? ''
    // HTML 注释（含 PROFILE.md 的 <!-- memory:auto:begin/end --> 区间标记）不渲染
    if (/^\s*<!--[\s\S]*?-->\s*$/.test(line)) {
      flushParagraph()
      i += 1
      continue
    }
    const fence = /^```(.*)$/.exec(line)
    if (fence !== null) {
      flushParagraph()
      flushList()
      const buffer: string[] = []
      i += 1
      while (i < lines.length && !/^```/.test(lines[i] ?? '')) {
        buffer.push(lines[i] ?? '')
        i += 1
      }
      i += 1
      chunks.push(
        `<pre class="my-3 overflow-x-auto rounded-md border border-border bg-card p-3 font-mono text-caption leading-5 text-foreground"><code>${escapeHtml(buffer.join('\n'))}</code></pre>`,
      )
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      flushParagraph()
      flushList()
      const level = (heading[1] ?? '#').length
      chunks.push(`<h${level} class="${headingClass(level)}">${inline(heading[2] ?? '')}</h${level}>`)
      i += 1
      continue
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line)
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line)
    if (ul !== null || ol !== null) {
      flushParagraph()
      const nextType: 'ul' | 'ol' = ul !== null ? 'ul' : 'ol'
      if (listType !== nextType) {
        flushList()
        listType = nextType
      }
      listItems.push((ul ?? ol ?? ['', ''])[1] ?? '')
      i += 1
      continue
    }
    const quote = /^>\s?(.*)$/.exec(line)
    if (quote !== null) {
      flushParagraph()
      flushList()
      const buffer: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i] ?? '')) {
        buffer.push((lines[i] ?? '').replace(/^>\s?/, ''))
        i += 1
      }
      chunks.push(
        `<blockquote class="my-2 border-l-2 border-border pl-3 text-body leading-6 text-muted-foreground">${buffer.map(inline).join('<br />')}</blockquote>`,
      )
      continue
    }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      flushParagraph()
      flushList()
      chunks.push('<hr class="my-4 border-border" />')
      i += 1
      continue
    }
    if (line.trim() === '') {
      flushParagraph()
      flushList()
      i += 1
      continue
    }
    paragraph.push(line)
    i += 1
  }
  flushParagraph()
  flushList()
  return chunks.join('\n')
})
</script>

<template>
  <div
    v-if="html !== ''"
    data-testid="markdown-view"
    class="max-w-none break-words [&_a]:break-all"
    v-html="html"
  />
  <p v-else class="text-label text-muted-foreground">{{ emptyText }}</p>
</template>
