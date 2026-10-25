#!/usr/bin/env node
/**
 * bilibili 接入验证（bili 元工具 + sidecar 客户端 + MCP 收敛门）。
 * 运行：node scripts/verify-bili.mjs
 *
 * 用一个本地 mock sidecar 复刻 sidecars/bili/wrapper.py 的契约：
 *   GET  /health
 *   GET  /auth/status
 *   POST /auth/qr/start
 *   GET  /auth/qr/status?session_id=...
 *   POST /cmd
 *   X-Bili-Token 头（配置了 token 时强制校验）
 * 因此不需要上游 bili-agent 就能验证整条链路。
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BiliSidecarError,
  biliAuthStatus,
  biliEnv,
  biliQrImageDataUrl,
  biliQrStart,
  biliQrStatus,
  biliRunCommand,
} from '../packages/littly/tools/src/bili.ts'
import { BILI_TOOL, toolByName } from '../packages/littly/tools/src/defs.ts'
import { CONVERGE_REASON, apply as applyBili } from '../packages/littly/bili/src/index.ts'

let pass = 0
let fail = 0
const ok = (cond, name) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.error(`  ✗ ${name}`) }
}

// ---------- mock sidecar ----------
const TOKEN = 'test-token'
const seen = { cmd: [], authHeader: null }
const server = createServer((req, res) => {
  seen.authHeader = req.headers['x-bili-token'] ?? null
  const url = new URL(req.url, 'http://127.0.0.1')
  const send = (status, obj) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(obj))
  }
  if (url.pathname === '/health') return send(200, { ok: true })
  if (req.headers['x-bili-token'] !== TOKEN) {
    return send(401, { ok: false, error: { code: 'invalid_argument', message: '缺少或错误的 X-Bili-Token 头。' } })
  }
  if (url.pathname === '/auth/status') {
    return send(200, { exit_code: 0, result: { ok: true, data: { logged_in: true, user: { mid: 12345, uname: '小璃' } } } })
  }
  if (url.pathname === '/auth/qr/start') {
    return send(200, { ok: true, session_id: 'sess-abcdef01', qr_url: 'https://passport.bilibili.com/qr/xyz', qr_image_base64: 'iVBORw0KGgo=', expires_in: 180 })
  }
  if (url.pathname === '/auth/qr/status') {
    const sid = url.searchParams.get('session_id')
    if (sid !== 'sess-abcdef01') {
      return send(404, { ok: false, error: { code: 'not_found', message: '未知 session_id，请重新 POST /auth/qr/start。' } })
    }
    return send(200, { state: 'wait', age_seconds: 3 })
  }
  if (url.pathname === '/cmd' && req.method === 'POST') {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const body = JSON.parse(raw || '{}')
      const argv = body.argv ?? []
      seen.cmd.push({ argv, dryRun: body.dry_run })
      if (argv[0] === 'boom') {
        return send(200, { exit_code: 5, dry_run: false, result: { ok: false, error: { code: 'risk_control', message: '风控拦截' } } })
      }
      const isWrite = argv[0] === 'comment'
      const dry = isWrite && body.dry_run !== false
      return send(200, {
        exit_code: 0,
        dry_run: dry,
        result: { ok: true, data: { echoed: argv, dry_run: dry } },
      })
    })
    return
  }
  return send(404, { ok: false, error: { code: 'not_found', message: 'no route' } })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
process.env.BILI_SIDECAR_URL = `http://127.0.0.1:${port}`
process.env.BILI_SIDECAR_TOKEN = TOKEN

console.log('== sidecar 客户端 ==')
const env = biliEnv()
ok(env.baseUrl === `http://127.0.0.1:${port}`, 'baseUrl 取自 BILI_SIDECAR_URL')
ok(env.token === TOKEN, 'token 取自 BILI_SIDECAR_TOKEN')
ok(env.configured === true, '已配置标记')

const status = await biliAuthStatus()
ok(status.ok === true, 'auth/status 成功')
ok((status.data.user).uname === '小璃', '账号信息透传')
ok(seen.authHeader === TOKEN, 'X-Bili-Token 头已带上')

const qr = await biliQrStart()
ok(qr.session_id === 'sess-abcdef01', 'qr/start 返回 session_id')
ok(qr.qr_image_base64 !== undefined, 'qr/start 返回二维码图')

console.log('== 二维码图归一化（裸 base64 → data URL）==')
// sidecar 给的是裸 base64，直接塞进 <img src> 会被浏览器当成相对 URL，图渲染不出来。
const raw = 'iVBORw0KGgoAAAANSUhEUg=='
ok(biliQrImageDataUrl(raw) === `data:image/png;base64,${raw}`, '裸 base64 → 补 data:image/png;base64, 前缀')
ok(biliQrImageDataUrl('data:image/png;base64,xxx') === 'data:image/png;base64,xxx', '已是 data: 的原样用')
ok(biliQrImageDataUrl('') === undefined, '空串 → undefined')
ok(biliQrImageDataUrl(undefined) === undefined, 'undefined → undefined')
ok(biliQrImageDataUrl(null) === undefined, 'null → undefined')
ok(biliQrImageDataUrl(123) === undefined, '非字符串 → undefined')

const qrStatus = await biliQrStatus('sess-abcdef01')
ok(qrStatus.state === 'wait', 'qr/status 轮询状态')

let qrErr = null
try {
  await biliQrStatus('wrong-session')
} catch (e) {
  qrErr = e
}
ok(qrErr instanceof BiliSidecarError, '未知 session → BiliSidecarError')
ok(qrErr?.code === 'not_found', '错误码透传 not_found')
ok(qrErr?.message.includes('未知 session_id'), '错误文案透传')

console.log('== bili 元工具（受护栏约束）==')
const run = await biliRunCommand(['hot', 'search'])
ok(run.result.ok === true, '只读子命令执行成功')
ok(run.dryRun === false, '只读命令不是 dry-run')
ok(seen.cmd.at(-1).argv[0] === 'hot', 'argv 传给 sidecar')

const writeDry = await biliRunCommand(['comment', 'post', 'hello'])
ok(writeDry.dryRun === true, '写操作默认 dry-run（sidecar 强制）')
ok(seen.cmd.at(-1).dryRun === undefined, '未显式传 dry_run 时由 sidecar 决定')

const writeReal = await biliRunCommand(['comment', 'post', 'hello'], false)
ok(writeReal.dryRun === false, '显式 dryRun=false 才真正执行')

const boom = await biliRunCommand(['boom'])
ok(boom.result.ok === false, 'sidecar 业务错误透传')
ok(boom.result.error.code === 'risk_control', '错误码透传 risk_control')

console.log('== 工具定义 ==')
const biliTool = toolByName('bili')
ok(biliTool !== undefined, 'bili 工具已注册')
ok(biliTool.function.name === 'bili', '工具名 = bili')
ok(BILI_TOOL.function.parameters.properties.argv !== undefined, '工具接受 argv 参数')
ok(biliTool.function.description.includes('白名单'), '描述里写明白名单护栏')

console.log('== MCP 收敛门 ==')
const denied = []
const fakeCtx = {
  logger: { info: () => {} },
  on: (event, handler) => { fakeCtx._handler = handler },
  _handler: null,
}
applyBili(fakeCtx, { converge: true, mcpPrefix: 'mcp__bili__' })
ok(fakeCtx._handler !== null, '插件注册了 tools/pre-execute 监听')

const nextAllow = async () => ({ kind: 'allow' })
const d1 = await fakeCtx._handler({ name: 'mcp__bili__video_view' }, nextAllow)
ok(d1.kind === 'deny', '原始 MCP 工具被拒')
ok(d1.reason === CONVERGE_REASON, '拒绝理由指向 bili 元工具')
const d2 = await fakeCtx._handler({ name: 'bili' }, nextAllow)
ok(d2.kind === 'allow', 'bili 元工具放行')
const d3 = await fakeCtx._handler({ name: 'remember' }, nextAllow)
ok(d3.kind === 'allow', '其它工具不受影响')

const fakeCtx2 = { logger: { info: () => {} }, on: () => {} }
applyBili(fakeCtx2, { converge: false, mcpPrefix: 'mcp__bili__' })
ok(fakeCtx2._handler === undefined, 'converge=false 时不注册拦截')

server.close()
console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
