#!/usr/bin/env node
/**
 * verify-agent-loop.mjs —— 对话主链路回归测试（自包含）。
 *
 * 为什么需要它：`hub.runTurn` / 缓冲窗口 / 恰好一次 / 沉默语义 / 安全阀 / 工具循环
 * 是整套系统的核心契约（PRINCIPLES §三），但此前的 16 个行为脚本没有一处真正跑过这些路径。
 * 本脚本用**本地 mock OpenAI 兼容服务** + **真实 harness 进程**把它们跑成断言：
 *
 *   T1 缓冲窗口：fireAt 落在 15–20s 之后；手动 flush 后 user+assistant 各一行、模型只调一次
 *   T2 合并 + 重置：窗口内第二条消息把整批 fireAt 推后；一次模型调用看到两条消息
 *   T3 恰好一次：并发两次 flush，模型调用只增加 1 次（原子认领 + 二次验证）
 *   T4 沉默 = 不落库：模型返回空 content → 只留 user 行，没有 assistant 行
 *   T5 安全阀（唯一硬红线例外）：空回复 + 求死表述 → 强制再要一次并落库
 *   T6 工具循环：模型先给 tool_calls（remember）再给终稿 → 记忆落库、≤5 轮、有回复
 *   T7 思考不外发：content 里带 <thinking>…</thinking> → 回复正文与落库内容都不含思考
 *
 * 用法：
 *   node scripts/verify-agent-loop.mjs            # 自己起 harness（默认自动挑空闲端口）
 *   node scripts/verify-agent-loop.mjs 3111       # 复用已启动的 harness（模型必须指向 mock，否则会打真模型）
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer as createNetServer } from 'node:net'
import { execFileSync } from 'node:child_process'

const HARNESS_ROOT = resolve(import.meta.dirname, '..')
const TIMEOUT_MS = 200_000

// ---------- 断言 ----------
let pass = 0
let fail = 0
const failures = []
function ok(cond, label, detail = '') {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    failures.push(`${label}${detail ? `（${detail}）` : ''}`)
    console.log(`  ✗ ${label}${detail ? `（${detail}）` : ''}`)
  }
}
function section(name) {
  console.log(`\n== ${name} ==`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- mock model ----------
/** 模型调用记录：{ at, texts, marker } */
const calls = []
let toolCallIssued = false
let crisisRetried = false
const MARKER_SILENCE = '[silence]'
const MARKER_CRISIS = '[crisis]'
const MARKER_TOOL = '[tool]'
const MARKER_THINK = '[think]'

function lastUserText(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : []
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i]?.role === 'user') return String(msgs[i].content ?? '')
  }
  return ''
}

/** 安全阀重试时最后一条 user 可能是「请开口」类指令，所以 marker 要扫全部 user 消息。 */
function anyUserText(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : []
  return msgs.filter((m) => m.role === 'user').map((m) => String(m.content ?? '')).join('\n')
}

function detectMarker(text) {
  for (const m of [MARKER_SILENCE, MARKER_CRISIS, MARKER_TOOL, MARKER_THINK]) {
    if (text.includes(m)) return m
  }
  return ''
}

function mockResponse(marker) {
  // 空回复：触发「沉默 / 安全阀」分支
  if (marker === MARKER_SILENCE) return { content: '' }
  if (marker === MARKER_CRISIS) {
    // 第一次空（触发安全阀），第二次给回复
    if (!crisisRetried) {
      crisisRetried = true
      return { content: '' }
    }
    return { content: '我在。别一个人扛着，跟我说说。' }
  }
  if (marker === MARKER_TOOL) {
    if (!toolCallIssued) {
      toolCallIssued = true
      return {
        content: '',
        toolCalls: [
          {
            id: 'call_verify_1',
            type: 'function',
            function: { name: 'remember', arguments: JSON.stringify({ category: 'fact', content: 'verify-agent-loop 测试记忆', importance: 2 }) },
          },
        ],
      }
    }
    return { content: '好，我记下了。' }
  }
  if (marker === MARKER_THINK) {
    return { content: '<thinking>这是内心独白，不该外发</thinking>在呢。' }
  }
  return { content: '在呢' }
}

function startMockModel() {
  const server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404).end('{}')
      return
    }
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      let body = {}
      try {
        body = JSON.parse(raw)
      } catch {
        body = {}
      }
      const text = lastUserText(body)
      const marker = detectMarker(anyUserText(body))
      calls.push({ at: Date.now(), texts: body?.messages?.filter((m) => m.role === 'user').map((m) => String(m.content)) ?? [], marker })
      const out = mockResponse(marker)
      const message = { role: 'assistant', content: out.content }
      if (out.toolCalls) message.tool_calls = out.toolCalls
      const payload = {
        id: `chatcmpl-verify-${calls.length}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body?.model ?? 'mock-model',
        choices: [{ index: 0, message, finish_reason: out.toolCalls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => resolvePromise({ server, port: server.address().port }))
  })
}

// ---------- 端口 ----------
function findFreePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const srv = createNetServer()
    srv.once('error', rejectPromise)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolvePromise(port))
    })
  })
}

// ---------- harness 进程 ----------
function run(cmd, args, opts = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('error', rejectPromise)
    child.on('close', (code) => resolvePromise({ code, out }))
  })
}

async function waitForApi(baseUrl, ms = 60_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api`)
      if (res.ok) return true
    } catch {
      /* retry */
    }
    await sleep(300)
  }
  return false
}

async function api(baseUrl, cookie, path, method = 'GET', body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, json, text, headers: res.headers }
}

// ---------- 主流程 ----------
const sharedPort = process.argv[2] ? Number(process.argv[2]) : 0
const tempRoot = mkdtempSync(join(tmpdir(), 'littly-agent-loop-'))
let harness = null
let mock = null
let baseUrl = ''

try {
  section('准备：mock 模型 + 真实 harness')
  mock = await startMockModel()
  const mockBase = `http://127.0.0.1:${mock.port}/v1`
  console.log(`  mock model: ${mockBase}（记录模型调用）`)

  let port = sharedPort
  if (port === 0) {
    harness = { child: null }
    port = await findFreePort()
    const dshHome = join(tempRoot, 'dsh-home')
    const dbFile = join(tempRoot, 'verify.db')
    mkdirSync(dshHome, { recursive: true })
    const seeded = await run(process.execPath, ['scripts/seed-profile.mjs', '--profile', 'chat'], {
      cwd: HARNESS_ROOT,
      env: { ...process.env, DSH_HOME: dshHome },
    })
    ok(seeded.code === 0, 'profile 播种成功', seeded.code === 0 ? '' : seeded.out.slice(-300))
    const env = {
      ...process.env,
      DSH_HOME: dshHome,
      LITTLY_DB_FILE: dbFile,
      PORT: String(port),
      OPENAI_BASE_URL: mockBase,
      OPENAI_API_KEY: 'mock-key',
      OPENAI_CHAT_MODEL: 'mock-model',
    }
    const child = spawn(process.execPath, ['apps/cli/lib/bin.js', '--profile', 'chat'], {
      cwd: HARNESS_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    harness.child = child
    harness.bootLog = ''
    child.stdout.on('data', (d) => (harness.bootLog += d))
    child.stderr.on('data', (d) => (harness.bootLog += d))
    let bootLog = harness.bootLog
    baseUrl = `http://127.0.0.1:${port}`
    const up = await waitForApi(baseUrl)
    ok(up, 'harness 启动并响应 /api', up ? '' : harness.bootLog.slice(-500))
    if (!up) throw new Error('harness 未启动')
    harness.dbFile = dbFile
  } else {
    baseUrl = `http://127.0.0.1:${port}`
    const up = await waitForApi(baseUrl, 15_000)
    ok(up, `复用已启动的 harness（:${port}）`)
    if (!up) throw new Error('目标 harness 不可达')
  }

  // 注册管理员会话（首个用户即 admin）
  const username = `loop_${Date.now().toString(36)}`
  const reg = await api(baseUrl, '', '/api/auth/register', 'POST', { username, password: 'loop-pass-123' })
  const setCookie = reg.headers.getSetCookie?.() ?? []
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ')
  ok(reg.status === 200 && cookie.includes('littly_token'), '注册管理员并拿到会话 cookie', `status=${reg.status}`)

  const bots = await api(baseUrl, cookie, '/api/bots')
  let botId = bots.json?.data?.bots?.[0]?.id ?? ''
  if (botId === '' && harness?.dbFile) {
    botId = String(sqlRows('SELECT id FROM bots ORDER BY created_at ASC LIMIT 1')[0]?.id ?? '')
  }
  ok(botId !== '', '首启播种出 bot', JSON.stringify(bots.json).slice(0, 160))
  const sender = reg.json?.data?.user?.id ?? ''

  const dbFile = harness?.dbFile
  /** 用 sqlite3 CLI 执行只读查询；返回 JSON 行数组。 */
  function sqlRows(query) {
    if (!dbFile) return []
    try {
      const out = execFileSync('sqlite3', ['-readonly', '-json', dbFile, query], { encoding: 'utf8' })
      const trimmed = out.trim()
      return trimmed === '' ? [] : JSON.parse(trimmed)
    } catch (error) {
      console.log(`  ! sqlite3 查询失败：${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  }
  function sqlInt(query) {
    const rows = sqlRows(query)
    return rows.length > 0 ? Number(Object.values(rows[0])[0] ?? 0) : -1
  }
  const msgCount = () => sqlInt(`SELECT COUNT(*) AS c FROM messages WHERE bot_id = '${botId}' AND sender = '${sender}'`)
  const assistantCount = () => sqlInt(`SELECT COUNT(*) AS c FROM messages WHERE bot_id = '${botId}' AND sender = '${sender}' AND role = 'assistant'`)
  const lastAssistant = () =>
    sqlRows(`SELECT content, delivery_status FROM messages WHERE bot_id = '${botId}' AND sender = '${sender}' AND role = 'assistant' ORDER BY rowid DESC LIMIT 1`)[0] ?? null

  /**
   * 等一批缓冲消息被真正跑完。
   * 谁认领都算通过：调度 tick（每 60s）可能抢在手动 flush 之前认领，
   * 此时 flush 接口按契约返回 flushed=false，但回合照样会执行——所以这里以
   * 「模型被调用过 或 assistant 落了行」为完成信号，再等 300ms 让落库稳定。
   */
  async function waitTurnDone(modelCallsBefore, assistantBefore, timeoutMs = 45_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (calls.length > modelCallsBefore || assistantCount() > assistantBefore) {
        await sleep(400)
        return true
      }
      await sleep(250)
    }
    return false
  }

  /** 入队一条消息 → 触发 flush（不阻塞到期）→ 轮询到回合完成。 */
  async function enqueueThenFlush(text) {
    const modelBefore = calls.length
    const assistantBefore = assistantCount()
    const enq = await api(baseUrl, cookie, '/api/chat/buffer', 'POST', { botId, sender, text })
    ok(enq.status === 200, `入队「${text.slice(0, 12)}…」`, `status=${enq.status}`)
    const fireAt = enq.json?.data?.fireAt ?? ''
    const flush = await api(baseUrl, cookie, '/api/chat/buffer/flush', 'POST', { botId, sender, waitMs: 1500 })
    ok(flush.status === 200, 'flush 接口可用', `status=${flush.status}`)
    const done = await waitTurnDone(modelBefore, assistantBefore)
    ok(done, '到期后批次被认领并完成（flush 或调度 tick）', `modelCalls=${calls.length - modelBefore}`)
    return { fireAt, flush, modelCalls: calls.length - modelBefore, modelBefore, assistantBefore, done }
  }

  // ---------- T1 缓冲窗口 + 单次调用 ----------
  section('T1 缓冲窗口 15–20s + 一次 flush 只调一次模型')
  {
    const msgsBefore = msgCount()
    const enq = await api(baseUrl, cookie, '/api/chat/buffer', 'POST', { botId, sender, text: '在吗？' })
    const fireAt = enq.json?.data?.fireAt ?? ''
    const delay = Date.parse(fireAt) - Date.now()
    const modelBefore = calls.length
    await api(baseUrl, cookie, '/api/chat/buffer/flush', 'POST', { botId, sender, waitMs: 1500 })
    const done = await waitTurnDone(modelBefore, assistantCount())
    ok(done, '批次完成')
    const modelCalls = calls.length - modelBefore
    ok(Number.isFinite(delay) && delay >= 13_000 && delay <= 21_500, 'fireAt 落在 15–20s 窗口内', `delay=${delay}ms`)
    ok(modelCalls === 1, '整批只调用模型一次', `calls=${modelCalls}`)
    ok(msgCount() - msgsBefore === 2, 'user + assistant 各落一行', `delta=${msgCount() - msgsBefore}`)
    const last = lastAssistant()
    ok(last?.delivery_status === 'sent', '投递状态 sent', String(last?.delivery_status))
  }

  // ---------- T2 合并 + 重置 ----------
  section('T2 窗口内第二条消息重置整批（一次模型调用看到两条）')
  {
    const before = calls.length
    const first = await api(baseUrl, cookie, '/api/chat/buffer', 'POST', { botId, sender, text: '第一句：今天好累' })
    const fireAt1 = Date.parse(first.json?.data?.fireAt ?? '')
    await sleep(1200)
    const second = await api(baseUrl, cookie, '/api/chat/buffer', 'POST', { botId, sender, text: '第二句：不过见到你就好了' })
    const fireAt2 = Date.parse(second.json?.data?.fireAt ?? '')
    const delay2 = fireAt2 - Date.now()
    ok(fireAt2 !== fireAt1, '新消息重置了整批 fireAt', `${fireAt1} → ${fireAt2}`)
    ok(delay2 >= 13_000 && delay2 <= 21_500, '重置后的 fireAt 仍落在 15–20s 窗口', `delay=${delay2}ms`)
    await api(baseUrl, cookie, '/api/chat/buffer/flush', 'POST', { botId, sender, waitMs: 1500 })
    await waitTurnDone(before, assistantCount())
    const used = calls.length - before
    ok(used === 1, '合并后仍只调用一次模型', `calls=${used}`)
    const lastCallTexts = calls[calls.length - 1]?.texts?.join('\n') ?? ''
    ok(lastCallTexts.includes('今天好累') && lastCallTexts.includes('见到你就好了'), '一次调用包含两条消息', lastCallTexts.slice(-80))
  }

  // ---------- T3 并发 flush：恰好一次 ----------
  section('T3 并发两次 flush → 模型只被调用一次（原子认领）')
  {
    await api(baseUrl, cookie, '/api/chat/buffer', 'POST', { botId, sender, text: '并发认领测试' })
    const before = calls.length
    const [a, b] = await Promise.all([
      api(baseUrl, cookie, '/api/chat/buffer/flush', 'POST', { botId, sender, waitMs: 1500 }),
      api(baseUrl, cookie, '/api/chat/buffer/flush', 'POST', { botId, sender, waitMs: 1500 }),
    ])
    ok(a.status === 200 && b.status === 200, '两次 flush 都正常返回', `${a.status}/${b.status}`)
    await waitTurnDone(before, assistantCount())
    ok(calls.length - before === 1, '恰好一次模型调用', `calls=${calls.length - before}`)
  }

  // ---------- T4 沉默 = 不落库 ----------
  section('T4 沉默语义：模型空回复 → 不落 assistant 行')
  {
    const assistantBefore = assistantCount()
    await enqueueThenFlush(`${MARKER_SILENCE} 我先睡了，晚安`)
    await sleep(300)
    ok(assistantCount() === assistantBefore, '没有新增 assistant 行（沉默不落库）', `before=${assistantBefore} after=${assistantCount()}`)
  }

  // ---------- T5 安全阀 ----------
  section('T5 安全阀（唯一硬红线例外）：空回复 + 求死表述 → 强制再要一次')
  {
    const assistantBefore = assistantCount()
    await enqueueThenFlush(`${MARKER_CRISIS} 我真的不想活了`)
    await sleep(300)
    ok(assistantCount() > assistantBefore, '安全阀触发后落了回复（不再沉默）', `before=${assistantBefore} after=${assistantCount()}`)
    const last = lastAssistant()
    ok((last?.content ?? '').trim().length > 0, '安全阀回复非空', String(last?.content).slice(0, 60))
  }

  // ---------- T7 思考不外发 ----------
  section('T7 思考不外发：<thinking> 不进正文/落库')
  {
    const { flush } = await enqueueThenFlush(`${MARKER_THINK} 在干嘛`)
    const flushedRows = flush.json?.data?.messages ?? []
    const replyText = String(flushedRows.filter((m) => m.role === 'assistant').at(-1)?.text ?? '')
    ok(!replyText.includes('内心独白'), 'HTTP 响应正文不含思考', replyText.slice(0, 50))
    const last = lastAssistant()
    ok(!String(last?.content ?? '').includes('内心独白'), '落库正文不含思考', String(last?.content).slice(0, 50))
    ok(String(last?.content ?? '').trim().length > 0, 'stripThinking 后仍有可见内容', String(last?.content).slice(0, 50))
  }
} catch (error) {
  fail += 1
  failures.push(`异常：${error instanceof Error ? error.message : String(error)}`)
  console.error('  ✗ 脚本异常：', error)
  // 便于定位「harness 崩了」这类失败：把子进程最后的 stderr/stdout 打出来
  if (harness?.bootLog) console.error('--- harness 子进程日志（末 3000 字）---\n' + String(harness.bootLog).slice(-3000))
} finally {
  try {
    if (harness?.child) harness.child.kill('SIGKILL')
  } catch {
    /* ignore */
  }
  try {
    mock?.server.close()
  } catch {
    /* ignore */
  }
  if (process.env.LITTLY_TEST_KEEP === '1') {
    console.log(`\n[keep] 临时目录保留：${tempRoot}`)
  } else {
    try {
      rmSync(tempRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

console.log(`\n${fail === 0 ? '✅' : '❌'} verify-agent-loop: pass=${pass} fail=${fail}`)
if (fail > 0) {
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
