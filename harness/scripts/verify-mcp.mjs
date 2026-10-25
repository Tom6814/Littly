#!/usr/bin/env node
/**
 * 运行时 MCP 管理 + 工具按角色启停 的行为验证。
 * 运行：node scripts/verify-mcp.mjs
 *
 * 覆盖：服务器清单解析与校验、增删改落库、工具定义命名（mcp__<server>__<tool>）、
 *       工具按角色启停的读写与切换语义、禁用集合的容错。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LittlyStorage } from '../packages/littly/storage/src/index.ts'
import { mcpToolDef, parseServers } from '../packages/littly/mcp/src/index.ts'
import {
  disabledToolsKey,
  getDisabledTools,
  setDisabledTools,
  toggleDisabledTool,
} from '../packages/littly/tools/src/enabled.ts'

let pass = 0
let fail = 0
const ok = (cond, name) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.error(`  ✗ ${name}`) }
}

console.log('== MCP 服务器清单解析 ==')
const raw = JSON.stringify([
  { name: 'bili', transport: 'stdio', command: 'bili', args: ['mcp', 'serve'], enabled: true },
  { name: 'docs', transport: 'streamable-http', url: 'http://127.0.0.1:8931/mcp' },
  { name: 'bad name!', transport: 'stdio', command: 'x' },
  { name: 'ok2', transport: 'stdio' },
])
const servers = parseServers(raw)
ok(servers.length === 3, '非法名被丢弃（3/4 通过）')
ok(servers[0].name === 'bili' && servers[0].args?.length === 2, 'stdio 服务器解析出 args')
ok(servers[1].transport === 'streamable-http' && servers[1].url !== undefined, 'http 服务器解析出 url')
ok(servers[2].enabled === true, '缺省 enabled 视为启用')
ok(parseServers('not json').length === 0, '坏 JSON → 空清单')
ok(parseServers(null).length === 0, '空值 → 空清单')

console.log('== MCP 工具命名 ==')
const def = mcpToolDef('demo', 'search_docs', '搜文档', {
  type: 'object',
  properties: { q: { type: 'string' } },
  required: ['q'],
})
ok(def.function.name === 'mcp__demo__search_docs', '工具名 = mcp__<server>__<tool>')
ok(def.function.description === '搜文档', '描述透传')
ok(def.function.parameters.properties.q !== undefined, '入参 schema 透传')
const noSchema = mcpToolDef('demo', 'x', '', undefined)
ok(noSchema.function.parameters['type'] === 'object', '缺 schema → 空 object schema')

console.log('== 工具按角色启停 ==')
const dir = mkdtempSync(join(tmpdir(), 'littly-mcp-'))
const storage = new LittlyStorage({ logger: { info: () => {} } }, { file: join(dir, 'm.db') })

ok(disabledToolsKey('b1') === 'tools.disabled.b1', '配置键名按角色隔离')
ok(getDisabledTools(storage, 'b1').size === 0, '初始为空集合')

setDisabledTools(storage, 'b1', ['gen_image', 'web_search'])
ok(getDisabledTools(storage, 'b1').size === 2, '写入 2 个停用工具')
ok(getDisabledTools(storage, 'b1').has('gen_image'), '停用集合含 gen_image')
ok(getDisabledTools(storage, 'b2').size === 0, '不影响其它角色')

let set = toggleDisabledTool(storage, 'b1', 'gen_image', true)
ok(!set.has('gen_image') && set.has('web_search'), '启用一个工具后从停用集合移除')
set = toggleDisabledTool(storage, 'b1', 'send_photo', false)
ok(set.has('send_photo') && set.size === 2, '停用一个新工具')

storage.setSetting(disabledToolsKey('b3'), 'not json')
ok(getDisabledTools(storage, 'b3').size === 0, '坏配置 → 空集合（容错）')

storage.close()
rmSync(dir, { recursive: true, force: true })

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
