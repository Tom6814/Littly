#!/usr/bin/env node
/**
 * B 站扫码登录链路验证（对着真的 harness + 真的 sidecar）。
 * 运行：node scripts/verify-bili-sidecar.mjs [port]
 *
 * 为什么单独验：用户反馈「扫码登录显示 fetch failed」。那条链路上有三个独立的断点，
 * 光看接口 200 不算修好：
 *   1. sidecar 根本没被容器连上 → 前端 fetch 直接失败（fetch failed）；
 *   2. sidecar 返回的是裸 base64，前端 <img src> 没有 data URL 前缀 → 图渲染不出来（空白框）；
 *   3. 扫码会话拿不到 session_id → 没法轮询状态。
 * 这里把三段都真跑一遍，并且把 base64 解成 PNG 校验魔数。
 */
const port = process.argv[2] || '3000'
const base = `http://127.0.0.1:${port}`

let pass = 0
let fail = 0
const ok = (cond, name) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.error(`  ✗ ${name}`) }
}

const jar = new Map()
const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')

async function api(path, init = {}) {
  const headers = { ...(init.headers ?? {}) }
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  const ck = cookieHeader()
  if (ck) headers['cookie'] = ck
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    redirect: 'manual',
  })
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';')
    const idx = pair.indexOf('=')
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim())
  }
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = { raw: text } }
  return { status: res.status, json, text }
}

console.log('== 注册 + 登录 ==')
const username = `bili_${Date.now()}`
let reg = await api('/api/auth/register', { method: 'POST', body: { username, password: 'bili-pass-123' } })
if (reg.status !== 200) {
  reg = await api('/api/auth/login', { method: 'POST', body: { username, password: 'bili-pass-123' } })
}
ok(reg.status === 200, `拿到会话（实际 ${reg.status}）`)

console.log('== sidecar 连通性 ==')
const status = await api('/api/bili/status')
ok(status.status === 200, `/api/bili/status 200（实际 ${status.status}）`)
const sdata = status.json?.data ?? {}
if (sdata.connected !== true) {
  ok(false, `sidecar 连上了（error=${sdata.error ?? '未知'}）`)
  console.log(`\n提示：${sdata.hint ?? ''}`)
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(1)
}
ok(true, 'sidecar 连上了')
ok(typeof sdata.logined === 'boolean', '登录状态字段存在')

console.log('== 发起扫码 ==')
const start = await api('/api/bili/qr/start', { method: 'POST', body: {} })
ok(start.status === 200, `发起扫码 200（实际 ${start.status}）`)
const d = start.json?.data ?? {}
ok(typeof d.sessionId === 'string' && d.sessionId.length > 0, '拿到 session_id')
ok(typeof d.qrUrl === 'string' && d.qrUrl.startsWith('http'), '拿到 qr_url')

console.log('== 二维码图片能渲染 ==')
const img = typeof d.qrImage === 'string' ? d.qrImage : ''
ok(img.length > 0, `拿到二维码图片数据（${img.length} 字符）`)
ok(img.startsWith('data:image/png;base64,'), '是带前缀的 data URL（<img src> 能直接渲染）')
const b64 = img.replace(/^data:image\/png;base64,/, '')
const buf = Buffer.from(b64, 'base64')
ok(buf.length > 100, `base64 解出来有内容（${buf.length} 字节）`)
ok(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'PNG 魔数正确（真是一张 PNG）')
ok(buf.subarray(12, 16).toString('ascii') === 'IHDR', 'PNG 头段正确')

console.log('== 轮询扫码状态 ==')
if (typeof d.sessionId === 'string' && d.sessionId !== '') {
  const st = await api(`/api/bili/qr/status?sessionId=${encodeURIComponent(d.sessionId)}`)
  ok(st.status === 200, `查状态 200（实际 ${st.status}）`)
  const stData = st.json?.data ?? {}
  ok(typeof stData.status === 'string', `状态字段存在（${stData.status ?? '未知'}）`)
  ok(stData.status !== 'error', '轮询没有报错')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
