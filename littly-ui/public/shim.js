/* Littly v2 compatibility bridge: old console UI (/api/*) -> v2 core (/littly/api/*). */
(function () {
  const CORE = '/littly/api'
  const origFetch = window.fetch.bind(window)

  async function core(path, opts) {
    const res = await origFetch(CORE + path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(opts && opts.headers) },
      ...opts,
    })
    const text = await res.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = text }
    if (!res.ok) throw new Error((data && (data.detail || data.error)) || ('HTTP ' + res.status))
    return data
  }
  const json = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
  const enc = encodeURIComponent
  const now = () => new Date().toISOString()
  const person = { id: 'owner', username: '小璃', role: 'admin' }
  let cached = null
  async function boot() {
    if (!cached) cached = await core('/bootstrap')
    return cached
  }
  const at = (m) => m.at || m.created_at || now()
  function msg(m) {
    return {
      id: m.id, role: m.role === 'assistant' ? 'assistant' : 'user', sender: m.role === 'assistant' ? 'owner' : 'owner',
      botId: 'owner', createdAt: at(m), text: m.content || '', pieces: [{ type: 'text', text: m.content || '' }],
    }
  }
  async function messages() {
    const d = await core('/messages?limit=80')
    return (d.messages || []).map(msg)
  }
  function characterFrom(boot) {
    const p = boot.person || {}
    return {
      id: 'owner', name: p.name || '小璃', avatarUrl: '',
      description: p.bio || '', persona: [p.self, p.boundaries].filter(Boolean).join('\n\n'),
      scenario: p.style || '', firstMes: '',
      card: { spec: 'chara_card_v2', spec_version: '2.0', name: p.name || '小璃', description: p.bio || '', personality: [p.self, p.boundaries].filter(Boolean).join('\n\n'), scenario: p.style || '', first_mes: '' },
      createdAt: now(),
    }
  }
  async function contacts() {
    const [b, p] = await Promise.all([boot(), core('/people')])
    const out = (p.people || []).map((x) => ({
      id: x.id, rowId: x.id, botId: 'owner', name: x.name || '她', brief: x.brief || '',
      profile: { 关系: x.tier, 亲密度: String(x.closeness || 0) }, isOwner: x.relationship === 'owner',
      blocked: x.tier === 'blocked' || x.tier === 'archived', channel: x.channel || '', externalId: x.id,
      lastActiveAt: x.last || undefined, createdAt: x.last || now(),
    }))
    if (!out.some((c) => c.isOwner)) out.unshift({ id: 'owner', rowId: 'owner', botId: 'owner', name: b.person.name || '小璃', brief: '主人', profile: null, isOwner: true, blocked: false, channel: 'web', externalId: 'owner', createdAt: now() })
    return out
  }
  async function memories() {
    const d = await core('/memories')
    return (d.memories || []).map((m) => ({
      id: m.id, entryId: m.id, domain: m.domain || 'life', title: m.title || '', body: m.body || '',
      eventTime: m.event_time || now(), recordTime: m.record_time || now(), importance: m.importance || 3,
      visibility: m.visibility, kind: m.kind, tags: [], related: [], thread: '', provenance: m.source || '',
      valid: true, supersededBy: '', volatility: '', sourceRef: '', timeLabel: (m.event_time || '').slice(0, 10),
    }))
  }
  async function diaries() {
    const d = await core('/diaries')
    return (d.diaries || []).map((x) => ({ id: x.id, botId: 'owner', date: x.day || '', content: x.content || '', mood: x.mood || '', createdAt: x.at || now() }))
  }
  async function world() { return await core('/world') }
  async function snowluma() {
    const w = await world()
    const s = (w.channels && w.channels.snowluma) || {}
    const waiting = s.state === 'waiting_login' || (!s.connected && s.enabled)
    return {
      available: true,
      state: s.connected ? 'connected' : (waiting ? 'waiting_scan' : (s.enabled ? 'error' : 'not_installed')),
      dockerOk: true,
      image: { present: true, digest: '', tag: 'v2.2.1' },
      container: { exists: true, running: true, status: s.connected ? 'running' : 'waiting for scan' },
      ports: { novnc: 6081, webui: 5099, ws: 3001 },
      novncUrl: 'http://127.0.0.1:6081/vnc.html', webuiUrl: 'http://127.0.0.1:5099', wsUrl: s.ws_url || 'ws://littly-snowluma:3001',
      vncPassword: '', webuiPassword: '', configReady: true, configPatched: true, configWarning: '',
      hasToken: !!s.ws_url, consent: true, pullProgress: '', lastError: s.last_error || '', logsTail: '',
    }
  }
  async function stats() {
    const [t, p, m] = await Promise.all([core('/today'), core('/people'), core('/messages?limit=800')])
    const counts = {}
    for (const x of (m.messages || [])) {
      const d = String(x.at || '').slice(0, 10)
      if (d) counts[d] = (counts[d] || 0) + 1
    }
    const daily = []
    for (let i = 13; i >= 0; i--) {
      const dt = new Date(Date.now() - i * 86400000)
      const key = dt.toISOString().slice(0, 10)
      daily.push({ date: key, messages: counts[key] || 0 })
    }
    return { daily, toolCalls: [], totals: { messages: (t.messages || []).length, memories: (t.counts && t.counts.memories) || 0, contacts: (p.people || []).length } }
  }
  function err(res, message) { return new Response(JSON.stringify({ error: { code: 'error', message } }), { status: res, headers: { 'Content-Type': 'application/json' } }) }

  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || ''
    const u = new URL(url, location.origin)
    const path = u.pathname
    if (!path.startsWith('/api/')) return origFetch(input, init)
    const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase()
    let body = null
    try { body = init && init.body ? JSON.parse(init.body) : null } catch { body = null }
    const q = u.searchParams
    try {
      if (path === '/api/auth/session') return json({ user: person })
      if (path === '/api/auth/login') return json({ user: person })
      if (path === '/api/auth/logout') return json({ ok: true })
      if (path === '/api/onboarding') return json({ completed: true, steps: { model: true, persona: true, wechat: true } })
      if (path === '/api/onboarding/test-model') return json({ ok: true })
      if (path === '/api/onboarding/complete') return json({ ok: true })
      if (path === '/api/bots') return json({ bots: [{ id: 'owner', name: (await boot()).person.name || '小璃', settings: {} }] })
      if (path.startsWith('/api/bots/') && path.endsWith('/channels')) {
        if (method === 'GET') {
          const d = await core('/connections')
          const channels = {}
          for (const c of (d.connections || [])) channels[c.type] = { enabled: !!c.enabled, ...(c.credentials || {}) }
          return json({ channels })
        }
        const channels = (body && body.channels) || {}
        for (const [type, cfg] of Object.entries(channels)) {
          const credentials = { ...(cfg || {}) }
          delete credentials.enabled
          await core('/connections/' + encodeURIComponent(type), { method: 'PUT', body: JSON.stringify({ enabled: !!(cfg && cfg.enabled), credentials }) })
        }
        return json({ ok: true })
      }
      if (path.startsWith('/api/bots/')) {
        if (method === 'PATCH' || method === 'PUT') return json({ ok: true })
        return json({ bot: { id: 'owner', name: (await boot()).person.name || '小璃', settings: {} } })
      }
      if (path === '/api/characters' && method === 'GET') return json({ characters: [characterFrom(await boot())] })
      if (path.startsWith('/api/characters/owner') && (method === 'PATCH' || method === 'PUT')) {
        const card = (body && body.card) || {}
        const patch = {}
        if (body && body.name) patch.name = body.name
        if (card.description !== undefined) patch.bio = card.description
        if (card.personality !== undefined) patch.self = card.personality
        if (card.scenario !== undefined) patch.style = card.scenario
        await core('/config', { method: 'PUT', body: JSON.stringify(patch) })
        return json({ ok: true })
      }
      if (path.startsWith('/api/characters')) return json({ ok: true, characters: [] })
      if (path === '/api/messages' && method === 'GET') { const list = await messages(); return json({ messages: list, hasMore: false }) }
      if (path === '/api/chat' && method === 'POST') {
        const r = await core('/chat', { method: 'POST', body: JSON.stringify({ content: (body && body.text) || '' }) })
        const list = await messages()
        return json({ messages: list, reply: r.reply || '', toolCalls: [], thinkingLength: 0, silent: !r.replied })
      }
      if (path === '/api/chat/buffer') return json({ buffered: false, count: 0, fireAt: null })
      if (path === '/api/chat/buffer/flush' || path === '/api/chat/regenerate' || path === '/api/chat/edit') { const list = await messages(); return json({ messages: list, reply: '', toolCalls: [], thinkingLength: 0, silent: false }) }
      if (path === '/api/conversations') return json({ conversations: [] })
      if (path === '/api/diaries' && method === 'GET') return json({ diaries: await diaries() })
      if (path === '/api/diaries/write') { await core('/dream', { method: 'POST' }); return json({ alreadyWritten: false }) }
      if (path.startsWith('/api/diaries/')) return json({ ok: true })
      if (path === '/api/memories' && method === 'GET') { const list = await memories(); return json({ memories: list }) }
      if (path === '/api/memories' && method === 'POST') { const m = body || {}; const r = await core('/memories', { method: 'POST', body: JSON.stringify({ title: m.title || m.content || '记忆', body: m.content || m.body || '', domain: m.domain || 'life', importance: m.importance || 3, visibility: 'public' }) }); return json(r) }
      if (path.startsWith('/api/memories/') && method === 'DELETE') return json({ ok: true })
      if (path === '/api/memory/profile') {
        const b = await boot(); const list = await memories()
        const content = '# 关于她\n\n' + list.slice(0, 20).map((m) => '- ' + m.title + '：' + m.body).join('\n')
        return json({ profile: content, updatedAt: now(), entryCount: list.length, truncated: false })
      }
      if (path === '/api/memory/domains') {
        const list = await memories(); const map = new Map()
        for (const m of list) { const k = m.domain || 'life'; const v = map.get(k) || { domain: k, label: k, description: '', count: 0, recentTitle: m.title, recentTimeLabel: m.timeLabel, updatedAt: now() }; v.count++; map.set(k, v) }
        return json({ available: true, domains: [...map.values()] })
      }
      if (path === '/api/memory/entries' && method === 'GET') { const list = await memories(); return json({ available: true, entries: list, total: list.length }) }
      if (path.startsWith('/api/memory/entries/')) { const list = await memories(); const id = decodeURIComponent(path.split('/').pop()); const e = list.find((x) => x.id === id); return json(e ? { available: true, entry: e } : { available: false }) }
      if (path === '/api/memory/search') { const d = await core('/memories?q=' + enc(q.get('q') || '')); return json({ available: true, results: (d.memories || []).map((m) => ({ entryId: m.id, domain: m.domain, title: m.title, timeLabel: (m.event_time || '').slice(0, 10), score: m.importance || 0 })) }) }
      if (path === '/api/memory/staging') return json({ available: true, items: [], total: 0 })
      if (path === '/api/memory/staging/consolidate') { await core('/dream', { method: 'POST' }); return json({ ok: true, report: null }) }
      if (path === '/api/memory/dream/status') return json({ available: true, running: false, lastRunAt: '', nextRunAt: '', lastReport: null, lastError: '' })
      if (path === '/api/contacts' && method === 'GET') return json({ contacts: await contacts() })
      if (path.startsWith('/api/contacts/') && method === 'PATCH') return json({ ok: true })
      if (path.startsWith('/api/contacts/')) { const all = await contacts(); const id = decodeURIComponent(path.split('/').pop()); return json({ contact: all.find((c) => c.id === id) || null }) }
      if (path === '/api/relations') return json({ relations: [] })
      if (path.startsWith('/api/relations/')) return json({ ok: true })
      if (path === '/api/wechat/status') {
        const d = await (await origFetch('/littly/wechat/status')).json()
        return json({ bound: !!d.bound, botId: 'owner', ilinkBotId: d.ilinkBotId || '', ilinkUserId: d.ilinkUserId || '', nickname: d.nickname || '微信', status: d.status || (d.bound ? 'connected' : 'stopped'), windowFresh: true, note: d.bound ? '已绑定微信' : '请扫码绑定微信' })
      }
      if (path === '/api/wechat/qr' && method === 'POST') {
        const r = await origFetch('/littly/wechat/qr/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        const d = await r.json()
        return json({ sessionId: d.sessionId || (d.session && d.session.id) || '', qrDataUrl: d.qrDataUrl || (d.session && d.session.qrImg) || '', expiresAt: d.expiresAt || '' })
      }
      if (path.startsWith('/api/wechat/qr/') && method === 'GET') {
        const sid = decodeURIComponent(path.split('/').pop())
        const r = await origFetch('/littly/wechat/qr/status?session=' + enc(sid))
        const d = await r.json()
        return json({ status: d.status || 'wait', qrDataUrl: d.qrImg || d.qrDataUrl || '', error: d.error || '', ilinkBotId: (d.result && d.result.botId) || '', ilinkUserId: (d.result && d.result.userId) || '' })
      }
      if (path === '/api/wechat/logout' && method === 'POST') { await origFetch('/littly/wechat/logout', { method: 'POST' }); return json({ ok: true }) }
      if (path === '/api/wechat/friend-qr') return json({ qrDataUrl: '', note: '扫码后在微信里直接给她发消息即可' })
      if (path === '/api/qq/status') { const s = (await world()).channels.snowluma || {}; return json({ available: true, snowluma: { enabled: !!s.enabled, connected: !!s.connected, selfId: s.account || '', lastError: s.last_error || '', lastEventAt: '' }, qqbot: { enabled: false, connected: false } }) }
      if (path === '/api/qq/logs') return json({ logs: [] })
      if (path === '/api/qq/probe') { const s = (await world()).channels.snowluma || {}; return json({ ok: !!s.connected, waiting: !s.connected && !!s.enabled, selfId: s.account || '', nickname: '', error: s.last_error || '' }) }
      if (path === '/api/qq/snowluma' && method === 'PUT') { const p = { snowluma_enabled: !!(body && body.enabled) }; if (body && body.wsUrl) p.snowluma_ws = body.wsUrl; if (body && body.token) p.snowluma_token = body.token; await core('/config', { method: 'PUT', body: JSON.stringify(p) }); return json({ ok: true }) }
      if (path === '/api/qq/qqbot') return json({ ok: true })
      if (path === '/api/snowluma/status') return json(await snowluma())
      if (path.startsWith('/api/snowluma/')) return json(await snowluma())
      if (path === '/api/settings/ai' && method === 'GET') { const b = await boot(); return json({ baseURL: b.model && b.model.base_url || '', apiKey: '***', apiKeySet: true, chatModel: b.model && b.model.model || 'deepseek-flash', growthModel: b.model && b.model.model || 'deepseek-flash', webSearch: false, embedding: false, image: false }) }
      if (path === '/api/settings/ai' && (method === 'PUT' || method === 'PATCH')) { const p = {}; if (body && body.chatModel) p.model = body.chatModel; await core('/config', { method: 'PUT', body: JSON.stringify(p) }); return json({ ok: true }) }
      if (path === '/api/settings/platform') return json({ registrationEnabled: false })
      if (path === '/api/stats/activity') return json(await stats())
      if (path === '/api/call/requests') return json({ requests: [] })
      if (path.startsWith('/api/call/')) return json({ ok: true })
      if (path === '/api/persona-rules') return json({ content: '', enabled: true })
      if (path === '/api/bind/status') return json({ items: [] })
      if (path.startsWith('/api/bind/')) return json({ ok: true })
      if (path === '/api/plugins') return json({ plugins: [] })
      return json({})
    } catch (e) {
      return err(500, (e && e.message) || 'v2 bridge error')
    }
  }

  // Trim old-console clutter that has no v2 equivalent: extra bot actions,
  // logout, voice config, and QQ container-management buttons. The v2 core is
  // one person / one instance.
  function tidy() {
    const hide = (el) => { if (el) el.style.display = 'none' }
    document.querySelectorAll('button,a').forEach((el) => {
      const t = (el.textContent || '').trim()
      if (['新建角色', '导入 PNG', '退出登录', '停止', '卸载', '容器日志', '添加关系'].includes(t)) hide(el)
    })
    document.querySelectorAll('h2,h3').forEach((el) => {
      if ((el.textContent || '').trim() === '语音') {
        const s = el.closest('section')
        if (s) hide(s)
      }
    })
  }
  window.addEventListener('hashchange', () => setTimeout(tidy, 400))
  document.addEventListener('DOMContentLoaded', () => setTimeout(tidy, 1200))
  const tidyTimer = setInterval(tidy, 1500)
  setTimeout(() => clearInterval(tidyTimer), 30000)

  // No SSE in v2 core: provide a quiet EventSource stub so the old chat page
  // doesn't reconnect-loop. Send responses already carry the messages.
  const NativeES = window.EventSource
  window.EventSource = function (url) {
    if (!String(url).includes('/api/stream')) return new NativeES(url)
    const listeners = {}
    const stub = {
      readyState: 1, onopen: null, onmessage: null, onerror: null,
      addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn) },
      removeEventListener() {}, close() {},
    }
    setTimeout(() => { stub.onopen && stub.onopen({}); (listeners.open || []).forEach((f) => f({})) }, 50)
    return stub
  }
})();
