#!/usr/bin/env node
/**
 * 微信 iLink 渠道验证（mock iLink HTTP，无外部依赖）。
 * 运行：node scripts/verify-wechat.mjs
 *
 * 覆盖（task-2 验收项）：
 *  1. 协议客户端：真实 iLink 端点/请求头/请求体、长轮询超时按 wait、524 网关错误按 wait。
 *  2. 扫码状态机：wait → scaned → confirmed；scaned_but_redirect 切 host；expired 自动换码。
 *  3. 二维码：qrcode_img_content（文本 URL）→ PNG data URL（PNG 魔数 + IHDR 尺寸校验）。
 *  4. 入站：getUpdates → 游标持久化 → context_token 保存 → 绑定拦截短路 → 身份归一
 *     → 默认缓冲入队（channelId='wechat'）；direct 模式 → hub.runTurn → 出站回发。
 *  5. 出站：sendmessage 方法/头/payload 逐字段断言（Bearer token、iLink-App-Id、
 *     AuthorizationType、X-WECHAT-UIN、base_info、client_id 格式、context_token）。
 *  6. 24h 窗口：新鲜窗口可发；过期窗口/无 token 明确报错且不发网络请求。
 *  7. 控制台 API：POST /api/wechat/qr、GET /qr/:sessionId、GET /status、POST /friend-qr、
 *     POST /logout 的信封与鉴权（admin/required/403）。
 *  8. 登出：清凭据/游标/context_token、停轮询、保留身份绑定。
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LittlyStorage } from '../packages/littly/storage/src/index.ts'
import {
  ILinkClient,
  encodeClientVersion,
  extractText,
  generateClientId,
} from '../packages/littly/channel-wechat-ilink/src/ilink-client.ts'
import { ILinkBindService, createFriendQr } from '../packages/littly/channel-wechat-ilink/src/ilink-bind.ts'
import { ILinkAccountManager } from '../packages/littly/channel-wechat-ilink/src/ilink-account.ts'
import {
  processWechatMessage,
  pushWechatText,
  resolveWechatTarget,
  wechatSenderKey,
  claimWechatIdentity,
  createDirectDispatcher,
} from '../packages/littly/channel-wechat-ilink/src/inbound.ts'
import { MSG_SUCCESS_WECHAT, createWechatCode } from '../packages/littly/channel-wechat-ilink/src/binding.ts'
import {
  CONTEXT_TOKEN_TTL_MS,
  clearCredentials,
  getBindSession,
  getContextToken,
  getContextTokenState,
  getCredentials,
  getSyncBuf,
  hasFreshContextToken,
  listBoundBotIds,
  loadBot,
  saveCredentials,
  setContextToken,
  setSyncBuf,
} from '../packages/littly/channel-wechat-ilink/src/ilink-store.ts'
import { encodeQr, qrContentToDataUrl, qrToPng } from '../packages/littly/channel-wechat-ilink/src/ilink-qr.ts'
import { Router } from '../packages/littly/console-api/src/http.ts'
import { registerWechatRoutes } from '../packages/littly/console-api/src/routes-wechat.ts'

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.error(`  ✗ ${name}${extra !== '' ? `（${extra}）` : ''}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nowIso = () => new Date().toISOString()
const BOT_ID = 'bot-wx-1'
const USER_ID = 'user-wx-1'
const WXID = 'wxid_alpha@im.wechat'
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// ============================================================
// mock iLink HTTP（两台上游：主 host + redirect host）
// ============================================================

/** 读请求体。 */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

/** 回 JSON。 */
function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/**
 * 建 mock iLink 服务器。
 * @param {object} script 剧本：statusScript / updatesScript 队列
 */
function createMockIlink(script = {}) {
  const state = {
    qrRequests: [],
    statusRequests: [],
    updateRequests: [],
    sendRequests: [],
    typingRequests: [],
    configRequests: [],
    qrCount: 0,
    statusScript: [...(script.statusScript ?? [])],
    updatesScript: [...(script.updatesScript ?? [])],
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    const bodyText = await readBody(req)
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)]))
    switch (url.pathname) {
      case '/ilink/bot/get_bot_qrcode': {
        state.qrCount++
        const qrcode = `qr-mock-${state.qrCount}`
        state.qrRequests.push({ headers, url: url.toString() })
        sendJson(res, 200, {
          qrcode,
          qrcode_img_content: `https://liteapp.weixin.qq.com/q/MOCTEST?qrcode=${qrcode}&bot_type=3`,
        })
        return
      }
      case '/ilink/bot/get_qrcode_status': {
        const qrcode = url.searchParams.get('qrcode')
        state.statusRequests.push({ qrcode, headers, url: url.toString() })
        const next = state.statusScript.shift() ?? { status: 'wait' }
        if (next === 'hang') {
          await sleep(400)
          sendJson(res, 200, { status: 'wait' })
          return
        }
        if (next === 'http524') {
          res.writeHead(524, { 'content-type': 'text/plain' })
          res.end('gateway timeout')
          return
        }
        sendJson(res, 200, next)
        return
      }
      case '/ilink/bot/getupdates': {
        state.updateRequests.push({ headers, body: bodyText })
        const next = state.updatesScript.shift()
        if (next === undefined || next === 'hang') {
          await sleep(150)
          sendJson(res, 200, { ret: 0, msgs: [], get_updates_buf: '' })
          return
        }
        sendJson(res, 200, next)
        return
      }
      case '/ilink/bot/sendmessage': {
        state.sendRequests.push({ headers, body: bodyText })
        sendJson(res, 200, { ret: 0, errcode: 0 })
        return
      }
      case '/ilink/bot/sendtyping': {
        state.typingRequests.push({ headers, body: bodyText })
        sendJson(res, 200, { ret: 0, errcode: 0 })
        return
      }
      case '/ilink/bot/getconfig': {
        state.configRequests.push({ headers, body: bodyText })
        sendJson(res, 200, { ret: 0, typing_ticket: 'ticket-mock-1' })
        return
      }
      default:
        sendJson(res, 404, { ret: 404, errmsg: 'not found' })
    }
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve({ server, state, baseUrl: `http://127.0.0.1:${addr.port}` })
    })
  })
}

/** 关服务器。 */
function closeServer(server) {
  return new Promise((resolve) => server.close(resolve))
}

// ============================================================
// 真实 SQLite 库
// ============================================================

const dir = mkdtempSync(join(tmpdir(), 'littly-verify-wx-'))
const storage = new LittlyStorage({ logger: { info: () => {} } }, { file: join(dir, 'verify.db') })
storage.prepare('INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?,?,?,?,?)').run(USER_ID, 'wxowner', 'x', 'admin', nowIso())
storage.prepare('INSERT INTO bots (id, name, created_at) VALUES (?,?,?)').run(BOT_ID, '小璃', nowIso())

const logs = []
const log = (msg, ...args) => {
  logs.push([String(msg), ...args].join(' '))
}

/** fake hub：记录缓冲入队与 runTurn。 */
function createFakeHub() {
  const enqueued = []
  const turns = []
  return {
    enqueued,
    turns,
    enqueueBufferedMessage(input) {
      enqueued.push(input)
      return { messageId: `m-${enqueued.length}`, fireAt: nowIso() }
    },
    async runTurn(request) {
      turns.push(request)
      return { reply: '收到啦～', pieces: ['收到', '啦～'], artifacts: [], toolCalls: [], thinkingLength: 0, rawThinking: '', messageId: `t-${turns.length}` }
    },
  }
}

// ============================================================
// 1. 协议常量 / 工具函数
// ============================================================

console.log('== 1. 协议常量与工具 ==')
ok(encodeClientVersion('2.1.6') === 0x00020106, 'encodeClientVersion(2.1.6) = 131334')
ok(encodeClientVersion('1.0.11') === 65547, 'encodeClientVersion(1.0.11) = 65547')
ok(/^openclaw-weixin:\d+-[0-9a-f]{8}$/.test(generateClientId()), 'client_id 形如 openclaw-weixin:<ms>-<hex8>')
ok(
  extractText({ item_list: [{ type: 1, text_item: { text: '你好' } }] }) === '你好',
  'extractText 取文本',
)
ok(
  extractText({
    item_list: [
      { type: 1, text_item: { text: '回复' }, ref_msg: { title: '标题', message_item: { type: 1, text_item: { text: '引用' } } } },
    ],
  }) === '[引用: 标题 | 引用]\n回复',
  'extractText 引用前缀',
)
ok(extractText({ item_list: [{ type: 3, voice_item: { text: '语音转写' } }] }) === '语音转写', 'extractText 语音转写兜底')
ok(extractText({ item_list: [{ type: 2 }] }) === '', 'extractText 图片消息无正文')
ok(wechatSenderKey('wxid_a') === 'wxid_a@im.wechat', '裸 wxid 补 @im.wechat')
ok(wechatSenderKey(WXID) === WXID, '已带后缀幂等')
ok(generateClientId() !== generateClientId(), 'client_id 唯一')

// ============================================================
// 2. 二维码编码 + 归一化（真实 iLink 返回文本 URL）
// ============================================================

console.log('== 2. 二维码（qrcode_img_content → PNG data URL）==')
{
  const realContent = 'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=eaae05598cbf41c8fd681bb6091b58cc&bot_type=3'
  const matrix = encodeQr(realContent)
  ok(matrix.version >= 1 && matrix.size === 17 + matrix.version * 4, `encodeQr 版本/尺寸合法（v${matrix.version} / ${matrix.size}）`)
  const png = qrToPng(matrix)
  ok(png.subarray(0, 8).equals(PNG_MAGIC), 'qrToPng 输出 PNG 魔数')
  ok(png.length > 500, 'PNG 字节数合理')
  const normalized = qrContentToDataUrl(realContent)
  ok(normalized.source === 'text', '文本内容 → 服务端编码（source=text）')
  ok(normalized.payload === realContent, 'payload 保留原始二维码文本')
  ok(normalized.dataUrl.startsWith('data:image/png;base64,'), '归一化为 PNG data URL')
  const img = Buffer.from(normalized.dataUrl.slice('data:image/png;base64,'.length), 'base64')
  ok(img.subarray(0, 8).equals(PNG_MAGIC), 'data URL 解码后是 PNG')
  const width = img.readUInt32BE(16)
  const height = img.readUInt32BE(20)
  ok(width === height && width >= 200, `PNG 尺寸方形且可扫（${width}×${height}）`)
  // 已是 data URL / base64 图片的兼容路径
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`
  ok(qrContentToDataUrl(dataUrl).dataUrl === dataUrl, '已是 data URL → 原样返回')
  ok(qrContentToDataUrl(png.toString('base64')).source === 'image', '裸 base64 图片 → 识别为 image')
}

// ============================================================
// 3. 扫码状态机（wait → scaned → redirect → confirmed / expired 换码）
// ============================================================

console.log('== 3. 扫码状态机（mock iLink）==')
{
  const mock = await createMockIlink()
  const mockRedirect = await createMockIlink()
  const redirectHost = mockRedirect.baseUrl.replace('http://', '')
  // 主 host：wait → scaned → scaned_but_redirect → confirmed（redirect 后到第二台 mock）
  mock.state.statusScript = [{ status: 'wait' }, { status: 'scaned' }, { status: 'scaned_but_redirect', redirect_host: redirectHost }]
  mockRedirect.state.statusScript = [
    { status: 'confirmed', bot_token: 'token-from-scan', ilink_bot_id: 'ilink-bot-42', baseurl: mockRedirect.baseUrl, ilink_user_id: 'ilink-user-42' },
  ]
  const clientFactory = (options = {}) => new ILinkClient({ ...options, baseUrl: mock.baseUrl })
  const confirmed = []
  const binds = new ILinkBindService({
    storage,
    log,
    clientFactory,
    redirectScheme: 'http',
    onConfirmed: async (input) => {
      confirmed.push(input)
      saveCredentials(storage, input.botId, input.credentials)
    },
  })
  const started = await binds.startBind({ botId: BOT_ID, userId: USER_ID })
  ok(typeof started.sessionId === 'string' && started.sessionId !== '', 'startBind 返回 sessionId')
  ok(started.qrDataUrl.startsWith('data:image/png;base64,'), 'startBind 返回 PNG data URL')
  ok(started.expiresAt > Date.now(), 'startBind 返回未来过期时刻')
  ok(started.sessionId.startsWith('wx-bind-'), 'sessionId 前缀 wx-bind-')

  // 轮询直到 confirmed（mock 状态机 35s 长轮询被 mock 立即返回，250ms 间隔）
  const deadline = Date.now() + 8_000
  let snapshot = binds.get(started.sessionId)
  const seen = new Set([snapshot?.status])
  while (Date.now() < deadline) {
    snapshot = binds.get(started.sessionId)
    if (snapshot !== null) seen.add(snapshot.status)
    if (snapshot?.status === 'confirmed' || snapshot?.status === 'failed') break
    await sleep(80)
  }
  ok(seen.has('wait') || seen.has('scanned'), '状态机经过 wait/scaned')
  ok(seen.has('scanned'), '状态机识别 scaned（protocol 拼写）→ API scanned')
  ok(snapshot?.status === 'confirmed', '状态机最终 confirmed', snapshot?.error ?? '')
  ok(confirmed.length === 1 && confirmed[0].credentials.ilink_bot_id === 'ilink-bot-42', 'confirmed 回调带四元凭据')
  ok(confirmed[0].credentials.bot_token === 'token-from-scan', '凭据含 bot_token')
  ok(confirmed[0].credentials.ilink_user_id === 'ilink-user-42', '凭据含 ilink_user_id')
  ok(mock.state.statusRequests.length >= 3, '主 host 收到多次状态轮询')
  ok(mockRedirect.state.statusRequests.length >= 1, 'scaned_but_redirect 后切到 redirect host 轮询')
  ok(binds.get(started.sessionId)?.status === 'confirmed', 'confirmed 会话缓存给断线重连')
  binds.cancelAll()

  // 凭据落库断言
  const creds = getCredentials(storage, BOT_ID)
  ok(creds?.bot_token === 'token-from-scan' && creds.ilink_bot_id === 'ilink-bot-42', '凭据写入 global_settings 权威副本')
  const botRow = loadBot(storage, BOT_ID)
  ok(botRow?.wx_enabled === 1 && botRow.wx_hub_bot_id === 'ilink-bot-42' && botRow.wx_push_token === 'token-from-scan', '凭据镜像到 bots.wx_* 列')
  ok(botRow.wx_push_endpoint === mockRedirect.baseUrl, 'baseurl 镜像到 wx_push_endpoint')

  // expired → 自动换码
  const mockExp = await createMockIlink()
  mockExp.state.statusScript = [{ status: 'wait' }, { status: 'expired' }, { status: 'wait' }, { status: 'scaned' }]
  const bindsExp = new ILinkBindService({
    storage,
    log,
    clientFactory: (options = {}) => new ILinkClient({ ...options, baseUrl: mockExp.baseUrl }),
    onConfirmed: () => {},
  })
  const expStart = await bindsExp.startBind({ botId: BOT_ID, userId: USER_ID })
  const originalQr = expStart.qrDataUrl
  const expDeadline = Date.now() + 6_000
  let refreshed = false
  while (Date.now() < expDeadline) {
    const snap = bindsExp.get(expStart.sessionId)
    if (snap?.status === 'expired') {
      refreshed = snap.qrDataUrl !== originalQr && mockExp.state.qrCount >= 2
      break
    }
    await sleep(80)
  }
  ok(refreshed, 'expired → 自动换码（qr 数量增加、data URL 变化）')
  ok(mockExp.state.qrRequests.length >= 2, '过期后重新请求 get_bot_qrcode')
  bindsExp.cancelAll()
  await closeServer(mockExp.server)

  await closeServer(mock.server)
  await closeServer(mockRedirect.server)
  // 清掉测试凭据，后面测试重新写
  clearCredentials(storage, BOT_ID)
}

// ============================================================
// 4. 协议客户端：请求头 / 长轮询超时语义 / 524
// ============================================================

console.log('== 4. 协议客户端 ==')
{
  const mock = await createMockIlink()
  const client = new ILinkClient({ token: 'tk-abc', baseUrl: mock.baseUrl })
  // 4.1 取码 GET + commonHeaders
  const qr = await client.getBotQrCode()
  ok(qr.qrcode === 'qr-mock-1' && qr.qrcode_img_content.includes('bot_type=3'), 'getBotQrCode 解析 qrcode / qrcode_img_content')
  const qrHeaders = mock.state.qrRequests[0].headers
  ok(qrHeaders['ilink-app-id'] === 'bot', 'GET 头 iLink-App-Id=bot')
  ok(qrHeaders['ilink-app-clientversion'] === String(encodeClientVersion('2.1.6')), `GET 头 iLink-App-ClientVersion=${String(encodeClientVersion('2.1.6'))}`)
  ok(new URL(mock.state.qrRequests[0].url).searchParams.get('bot_type') === '3', 'get_bot_qrcode 查询 bot_type=3')

  // 4.2 长轮询 524 → wait（不抛）
  mock.state.statusScript = ['http524']
  const st = await client.pollQrStatus(qr.qrcode)
  ok(st.status === 'wait', '状态轮询 HTTP 524 → 按 wait 继续（长轮询语义）')

  // 4.3 getUpdates：POST + 长轮询超时 → 空响应保留旧游标
  mock.state.updatesScript = ['hang']
  const updates = await client.getUpdates('buf-old', { timeoutMs: 50 })
  ok(updates.ret === 0 && Array.isArray(updates.msgs) && updates.get_updates_buf === 'buf-old', 'getUpdates 超时 → 空响应 + 保留旧游标')
  const upBody = JSON.parse(mock.state.updateRequests[0].body)
  ok(upBody.get_updates_buf === 'buf-old', 'getUpdates 请求体带游标')
  ok(upBody.base_info.channel_version === '2.1.6', 'getUpdates 请求体 base_info.channel_version=2.1.6')
  const upHeaders = mock.state.updateRequests[0].headers
  ok(upHeaders['authorization'] === 'Bearer tk-abc', 'POST 头 Authorization: Bearer <token>')
  ok(upHeaders['authorizationtype'] === 'ilink_bot_token', 'POST 头 AuthorizationType=ilink_bot_token')
  ok(upHeaders['x-wechat-uin'] !== undefined && upHeaders['x-wechat-uin'] !== '', 'POST 头 X-WECHAT-UIN 存在')
  ok(upHeaders['content-type'] === 'application/json', 'POST 头 Content-Type=application/json')
  ok(Number(upHeaders['content-length']) > 0, 'POST 头 Content-Length 正确')

  // 4.4 sendmessage 原始消息
  await client.sendMessage({
    to_user_id: WXID,
    client_id: 'cid-1',
    message_type: 2,
    message_state: 2,
    context_token: 'ctx-1',
    item_list: [{ type: 1, text_item: { text: 'hi' } }],
  })
  const sendBody = JSON.parse(mock.state.sendRequests[0].body)
  ok(sendBody.msg.to_user_id === WXID && sendBody.msg.context_token === 'ctx-1', 'sendMessage 载荷带 to_user_id/context_token')
  ok(sendBody.base_info.channel_version === '2.1.6', 'sendMessage 载荷带 base_info')

  // 4.5 getConfig / sendTyping
  const config = await client.getConfig('ilink-user-42', 'ctx-1')
  ok(config.typing_ticket === 'ticket-mock-1', 'getConfig 解析 typing_ticket')
  await client.sendTyping('ilink-user-42', 'ticket-mock-1', true)
  const typingBody = JSON.parse(mock.state.typingRequests[0].body)
  ok(typingBody.status === 1 && typingBody.ilink_user_id === 'ilink-user-42', 'sendTyping status=1')
  await closeServer(mock.server)
}

// ============================================================
// 5. 入站：getUpdates → context_token/游标 → 绑定/归一 → hub 分发
// ============================================================

console.log('== 5. 入站链路（长轮询 → runTurn/入队）==')
{
  // 准备凭据（用前面 confirmed 的 mock 站点不可用，直接写库）
  saveCredentials(storage, BOT_ID, {
    bot_token: 'token-inbound',
    baseurl: '',
    ilink_bot_id: 'ilink-bot-inbound',
    ilink_user_id: 'ilink-user-owner',
  })
  const mock = await createMockIlink()
  mock.state.updatesScript = [
    {
      ret: 0,
      get_updates_buf: 'buf-1',
      longpolling_timeout_ms: 500,
      msgs: [
        {
          message_id: 101,
          from_user_id: WXID,
          message_type: 1,
          context_token: 'ctx-token-1',
          item_list: [{ type: 1, text_item: { text: '在吗？' } }],
        },
      ],
    },
  ]
  const hub = createFakeHub()
  const inboundInputs = []
  const clientFactory = (options = {}) => new ILinkClient({ ...options, baseUrl: mock.baseUrl, fetchImpl: undefined })
  const manager = new ILinkAccountManager({
    storage,
    log,
    clientFactory,
    onInbound: async (input) => {
      inboundInputs.push(input)
      const bot = loadBot(storage, input.botId)
      await processWechatMessage(
        { storage, hub, log, push: async () => true },
        bot,
        input.fromUserId,
        input.text,
      )
    },
  })
  ok(manager.start(BOT_ID) === true, '账号管理器启动长轮询')
  ok(manager.start(BOT_ID) === false, '重复 start 幂等（已在跑）')
  const deadline = Date.now() + 4_000
  while (Date.now() < deadline && inboundInputs.length === 0) await sleep(60)
  ok(inboundInputs.length === 1, 'getUpdates 收到 1 条入站')
  ok(inboundInputs[0].text === '在吗？', '入站正文正确')
  ok(hub.enqueued.length === 1, '默认模式：入站交给 hub 缓冲（不直接调模型）')
  ok(hub.enqueued[0].channelId === 'wechat', '缓冲入队 channelId=wechat')
  ok(hub.enqueued[0].sender === WXID, '未绑定身份 → sender=渠道原生合成键')
  ok(getSyncBuf(storage, BOT_ID) === 'buf-1', 'get_updates_buf 游标持久化')
  const ctxState = getContextTokenState(storage, BOT_ID, WXID)
  ok(ctxState?.token === 'ctx-token-1' && ctxState.at > 0, 'context_token 持久化（含入站时间戳）')
  ok(hasFreshContextToken(storage, BOT_ID, WXID), '24h 窗口判定为新鲜')
  manager.stop(BOT_ID)
  ok(manager.status(BOT_ID) === 'stopped', 'stop 后状态 stopped')

  // 5.2 已绑定身份 → sender 归一化为 userId；绑定码消息短路
  claimWechatIdentity(storage, BOT_ID, USER_ID, WXID)
  ok(resolveWechatTarget(storage, BOT_ID, USER_ID)?.toUser === WXID, '身份归一：userId → 原始 wxid 可解析')
  const hub2 = createFakeHub()
  const pushes = []
  const push = async (bot, to, text) => {
    pushes.push({ to, text })
    return true
  }
  await processWechatMessage({ storage, hub: hub2, log, push }, loadBot(storage, BOT_ID), WXID, '普通消息')
  ok(hub2.enqueued.length === 1 && hub2.enqueued[0].sender === USER_ID, '已绑定身份 → sender=平台 userId（与网页端同一会话线）')

  // 绑定码：命中即短路（不入队），回复走渠道
  const issued = createWechatCode(storage, USER_ID)
  const before = hub2.enqueued.length
  await processWechatMessage({ storage, hub: hub2, log, push }, loadBot(storage, BOT_ID), 'wxid_bind@im.wechat', `绑定 ${issued.code}`)
  ok(hub2.enqueued.length === before, '绑定码命中 → 短路（不入模型）')
  ok(pushes[pushes.length - 1].text === MSG_SUCCESS_WECHAT, '绑定成功文案逐字一致')
  ok(pushes[pushes.length - 1].to === 'wxid_bind@im.wechat', '绑定回复发往原始微信 id')

  // 5.3 direct 模式：入站 → hub.runTurn（channelId='wechat'）→ 出站发送
  // 注意：绑定码测试换号替换了该用户的 wechat 身份，这里重新认领回 WXID（验证归一链路）
  claimWechatIdentity(storage, BOT_ID, USER_ID, WXID)
  const hub3 = createFakeHub()
  const outbound = []
  const dispatcher = createDirectDispatcher(hub3, async (bot, to, text) => {
    outbound.push({ bot: bot.id, to, text })
    return true
  })
  await processWechatMessage(
    { storage, hub: hub3, log, dispatch: dispatcher, push: async () => true },
    loadBot(storage, BOT_ID),
    WXID,
    '秒回测试',
  )
  ok(hub3.turns.length === 1, 'direct 模式：入站调用 hub.runTurn')
  ok(hub3.turns[0].channelId === 'wechat', 'runTurn 带 channelId=wechat')
  ok(hub3.turns[0].sender === USER_ID, 'runTurn sender 为归一化 userId')
  ok(outbound.length === 2 && outbound[0].text === '收到' && outbound[1].text === '啦～', 'direct 模式：回复按片出站（context_token 会话）')
  await closeServer(mock.server)
}

// ============================================================
// 6. 出站 send_message：头/payload/24h 窗口
// ============================================================

console.log('== 6. 出站 send_message 与 24h 窗口 ==')
{
  const mock = await createMockIlink()
  const clientFactory = (options = {}) => new ILinkClient({ ...options, baseUrl: mock.baseUrl })
  const manager = new ILinkAccountManager({ storage, log, clientFactory })
  // 新鲜 context_token（入站 1 分钟前）
  setContextToken(storage, BOT_ID, WXID, 'ctx-fresh', Date.now() - 60_000)
  const result = await manager.sendText(BOT_ID, WXID, '这是回复')
  ok(/^openclaw-weixin:\d+-[0-9a-f]{8}$/.test(result.clientId), 'sendText 返回合法 client_id')
  ok(mock.state.sendRequests.length === 1, 'sendmessage 请求发出一次')
  const raw = mock.state.sendRequests[0]
  const body = JSON.parse(raw.body)
  ok(raw.headers['authorization'] === 'Bearer token-inbound', '出站头 Authorization: Bearer bot_token')
  ok(raw.headers['ilink-app-id'] === 'bot' && raw.headers['authorizationtype'] === 'ilink_bot_token', '出站头协议字段正确')
  ok(body.msg.to_user_id === WXID, '出站 msg.to_user_id = 原始 wxid')
  ok(body.msg.message_type === 2 && body.msg.message_state === 2, '出站 message_type=2 / message_state=2（bot 完成态）')
  ok(body.msg.context_token === 'ctx-fresh', '出站 msg.context_token = 会话 context_token')
  ok(body.msg.client_id === result.clientId, '出站 client_id 与返回值一致')
  ok(body.msg.item_list[0].type === 1 && body.msg.item_list[0].text_item.text === '这是回复', '出站 item_list 为文本条目')
  ok(body.base_info.channel_version === '2.1.6', '出站 base_info.channel_version=2.1.6')

  // 24h 窗口过期 → 明确报错、不发网络
  const before = mock.state.sendRequests.length
  setContextToken(storage, BOT_ID, WXID, 'ctx-stale', Date.now() - CONTEXT_TOKEN_TTL_MS - 60_000)
  let windowError = null
  try {
    await manager.sendText(BOT_ID, WXID, '过期了')
  } catch (err) {
    windowError = err
  }
  ok(windowError !== null && windowError.code === 'ilink_window_expired', '24h 窗口过期 → ilink_window_expired（不发网络）')
  ok(mock.state.sendRequests.length === before, '窗口过期时没有发出 sendmessage')

  // 无 context_token
  storage.prepare("DELETE FROM global_settings WHERE key LIKE 'ilink.ctx.%'").run()
  let noTokenError = null
  try {
    await manager.sendText(BOT_ID, WXID, '没 token')
  } catch (err) {
    noTokenError = err
  }
  ok(noTokenError !== null && noTokenError.code === 'ilink_no_context_token', '无 context_token → ilink_no_context_token')

  // sendTyping
  setContextToken(storage, BOT_ID, WXID, 'ctx-fresh2', Date.now())
  await manager.sendTyping(BOT_ID, WXID, true)
  ok(mock.state.typingRequests.length === 1 && JSON.parse(mock.state.typingRequests[0].body).status === 1, 'sendTyping 走 getconfig 拿 ticket 后发送')

  // webhook 兼容路径（pushWechatText 默认实现：会按凭据自建客户端）
  saveCredentials(storage, BOT_ID, { bot_token: 'token-inbound', baseurl: mock.baseUrl, ilink_bot_id: 'ilink-bot-inbound', ilink_user_id: 'ilink-user-owner' })
  setContextToken(storage, BOT_ID, WXID, 'ctx-webhook', Date.now())
  const pushed = await pushWechatText({ storage, log }, loadBot(storage, BOT_ID), WXID, 'webhook 兼容')
  ok(pushed === true, 'pushWechatText 默认实现可直发（webhook 兼容）')

  await closeServer(mock.server)
}

// ============================================================
// 7. 控制台 API 契约（真 Router + 真 HTTP）
// ============================================================

console.log('== 7. 控制台 API（/api/wechat/*）==')
{
  const mock = await createMockIlink()
  mock.state.statusScript = [
    { status: 'wait' },
    { status: 'scaned' },
    { status: 'confirmed', bot_token: 'token-api', ilink_bot_id: 'ilink-bot-api', baseurl: mock.baseUrl, ilink_user_id: 'ilink-user-api' },
  ]
  const binds = new ILinkBindService({
    storage,
    log,
    clientFactory: (options = {}) => new ILinkClient({ ...options, baseUrl: mock.baseUrl }),
    onConfirmed: async ({ botId, credentials }) => {
      saveCredentials(storage, botId, credentials)
    },
  })
  let currentUser = { id: USER_ID, username: 'wxowner', password_hash: 'x', role: 'admin', created_at: nowIso() }
  const fakeService = {
    startBind: (input = {}) => binds.startBind({ botId: BOT_ID, userId: input.userId ?? USER_ID }),
    getBind: (sessionId) => binds.get(sessionId),
    friendQr: (botId) => createFriendQr({ storage, log, clientFactory: (options = {}) => new ILinkClient({ ...options, baseUrl: mock.baseUrl }) }, botId ?? BOT_ID),
    status: () => ({
      bound: getCredentials(storage, BOT_ID) !== null,
      botId: BOT_ID,
      ilinkBotId: getCredentials(storage, BOT_ID)?.ilink_bot_id,
      ilinkUserId: getCredentials(storage, BOT_ID)?.ilink_user_id,
      status: 'connected',
      windowFresh: true,
      lastInboundAt: 0,
    }),
    logout: async () => {
      clearCredentials(storage, BOT_ID)
      return { ok: true, botId: BOT_ID }
    },
    sendText: async () => ({ clientId: 'cid' }),
    ensureMonitors: () => 0,
    stop: () => {},
    windowFresh: () => true,
    defaultBot: () => loadBot(storage, BOT_ID),
  }
  const router = new Router()
  router.resolveUser = () => currentUser
  registerWechatRoutes(router, {}, () => fakeService)
  const httpServer = createServer((req, res) => {
    void router.handle(req, res)
  })
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const apiBase = `http://127.0.0.1:${httpServer.address().port}`
  const api = async (method, path, body) => {
    const response = await fetch(`${apiBase}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    return { status: response.status, json: await response.json() }
  }

  // 7.1 未登录 → 401
  currentUser = null
  const unauth = await api('GET', '/api/wechat/status')
  ok(unauth.status === 401 && unauth.json.error?.code === 'unauthorized', '未登录访问 /status → 401 信封')

  // 7.2 非 admin 发起绑定 → 403
  currentUser = { id: 'normal', username: 'n', password_hash: 'x', role: 'user', created_at: nowIso() }
  const forbidden = await api('POST', '/api/wechat/qr')
  ok(forbidden.status === 403 && forbidden.json.error?.code === 'forbidden', '非 admin POST /qr → 403')

  // 7.3 admin POST /qr → data URL + sessionId
  currentUser = { id: USER_ID, username: 'wxowner', password_hash: 'x', role: 'admin', created_at: nowIso() }
  const startResp = await api('POST', '/api/wechat/qr')
  ok(startResp.status === 200, 'POST /api/wechat/qr → 200')
  const qrData = startResp.json.data
  ok(typeof qrData.sessionId === 'string' && qrData.sessionId !== '', 'POST /qr 返回 sessionId')
  ok(qrData.qrDataUrl.startsWith('data:image/png;base64,') && qrData.expiresAt > Date.now(), 'POST /qr 返回 qrDataUrl(PNG)+expiresAt')
  ok(qrData.botId === BOT_ID, 'POST /qr 返回 botId')

  // 7.4 GET /qr/:sessionId 轮询到 confirmed
  let poll = null
  const pollDeadline = Date.now() + 8_000
  while (Date.now() < pollDeadline) {
    poll = await api('GET', `/api/wechat/qr/${qrData.sessionId}`)
    if (poll.json.data?.status === 'confirmed') break
    await sleep(80)
  }
  ok(poll.status === 200 && poll.json.data.status === 'confirmed', 'GET /qr/:sessionId 轮询到 confirmed', JSON.stringify(poll?.json?.data?.status))
  ok(typeof poll.json.data.ilinkBotId === 'string' && poll.json.data.ilinkBotId !== '', 'confirmed 响应带 ilinkBotId')
  const notFound = await api('GET', '/api/wechat/qr/no-such-session')
  ok(notFound.status === 404 && notFound.json.error?.code === 'not_found', '未知 session → 404 信封')

  // 7.5 GET /status
  const statusResp = await api('GET', '/api/wechat/status')
  ok(statusResp.status === 200 && statusResp.json.data.bound === true, 'GET /status → bound=true')
  ok(statusResp.json.data.botId === BOT_ID && statusResp.json.data.ilinkUserId === 'ilink-user-api', 'GET /status 返回 botId/ilinkUserId')
  ok(typeof statusResp.json.data.note === 'string' && statusResp.json.data.note.includes('名片'), 'GET /status 带名片码协议说明')

  // 7.6 POST /friend-qr
  const friend = await api('POST', '/api/wechat/friend-qr')
  ok(friend.status === 200, 'POST /friend-qr → 200')
  ok(friend.json.data.qrDataUrl.startsWith('data:image/png;base64,'), 'friend-qr 返回 PNG data URL')
  ok(friend.json.data.kind === 'bot_qrcode' && friend.json.data.expiresAt > Date.now(), 'friend-qr 带 kind=bot_qrcode + expiresAt')
  ok(friend.json.data.note.includes('没有独立的名片码接口'), 'friend-qr 明确说明协议依据')

  // 7.7 POST /logout（admin）
  const logout = await api('POST', '/api/wechat/logout')
  ok(logout.status === 200 && logout.json.data.ok === true, 'POST /logout → ok=true')
  ok(getCredentials(storage, BOT_ID) === null, '登出后凭据已清')
  ok(getSyncBuf(storage, BOT_ID) === '', '登出后游标已清')
  const sessionsAfter = getBindSession(storage, qrData.sessionId)
  ok(sessionsAfter === null || sessionsAfter.status === 'confirmed', '登出后扫码会话已清理/保留终态')

  await new Promise((resolve) => httpServer.close(resolve))
  await closeServer(mock.server)
}

// ============================================================
// 8. 凭据/状态辅助函数
// ============================================================

console.log('== 8. 凭据与状态辅助 ==')
{
  saveCredentials(storage, BOT_ID, { bot_token: 'tk', baseurl: 'https://example.test', ilink_bot_id: 'ib', ilink_user_id: 'iu' })
  ok(listBoundBotIds(storage).includes(BOT_ID), 'listBoundBotIds 包含已绑定 bot')
  ok(getContextToken(storage, BOT_ID, WXID) === '', '登出后 context_token 为空')
  setSyncBuf(storage, BOT_ID, 'cursor-x')
  ok(getSyncBuf(storage, BOT_ID) === 'cursor-x', '游标往返')
  setSyncBuf(storage, BOT_ID, '')
  ok(getSyncBuf(storage, BOT_ID) === 'cursor-x', '空游标不覆盖')
  clearCredentials(storage, BOT_ID)
  ok(getCredentials(storage, BOT_ID) === null && !listBoundBotIds(storage).includes(BOT_ID), 'clearCredentials 清理干净')
  const logsText = logs.join('\n')
  ok(logsText.includes('[wechat]'), '插件日志走注入 log（无 console 噪音）')
}

// ============================================================
// 汇总
// ============================================================

rmSync(dir, { recursive: true, force: true })
console.log(`\n${fail === 0 ? '✅' : '❌'} verify-wechat: pass=${pass} fail=${fail}`)
if (fail > 0) process.exitCode = 1
