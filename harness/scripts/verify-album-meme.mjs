#!/usr/bin/env node
/**
 * 相册语义化 + `meme:<短哈希>` 选图协议行为验证。
 * 运行：node scripts/verify-album-meme.mjs
 *
 * 全程 in-process：临时 SQLite + 本地 mock OpenAI 兼容视觉端点 + 可注入 fake 视觉函数，
 * 不访问外网。覆盖：schema 迁移/幂等、sha256 去重、meme 稳定唯一、view_album 过滤、
 * send_photo meme 协议、语义分析成功/失败隔离与状态流转。
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LittlyStorage,
  assignMemeIds,
  photoMemeBase,
} from '../packages/littly/storage/src/index.ts'
// tools 的 Registry 用了 TS parameter property（Node strip-only 不支持），走构建后的包。
import { createToolRegistry } from '../packages/littly/tools/lib/index.js'
import { Router } from '../packages/littly/console-api/src/http.ts'
import { registerDataRoutes } from '../packages/littly/console-api/src/routes-data.ts'
import { analyzePhotos, parseSemanticPayload } from '../packages/littly/console-api/src/photos-semantic.ts'

let pass = 0
let fail = 0
const ok = (cond, name, detail) => {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    console.error(`  ✗ ${name}${detail === undefined ? '' : `  → ${detail}`}`)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'littly-album-meme-'))
process.env['LITTLY_DATA_DIR'] = join(dir, 'data')
const dbFile = join(dir, 'album.db')
const fakeCtx = { logger: { info: () => {} } }
let storage = new LittlyStorage(fakeCtx, { file: dbFile })
const nowIso = new Date().toISOString()

function tableColumns(target) {
  return target.prepare('PRAGMA table_info(photos)').all().map((row) => row.name)
}

// ---------- 1. schema / 迁移幂等 ----------

console.log('== schema 迁移 ==')
const expectedColumns = ['sha256', 'mime', 'category', 'semantic_status', 'semantic_at', 'semantic_error']
let columns = tableColumns(storage)
ok(expectedColumns.every((name) => columns.includes(name)), 'photos 六列齐备')
const indexes = storage.prepare('PRAGMA index_list(photos)').all()
ok(indexes.some((row) => row.name === 'idx_photos_bot_sha'), '(bot_id, sha256) 索引已建')
ok(storage.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v === 3, '迁移版本 = 3')

const defaults = storage.prepare("SELECT * FROM photos LIMIT 1").get()
ok(defaults === undefined, '空库读取不报错')

storage.close()
storage = new LittlyStorage(fakeCtx, { file: dbFile })
columns = tableColumns(storage)
ok(expectedColumns.every((name) => columns.includes(name)), '重开同一库：迁移幂等、列仍在')
ok(storage.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get().c === 3, '迁移记录不重复')

// ---------- 2. meme 纯函数 ----------

console.log('== meme 短 id ==')
const shaA = '0123456789ab' + '1'.repeat(52)
const shaB = '0123456789ab' + '2'.repeat(52)
const collisionRows = [
  { id: 'row-a', sha256: shaA },
  { id: 'row-b', sha256: shaB },
]
const collisionMap = assignMemeIds(collisionRows)
ok(collisionMap.get('row-a') !== collisionMap.get('row-b'), '12 位前缀碰撞 → meme 唯一')
ok([...collisionMap.values()].some((meme) => meme.length > 12), '碰撞时自动加长前缀')
ok(
  JSON.stringify([...assignMemeIds([...collisionRows].reverse()).entries()]) === JSON.stringify([...collisionMap.entries()]),
  'meme 分配与输入顺序无关（稳定）',
)

const duplicateSha = 'f'.repeat(64)
const dupMap = assignMemeIds([
  { id: 'aaaaaaaa-1111-4111-8111-111111111111', sha256: duplicateSha },
  { id: 'bbbbbbbb-2222-4222-8222-222222222222', sha256: duplicateSha },
])
ok(dupMap.get('aaaaaaaa-1111-4111-8111-111111111111') !== dupMap.get('bbbbbbbb-2222-4222-8222-222222222222'), '历史重复 sha 仍分配不同 meme')

const uuid = '123e4567-e89b-42d3-a456-426614174000'
const legacyMap = assignMemeIds([{ id: uuid, sha256: '' }])
ok(legacyMap.get(uuid) === uuid.slice(0, 12), '空 sha256 → id 前 12')
ok(photoMemeBase({ id: uuid, sha256: shaA }) === shaA.slice(0, 64), '有 sha256 时优先 sha256')

// ---------- 3. 测试夹具 / 路由 ----------

console.log('== 上传去重 / 接口 view ==')
for (const [id, name] of [['b1', '小璃'], ['b2', '阿雾'], ['b3', '小满'], ['b4', '无视觉'], ['b5', '注入']]) {
  storage.prepare('INSERT INTO bots (id, name, created_at) VALUES (?,?,?)').run(id, name, nowIso)
}

function insertPhoto(input) {
  storage
    .prepare(
      'INSERT INTO photos (id, bot_id, url, caption, tags, sha256, mime, category, semantic_status, semantic_at, semantic_error, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      input.id,
      input.botId ?? 'b1',
      input.url ?? `/api/photos/file/photos/${input.id}.png`,
      input.caption ?? '',
      JSON.stringify(input.tags ?? []),
      input.sha256 ?? '',
      input.mime ?? 'image/png',
      input.category ?? '',
      input.semanticStatus ?? 'none',
      input.semanticAt ?? null,
      input.semanticError ?? '',
      input.createdAt ?? nowIso,
    )
}

const deps = {
  storage,
  persona: { loadBot: (id) => storage.prepare('SELECT * FROM bots WHERE id = ?').get(id) ?? null },
  memory: {},
  hub: {},
  growth: {},
  mcp: {},
  sessions: {},
  cwd: dir,
  log: () => {},
}
const admin = { id: 'u-admin', username: 'admin', password_hash: 'x', role: 'admin', created_at: nowIso }
let currentUser = admin
const router = new Router()
router.resolveUser = () => currentUser
registerDataRoutes(router, deps)
const server = createServer((req, res) => {
  router.handle(req, res).catch((error) => {
    console.error('[verify] request failed:', error)
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

async function api(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, json: await response.json() }
}

async function upload(botId, bytes, filename = 'photo.png', type = 'image/png') {
  const form = new FormData()
  form.append('file', new Blob([bytes], { type }), filename)
  const response = await fetch(`${base}/api/photos?botId=${encodeURIComponent(botId)}`, { method: 'POST', body: form })
  return { status: response.status, json: await response.json() }
}

const bytesA = Buffer.from('fake-png-content-A')
const bytesB = Buffer.from('fake-png-content-B')
const shaAFile = createHash('sha256').update(bytesA).digest('hex')

const uploadA = await upload('b1', bytesA, 'sea.png')
ok(uploadA.status === 200 && uploadA.json.data.photo.sha256 === shaAFile, '上传后落 sha256')
ok(uploadA.json.data.photo.mime === 'image/png', '上传后落 mime')
ok(uploadA.json.data.deduplicated === false, '首次上传标记 deduplicated=false')
ok(uploadA.json.data.photo.meme === shaAFile.slice(0, 12), '上传响应带 sha 前 12 meme')
ok(uploadA.json.data.photo.semanticStatus === 'none', '未配置视觉 → semantic_status=none')

const uploadA2 = await upload('b1', bytesA, 'copy.png')
ok(uploadA2.status === 200 && uploadA2.json.data.photo.id === uploadA.json.data.photo.id, '同文件二次上传返回同 id')
ok(uploadA2.json.data.deduplicated === true, '同文件二次上传不重复入库')
ok(
  storage.prepare('SELECT COUNT(*) AS c FROM photos WHERE bot_id = ? AND sha256 = ?').get('b1', shaAFile).c === 1,
  '同 bot 同 sha256 只有一条记录',
)
ok(
  readdirSync(join(dir, 'data', 'downloads', 'photos')).length === 1,
  '去重上传不重复写文件',
)

const uploadB = await upload('b1', bytesB, 'other.png')
ok(uploadB.json.data.photo.id !== uploadA.json.data.photo.id, '不同文件 → 不同照片 id')
ok(uploadB.json.data.photo.meme !== uploadA.json.data.photo.meme, '不同文件 → 不同 meme')

insertPhoto({ id: uuid, botId: 'b1', caption: '老照片（无指纹）', createdAt: '2025-01-01T00:00:00.000Z' })
const listB1 = await api('GET', '/api/photos?botId=b1')
const listedLegacy = listB1.json.data.photos.find((photo) => photo.id === uuid)
ok(listedLegacy !== undefined && listedLegacy.meme === uuid.slice(0, 12), '接口 photoView 给老照片补 meme')
ok(listedLegacy.semanticStatus === 'none' && listedLegacy.category === '', '接口 photoView 带语义字段默认值')

// ---------- 4. view_album / send_photo / tag_photo ----------

console.log('== view_album 检索 ==')
for (let i = 0; i < 25; i += 1) {
  const tags = i === 0 ? ['海边', '日落'] : i === 1 ? ['猫', '可爱'] : ['日常']
  const caption = i === 0 ? '海边日落' : i === 1 ? '猫咪打哈欠' : `日常照片${i}`
  const category = i === 0 ? '开心' : i === 1 ? '可爱' : '日常'
  insertPhoto({
    id: `seed-${String(i).padStart(3, '0')}`,
    botId: 'b2',
    caption,
    tags,
    category,
    sha256: createHash('sha256').update(`seed-${i}`).digest('hex'),
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  })
}

const bridgeCalls = []
const bridge = {
  sendText: async () => ({ ok: true }),
  sendPhoto: async (channel, botId, sender, url, caption) => {
    bridgeCalls.push({ channel, botId, sender, url, caption })
    return { ok: true }
  },
  callAction: async () => null,
  photoPublicUrl: (url) => `https://cdn.test${url}`,
  startCall: async () => ({ ok: true }),
}
const tools = createToolRegistry(storage, {}, bridge, dir)
const ctxB2 = { botId: 'b2', sender: 'u1', botName: '阿雾', channelId: 'web' }
async function callTool(name, args, ctx = ctxB2) {
  const result = await tools.dispatch(name, args, ctx)
  return { ok: result.ok, data: JSON.parse(result.result) }
}

const defaultView = await callTool('view_album', {})
ok(defaultView.ok && defaultView.data.photos.length === 20, 'view_album 默认最近 20 条')
ok(defaultView.data.photos.every((photo) => typeof photo.meme === 'string' && photo.meme !== ''), 'view_album 每条都带 meme')
ok(new Set(defaultView.data.photos.map((photo) => photo.meme)).size === 20, '默认列表 meme 唯一')

const sunsetView = await callTool('view_album', { query: '日落' })
ok(sunsetView.ok && sunsetView.data.photos.length === 1 && sunsetView.data.photos[0].id === 'seed-000', 'query 按描述过滤')
ok(sunsetView.data.photos[0].meme === createHash('sha256').update('seed-0').digest('hex').slice(0, 12), 'query 结果 meme 与 sha 前 12 一致')

const catView = await callTool('view_album', { category: '可爱' })
ok(catView.ok && catView.data.photos.length === 1 && catView.data.photos[0].id === 'seed-001', 'category 过滤')
const tagView = await callTool('view_album', { tag: '猫' })
ok(tagView.ok && tagView.data.photos.length === 1 && tagView.data.photos[0].id === 'seed-001', 'tag 过滤（SQL LIKE）')
const combinedView = await callTool('view_album', { query: '日常', category: '日常', limit: 100 })
ok(combinedView.ok && combinedView.data.photos.length === 23, 'query + category 组合过滤')
const limitedView = await callTool('view_album', { limit: 5 })
ok(limitedView.ok && limitedView.data.photos.length === 5, 'limit 生效')
const singleView = await callTool('view_album', { id: 'seed-000' })
ok(singleView.ok && singleView.data.photos.length === 1 && singleView.data.photos[0].meme === sunsetView.data.photos[0].meme, 'id 查单张 meme 稳定')

console.log('== send_photo meme 协议 ==')
const sunsetMeme = sunsetView.data.photos[0].meme
const sentByMeme = await callTool('send_photo', { meme: `meme:${sunsetMeme}`, caption: '看日落' })
ok(sentByMeme.ok, 'meme:<hex> 发送成功')
ok(bridgeCalls.length === 1 && bridgeCalls[0].url === 'https://cdn.test/api/photos/file/photos/seed-000.png', 'send_photo 走 bridge.sendPhoto + photoPublicUrl')
ok(bridgeCalls[0].caption === '看日落', 'send_photo 透传 caption')

const sentBare = await callTool('send_photo', { meme: sunsetMeme })
ok(sentBare.ok && bridgeCalls.length === 2, '裸 hex 发送成功')

const unknownMeme = await callTool('send_photo', { meme: 'deadbeefcafe' })
ok(!unknownMeme.ok && String(unknownMeme.data.error).includes('view_album'), '未知 meme 报错并提示先 view_album')
ok(bridgeCalls.length === 2, '未知 meme 不触发发送')

const missingMeme = await callTool('send_photo', {})
ok(!missingMeme.ok && String(missingMeme.data.error).includes('meme'), '缺 meme/id 明确报错')

const sentById = await callTool('send_photo', { id: 'seed-000' })
ok(sentById.ok && bridgeCalls.length === 3, 'id 兼容入口仍可用')

const wrongBot = await callTool('send_photo', { meme: sunsetMeme }, { botId: 'b5', sender: 'u1', botName: '注入', channelId: 'web' })
ok(!wrongBot.ok && String(wrongBot.data.error).includes('view_album'), '跨 bot meme 不可用')

console.log('== tag_photo category ==')
const tagged = await callTool('tag_photo', { id: 'seed-001', category: '生气', tags: ['测试'] })
ok(tagged.ok, 'tag_photo 支持 category')
const taggedRow = storage.prepare('SELECT * FROM photos WHERE id = ?').get('seed-001')
ok(taggedRow.category === '生气' && taggedRow.tags === '["测试"]', 'category/tags 已写库')
const captionOnly = await callTool('tag_photo', { id: 'seed-001', caption: '新描述' })
ok(captionOnly.ok && storage.prepare('SELECT tags FROM photos WHERE id = ?').get('seed-001').tags === '["测试"]', '只改 caption 不清空 tags')

// ---------- 5. 语义分析（本地 mock，不出网） ----------

console.log('== 语义分析 ==')
const goodBytes = Buffer.from('vision-good-bytes')
const badBytes = Buffer.from('vision-bad-bytes')
const pendingBytes = Buffer.from('vision-pending-bytes')
const goodUpload = await upload('b3', goodBytes, 'good.png')
const badUpload = await upload('b3', badBytes, 'bad.png')
const pendingUpload = await upload('b3', pendingBytes, 'pending.png')
ok(goodUpload.json.data.photo.semanticStatus === 'none', '视觉未启用时上传不入 pending')

const mockPayload = JSON.stringify({ caption: '海边日落，风很轻', tags: ['海边', '日落'], category: '开心', mood: '放松' })
const badB64 = badBytes.toString('base64')
let visionRequests = 0
const mock = createServer(async (req, res) => {
  if (req.method !== 'POST' || !String(req.url).endsWith('/chat/completions')) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw)
  const imageUrl = body?.messages?.[1]?.content?.[1]?.image_url?.url ?? ''
  visionRequests += 1
  const content = imageUrl.endsWith(badB64) ? '这不是 JSON' : mockPayload
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { content } }] }))
})
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
const mockBase = `http://127.0.0.1:${mock.address().port}/v1`

currentUser = { id: 'u-normal', username: 'normal', password_hash: 'x', role: 'user', created_at: nowIso }
const forbidden = await api('POST', '/api/photos/analyze', { botId: 'b3', ids: [goodUpload.json.data.photo.id] })
ok(forbidden.status === 403, '非 admin 调用 analyze → 403')
currentUser = admin

storage
  .prepare("UPDATE bots SET ai_vision_enabled = 1, ai_vision_base_url = ?, ai_vision_model = 'fake-vl', ai_vision_api_key = 'test-key' WHERE id = 'b3'")
  .run(mockBase)

const analyzed = await api('POST', '/api/photos/analyze', {
  botId: 'b3',
  ids: [goodUpload.json.data.photo.id, badUpload.json.data.photo.id],
})
ok(analyzed.status === 200 && analyzed.json.data.analyzed === 1 && analyzed.json.data.failed === 1, '批量返回 analyzed=1 failed=1')
ok(analyzed.json.data.configured === true && visionRequests === 2, '真实 HTTP 路径打到本地 mock（2 次）')
const goodRow = storage.prepare('SELECT * FROM photos WHERE id = ?').get(goodUpload.json.data.photo.id)
ok(goodRow.semantic_status === 'done' && goodRow.semantic_at !== null, '成功照片 semantic_status=done + semantic_at')
ok(goodRow.caption === '海边日落，风很轻' && goodRow.category === '开心', '成功照片写入 caption/category')
ok(JSON.parse(goodRow.tags).join(',') === '海边,日落' && goodRow.semantic_error === '', '成功照片写入 tags、清空 error')
const badRow = storage.prepare('SELECT * FROM photos WHERE id = ?').get(badUpload.json.data.photo.id)
ok(badRow.semantic_status === 'failed' && badRow.semantic_error !== '', '失败照片写 semantic_status=failed + error')
ok(goodRow.caption !== badRow.caption && badRow.caption === '', '单张失败不影响其它记录')

const batch = await api('POST', '/api/photos/analyze', { botId: 'b3', limit: 10 })
ok(batch.status === 200 && batch.json.data.analyzed === 1 && batch.json.data.failed === 1, '批量只捞非 done（pending + failed）')
const pendingRow = storage.prepare('SELECT * FROM photos WHERE id = ?').get(pendingUpload.json.data.photo.id)
ok(pendingRow.semantic_status === 'done' && pendingRow.category === '开心', '批量中的 pending 照片完成分析')
ok(storage.prepare('SELECT semantic_status FROM photos WHERE id = ?').get(goodUpload.json.data.photo.id).semantic_status === 'done', '已 done 的照片不被重复分析')

const missingAnalyze = await api('POST', '/api/photos/analyze', { botId: 'b3', ids: ['no-such-photo'] })
ok(missingAnalyze.status === 200 && missingAnalyze.json.data.skipped === 1 && missingAnalyze.json.data.analyzed === 0, '不存在的 id 计入 skipped')

insertPhoto({ id: 'b4-photo', botId: 'b4', caption: '没视觉' })
const noVision = await api('POST', '/api/photos/analyze', { botId: 'b4' })
ok(noVision.status === 200 && noVision.json.data.configured === false && noVision.json.data.skipped === 1, '未配置视觉 → configured=false + skipped')

// ---------- 6. 注入 fake 视觉函数（零网络） ----------

console.log('== fake 视觉函数注入 ==')
insertPhoto({ id: 'b5-photo', botId: 'b5', caption: '注入目标', url: 'https://example.test/b5-photo.png' })
insertPhoto({ id: 'b5-broken', botId: 'b5', caption: '注入失败', url: 'https://example.test/b5-broken.png' })
const injected = await analyzePhotos(deps, {
  botId: 'b5',
  ids: ['b5-photo'],
  vision: async () => '```json\n{"caption":"注入成功","tags":["a","a","b"],"category":"未知分类","mood":"平静"}\n```',
})
ok(injected.analyzed === 1 && injected.failed === 0 && injected.configured === true, '注入 fake 视觉函数 → 成功')
const injectedRow = storage.prepare('SELECT * FROM photos WHERE id = ?').get('b5-photo')
ok(injectedRow.caption === '注入成功' && injectedRow.tags === '["a","b"]', 'caption 写入、tags 去重')
ok(injectedRow.category === '其他', '未知分类归一为「其他」')

const injectedFail = await analyzePhotos(deps, {
  botId: 'b5',
  ids: ['b5-broken'],
  vision: async () => '这不是 JSON',
})
ok(injectedFail.failed === 1 && injectedFail.analyzed === 0, '注入 fake 抛解析失败 → failed')
const injectedBrokenRow = storage.prepare('SELECT * FROM photos WHERE id = ?').get('b5-broken')
ok(injectedBrokenRow.semantic_status === 'failed' && injectedBrokenRow.semantic_error !== '', '失败写入 error，状态 failed')
ok(storage.prepare('SELECT semantic_status FROM photos WHERE id = ?').get('b5-photo').semantic_status === 'done', '失败不影响其它记录')

const parsedFence = parseSemanticPayload('说明文字\n```json\n{"caption":"围栏","tags":[],"category":"日常","mood":"淡"}\n```')
ok(parsedFence.caption === '围栏' && parsedFence.category === '日常', '解析容忍 markdown 围栏')
let parseFailed = false
try {
  parseSemanticPayload('{"tags":[]}')
} catch {
  parseFailed = true
}
ok(parseFailed, '缺 caption 的 JSON 判为解析失败')

// ---------- 收尾 ----------

await new Promise((resolve) => server.close(resolve))
await new Promise((resolve) => mock.close(resolve))
storage.close()
rmSync(dir, { recursive: true, force: true })

console.log(`\n完成：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
