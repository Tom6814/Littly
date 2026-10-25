// Deepgram 流式 STT 客户端（语音通话用，Nova-3）。
// 浏览器把 16kHz/单声道/PCM16 的音频通过本项目 WS 转发到这里，这里再转发给
// Deepgram streaming WebSocket。
//
// 「说完整句」的判定做了双保险（实测 UtteranceEnd 事件在某些连接下不触发，
// 导致说完停顿后没有反应）：
//   1. 快路径：Deepgram 发 UtteranceEnd（endpointing 静音检测）→ 立即提交。
//   2. 兜底：每次收到 Results（interim/final）都重置一个静默计时器；识别结果
//      停止 800ms 即判定「对方说完了」→ 提交当前累积文本。
// 两条路径共用 onSentence 回调（通话里提交给角色 AI 的时机）。
// Node 端用 ws 库（同时承担客户端 + 服务端，headers 传 Authorization 可靠）。
//
// 旧 monolith src/internal/voice-call/deepgram.ts 忠实移植。
// 唯一改动：构造函数的参数属性写法改为显式字段 + 赋值
// —— Node 的类型剥离模式（strip-only）拒绝参数属性。

import WebSocket from 'ws'

export interface DeepgramHandlers {
  // 识别中间结果（滚动显示用）
  onInterim: (text: string) => void
  // 一句话完整结束 —— 提交给 AI 的时机
  onSentence: (text: string) => void
  onError: (err: Error) => void
  onClose: () => void
}

const DEEPGRAM_WS_URL = 'wss://api.deepgram.com/v1/listen'
// 识别结果停止多久视为「说完了」（毫秒）。真人说话句间停顿通常 500-1200ms。
const SILENCE_MS = 800

export class DeepgramStreamSTT {
  private ws: WebSocket | null = null
  // 当前句已累积的 final 片段（utterance 内多个 final 结果拼成一句）
  private sentenceBuf: string[] = []
  // 最近一个 interim（final 未到位时用它兜底整句）
  private lastInterim = ''
  private silenceTimer: NodeJS.Timeout | null = null
  // §断线重连 — Deepgram 连接一断，通话识别就全废；自动重连（带退避），
  // 重连期间音频静默丢弃（毫秒级窗口），连接恢复后继续识别。
  private manuallyClosed = false
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectCount = 0
  private readonly MAX_RECONNECT = 5
  // §KeepAlive — Deepgram 在「无音频」约 10s 后会闲置断开；AI 说话期间我方不发
  // 音频（避免回声转写），靠这个心跳维持连接，防止「说到一半识别服务断开」。
  private keepAliveTimer: NodeJS.Timeout | null = null
  private readonly apiKey: string
  private readonly handlers: DeepgramHandlers

  constructor(apiKey: string, handlers: DeepgramHandlers) {
    this.apiKey = apiKey
    this.handlers = handlers
  }

  connect(): void {
    const url = new URL(DEEPGRAM_WS_URL)
    url.searchParams.set('model', 'nova-2')
    url.searchParams.set('language', 'zh') // 中文优先；语音通话场景按中文对话设计
    url.searchParams.set('smart_format', 'true')
    url.searchParams.set('punctuate', 'true')
    url.searchParams.set('interim_results', 'true')
    url.searchParams.set('utterances', 'true')
    url.searchParams.set('endpointing', '500') // 500ms 静音即视为句尾 → UtteranceEnd（快路径）
    url.searchParams.set('encoding', 'linear16')
    url.searchParams.set('sample_rate', '16000')
    url.searchParams.set('channels', '1')

    this.ws = new WebSocket(url.toString(), {
      headers: { Authorization: `Token ${this.apiKey}` },
    })
    this.ws.on('open', () => {
      // 重连成功：清空旧句缓冲，避免跨连接拼出乱句
      this.reconnectCount = 0
      this.sentenceBuf = []
      this.lastInterim = ''
      // 心跳：无音频时也维持连接（Deepgram 10s 闲置会断开）
      this.stopKeepAlive()
      this.keepAliveTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'KeepAlive' }))
        }
      }, 5000)
    })
    this.ws.on('message', (data) => this.handleMessage(String(data)))
    this.ws.on('error', (e) => {
      console.warn('[deepgram] ws error:', e instanceof Error ? e.message : e)
      this.scheduleReconnect()
    })
    this.ws.on('close', () => {
      this.stopKeepAlive()
      if (!this.manuallyClosed) this.scheduleReconnect()
      this.handlers.onClose()
    })
  }

  sendPCM(buf: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(buf)
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer)
      this.keepAliveTimer = null
    }
  }

  close(): void {
    this.manuallyClosed = true
    this.stopKeepAlive()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer)
      this.silenceTimer = null
    }
    try {
      if (this.ws?.readyState === WebSocket.OPEN) {
        // Deepgram 协议：先发 CloseStream 再关闭连接
        this.ws.send(JSON.stringify({ type: 'CloseStream' }))
        this.ws.close()
      }
    } catch {
      // 忽略关闭阶段异常
    }
  }

  // 断线重连：指数退避 1s → 2s → 4s → 8s → 16s；超过上限放弃并上报
  private scheduleReconnect(): void {
    if (this.manuallyClosed) return
    if (this.reconnectCount >= this.MAX_RECONNECT) {
      this.handlers.onError(new Error('识别服务连接失败，已放弃重连'))
      return
    }
    if (this.reconnectTimer) return
    const delay = Math.min(1000 * 2 ** this.reconnectCount, 16000)
    this.reconnectCount++
    console.warn(`[deepgram] ${delay / 1000}s 后重连 (第 ${this.reconnectCount} 次)`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  // 当前完整文本（final 累积 + 最近 interim 兜底）
  private shownText(): string {
    const base = this.sentenceBuf.join(' ')
    return (this.lastInterim ? `${base} ${this.lastInterim}` : base).trim()
  }

  // 提交当前句并复位
  private flush(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer)
      this.silenceTimer = null
    }
    const s = this.shownText()
    this.sentenceBuf = []
    this.lastInterim = ''
    if (s) this.handlers.onSentence(s)
  }

  // 只要还在吐识别结果就重置静默计时（说话中不触发，停下来 800ms 触发）
  private armSilenceTimer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer)
    this.silenceTimer = setTimeout(() => this.flush(), SILENCE_MS)
  }

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }
    if (msg['type'] === 'Results') {
      const channel = msg['channel'] as { alternatives?: Array<{ transcript?: unknown }> } | undefined
      const alt = channel?.alternatives?.[0]
      const t = typeof alt?.transcript === 'string' ? alt.transcript.trim() : ''
      if (msg['is_final']) {
        // final 结果追加到当前句；interim 兜底失效（final 更完整）
        if (t) {
          this.sentenceBuf.push(t)
          this.lastInterim = ''
        }
      } else if (t) {
        this.lastInterim = t
      }
      this.handlers.onInterim(this.shownText())
      this.armSilenceTimer()
    } else if (msg['type'] === 'UtteranceEnd') {
      // 快路径：Deepgram 判定句尾
      this.flush()
    }
  }
}
