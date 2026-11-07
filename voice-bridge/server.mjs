// Littly voice call bridge — original pipeline:
// browser PCM16/16k -> Deepgram streaming STT -> her chat -> Fish streaming TTS.
// Ported from harness/packages/littly/voice-call/{deepgram,call-server}.ts.
import http from 'node:http'
import crypto from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'

const PORT = Number(process.env.PORT || 3300)
const CORE = process.env.LITTLY_CORE_URL || 'http://memoh-server:8080'
const DG_KEY = process.env.DEEPGRAM_API_KEY || ''
const FISH_KEY = process.env.FISH_AUDIO_API_KEY || ''
const FISH_MODEL = process.env.FISH_AUDIO_MODEL || 's2.1-pro-free'
const FISH_REFERENCE = process.env.FISH_AUDIO_REFERENCE_ID || ''
const SECRET = process.env.VOICE_TOKEN_SECRET || ''
const DG_URL = 'wss://api.deepgram.com/v1/listen'
const SILENCE_MS = 800

function verifyToken(token) {
  if (!SECRET || !token) return null
  const dot = token.lastIndexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null
  const body = token.slice(0, dot), sig = token.slice(dot + 1)
  const want = crypto.createHmac('sha256', SECRET).update(body, 'utf8').digest('base64url')
  const a = Buffer.from(sig, 'base64url'), b = Buffer.from(want, 'base64url')
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (!p?.botId || !p?.sender || typeof p.exp !== 'number' || p.exp < Date.now()) return null
    return p
  } catch { return null }
}

function send(ws, obj) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)) }

class DeepgramSTT {
  constructor(key, handlers) {
    this.key = key; this.handlers = handlers; this.ws = null
    this.buf = []; this.interim = ''; this.silence = null
    this.closed = false; this.reconnect = null; this.count = 0; this.keep = null
  }
  connect() {
    const u = new URL(DG_URL)
    u.searchParams.set('model', 'nova-2')
    u.searchParams.set('language', 'zh')
    u.searchParams.set('smart_format', 'true'); u.searchParams.set('punctuate', 'true')
    u.searchParams.set('interim_results', 'true'); u.searchParams.set('utterances', 'true')
    u.searchParams.set('endpointing', '500'); u.searchParams.set('encoding', 'linear16')
    u.searchParams.set('sample_rate', '16000'); u.searchParams.set('channels', '1')
    this.ws = new WebSocket(u.toString(), { headers: { Authorization: `Token ${this.key}` } })
    this.ws.on('open', () => {
      this.count = 0; this.buf = []; this.interim = ''
      this.stopKeep(); this.keep = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'KeepAlive' }))
      }, 5000)
    })
    this.ws.on('message', (d) => this.onMessage(String(d)))
    this.ws.on('error', (e) => { console.warn('[deepgram]', e?.message || e); this.schedule() })
    this.ws.on('close', () => { this.stopKeep(); if (!this.closed) this.schedule(); this.handlers.onClose?.() })
  }
  sendPCM(buf) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(buf) }
  stopKeep() { if (this.keep) { clearInterval(this.keep); this.keep = null } }
  close() {
    this.closed = true; this.stopKeep()
    if (this.reconnect) clearTimeout(this.reconnect)
    if (this.silence) clearTimeout(this.silence)
    try { if (this.ws?.readyState === WebSocket.OPEN) { this.ws.send(JSON.stringify({ type: 'CloseStream' })); this.ws.close() } } catch {}
  }
  schedule() {
    if (this.closed || this.reconnect) return
    if (this.count >= 5) { this.handlers.onError?.(new Error('识别服务连接失败，已放弃重连')); return }
    const delay = Math.min(1000 * 2 ** this.count, 16000); this.count++
    console.warn(`[deepgram] reconnect in ${delay}ms`)
    this.reconnect = setTimeout(() => { this.reconnect = null; this.connect() }, delay)
  }
  shown() { return (this.interim ? `${this.buf.join(' ')} ${this.interim}` : this.buf.join(' ')).trim() }
  flush() {
    if (this.silence) { clearTimeout(this.silence); this.silence = null }
    const text = this.shown(); this.buf = []; this.interim = ''
    if (text) this.handlers.onSentence?.(text)
  }
  arm() {
    if (this.silence) clearTimeout(this.silence)
    this.silence = setTimeout(() => this.flush(), SILENCE_MS)
  }
  onMessage(raw) {
    let m; try { m = JSON.parse(raw) } catch { return }
    if (m.type === 'Results') {
      const t = (m.channel?.alternatives?.[0]?.transcript || '').trim()
      if (m.is_final) { if (t) { this.buf.push(t); this.interim = '' } }
      else if (t) this.interim = t
      this.handlers.onInterim?.(this.shown()); this.arm()
    } else if (m.type === 'UtteranceEnd') this.flush()
  }
}

async function fishStream(text, onChunk, signal) {
  const body = { text, temperature: 0.7, top_p: 0.7, normalize: true, format: 'mp3', sample_rate: 44100,
    mp3_bitrate: 128, chunk_length: 300, min_chunk_length: 50, condition_on_previous_chunks: true,
    latency: 'balanced', prosody: { speed: 1 } }
  if (FISH_REFERENCE) body.reference_id = FISH_REFERENCE
  const res = await fetch('https://api.fish.audio/v1/tts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${FISH_KEY}`, 'Content-Type': 'application/json', model: FISH_MODEL },
    body: JSON.stringify(body), signal,
  })
  if (!res.ok) throw new Error(`Fish TTS 失败 (${res.status}): ${(await res.text()).slice(0, 200)}`)
  const reader = res.body?.getReader(); if (!reader) throw new Error('Fish TTS 无流')
  for (;;) { const { done, value } = await reader.read(); if (done) break; if (value?.length) onChunk(Buffer.from(value)) }
}

const wss = new WebSocketServer({ noServer: true })
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, deepgram: !!DG_KEY, fish: !!FISH_KEY })) }
  res.writeHead(404); res.end('not found')
})
server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url || '/', 'http://x')
  if (u.pathname !== '/call') { socket.destroy(); return }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})
wss.on('connection', (ws, req) => {
  const u = new URL(req.url || '/', 'http://x')
  const payload = verifyToken(u.searchParams.get('token') || '')
  if (!payload) { send(ws, { type: 'error', message: '通话鉴权失败：令牌缺失或已过期' }); ws.close(4401); return }
  if (!DG_KEY) { send(ws, { type: 'error', message: 'Deepgram API Key 未配置（DEEPGRAM_API_KEY）' }); ws.close(); return }
  let busy = false, ended = false, ttsAbort = null
  const started = Date.now(), lines = []
  const stt = new DeepgramSTT(DG_KEY, {
    onInterim: (t) => send(ws, { type: 'stt_interim', text: t }),
    onSentence: (t) => { if (!ended && !busy) reply(t) },
    onError: (e) => send(ws, { type: 'stt_error', message: e.message }),
  })
  stt.connect()
  send(ws, { type: 'ready' })

  async function reply(text) {
    busy = true
    try {
      lines.push(`对方: ${text}`)
      send(ws, { type: 'stt_final', text })
      send(ws, { type: 'ai_thinking' })
      const r = await fetch(CORE + '/littly/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text }) })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.detail || d.error || 'chat failed')
      const answer = d.replied && d.reply ? d.reply : '……'
      lines.push(`我: ${answer}`)
      send(ws, { type: 'ai_text', text: answer })
      if (!FISH_KEY) { send(ws, { type: 'tts_text', text: answer }); return }
      send(ws, { type: 'tts_start' })
      const ac = new AbortController(); ttsAbort = ac
      try {
        await fishStream(answer, (buf) => send(ws, { type: 'tts_chunk', audio: buf.toString('base64'), text: answer }), ac.signal)
      } catch (e) { console.warn('[fish]', e?.message || e) }
      finally { if (ttsAbort === ac) ttsAbort = null }
      send(ws, { type: 'tts_chunk_end', text: answer })
    } catch (e) {
      console.error('[voice] reply', e?.message || e); send(ws, { type: 'ai_text', text: '……' })
    } finally { busy = false }
  }

  async function end() {
    if (ended) return; ended = true
    stt.close(); ttsAbort?.abort()
    send(ws, { type: 'call_end', transcript: lines })
    const dur = Math.max(0, Math.round((Date.now() - started) / 1000))
    fetch(CORE + '/littly/api/call/ended', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ duration_sec: dur, transcript: lines }) }).catch(() => {})
    setTimeout(() => { try { ws.close() } catch {} }, 200)
  }
  ws.on('message', (data, isBinary) => {
    if (ended) return
    if (isBinary) { stt.sendPCM(Buffer.isBuffer(data) ? data : Buffer.from(data)); return }
    try { const o = JSON.parse(String(data)); if (o.type === 'stop') end(); else if (o.type === 'interrupt') { ttsAbort?.abort(); ttsAbort = null } } catch {}
  })
  ws.on('close', end); ws.on('error', end)
})
server.listen(PORT, '0.0.0.0', () => console.log(`littly-voice-bridge listening on ${PORT} deepgram=${!!DG_KEY} fish=${!!FISH_KEY}`))
