#!/usr/bin/env node
/**
 * 首次引导（onboarding）API 真实验收。
 * 运行：node scripts/verify-onboarding.mjs [port] [dbPath]
 *
 * 需要目标端口上有真实运行的 harness（CI 跳过本脚本，见 .github/workflows/ci.yml）。
 * 覆盖 SPEC §4 引导向导后端接口：
 *  - GET  /api/onboarding            → {completed, steps:{model,persona,wechat}}
 *  - POST /api/onboarding/test-model → {ok, latencyMs, error?}（真模型 / 坏配置两条路径）
 *  - POST /api/onboarding/complete   → 标记完成，GET 反映 completed=true
 *  - 未登录 → 401（会话鉴权）
 */
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const port = process.argv[2] || '3111'
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
  if (ck) headers.cookie = ck
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

// ---- 登录并提权（首个用户即 admin；已有 admin 凭据则直接登录）----
const username = process.env.LITTLY_E2E_USER ?? `onb_${Date.now()}`
const password = process.env.LITTLY_E2E_PASS ?? 'onb-pass-123'
let reg = await api('/api/auth/login', { method: 'POST', body: { username, password } })
if (reg.status !== 200) reg = await api('/api/auth/register', { method: 'POST', body: { username, password } })
ok(reg.status === 200, `注册/登录（${reg.status}）`)

{
  let runtimeDb = ''
  try {
    const info = JSON.parse(readFileSync(join(tmpdir(), `littly-runtime-${port}.json`), 'utf8'))
    if (typeof info?.dbFile === 'string') runtimeDb = info.dbFile
  } catch { /* 旧版服务无自述文件 */ }
  const { LittlyStorage } = await import('../packages/littly/storage/src/index.ts')
  const candidates = [runtimeDb, process.argv[3], process.env.LITTLY_DB_FILE, 'data/littly.db'].filter((x) => typeof x === 'string' && x !== '')
  let elevated = false
  for (const dbFile of candidates) {
    try {
      const store = new LittlyStorage({ logger: { info: () => {} } }, { file: dbFile })
      store.prepare("UPDATE users SET role = 'admin' WHERE username = ?").run(username)
      store.close()
      elevated = true
      break
    } catch { /* 换候选 */ }
  }
  ok(elevated, '本地提权为 admin（定位真实业务库）')
}

console.log('== onboarding API ==')
// 未登录 → 401
{
  const saved = new Map(jar)
  jar.clear()
  const anon = await api('/api/onboarding')
  ok(anon.status === 401, `未登录 GET /api/onboarding → 401（实际 ${anon.status}）`)
  for (const [k, v] of saved) jar.set(k, v)
}

const got = await api('/api/onboarding')
ok(got.status === 200, `GET /api/onboarding 200（实际 ${got.status}）`)
const data = got.json?.data ?? got.json ?? {}
ok(typeof data.completed === 'boolean', 'GET 返回 completed 布尔值')
ok(data.steps !== undefined && typeof data.steps === 'object', 'GET 返回 steps 对象')
ok(typeof data.steps?.model === 'boolean', 'steps.model 是布尔值')
ok(typeof data.steps?.persona === 'boolean', 'steps.persona 是布尔值')
ok(typeof data.steps?.wechat === 'boolean', 'steps.wechat 是布尔值')

// 坏配置 → ok:false + 可读 error（不崩、不 500）
{
  const bad = await api('/api/onboarding/test-model', {
    method: 'POST',
    body: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'bad-key', model: 'no-such-model' },
  })
  ok(bad.status === 200, `坏配置 test-model 200（不得 500，实际 ${bad.status}）`)
  const bd = bad.json?.data ?? bad.json ?? {}
  ok(bd.ok === false, '坏配置 → ok:false')
  ok(typeof bd.latencyMs === 'number', '坏配置也返回 latencyMs')
  ok(typeof bd.error === 'string' && bd.error.length > 0, '坏配置返回可读 error')
}

// 用服务端现有配置真测一次（服务启动时 env 里有真模型 key）→ ok:true
{
  const real = await api('/api/onboarding/test-model', { method: 'POST', body: {} })
  ok(real.status === 200, `现有配置 test-model 200（实际 ${real.status}）`)
  const rd = real.json?.data ?? real.json ?? {}
  ok(rd.ok === true, `现有配置（服务端 env/DB）→ ok:true（${rd.error ?? '无错误'}）`)
  ok(typeof rd.latencyMs === 'number' && rd.latencyMs >= 0, `真模型延迟可读（${rd.latencyMs}ms）`)
}

// 完成引导 → completed 持久化
{
  const done = await api('/api/onboarding/complete', { method: 'POST', body: {} })
  ok(done.status === 200, `POST /api/onboarding/complete 200（实际 ${done.status}）`)
  const after = await api('/api/onboarding')
  const ad = after.json?.data ?? after.json ?? {}
  ok(ad.completed === true, '完成后再 GET → completed=true')
  ok(ad.steps?.model !== undefined && ad.steps?.persona !== undefined, '完成后 steps 仍可读（幂等）')
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
