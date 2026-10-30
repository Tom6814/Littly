/**
 * @littly/voice-call — 实时语音通话插件（旧 monolith src/internal/voice-call/* 的忠实移植）。
 *
 * 装配两件事：
 *   1. ctx.webServer 的 /call 升级路由（WS 服务端）→ 浏览器连 wss://<host>/call?botId=..&sender=..
 *   2. hub 的 'web' 渠道 sendText/startCall → 让 AI 在聊天里调用 start_call 工具时，
 *      登记一条待接来电（内存暂存，90s TTL），控制台轮询端点领取后弹「来电」接听框。
 *
 * 服务键 'littlyVoiceCall'：控制台（/api/call/requests）可注入消费待接来电。
 */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { LittlyStorage } from '@littly/storage'
import type { LittlyPersona } from '@littly/persona'
import type { LittlyMemory } from '@littly/memory'
import type { LittlyHub } from '@littly/agents'
import { CALL_PATH, createVoiceCallService, type VoiceCallService } from './call-server.ts'
import { addPendingCall } from './pending.ts'

export const name = 'littly-voice-call'

export const inject = ['littlyStorage', 'littlyPersona', 'littlyMemory', 'littlyHub', 'webServer']

export interface Config {}

export const Config: z<Config> = z.object({})

declare module '@deepseek-ai/cordis' {
  interface Context {
    littlyVoiceCall: VoiceCallService
  }
}

/** ctx.webServer 的最小面（避免本包依赖 host 包）。 */
export interface WebServerUpgradeLike {
  registerUpgrade: (route: {
    path: string
    handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
  }) => () => void
}

export function apply(ctx: Context, _config: Config): void {
  const storage = ctx.littlyStorage as LittlyStorage
  const persona = ctx.littlyPersona as LittlyPersona
  const memory = ctx.littlyMemory as LittlyMemory
  const hub = ctx.littlyHub as LittlyHub
  const log = (msg: string, ...args: unknown[]): void => {
    ctx.logger.info(msg, ...args)
  }

  const service = createVoiceCallService({ storage, persona, memory, hub, log })
  ctx.provide('littlyVoiceCall', service)

  // §同源部署 — 语音 WebSocket 挂到 webServer 的 /call 路径上，
  // 让控制台页面与语音通话共用同一个公网端口（浏览器连 wss://<域名>/call）。
  const web = (ctx as unknown as { webServer?: WebServerUpgradeLike }).webServer
  if (web === undefined) {
    ctx.logger.warn('littly-voice-call: webServer 服务不可用，语音通话未挂载')
  } else {
    ctx.effect(
      () => web.registerUpgrade({ path: CALL_PATH, handler: service.handleUpgrade }),
      'littly-voice-call: /call upgrade',
    )
  }

  // §web 渠道 — start_call 工具经 hub 的 ChannelBridge 落到这里：登记一条待接来电。
  // （旧 monolith 的 builtin/executor.ts doStartCall 同义：addPendingCall + 返回 ok）
  hub.registerChannel('web', {
    sendText: async (botId: string, sender: string, text: string) => {
      try {
        storage
          .prepare('INSERT INTO messages (id, bot_id, sender, role, content, reply_type, channel_id, created_at) VALUES (?,?,?,?,?,?,?,?)')
          .run(randomUUID(), botId, sender, 'assistant', text, 'text', 'web', new Date().toISOString())
        return { ok: true, sent: 1 }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
    startCall: async (botId: string, sender: string, reason: string, topic?: string) => {
      if (!reason.trim()) {
        log('[voice-call] start_call 缺少 reason')
        return { ok: false }
      }
      const call = addPendingCall(botId, sender, reason.trim(), (topic ?? '').trim())
      log('[voice-call] AI 主动来电已登记 (bot=%s, sender=%s, callId=%s)', botId, sender, call.id)
      return { ok: true }
    },
  })

  ctx.logger.info('littly voice call ready')
}

export { createVoiceCallService, CALL_PATH } from './call-server.ts'
export type { VoiceCallService, VoiceCallDeps } from './call-server.ts'
export { addPendingCall, consumePendingCall, listPendingCalls, PENDING_TTL_MS } from './pending.ts'
export type { PendingCall } from './pending.ts'
export { buildCallSystemPrompt, selectCallSystemParts, CALL_SYSTEM_LAYERS, CALL_EXCLUDED_LAYERS } from './call-prompt.ts'
export { DeepgramStreamSTT } from './deepgram.ts'
export type { DeepgramHandlers } from './deepgram.ts'
export { summarizeCall, clampFireAt, parseFireAt } from './summary.ts'
export { RECALL_CONTEXT_TOOL, END_CALL_TOOL, executeRecallContext, isEndCallTool } from './call-tools.ts'
export { signCallToken, verifyCallToken, CALL_TOKEN_TTL_MS } from './call-token.ts'
export type { CallTokenPayload } from './call-token.ts'
