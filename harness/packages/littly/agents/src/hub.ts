/**
 * LittlyHub —— 对话主链路（旧 sink/ai.ts runChat + sink/buffer.ts 的移植基线）。
 *
 * 行为契约（docs/PRINCIPLES.md §三，必须原样保留）：
 * - 缓冲窗口：15~20s 随机合并 + 新消息重置整批 + 原子认领「恰好一次」+ 认领后二次验证。
 * - 沉默 = 不落库；投递失败 = 落库但标记 delivery_status='failed'。
 * - 收尾槽位只此一条（PHI，拟人化风格块并入同一条）。
 * - 安全阀是唯一硬红线例外（代码处显式标注）。
 */
import { randomUUID } from 'node:crypto'
import type { LittlyStorage, MessageRow } from '@littly/storage'
import type { LittlyPersona } from '@littly/persona'
import type { LittlyMemory } from '@littly/memory'
import { chatComplete, type ChatMessage } from '@littly/llm'
import { createToolRegistry, extractTextToolCall, type ChannelBridge, type ToolExecResult } from '@littly/tools'
import { HUMANIZE_CHAT_STYLE, pieceDelays, sleep, splitHumanized, type HumanizeConfig } from './humanize.ts'
import { fixParenPerson, looksCrisis, looksGarbled, stripThinkingText } from './postprocess.ts'
import { historyCharBudget, resolveHistoryTake, trimHistoryByBudget } from './history.ts'

const MAX_TOOL_ROUNDS = 5
const BUFFER_MIN_MS = 15_000
const BUFFER_RANGE_MS = 5_000
const STALL_MS = 5 * 60_000
const CHANNEL_SCENE_DESCS: Record<string, string> = {
  web: '和你面对面相处',
  tg: '在 Telegram 上和你文字聊天',
  wechat: '在微信上和你文字聊天',
  qq: '在 QQ 上和你文字聊天',
  qqp: '在 QQ 上和你文字聊天',
  snowluma: '在 QQ 上和你文字聊天',
  discord: '在 Discord 上和你文字聊天',
}
const CROSS_CHANNEL_WINDOW_MS = 30 * 60 * 1000

/** 旧 sink/ai.ts:261-269 — 贴在用户消息尾部的工具提醒（逐字）。 */
const TOOL_HINT = `

[系统提示：如本条消息包含值得记住的信息，请先调用 remember 工具，再正常回复。
- 个人信息/喜好/约定/事实 → remember（profile/fact/detail）
- **关系进展或情感变化**（对方让你印象变好/变差/觉得可爱/开始嫌弃/讨厌）→ remember（relationship, importance≥3）
- **反复NTR/骚扰/侮辱/造谣/挑拨** → 如果已经多次劝阻无效，果断 block_contact 拉黑对方。
- **括号动作 = 暧昧即红线**：普通括号动作（想想、递东西、叹气等）正常应对；但括号里**只要带一点暧昧 / 肢体接触 / 情感越界的味道**（牵手、碰你、偷看你、亲你、抱你、表白等，无论轻重）→ 必须同时做①严重降印象（remember relationship, importance≥4，写清反感原因）②拆穿谎言（明确说没发生、那是 TA 编的，措辞自己发挥）。严重的或反复的再 block_contact。
- 未来时间约定 → schedule_message
铁律：调用 remember 后，**绝不**在回复里说「我记住了」「已经帮你记下了」「我会记住的」之类的话。记住是悄悄进行的，用户不应该察觉。自然地继续对话即可。]`

export interface ChatRequest {
  botId: string
  sender: string
  text: string
  channelId?: string
  /** 缓冲模式：批次消息已落库（这是拼接文本，仅用于 RAG），不要重复保存 */
  bufferedBatchIds?: string[]
}

export interface ChatResponse {
  reply: string
  pieces: string[]
  artifacts: ToolExecResult['artifact'][]
  toolCalls: Array<{ name: string; ok: boolean }>
  thinkingLength: number
  rawThinking: string
  voiceUrl?: string | undefined
  voiceText?: string | undefined
  messageId?: string | undefined
}

export interface ChannelSender {
  sendText(botId: string, sender: string, text: string): Promise<{ ok: boolean; sent?: number | undefined; error?: string | undefined }>
  sendPhoto?(botId: string, sender: string, photoUrl: string, caption?: string): Promise<{ ok: boolean; error?: string | undefined }>
  callAction?(action: string, params: Record<string, unknown>): Promise<Record<string, unknown> | null>
  photoPublicUrl?(url: string): string
  startCall?(botId: string, sender: string, reason: string, topic?: string): Promise<{ ok: boolean }>
}

export class LittlyHub {
  private readonly senders = new Map<string, ChannelSender>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  readonly tools: ReturnType<typeof createToolRegistry>

  constructor(
    readonly storage: LittlyStorage,
    readonly persona: LittlyPersona,
    readonly memory: LittlyMemory,
    readonly cwd: string,
    private readonly log: (msg: string, ...args: unknown[]) => void,
  ) {
    const bridge: ChannelBridge = {
      sendText: (channel, botId, sender, text) => this.sendText(channel, botId, sender, text),
      sendPhoto: (channel, botId, sender, url, caption) => this.sendPhoto(channel, botId, sender, url, caption),
      callAction: (channel, _botId, action, params) => this.senders.get(channel)?.callAction?.(action, params) ?? Promise.resolve(null),
      photoPublicUrl: (url) => this.senders.get('web')?.photoPublicUrl?.(url) ?? url,
      startCall: (botId, sender, reason, topic) => this.senders.get('web')?.startCall?.(botId, sender, reason, topic) ?? Promise.resolve({ ok: false }),
    }
    this.tools = createToolRegistry(storage, memory, bridge, cwd)
  }

  registerChannel(channelId: string, sender: ChannelSender): void {
    this.senders.set(channelId, sender)
  }

  private async sendText(channel: string, botId: string, sender: string, text: string): Promise<{ ok: boolean; sent?: number | undefined; error?: string | undefined }> {
    const s = this.senders.get(channel)
    if (!s) return { ok: false, error: `渠道 ${channel} 未接入` }
    return s.sendText(botId, sender, text)
  }

  private async sendPhoto(channel: string, botId: string, sender: string, url: string, caption?: string): Promise<{ ok: boolean; error?: string | undefined }> {
    const s = this.senders.get(channel)
    if (!s?.sendPhoto) return { ok: false, error: `渠道 ${channel} 不支持图片` }
    return s.sendPhoto(botId, sender, url, caption)
  }

  // ---- 缓冲窗口（旧 sink/buffer.ts 语义）----

  /** 入站落库 + 合并窗口。返回本条消息 id 与批次到期时刻。 */
  enqueueBufferedMessage(input: { botId: string; sender: string; text: string; channelId: string }): { messageId: string; fireAt: string } {
    const now = new Date()
    const fireAt = new Date(now.getTime() + BUFFER_MIN_MS + Math.random() * BUFFER_RANGE_MS)
    // 确保联系人行存在（channel 适配器可先行 upsert 更详细信息；这里兜底）
    this.storage.prepare(
      "INSERT INTO contacts (id, bot_id, sender, name, channel, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM contacts WHERE bot_id = ? AND sender = ?)",
    ).run(randomUUID(), input.botId, input.sender, input.sender, input.channelId, now.toISOString(), now.toISOString(), input.botId, input.sender)
    const id = randomUUID()
    this.storage.prepare(
      "INSERT INTO messages (id, bot_id, sender, role, content, reply_type, buffer_status, buffer_fire_at, channel_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run(id, input.botId, input.sender, 'user', input.text, 'text', 'pending', fireAt.toISOString(), input.channelId, now.toISOString())
    // 新消息重置整批到期时刻
    this.storage.prepare("UPDATE messages SET buffer_fire_at = ? WHERE bot_id = ? AND sender = ? AND buffer_status = 'pending'").run(fireAt.toISOString(), input.botId, input.sender)
    this.scheduleFlush(input.botId, input.sender, fireAt)
    return { messageId: id, fireAt: fireAt.toISOString() }
  }

  private scheduleFlush(botId: string, sender: string, fireAt: Date): void {
    const key = `${botId}::${sender}`
    const old = this.timers.get(key)
    if (old) clearTimeout(old)
    const delay = Math.max(0, fireAt.getTime() - Date.now()) + 200
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key)
      void this.flushBuffered(botId, sender).catch((err) => this.log('flush failed: %s', err))
    }, delay))
  }

  bufferStatus(botId: string, sender: string): { buffered: boolean; fireAt: string | null; count: number } {
    const rows = this.storage.prepare(
      "SELECT buffer_fire_at, COUNT(*) AS c FROM messages WHERE bot_id = ? AND sender = ? AND buffer_status = 'pending' GROUP BY buffer_fire_at",
    ).all(botId, sender) as Array<{ buffer_fire_at: string | null; c: number }>
    if (rows.length === 0) return { buffered: false, fireAt: null, count: 0 }
    const first = rows[0]
    return { buffered: true, fireAt: first?.buffer_fire_at ?? null, count: rows.reduce((a, b) => a + b.c, 0) }
  }

  /** 到期 → 原子认领 → 二次验证 → 一次模型调用 → 标记已刷新（失败也标记）。 */
  async flushBuffered(botId: string, sender: string, opts: { waitMs?: number } = {}): Promise<{ flushed: boolean; response?: ChatResponse }> {
    const deadline = Date.now() + (opts.waitMs ?? 0)
    for (;;) {
      const due = this.storage.prepare(
        "SELECT COUNT(*) AS c FROM messages WHERE bot_id = ? AND sender = ? AND buffer_status = 'pending' AND buffer_fire_at <= ?",
      ).get(botId, sender, new Date().toISOString()) as { c: number }
      if (due.c > 0) break
      if (Date.now() >= deadline) return { flushed: false }
      if (this.bufferStatus(botId, sender).count === 0) return { flushed: false }
      await sleep(Math.min(2000, Math.max(100, deadline - Date.now())))
    }
    // 原子认领（pending → flushing），抢不到就退出
    const claimed = this.storage.prepare(
      "UPDATE messages SET buffer_status = 'flushing' WHERE bot_id = ? AND sender = ? AND buffer_status = 'pending' AND buffer_fire_at <= ? RETURNING id",
    ).all(botId, sender, new Date().toISOString()) as Array<{ id: string }>
    const ids = claimed.map((r) => r.id)
    if (ids.length === 0) return { flushed: false }
    // 认领后二次验证：批次被新入站推到未来 → 退回 pending 退出
    const rows = this.storage.prepare(
      `SELECT * FROM messages WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at ASC`,
      ...ids,
    ) as unknown as MessageRow[]
    if (rows.some((r) => (r.buffer_fire_at && new Date(r.buffer_fire_at).getTime() > Date.now()))) {
      this.storage.prepare(`UPDATE messages SET buffer_status = 'pending' WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids).run()
      return { flushed: false }
    }
    const batchText = rows.map((r) => r.content).join('\n')
    const channelId = rows[rows.length - 1]?.channel_id || 'web'
    let response: ChatResponse
    try {
      response = await this.runTurn({ botId, sender, text: batchText, channelId, bufferedBatchIds: ids })
    } finally {
      // 失败也标记已刷新，避免死循环
      this.storage.prepare(`UPDATE messages SET buffer_status = 'flushed' WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids).run()
    }
    return { flushed: true, response }
  }

  /** 僵死批次恢复（调度 tick 每周期调用）。 */
  recoverStalled(): number {
    const cutoff = new Date(Date.now() - STALL_MS).toISOString()
    const r = this.storage.prepare(
      "UPDATE messages SET buffer_status = 'flushed' WHERE buffer_status = 'flushing' AND buffer_fire_at < ?",
    ).run(cutoff)
    return Number(r.changes)
  }

  // ---- 对话主链路（runChat 移植）----

  async runTurn(req: ChatRequest): Promise<ChatResponse> {
    const isBuffered = !!req.bufferedBatchIds?.length
    const bot = this.storage.prepare('SELECT * FROM bots WHERE id = ?').get(req.botId) as never as { [k: string]: unknown } | undefined
    if (!bot) throw new Error('bot not found')
    const botRow = bot as unknown as {
      name: unknown
      ai_max_history: number; ai_temperature: number; ai_model: string; ai_humanize_enabled: number; ai_humanize_wechat: number;
      sleep_until: string | null
    }
    // §回响睡眠 — 用户来消息即唤醒
    if (botRow.sleep_until) {
      this.storage.prepare('UPDATE bots SET sleep_until = NULL WHERE id = ?').run(req.botId)
    }
    // --- 0. 拉黑拦截 ---
    const contact0 = this.storage.prepare('SELECT * FROM contacts WHERE bot_id = ? AND sender = ?').get(req.botId, req.sender) as { blocked: number; metadata: string } | undefined
    if (contact0?.blocked) {
      if (!isBuffered) {
        this.storage.prepare("INSERT INTO messages (id, bot_id, sender, role, content, reply_type, created_at) VALUES (?,?,?,?,?,?,?)")
          .run(randomUUID(), req.botId, req.sender, 'user', req.text, 'text', new Date().toISOString())
      }
      let reason = ''
      try { reason = String((JSON.parse(contact0.metadata || '{}') as { blockedReason?: string }).blockedReason ?? '') } catch { /* ignore */ }
      const blockedReply = reason ? `你已被拉黑\n原因：${reason}` : '你已被拉黑'
      const savedId = randomUUID()
      this.storage.prepare("INSERT INTO messages (id, bot_id, sender, role, content, reply_type, created_at) VALUES (?,?,?,?,?,?,?)")
        .run(savedId, req.botId, req.sender, 'assistant', blockedReply, 'text', new Date().toISOString())
      return { reply: blockedReply, pieces: blockedReply.split('\n').filter(Boolean), artifacts: [], toolCalls: [], thinkingLength: 0, rawThinking: '', messageId: savedId }
    }

    // --- 1. 组装上下文 ---
    const history = this.storage.prepare(
      "SELECT * FROM messages WHERE bot_id = ? AND sender = ? AND role IN ('user','assistant') ORDER BY created_at DESC LIMIT ?",
    ).all(req.botId, req.sender, resolveHistoryTake(botRow.ai_max_history)) as unknown as MessageRow[]
    const orderedHistory = trimHistoryByBudget(history.reverse(), historyCharBudget(botRow.ai_max_history))
    const recentText = orderedHistory.map((m) => m.content).join('\n') + (isBuffered ? '' : `\n${req.text}`)
    const currentContact = this.persona.loadContact(req.botId, req.sender)
    const currentMemories = currentContact ? await this.memory.retrieveMemories({ botId: req.botId, sender: req.sender, query: recentText }) : []
    const currentChannel = req.channelId ?? currentContact?.channel ?? 'web'

    // 跨渠道临场感知
    let crossChannelHint: string | undefined
    const lastOther = this.storage.prepare(
      "SELECT channel_id, created_at FROM messages WHERE bot_id = ? AND sender = ? AND role = 'user' AND channel_id != '' AND channel_id != ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1",
    ).get(req.botId, req.sender, currentChannel, new Date(Date.now() - CROSS_CHANNEL_WINDOW_MS).toISOString()) as { channel_id: string; created_at: string } | undefined
    if (lastOther) {
      const mins = Math.max(1, Math.round((Date.now() - new Date(lastOther.created_at).getTime()) / 60000))
      crossChannelHint = `对方 ${mins} 分钟前还在${CHANNEL_SCENE_DESCS[lastOther.channel_id] ?? '在其他地方和你交流'}`
    }

    // 滚动摘要（非阻塞）
    void this.memory.maybeUpdateHistoryDigest(req.botId, req.sender, orderedHistory.length).catch(() => {})
    const digest = this.memory.getHistoryDigest(req.botId, req.sender)

    const built = this.persona.buildPrompt({
      botId: req.botId,
      sender: req.sender,
      channel: currentChannel,
      haystack: recentText,
      focusText: req.text,
      currentMemories,
      historyDigest: digest?.summary || undefined,
      crossChannelHint,
    })
    if (!built) throw new Error('bot not found')
    const character = this.persona.loadCharacter(req.botId)

    // --- 2. 保存用户消息（缓冲模式已在库）---
    if (!isBuffered) {
      this.storage.prepare("INSERT INTO messages (id, bot_id, sender, role, content, reply_type, channel_id, created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(randomUUID(), req.botId, req.sender, 'user', req.text, 'text', req.channelId ?? '', new Date().toISOString())
    }

    // --- 3. 工具循环 ---
    const historyMsgs: Array<{ id: string; role: 'user' | 'assistant'; content: string }> = orderedHistory.map((m) => ({ id: m.id, role: m.role as 'user' | 'assistant', content: m.content }))
    let lastBatchIdx = -1
    if (isBuffered) {
      const batchSet = new Set(req.bufferedBatchIds!)
      for (let i = historyMsgs.length - 1; i >= 0; i--) {
        const m = historyMsgs[i]
        if (m && batchSet.has(m.id)) {
          lastBatchIdx = i
          break
        }
      }
    }
    const lastBatch = lastBatchIdx >= 0 ? historyMsgs[lastBatchIdx] : undefined
    if (lastBatch) lastBatch.content += TOOL_HINT
    const finalUser: ChatMessage | null = lastBatchIdx >= 0 ? null : { role: 'user', content: `${req.text}${TOOL_HINT}` }
    let postHistoryMsg = built.phi
    if (botRow.ai_humanize_enabled) {
      postHistoryMsg = postHistoryMsg ? `${postHistoryMsg}\n\n${HUMANIZE_CHAT_STYLE}` : HUMANIZE_CHAT_STYLE
    }
    const messages: ChatMessage[] = [
      { role: 'system', content: built.system },
      ...(character?.first_mes && orderedHistory.length === 0 ? [{ role: 'assistant' as const, content: character.first_mes }] : []),
      ...historyMsgs.map((m) => ({ role: m.role, content: m.content })),
      ...(finalUser ? [finalUser] : []),
      ...(postHistoryMsg ? [{ role: 'system' as const, content: postHistoryMsg }] : []),
    ]

    const tools = this.tools.collectTools()
    const execCtx = { botId: req.botId, sender: req.sender, botName: String(bot.name ?? ''), channelId: req.channelId }
    const artifacts: ToolExecResult['artifact'][] = []
    const toolCallLog: Array<{ name: string; ok: boolean }> = []
    let lastThinking = ''
    let lastNonEmpty = ''
    let finalReply = ''

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const res = await chatComplete(this.storage, messages, {
        model: botRow.ai_model || undefined,
        temperature: botRow.ai_temperature,
        tools,
        toolChoice: 'auto',
        enableThinking: true,
      })
      lastThinking = res.thinking || ''
      if (res.content?.trim()) lastNonEmpty = res.content.trim()

      if (res.toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: res.content || '',
          tool_calls: res.toolCalls.map((tc) => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } })),
        })
        for (const tc of res.toolCalls) {
          const result = await this.tools.dispatch(tc.name, tc.arguments, execCtx)
          toolCallLog.push({ name: tc.name, ok: result.ok })
          if (result.artifact) artifacts.push(result.artifact)
          messages.push({ role: 'tool', content: result.result, tool_call_id: tc.id })
        }
        continue
      }

      // ★文本形态工具调用兜底
      if (res.content) {
        const textCalls = extractTextToolCall(res.content)
        if (textCalls && textCalls.calls.length > 0) {
          messages.push({ role: 'assistant', content: res.content })
          for (const tc of textCalls.calls) {
            const result = await this.tools.dispatch(tc.name, tc.arguments, execCtx)
            toolCallLog.push({ name: tc.name, ok: result.ok })
            if (result.artifact) artifacts.push(result.artifact)
            messages.push({ role: 'tool', content: result.result, tool_call_id: `textcall-${tc.name}-${round}-${toolCallLog.length}` })
          }
          if (textCalls.cleaned.trim()) lastNonEmpty = textCalls.cleaned.trim()
          continue
        }
      }

      finalReply = res.content || ''
      break
    }

    if (!finalReply) {
      if (lastNonEmpty) finalReply = lastNonEmpty
      else if (artifacts.length > 0) finalReply = ''
      // 既无文本也无产物 → 沉默：不落库（§3.1；'……' 兜底已删除）
    }

    finalReply = fixParenPerson(finalReply)
    finalReply = stripThinkingText(finalReply)

    // §11.5 乱码兜底：不带工具的干净上下文重试一次
    if (looksGarbled(finalReply)) {
      const recovery = await chatComplete(this.storage, messages, {
        model: botRow.ai_model || undefined,
        temperature: botRow.ai_temperature,
        tools: undefined,
        toolChoice: 'none',
        enableThinking: true,
      })
      const recovered = stripThinkingText(recovery.content || '').trim()
      finalReply = recovered && !looksGarbled(recovered) ? recovered : '刚才有点短路啦，我们继续？'
    }

    // §3.3 安全阀 —— ★不变量 II 的唯一例外★（显式标注，范围只此一条）。
    if (!finalReply && looksCrisis(req.text)) {
      const crisisRecovery = await chatComplete(this.storage, [
        ...messages,
        {
          role: 'user',
          content: '[系统提示：对方刚才的话里透出想伤害自己、不想活下去的念头。你现在必须开口——不讲道理、不给方案，就用你自己的语气说一句你真的想对 TA 说的话，哪怕只是一句「我在」。不要沉默。]',
        },
      ], {
        model: botRow.ai_model || undefined,
        temperature: botRow.ai_temperature,
        tools: undefined,
        toolChoice: 'none',
        enableThinking: true,
      })
      const recovered = stripThinkingText(crisisRecovery.content || '').trim()
      finalReply = recovered && !looksGarbled(recovered) ? recovered : '……我在，别做傻事。'
    }

    // --- 4. 落库（沉默不落库）---
    let savedMessageId: string | undefined
    if (finalReply) {
      savedMessageId = randomUUID()
      const replyType = artifacts.some((a) => a?.type === 'image') ? 'image' : artifacts.some((a) => a?.type === 'file') ? 'file' : 'text'
      this.storage.prepare("INSERT INTO messages (id, bot_id, sender, role, content, reply_type, reasoning, channel_id, delivery_status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(savedMessageId, req.botId, req.sender, 'assistant', finalReply, replyType, lastThinking || null, req.channelId ?? '', 'sent', new Date().toISOString())
    }

    // --- 5. 拟人化分片 + 渠道投递 ---
    const humanizeCfg: HumanizeConfig = { enabled: !!botRow.ai_humanize_wechat, maxSplits: 10, perPieceDelayMs: 1200, totalDelayCapMs: 6000 }
    const pieces = finalReply ? splitHumanized(finalReply, humanizeCfg) : []
    if (finalReply && currentChannel !== 'web' && req.channelId) {
      try {
        const sender0 = this.senders.get(req.channelId)
        if (sender0) {
          const delays = pieceDelays(pieces.length, humanizeCfg)
          let sent = 0
          for (let i = 0; i < pieces.length; i++) {
            const piece = pieces[i]
            if (!piece) continue
            if (i > 0) await sleep(delays[i - 1] ?? 0)
            const r = await sender0.sendText(req.botId, req.sender, piece)
            if (r.ok) sent++
            else break
          }
          if (savedMessageId) {
            this.storage.prepare('UPDATE messages SET delivery_status = ? WHERE id = ?').run(sent === pieces.length ? 'sent' : 'failed', savedMessageId)
          }
        }
      } catch {
        if (savedMessageId) this.storage.prepare("UPDATE messages SET delivery_status = 'failed' WHERE id = ?").run(savedMessageId)
      }
    }

    return {
      reply: finalReply,
      pieces,
      artifacts,
      toolCalls: toolCallLog,
      thinkingLength: lastThinking.length,
      rawThinking: lastThinking,
      messageId: savedMessageId,
    }
  }
}
