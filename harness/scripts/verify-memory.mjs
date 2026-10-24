#!/usr/bin/env node
/**
 * 记忆引擎行为验证（golden-baseline 风格：关键公式与阈值逐项断言）。
 * 运行：node scripts/verify-memory.mjs（不依赖构建产物之外的任何状态）
 */
import { tokenize, diceCoefficient, lexicalRelevance, recencyScore, cosineSimilarity, parseEmbedding, encodeEmbedding, scoreMemory, halfLifeFor, STATE_HALF_LIFE_CAP_DAYS } from '../packages/littly/memory/src/score.ts'
import { extractTextToolCall } from '../packages/littly/tools/src/text-call.ts'
import { trimHistoryByBudget, resolveHistoryTake, historyCharBudget } from '../packages/littly/agents/src/history.ts'
import { splitHumanized } from '../packages/littly/agents/src/humanize.ts'
import { fixParenPerson, looksGarbled, looksCrisis, stripThinkingText } from '../packages/littly/agents/src/postprocess.ts'

let pass = 0
let fail = 0
const ok = (cond, name) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.error(`  ✗ ${name}`) }
}

console.log('== 记忆打分 ==')
ok(diceCoefficient(tokenize('记忆系统测试'), tokenize('记忆系统测试')) === 1, '相同文本 Dice=1')
ok(lexicalRelevance('我喜欢猫', '我喜欢猫，尤其橘猫') > 0.5, '词法相关度高')
ok(lexicalRelevance('我喜欢猫', '今天天气不错') < 0.3, '无关文本相关度低')
ok(Math.abs(recencyScore(new Date(Date.now() - 14 * 86400000)) - 0.5) < 1e-6, '14 天半衰期 = 0.5')
ok(recencyScore(new Date(Date.now() + 86400000)) === 1, '未来事件不衰减（预定计划不惩罚）')
const env = { m: 'test-model', v: [1, 0] }
ok(parseEmbedding(encodeEmbedding('test-model', [1, 0]), 'test-model') !== null, '向量信封编码解析')
ok(parseEmbedding(encodeEmbedding('other', [1, 0]), 'test-model') === null, '模型戳不符 → null（触发懒回填）')
ok(parseEmbedding('[1,0]', 'test-model') === null, '裸数组 legacy → null')
ok(cosineSimilarity([1, 0], [0, 1]) === 0, '余弦正交 = 0')
ok(halfLifeFor('fact', 'state') === STATE_HALF_LIFE_CAP_DAYS, 'state 波动性封顶 7 天')
ok(halfLifeFor('relationship', 'stable') === 365, 'relationship 半衰期 365 天')
const freshImportant = scoreMemory(0.8, 5, new Date().toISOString(), 'fact', 'stable')
const oldTrivial = scoreMemory(0.2, 1, new Date(Date.now() - 60 * 86400000).toISOString(), 'fact', 'stable')
ok(freshImportant > oldTrivial, '新而重要 > 旧而琐屑')

console.log('== 历史窗口 ==')
ok(resolveHistoryTake(0) === 0, 'aiMaxHistory=0 → 不带历史（不许 ||20 吞 0）')
ok(resolveHistoryTake(undefined) === 20, '空值回落 20')
const msgs = Array.from({ length: 30 }, (_, i) => ({ content: 'x'.repeat(200) }))
ok(trimHistoryByBudget(msgs, 1000).length === 5, '预算裁剪按字符累计（1000/200=5 条）')
const huge = [{ content: 'y'.repeat(9999) }, ...Array.from({ length: 10 }, () => ({ content: 'x'.repeat(50) }))]
ok(trimHistoryByBudget(huge, 1000).length === 2, '最新一条单独超预算也保住（+1 条）')
ok(trimHistoryByBudget(msgs, 100000).length === 30, '预算充足全保留')
ok(historyCharBudget(20) === 6000 && historyCharBudget(0) === 2000, '预算联动 [2000,12000]')

console.log('== 拟人化分片 ==')
const pieces = splitHumanized('今天好累。\n嗯。不过没事啦！明天再聊，好不好？', { enabled: true, maxSplits: 10, perPieceDelayMs: 1200, totalDelayCapMs: 6000 })
ok(pieces.length >= 2 && pieces.length <= 10, `分片 2~10 条（实际 ${pieces.length}）`)
ok(splitHumanized('', { enabled: true, maxSplits: 10, perPieceDelayMs: 1200, totalDelayCapMs: 6000 }).length === 0, '空回复零分片')
ok(splitHumanized('一句', { enabled: false, maxSplits: 10, perPieceDelayMs: 1200, totalDelayCapMs: 6000 }).length === 1, '关闭分片=整条')

console.log('== 出口后处理 ==')
ok(fixParenPerson('（拉住他的衣领）看着你') === '（拉住你的衣领）看着你', '括号内「他」→「你」')
ok(fixParenPerson('（拉住你的衣领）') === '（拉住你的衣领）', '「你」不改动')
ok(fixParenPerson('我跟他说过了') === '我跟他说过了', '括号外正文不碰')
ok(stripThinkingText('<think>internal</think>你好') === '你好', '思考标签剥离')
ok(looksGarbled('schedule_message: xxx arg_key yyy'), '工具说明回显判乱码')
ok(!looksGarbled('今天天气不错，我们去散步吧。'), '正常中文不误判')
ok(looksCrisis('我不想活了'), '危机短语命中')
ok(!looksCrisis('笑死我了'), '「笑死」不误判（不变量 III）')

console.log('== 文本形态工具调用兜底 ==')
const j = extractTextToolCall('{"tool":"remember","arguments":{"items":[]}} 剩余文本')
ok(j && j.calls[0].name === 'remember' && j.cleaned === '剩余文本', 'JSON 形态解析+剥离')
const x = extractTextToolCall('<remember><arg_key>items</arg_key><arg_value>[]</arg_value></remember>你！！')
ok(x && x.calls[0].name === 'remember' && x.cleaned === '你！！', 'XML 形态解析+剥离（严重事故防线）')
ok(extractTextToolCall('普通回复没有调用') === null, '普通文本不受影响')

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
