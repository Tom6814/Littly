// 语音通话 WebSocket 服务（浏览器连 wss://<host>/call?botId=..&sender=..）。
// 链路：浏览器麦克风(16kHz PCM16) → 经本项目 WS 转发到服务器 → 服务器连 Deepgram STT
// → 「说完整句」（utterance + 静默双保险判定）→ 角色AI（精简 prompt + 关思考 + 仅三个专用工具）
// → Fish TTS 流式 PCM → 音频分片回传 → 落库 → 通话结束自动触发「回响总结」（记忆 + 待办）。
//
// 2026-08 Deepgram 走服务器端 STT：浏览器只把 PCM 转发上来，Deepgram 连接与令牌都由
// 服务器侧处理（Key 不落地浏览器），识别文本由服务器经 { type: 'stt_final', text } 回传。
//
// 设计要点（用户确认）：
// - 全实时双向通话：边说边转，Deepgram utterance/静默超时双保险判定说完整句。
//   该判定逻辑在服务器端 DeepgramStreamSTT，由 onSentence 回调提交给 AI。
// - 通话内容存入聊天记录（user/assistant 消息，replyType=text）。
// - 沿用角色当前模型；通话走一条独立精简链路：system prompt 只留人格/关系层
//   （跳过世界书关键词注入、关系树骨架、社交生活线），语音指令放对话最末
//   （jailbreak 槽位）权重最高，AI 一步产出适合 Fish 朗读的个性化口语文本。
// - 工具只保留三个（通话专用）：recall（翻旧账）+ recall_context（RAG 检索记忆
//   + 世界书 + 关系树 + 社交生活线，按需捞回被精简的上下文）+ end_call（AI 判断
//   对话到尾声主动结束通话）。最多 1 轮，其余工具不下发；思考始终关闭 ——
//   速度优先。通话中不手动写记忆（remember 去掉），由挂断后的回响总结统一落库。
// - TTS 用 Fish 流式 PCM 边合成边下发，前端边收边播（首字低延迟）；用户打断时
//   前端发 interrupt → 服务端 abort 当前 TTS。
// - Deepgram 断线 / 失败由服务器侧负责（自动重连带退避）；任何失败都静默降级。
//
// 旧 monolith src/internal/voice-call/call-server.ts 忠实移植；差异：
//   - Prisma → 原生 SQL（@littly/storage）；chatComplete/工具分发 → @littly/llm /
//     hub.tools.dispatch；人格层 → @littly/persona；记忆 → @littly/memory；
//   - 独立端口（VOICE_CALL_PORT）取消：升级路由挂在 ctx.webServer 的 /call 上；
//   - 角色行没有「语音延迟档」列 → TTS 固定 balanced（旧实现的默认值）。

import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { chatComplete, type ChatMessage } from '@littly/llm'
import { streamFishAudio } from '@littly/voice/src/fish-tts.ts'
import { RECALL_TOOL } from '@littly/tools/src/defs.ts'
import type { BotRow, LittlyStorage, MessageRow } from '@littly/storage'
import type { LittlyPersona } from '@littly/persona'
import type { LittlyMemory } from '@littly/memory'
import type { LittlyHub } from '@littly/agents'
import { historyCharBudget, resolveHistoryTake, trimHistoryByBudget } from '@littly/agents/src/history.ts'
import { DeepgramStreamSTT } from './deepgram.ts'
import { summarizeCall } from './summary.ts'
import { consumePendingCall, listPendingCalls, type PendingCall } from './pending.ts'
import { buildCallSystemPrompt } from './call-prompt.ts'
import { END_CALL_TOOL, RECALL_CONTEXT_TOOL, executeRecallContext, isEndCallTool } from './call-tools.ts'
import { verifyCallToken } from './call-token.ts'

const REPLY_MAX_TOKENS = 400

/** 语音通话的 WS 路径（同源部署：浏览器连 wss://<域名>/call）。 */
export const CALL_PATH = '/call'

// §通话语音风格 — 通话走一条独立精简链路：角色 AI 一步直接产出「适合 Fish 朗读的
// 个性化口语文本」，无需再经语气AI改写。放在对话最末的收尾 system 槽位
// （jailbreak 位），贴近最新消息、权重最高。结构刻意「短句+关键词首置」，
// 让模型快速抓住重点；「入戏不出格」明确给到身份锚点与边界。
const CALL_VOICE_STYLE = `
【最高优先级 · 语音通话模式】你现在就是你自己，正和对方通着电话，你这句话会直接读给对方听。务必遵守：
● 抓重点：对方说了什么，就着最要紧的那一点回，别跑题、别复述、别绕。
● 入戏：带着你的性格、情绪和你们的关系说话，像真人接电话，自然带口语语气词（嘛、啦、嗯、哎、啊、呀、喔、诶、噗）。
● 不出格：绝不脱离角色、不越界、不解释"我是AI / 在演戏"；对方越界，你按人设该冷淡就冷淡。
● 好读：一句到两三句的口语，不分段、不换行、不编号；别用 markdown、emoji、括号动作（（笑）（摸摸头））、引号或书名号——读出来会很怪。
● 工具（就这三个）：记不清旧事 → recall；对方提到不熟的背景 → recall_context；话到尾声（再见/晚安/去忙）→ end_call，告别话放回复里说。记住是静默的，绝不说「我记住了」；挂断后系统会自动整理记忆。`

interface CallSession {
  ws: WebSocket
  bot: BotRow
  sender: string
  startedAt: number // 通话开始时间戳（算时长用）
  transcriptLines: string[] // 「对方: … / 我: …」交替，供回响总结提炼
  busy: boolean // AI 正在回复（防止句尾连发导致并发）
  ended: boolean
  opening?: { reason: string; topic: string } | undefined // AI 主动来电：接通后 AI 先说第一句
  ttsAbort: AbortController | null // 当前 TTS 流（用户打断时 abort）
  stt: DeepgramStreamSTT | null // 服务器端 Deepgram 识别（浏览器 PCM 转发到这里）
}

/** 语音通话链路依赖。 */
export interface VoiceCallDeps {
  storage: LittlyStorage
  persona: LittlyPersona
  memory: LittlyMemory
  hub: LittlyHub
  log: (msg: string, ...args: unknown[]) => void
}

/** 对外暴露的语音通话服务（插件装配 + 控制台取来电）。 */
export interface VoiceCallService {
  /** 接管 /call 的 HTTP Upgrade（交给 ctx.webServer.registerUpgrade）。 */
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void
  /** 待接来电列表（控制台轮询端点用）。 */
  listPendingCalls: (botId: string) => PendingCall[]
  /** 接听时消费来电（WS 连接带 callId 时用）。 */
  consumePendingCall: (id: string) => PendingCall | null
}

/** 装配语音通话服务：WS 服务端 + 会话管理 + 来电暂存读写。 */
export function createVoiceCallService(deps: VoiceCallDeps): VoiceCallService {
  const sessions = new Set<CallSession>()
  const wss = new WebSocketServer({ noServer: true })
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    void handleConnection(deps, sessions, ws, req)
  })

  return {
    handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
      let pathname = ''
      try {
        pathname = new URL(req.url || '/', 'http://localhost').pathname
      } catch {
        socket.destroy()
        return
      }
      if (pathname !== CALL_PATH) {
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        wss.emit('connection', ws, req)
      })
    },
    listPendingCalls: (botId: string): PendingCall[] => listPendingCalls(botId),
    consumePendingCall: (id: string): PendingCall | null => consumePendingCall(id),
  }
}

async function handleConnection(
  deps: VoiceCallDeps,
  sessions: Set<CallSession>,
  ws: WebSocket,
  req: IncomingMessage,
): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost')
  // §B2 握手鉴权：只信短时签名令牌（POST /api/call/token 签发），不信任 URL 自报身份。
  const secret = deps.storage.getSetting('platform.secret') ?? ''
  const token = url.searchParams.get('token') || ''
  const payload = verifyCallToken(secret, token)
  if (payload === null) {
    sendJson(ws, { type: 'error', message: '通话鉴权失败：缺少或无效的通话令牌（请先调用 /api/call/token）' })
    ws.close(4401, 'unauthorized')
    return
  }
  // URL 上的 botId/sender 只在「与令牌一致」时被接受，防止伪造他人身份。
  const claimedBot = url.searchParams.get('botId')
  const claimedSender = url.searchParams.get('sender')
  if ((claimedBot !== null && claimedBot !== payload.botId) || (claimedSender !== null && claimedSender !== payload.sender)) {
    sendJson(ws, { type: 'error', message: '通话鉴权失败：连接参数与令牌不一致' })
    ws.close(4403, 'forbidden')
    return
  }
  const botId = payload.botId
  const sender = payload.sender
  const bot = deps.storage.prepare('SELECT * FROM bots WHERE id = ?').get(botId) as BotRow | undefined
  if (!bot) {
    sendJson(ws, { type: 'error', message: '角色不存在' })
    ws.close()
    return
  }

  const session: CallSession = {
    ws,
    bot,
    sender,
    startedAt: Date.now(),
    transcriptLines: [],
    busy: false,
    ended: false,
    ttsAbort: null,
    stt: null,
  }

  // §服务器端 Deepgram STT — 浏览器把 PCM 经 WS 转到这里，这里再连 Deepgram 识别。
  // 「说完整句」由 DeepgramStreamSTT 的 utterance/静默双保险判定，onSentence 提交给 AI。
  const dgKey = bot.ai_call_api_key || process.env.DEEPGRAM_API_KEY || ''
  if (!dgKey) {
    sendJson(ws, { type: 'error', message: 'Deepgram API Key 未配置（请在角色设置→语音消息卡片填写，或设置环境变量 DEEPGRAM_API_KEY）' })
    ws.close()
    return
  }
  const stt = new DeepgramStreamSTT(dgKey, {
    onInterim: (t: string) => sendJson(ws, { type: 'stt_interim', text: t }),
    onSentence: (t: string) => {
      if (!session.ended && t.trim()) void handleSentence(deps, sessions, session, t.trim())
    },
    onError: (e: Error) => sendJson(ws, { type: 'stt_error', message: e.message }),
    onClose: () => {},
  })
  session.stt = stt
  stt.connect()

  // §AI 主动来电 — 连接携带 ai=1&callId=<pending 来电 id>：消费请求，接通后 AI 先说第一句
  const isAiCall = url.searchParams.get('ai') === '1'
  const aiCallId = url.searchParams.get('callId') || ''
  if (isAiCall && aiCallId) {
    const pc = consumePendingCall(aiCallId)
    if (pc) {
      session.opening = { reason: pc.reason, topic: pc.topic }
      deps.log('[voice-call] AI 主动来电接通 (bot=%s, sender=%s, reason=%s)', bot.name, sender, pc.reason.slice(0, 60))
    }
  }

  sessions.add(session)

  sendJson(ws, { type: 'ready' })

  // §AI 主动来电：接通后 AI 先说第一句（不等对方开口）
  if (session.opening) {
    void handleOpening(deps, sessions, session)
  }

  ws.on('message', (data: RawData, isBinary: boolean) => {
    if (session.ended) return
    // 二进制音频（浏览器麦克风 PCM16）→ 送入服务器端 Deepgram 识别
    if (isBinary) {
      session.stt?.sendPCM(toBuffer(data))
      return
    }
    try {
      const obj = JSON.parse(textOf(data)) as { type?: string }
      if (obj?.type === 'stop') {
        void endCall(deps, sessions, session)
      } else if (obj?.type === 'interrupt') {
        // 用户打断 AI 讲话：立即中止当前 TTS 合成（停止浪费额度与带宽）
        session.ttsAbort?.abort()
        session.ttsAbort = null
      }
    } catch {
      // 忽略无法解析的文本
    }
  })

  ws.on('close', () => {
    void endCall(deps, sessions, session)
  })

  ws.on('error', () => {
    void endCall(deps, sessions, session)
  })
}

// ── 一句话识别完成 → 角色 AI 回复（快速链路：无思考、仅三个专用工具） ──
// §通话不落逐句消息（像微信：通话结束只留一张「语音通话」卡片）；逐句内容只进
// transcriptLines，供挂断后的回响总结提炼记忆/待办。
async function handleSentence(
  deps: VoiceCallDeps,
  sessions: Set<CallSession>,
  session: CallSession,
  userText: string,
): Promise<void> {
  if (session.ended || session.busy) return
  session.busy = true
  const { ws } = session
  try {
    session.transcriptLines.push(`对方: ${userText}`)
    // 把识别到的文本回传前端（显示「对方说」）；前端收到的 stt_final 不再做二次提交
    sendJson(ws, { type: 'stt_final', text: userText })

    // 角色 AI：关思考、只保留必要工具，快速返回
    sendJson(ws, { type: 'ai_thinking' })
    const reply = await quickReply(deps, sessions, session, userText)
    if (!reply.trim()) {
      sendJson(ws, { type: 'ai_text', text: '……' })
      return
    }
    await sendReply(deps, session, reply)
  } catch (e) {
    deps.log('[voice-call] reply failed: %s', e instanceof Error ? e.message : e)
    sendJson(ws, { type: 'ai_text', text: '……' })
  } finally {
    session.busy = false
  }
}

// §AI 主动来电 — 接通后 AI 先说第一句（开场白基于 start_call 的 reason/topic）
async function handleOpening(
  deps: VoiceCallDeps,
  sessions: Set<CallSession>,
  session: CallSession,
): Promise<void> {
  if (session.ended || session.busy || !session.opening) return
  session.busy = true
  const { ws } = session
  try {
    sendJson(ws, { type: 'ai_thinking' })
    const reply = await quickReply(deps, sessions, session, '', session.opening)
    if (reply.trim()) await sendReply(deps, session, reply)
  } catch (e) {
    deps.log('[voice-call] opening failed: %s', e instanceof Error ? e.message : e)
    sendJson(ws, { type: 'ai_text', text: '喂？' })
  } finally {
    session.busy = false
  }
}

// 下发 AI 回复：文本先行 + Fish TTS 流式 PCM（边合成边下发，前端边收边播，
// 首字延迟大幅下降；无 key 或失败时仅文本兜底）。不落逐句消息（通话卡片统一收尾）。
async function sendReply(deps: VoiceCallDeps, session: CallSession, reply: string): Promise<void> {
  const { ws, bot } = session
  sendJson(ws, { type: 'ai_text', text: reply })
  session.transcriptLines.push(`我: ${reply}`)

  const ttsKey = bot.ai_voice_api_key || process.env.FISH_AUDIO_API_KEY || ''
  if (!ttsKey) {
    sendJson(ws, { type: 'tts_text', text: reply })
    return
  }

  sendJson(ws, { type: 'tts_start' })
  const ac = new AbortController()
  session.ttsAbort = ac
  const referenceId = bot.ai_voice_reference_id
  try {
    await streamFishAudio(
      reply,
      {
        apiKey: ttsKey,
        model: bot.ai_voice_model || 's2.1-pro-free',
        ...(referenceId ? { referenceId } : {}),
        temperature: bot.ai_voice_temperature ?? 0.7,
        speed: bot.ai_voice_speed ?? 1,
        latency: 'balanced',
      },
      (buf: Buffer) => {
        // 每个 MP3 分片直接推给前端（base64 内联）
        sendJson(ws, { type: 'tts_chunk', audio: buf.toString('base64'), text: reply })
      },
      ac.signal,
    )
    sendJson(ws, { type: 'tts_chunk_end', text: reply })
  } catch (e) {
    // 被 interrupt 中止或异常 → 文本兜底（前端可能已收到部分音频，无妨）
    deps.log('[voice-call] tts stream ended: %s', e instanceof Error ? e.message : e)
    sendJson(ws, { type: 'tts_chunk_end', text: reply })
  } finally {
    if (session.ttsAbort === ac) session.ttsAbort = null
  }
}

// ── 角色 AI 快速回复（复用人格层，但不带工具/思考；速度优先） ──
// opening 传入时表示「AI 主动来电开场」：AI 生成第一句话（基于 reason/topic），不依赖对方输入。
async function quickReply(
  deps: VoiceCallDeps,
  sessions: Set<CallSession>,
  session: CallSession,
  userText: string,
  opening?: { reason: string; topic: string },
): Promise<string> {
  const { bot, sender } = session

  // 通话历史窗口与聊天链路对齐：读 bot.ai_max_history（尊重 0 = 不带历史），
  // 字符预算随条数联动；不再硬编码 12 条。
  const history = deps.storage
    .prepare(
      "SELECT * FROM messages WHERE bot_id = ? AND sender = ? AND role IN ('user','assistant') ORDER BY created_at DESC LIMIT ?",
    )
    .all(bot.id, sender, resolveHistoryTake(bot.ai_max_history)) as unknown as MessageRow[]
  const orderedHistory = trimHistoryByBudget(history.reverse(), historyCharBudget(bot.ai_max_history))
  const recentText = orderedHistory.map((m) => m.content).join('\n') + '\n' + userText

  // RAG 记忆（保持连续性，但仅当前联系人）
  const currentContact = deps.persona.loadContact(bot.id, sender)
  const currentMemories = currentContact
    ? await deps.memory.retrieveMemories({ botId: bot.id, sender, query: recentText })
    : []

  // §1.2 修 Bug B：通话链路此前没传 historyDigest，「潜意识」层恒为空。
  // 这里补上（轻量读，不触发压缩——压缩交给聊天链路），与聊天链路对齐。
  const digest = deps.memory.getHistoryDigest(bot.id, sender)

  const built = deps.persona.buildPrompt({
    botId: bot.id,
    sender,
    channel: 'web',
    haystack: recentText,
    focusText: userText,
    currentMemories,
    historyDigest: digest?.summary || undefined,
  })
  if (!built) return ''
  const layers = built.layers

  // 通话精简 system：跳过世界书/关系树骨架/社交生活线等冗余层，只留人格与当前关系
  const systemPrompt = buildCallSystemPrompt(layers)

  // 通话情境锚（快速入心）：一行说清这通电话的对象 / 关系 / 最近脉络，
  // 让 AI 一上来就知道自己在跟谁说话、聊到哪了，避免冷场或话题跳跃。
  let callContext = ''
  try {
    const name = currentContact?.name || sender
    const rels = deps.persona
      .loadRelations(bot.id)
      .filter((r) => r.relation && r.to_sender === sender)
      .map((r) => r.relation)
      .join('、')
    const brief = currentContact?.brief?.trim()
    callContext = `【这通电话】你正在给「${name}」打电话。${brief ? `TA：${brief}。` : ''}${rels ? `你们的关系：${rels}。` : ''}${layers.historyDigest ? `最近聊到：${layers.historyDigest.slice(0, 120)}` : ''}`
  } catch {
    // 情境锚失败不阻断
  }

  // 通话场景：只保留三个必要工具 —— recall（翻旧账/淡忘记忆+历史原文）+
  // recall_context（RAG 检索记忆 + 世界书 + 关系树 + 社交生活线）。其余工具全部
  // 不下发（速度优先）。最多 1 轮工具调用，之后强制收束出最终回复；思考保持关闭。
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...(callContext ? [{ role: 'system' as const, content: callContext }] : []),
    ...orderedHistory.map((m) => ({
      role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: m.content,
    })),
    // AI 主动来电开场：用 reason/topic 作为"开场任务"，否则用对方刚说的话
    {
      role: 'user',
      content: opening
        ? `【AI 主动来电】你拨通了对方的电话，因为：${opening.reason}${opening.topic ? `。想聊：${opening.topic}` : ''}。对方刚接听，请说出你的第一句话——自然、带性格，像真人拨通后先开口打招呼（别只说「喂」）。`
        : userText,
    },
    // 通话语音指令放对话最末（jailbreak 槽位），贴近最新消息、权重最高
    { role: 'system', content: CALL_VOICE_STYLE },
  ]

  const CALL_TOOLS = [RECALL_TOOL, RECALL_CONTEXT_TOOL, END_CALL_TOOL]
  const MAX_CALL_TOOL_ROUNDS = 1
  for (let round = 0; round <= MAX_CALL_TOOL_ROUNDS; round++) {
    const canUseTools = round < MAX_CALL_TOOL_ROUNDS
    const res = await chatComplete(deps.storage, messages, {
      model: bot.ai_model || undefined,
      temperature: bot.ai_temperature ?? 0.8,
      maxTokens: REPLY_MAX_TOKENS,
      tools: canUseTools ? CALL_TOOLS : undefined,
      toolChoice: canUseTools ? 'auto' : 'none',
      // 通话始终关思考：速度优先
      enableThinking: false,
    })
    if (canUseTools && res.toolCalls.length > 0) {
      // 把模型发起的工具调用写回上下文（与 runChat 同一套协议）；recall_context /
      // end_call 是本链路专用工具（本地处理），其余走全局 dispatch。
      for (const tc of res.toolCalls) {
        // end_call：AI 主动结束通话 → 直接走收尾流程（call_end + 回响总结 + 关连接）
        if (isEndCallTool(tc.name)) {
          void endCall(deps, sessions, session)
          return ''
        }
      }
      messages.push({
        role: 'assistant',
        content: res.content || '',
        tool_calls: res.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      })
      for (const tc of res.toolCalls) {
        let content: string
        if (tc.name === 'recall_context') {
          const query = typeof tc.arguments?.query === 'string' ? tc.arguments.query : ''
          content = await executeRecallContext({ storage: deps.storage, memory: deps.memory }, bot.id, sender, query)
        } else {
          const toolRes = await deps.hub.tools.dispatch(tc.name, tc.arguments ?? {}, {
            botId: bot.id,
            sender,
            botName: bot.name,
            channelId: 'web',
          })
          content = toolRes.result
        }
        messages.push({ role: 'tool', content, tool_call_id: tc.id })
      }
      continue
    }
    return (res.content || '').trim()
  }
  return ''
}

// ── 通话结束：收尾 Deepgram + 触发总结回响 ──
async function endCall(
  deps: VoiceCallDeps,
  sessions: Set<CallSession>,
  session: CallSession,
): Promise<void> {
  if (session.ended) return
  session.ended = true
  sessions.delete(session)
  session.ttsAbort?.abort()
  session.ttsAbort = null
  // 关闭服务器端 Deepgram 识别连接
  session.stt?.close()
  session.stt = null

  const hasContent = session.transcriptLines.length > 0
  sendJson(session.ws, { type: 'call_end', transcript: session.transcriptLines })

  // §通话卡片 — 像微信：消息界面只落一张「语音通话」记录（发起方 + 时长），
  // 不展开逐句内容。逐句内容交给回响总结去提炼记忆/待办。
  try {
    const durSec = Math.max(0, Math.round((Date.now() - session.startedAt) / 1000))
    deps.storage
      .prepare(
        'INSERT INTO messages (id, bot_id, sender, role, content, reply_type, channel_id, voice_url, voice_original_text, meta, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        randomUUID(),
        session.bot.id,
        session.sender,
        'system', // 系统卡片，不参与 AI 对话上下文
        `通话时长 ${formatDuration(durSec)}`,
        'call',
        'web',
        '',
        '',
        // 发起方：ai=角色发起，user=用户发起（旧字段 voiceText 的等价物）
        JSON.stringify({ initiator: session.opening ? 'ai' : 'user' }),
        new Date().toISOString(),
      )
  } catch (e) {
    deps.log('[voice-call] call card save failed: %s', e instanceof Error ? e.message : e)
  }

  // 通话结束后自动「回响」：总结 → 记忆 + 待办（fire-and-forget，不阻塞）
  if (hasContent) {
    const transcript = session.transcriptLines.join('\n')
    void summarizeCall({ storage: deps.storage, memory: deps.memory, log: deps.log }, session.bot, session.sender, transcript)
  }

  // 稍后关闭连接，让 call_end 先送达
  setTimeout(() => {
    try {
      session.ws.close()
    } catch {
      // 已关闭
    }
  }, 200)
}

// 秒 → mm:ss（不足 1 分钟显示秒）
function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}秒`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function sendJson(ws: WebSocket, obj: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
}

/** ws 的二进制帧 → Buffer（ws v8 可能给 Buffer / Buffer[] / ArrayBuffer）。 */
function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

/** ws 的文本帧 → 字符串（ws v8 文本帧给 string，二进制给 Buffer）。 */
function textOf(data: RawData): string {
  if (typeof data === 'string') return data
  return toBuffer(data).toString('utf8')
}
