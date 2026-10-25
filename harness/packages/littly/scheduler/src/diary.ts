/**
 * 日记自动写作（旧 ai/diary.ts + bot/manager.ts 日记分量的移植基线）。
 *
 * - 触发：bot.diary_enabled=1 且 Shanghai 时区小时 >= diary_hour 且当天有对话，
 *   且（今天没写过 或 上次写作后又有新消息）——否则每个 tick 都会重写同一篇。
 * - 生成：chatComplete 第一人称人设提示词（角色 + 铁律 + 主人信息），对话记录按
 *   联系人分组并标注名字与时间（旧 08-28 事故教训：不分组会混时间线）。
 * - 落库：diaries 唯一 (bot_id, date)；重写 = 覆盖 content，旧稿进 snapshot。
 */
import { randomUUID } from 'node:crypto'
import type { BotRow, DiaryRow } from '@littly/storage'
import { chatComplete } from '@littly/llm'
import { audit } from './audit.ts'
import { shanghaiDateStr, shanghaiDayStartIso, shanghaiHour, shanghaiTimeStr } from './time.ts'
import type { SchedulerDeps } from './types.ts'

// 旧 ai/humanize-style.ts HUMANIZE_DIARY_STYLE 常量（逐字本地副本，勿改动）
const HUMANIZE_DIARY_STYLE =
  '【日记风格】像深夜随手写的私密日记：口语、碎片、不修饰。记具体的事和当时的感觉，不写道理不写总结。允许只写两三行，允许吐槽、允许半句没写完。不追求结构完整，有跳跃也没关系。情绪不平摊：生气就是生气，别在结尾补一句"其实我也能理解"。'

interface DayMessage {
  sender: string
  role: string
  content: string
  created_at: string
}

interface BotContact {
  sender: string
  name: string
  is_owner: number
}

interface BotMemory {
  category: string
  content: string
  sender: string
}

export async function runDiaryTick(deps: SchedulerDeps, now: Date): Promise<number> {
  const bots = deps.storage.prepare('SELECT * FROM bots WHERE diary_enabled = 1').all() as BotRow[]
  let written = 0
  for (const bot of bots) {
    try {
      if (await maybeWriteDiary(deps, bot, now)) written++
    } catch (err) {
      deps.log('[scheduler] 日记检查失败 (bot=%s): %s', bot.name, String(err))
    }
  }
  return written
}

async function maybeWriteDiary(deps: SchedulerDeps, bot: BotRow, now: Date): Promise<boolean> {
  // 只在配置小时之后写（Asia/Shanghai）
  if (shanghaiHour(now) < bot.diary_hour) return false
  const dateStr = shanghaiDateStr(now)
  const dayStartIso = shanghaiDayStartIso(dateStr)

  // 今天没有对话就不写空日记
  const msgCount = (
    deps.storage
      .prepare("SELECT COUNT(*) AS c FROM messages WHERE bot_id = ? AND created_at >= ? AND role IN ('user','assistant')")
      .get(bot.id, dayStartIso) as { c: number }
  ).c
  if (msgCount === 0) return false

  // 已写过：只有上次写作后又有新消息才重写（续写）
  const existing = deps.storage
    .prepare('SELECT * FROM diaries WHERE bot_id = ? AND date = ?')
    .get(bot.id, dateStr) as DiaryRow | undefined
  if (existing) {
    const freshCount = (
      deps.storage
        .prepare("SELECT COUNT(*) AS c FROM messages WHERE bot_id = ? AND created_at > ? AND role IN ('user','assistant')")
        .get(bot.id, existing.updated_at) as { c: number }
    ).c
    if (freshCount === 0) return false
  }

  return generateDiary(deps, bot, dateStr, dayStartIso, existing)
}

/** 对话记录按联系人分组（首次出现顺序）并标注名字与时间。 */
function buildConversationSummary(
  messages: DayMessage[],
  contacts: BotContact[],
  botName: string,
): string {
  const nameOf = (sender: string): string => contacts.find((c) => c.sender === sender)?.name || sender
  const groups = new Map<string, string[]>()
  for (const m of messages) {
    const isUser = m.role === 'user'
    const name = isUser ? nameOf(m.sender) : botName
    const line = `${shanghaiTimeStr(m.created_at)} ${name}（${isUser ? '用户' : '你'}）: ${m.content.slice(0, 200)}`
    const arr = groups.get(m.sender)
    if (arr) arr.push(line)
    else groups.set(m.sender, [line])
  }
  const blocks: string[] = []
  for (const [sender, lines] of groups) {
    blocks.push(`—— 和「${nameOf(sender)}」的对话 ——\n${lines.join('\n')}`)
  }
  return blocks.length > 0 ? blocks.join('\n\n') : '（今天还没有对话）'
}

async function generateDiary(
  deps: SchedulerDeps,
  bot: BotRow,
  dateStr: string,
  dayStartIso: string,
  existing: DiaryRow | undefined,
): Promise<boolean> {
  const messages = deps.storage
    .prepare(
      "SELECT sender, role, content, created_at FROM messages WHERE bot_id = ? AND created_at >= ? AND role IN ('user','assistant') ORDER BY created_at ASC LIMIT 100",
    )
    .all(bot.id, dayStartIso) as DayMessage[]
  const contacts = deps.storage
    .prepare('SELECT sender, name, is_owner FROM contacts WHERE bot_id = ?')
    .all(bot.id) as BotContact[]
  const nameOf = (sender: string): string => contacts.find((c) => c.sender === sender)?.name || sender
  const memories = deps.storage
    .prepare('SELECT category, content, sender FROM memories WHERE bot_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 10')
    .all(bot.id) as BotMemory[]

  const conversationSummary = buildConversationSummary(messages, contacts, bot.name)
  const memoriesSummary =
    memories.length > 0
      ? memories.map((m) => `- [${m.category}｜来自${nameOf(m.sender)}] ${m.content}`).join('\n')
      : '（暂无记忆）'
  const owner = contacts.find((c) => c.is_owner === 1)
  const ownerInfo = owner
    ? `\n你喜欢的人是「${owner.name || owner.sender}」，唯一且不可改变。`
    : '\n你还没有认定喜欢的人。'

  // 系统提示：bot 自述 + 角色卡 + 启用中的铁律
  const character = deps.hub.persona.loadCharacter(bot.id)
  const rule = deps.hub.persona.loadRule(bot.id)
  const sysParts: string[] = []
  if (bot.system_prompt.trim()) sysParts.push(bot.system_prompt.trim())
  if (character && character.system_prompt.trim()) sysParts.push(character.system_prompt.trim())
  if (rule && rule.enabled === 1 && rule.rules_text.trim()) sysParts.push(`【铁律】\n${rule.rules_text.trim()}`)
  const system =
    sysParts.length > 0 ? sysParts.join('\n\n') : '你是一个有性格的 AI 伙伴，正在写一篇给自己看的日记。'

  const isContinuation = !!existing
  const prompt = `# 写日记

今天是 ${dateStr}。
${ownerInfo}

# 今天发生的事（对话记录摘要，按人分组）
${conversationSummary}

# 你记得的事
${memoriesSummary}

---

${isContinuation ? `# 你已经写过的日记（需要续写 + 小修小改）

你今天已经写过一篇日记了。现在有新的事发生了，请**续写**这篇日记：保留大框架、小修小改、接着写新发生的事，输出**续写后的完整日记**（不是只输出新部分）。

**已有日记内容：**
${existing?.content ?? ''}

` : ''}请以你的第一人称视角，${isContinuation ? '续写' : '写'}一篇今天的日记。

要求：
1. 完全用你的角色性格和说话风格写——你是「${bot.name}」，不是 AI。
2. 第一人称「我」，像写给自己看的私密日记。
3. 记录今天和谁聊了什么、你的感受、你的心情、你对那个人的想法。
4. 要有情感——开心、失落、期待、小情绪都行；有喜欢的人相关的事就重点写 TA。
5. 不要写成流水账，要有内心活动和性格色彩的描述。
6. 长度 200-500 字，分段；开头用日期标题。
最后另起一行写：心情：[一个词概括今天的心情，如「温暖」「有点失落」「开心」「气愤」]

直接输出${isContinuation ? '续写后的完整' : ''}日记正文，不要解释、不要带「以下是日记」之类的引导语。

${HUMANIZE_DIARY_STYLE}`

  const res = await chatComplete(
    deps.storage,
    [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
    { model: bot.ai_model || undefined, temperature: 0.9 },
  )
  const content = res.content.trim()
  if (!content) return false

  const moodMatch = /心情[：:]\s*(.+)$/m.exec(content)
  const mood = moodMatch?.[1]?.trim() ?? ''
  const nowIso = new Date().toISOString()
  if (existing) {
    // 重写 = 覆盖内容，旧稿进 snapshot
    deps.storage
      .prepare('UPDATE diaries SET content = ?, mood = ?, snapshot = ?, updated_at = ? WHERE id = ?')
      .run(content, mood, JSON.stringify({ previousContent: existing.content, previousMood: existing.mood }), nowIso, existing.id)
  } else {
    deps.storage
      .prepare('INSERT INTO diaries (id, bot_id, date, content, mood, snapshot, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(randomUUID(), bot.id, dateStr, content, mood, '{}', nowIso, nowIso)
  }
  audit(deps, bot.id, 'diary', 'write_scheduled', `date=${dateStr} mood=${mood}`)
  deps.log('[scheduler] 日记已写 (bot=%s, date=%s)', bot.name, dateStr)
  return true
}
