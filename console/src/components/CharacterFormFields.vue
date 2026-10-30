<script setup lang="ts">
/**
 * 角色卡表单字段（新建 / 编辑共用）。
 * 由父级持有 form 对象（reactive），本组件只负责把字段接到 @felinic/ui 控件上。
 */
import { FieldStack, Input, Textarea } from '@felinic/ui'
import type { CharacterFormState } from './character-form'

const props = defineProps<{
  form: CharacterFormState
}>()
</script>

<template>
  <div class="space-y-4">
    <FieldStack label="名字" for="char-name" help="会显示在对话与角色卡列表里">
      <Input id="char-name" v-model="props.form.name" placeholder="例如：小璃" />
    </FieldStack>
    <FieldStack label="角色设定" for="char-desc">
      <Textarea
        id="char-desc"
        v-model="props.form.description"
        :rows="4"
        placeholder="她是谁、你们的关系、她的日常…"
      />
    </FieldStack>
    <FieldStack label="性格" for="char-personality">
      <Input id="char-personality" v-model="props.form.personality" placeholder="温柔、粘人、偶尔傲娇" />
    </FieldStack>
    <FieldStack label="场景" for="char-scenario">
      <Input id="char-scenario" v-model="props.form.scenario" placeholder="你们已经在一起一段时间了" />
    </FieldStack>
    <FieldStack label="第一句话" for="char-first">
      <Input id="char-first" v-model="props.form.firstMes" placeholder="回来啦～" />
    </FieldStack>
  </div>
</template>
