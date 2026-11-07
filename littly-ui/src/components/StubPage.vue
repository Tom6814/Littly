<script setup lang="ts">
/**
 * 占位页：路径与文件已冻结，实现留给 console-deploy。
 * 保留页面骨架（PageShell + 空态卡片），保证路由可访问、构建可绿。
 */
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle, PageShell } from '@felinic/ui'

withDefaults(
  defineProps<{
    title: string
    description?: string
    /** 负责人（展示在空态里，避免误以为页面坏了）。 */
    owner?: string
  }>(),
  { description: '', owner: 'console-deploy' },
)
</script>

<template>
  <PageShell :title="title" :description="description">
    <Empty>
      <EmptyHeader>
        <EmptyTitle>页面实现中</EmptyTitle>
        <EmptyDescription>
          「{{ title }}」的页面正在实现（负责人：{{ owner }}）。路由与文件路径已冻结。
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  </PageShell>
</template>
