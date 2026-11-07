// Littly WeChat bridge — QR login via the openilink iLink SDK (same flow as
// openilink-hub): scan once, then monitor messages and forward them to the
// Littly core. Replies are pushed back through iLink context tokens.
import http from 'node:http'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { Client, extractText } from '@openilink/openilink-sdk-node'
import QRCode from 'qrcode'

const CORE = process.env.LITTLY_CORE_URL || 'http://memoh-server:8080'
const DATA = process.env.BRIDGE_DATA || '/data/state.json'
const PORT = Number(process.env.PORT || 3200)

let state = { botToken: '', botId: '', baseUrl: '', userId: '', contexts: {} }
try { if (fs.existsSync(DATA)) state = { ...state, ...JSON.parse(fs.readFileSync(DATA, 'utf8')) } } catch {}
const save = () => { try { fs.mkdirSync('/data', { recursive: true }); fs.writeFileSync(DATA, JSON.stringify(state)) } catch (e) { console.error('save state', e) } }
const sessions = new Map()
let client = null
let running = false

async function forwardInbound(sender, text) {
  const r = await fetch(CORE + '/littly/api/channel/inbound', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'wechat', external_id: sender, name: '微信好友', text }),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok || !d.replied || !d.reply) return
  await push(sender, d.reply)
}

async function push(to, text) {
  if (!client || !state.botToken || !to || !text) return false
  try {
    const ctx = state.contexts[to]
    if (ctx && !client.getContextToken(to)) client.setContextToken(to, ctx)
    await client.push(to, text)
    return true
  } catch (e) { console.error('push', e?.message || e); return false }
}

async function startMonitor() {
  if (running || !state.botToken) return
  running = true
  client = new Client(state.botToken, state.baseUrl ? { base_url: state.baseUrl } : undefined)
  for (const [to, ctx] of Object.entries(state.contexts || {})) {
    try { client.setContextToken(to, ctx) } catch {}
  }
  const task = client.monitor(async (msg) => {
    const sender = msg.from_user_id || ''
    const text = extractText(msg)
    if (msg.context_token && sender) { state.contexts[sender] = msg.context_token; save() }
    if (sender && text) await forwardInbound(sender, text)
  }, {
    should_continue: () => running,
    on_error: (e) => console.error('monitor error', e?.message || e),
    on_session_expired: () => { console.error('wechat session expired; re-scan required'); running = false },
  }).catch((e) => { console.error('monitor stopped', e?.message || e); running = false })
  void task
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = ''
    req.on('data', (c) => { b += c })
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}) } catch { resolve({}) } })
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  try {
    if (url.pathname === '/health') return json(res, 200, { ok: true, bound: !!state.botToken, running })
    if (url.pathname === '/qr/start' && req.method === 'POST') {
      const session = 'wx-' + crypto.randomUUID()
      const st = { status: 'wait', qrImg: '', error: '', expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() }
      sessions.set(session, st)
      let firstQr
      const first = new Promise((resolve) => { firstQr = resolve })
      const c = new Client('')
      c.loginWithQr({
        on_qrcode: async (img) => { try { st.qrImg = img.startsWith('data:') ? img : await QRCode.toDataURL(img, { width: 320, margin: 1 }) } catch { st.qrImg = img } st.status = 'wait'; firstQr && firstQr() },
        on_scanned: () => { st.status = 'scanned' },
        on_expired: () => { st.status = 'expired' },
      }, 4 * 60 * 1000).then(async (result) => {
        if (result?.connected && result.bot_token) {
          state.botToken = result.bot_token
          state.botId = result.bot_id || ''
          state.baseUrl = result.base_url || ''
          state.userId = result.user_id || ''
          save()
          st.status = 'confirmed'
          st.result = { botId: state.botId, userId: state.userId }
          await startMonitor()
        } else {
          st.status = 'failed'
          st.error = result?.message || 'login failed'
        }
        firstQr && firstQr()
      }).catch((e) => {
        st.status = 'failed'; st.error = e?.message || String(e); firstQr && firstQr()
      })
      await Promise.race([first, new Promise((r) => setTimeout(r, 20000))])
      return json(res, 200, { sessionId: session, qrDataUrl: st.qrImg, expiresAt: st.expiresAt })
    }
    if (url.pathname === '/qr/status' && req.method === 'GET') {
      const st = sessions.get(url.searchParams.get('session') || '')
      if (!st) return json(res, 200, { status: 'failed', error: 'session expired' })
      return json(res, 200, st)
    }
    if (url.pathname === '/status') {
      return json(res, 200, {
        bound: !!state.botToken, status: running ? 'connected' : (state.botToken ? 'disconnected' : 'unbound'),
        ilinkBotId: state.botId, ilinkUserId: state.userId, nickname: '微信',
      })
    }
    if (url.pathname === '/logout' && req.method === 'POST') {
      running = false; client = null; state = { botToken: '', botId: '', baseUrl: '', userId: '', contexts: {} }; save()
      return json(res, 200, { ok: true })
    }
    if (url.pathname === '/send' && req.method === 'POST') {
      const b = await readBody(req)
      const ok = await push(String(b.to || ''), String(b.text || ''))
      return json(res, 200, { ok })
    }
    return json(res, 404, { error: 'not found' })
  } catch (e) {
    return json(res, 500, { error: e?.message || String(e) })
  }
})

startMonitor()
server.listen(PORT, '0.0.0.0', () => console.log('littly-wechat-bridge listening on', PORT))
