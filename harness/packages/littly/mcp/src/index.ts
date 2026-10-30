/**
 * @littly/mcp — 运行时 MCP 服务器管理。
 *
 * 计划 v2 §7/M5 的「MCP 接入」在 harness 里的落点：
 * dsh 原生只支持**静态** patch 行声明 MCP 服务器（bundle 里写死 mcp-bili 一行）。
 * 但控制台要能「按需加一个 MCP 服务器」——这需要运行时能连、能断、能重连。
 *
 * 本插件把「服务器清单」存在 DB（global_settings `mcp.servers`），
 * 启动时按清单连接，把服务器上的工具注册进 @littly/tools 的注册表，
 * 工具名沿用 dsh 命名规范 `mcp__<serverName>__<rawName>`。
 *
 * 与 dsh 静态行的关系：两者命名空间一致、互不冲突（同名服务器以先注册者为准）。
 * @littly/bili 的收敛门会把 `mcp__bili__*` 挡住（bili 走带护栏的元工具），
 * 其余用户自加的 MCP 服务器工具照常对模型可见。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { LittlyStorage } from '@littly/storage'
import type { LittlyHub } from '@littly/agents'
import type { ToolDef } from '@littly/tools'

export const name = 'littly-mcp'

export const inject = ['littlyStorage', 'littlyHub']

declare module '@deepseek-ai/cordis' {
  interface Context {
    littlyMcp: LittlyMcpManager
  }
}

export interface Config {
  /** 启动时自动连接清单里的服务器。 */
  autoConnect: boolean
}

export const Config: z<Config> = z.object({
  autoConnect: z.boolean().default(true),
})

/** 一个 MCP 服务器的配置（与 dsh mcp-client 的 Config 形状对齐）。 */
export interface McpServerConfig {
  /** 命名空间：工具名 mcp__<name>__<tool>；[A-Za-z0-9_-]{1,32} */
  name: string
  transport: 'stdio' | 'streamable-http'
  /** stdio：可执行文件 */
  command?: string
  /** stdio：参数 */
  args?: string[]
  /** stdio：附加环境变量 */
  env?: Record<string, string>
  /** streamable-http：端点 */
  url?: string
  /** streamable-http：附加请求头 */
  headers?: Record<string, string>
  /** 是否启用 */
  enabled: boolean
}

export interface McpServerStatus {
  config: McpServerConfig
  /** 连接状态 */
  state: 'connected' | 'connecting' | 'disconnected' | 'error'
  /** 该服务器提供的工具名 */
  tools: string[]
  /** 错误信息（state=error 时有值） */
  error?: string
}

const SETTINGS_KEY = 'mcp.servers'
const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/

export function parseServers(raw: string | null): McpServerConfig[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const out: McpServerConfig[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const rec = item as Record<string, unknown>
      const serverName = typeof rec['name'] === 'string' ? rec['name'] : ''
      if (!NAME_RE.test(serverName)) continue
      const transport = rec['transport'] === 'streamable-http' ? 'streamable-http' : 'stdio'
      out.push({
        name: serverName,
        transport,
        ...(typeof rec['command'] === 'string' ? { command: rec['command'] } : {}),
        ...(Array.isArray(rec['args']) ? { args: (rec['args'] as unknown[]).map((a) => String(a)) } : {}),
        ...(rec['env'] && typeof rec['env'] === 'object' ? { env: rec['env'] as Record<string, string> } : {}),
        ...(typeof rec['url'] === 'string' ? { url: rec['url'] } : {}),
        ...(rec['headers'] && typeof rec['headers'] === 'object' ? { headers: rec['headers'] as Record<string, string> } : {}),
        enabled: rec['enabled'] !== false,
      })
    }
    return out
  } catch {
    return []
  }
}

/** MCP 工具 → Littly 工具定义（OpenAI function calling 形状）。 */
export function mcpToolDef(serverName: string, rawName: string, description: string, inputSchema: unknown): ToolDef {
  const schema = inputSchema && typeof inputSchema === 'object' ? (inputSchema as Record<string, unknown>) : {}
  const parameters = schema['type'] === 'object' && typeof schema['properties'] === 'object'
    ? schema
    : { type: 'object', properties: {} }
  return {
    type: 'function',
    function: {
      name: `mcp__${serverName}__${rawName}`,
      description: description || `MCP 服务器 ${serverName} 提供的工具 ${rawName}`,
      parameters,
    },
  }
}

/** 连接态（含每个服务器的工具清单）。 */
interface LiveServer {
  client: { close: () => Promise<void> } | null
  tools: string[]
  /** 工具名 + 描述（testServer / tools 端点展示用）。 */
  toolDetails: Array<{ name: string; description?: string }>
  state: McpServerStatus['state']
  error?: string
}

/** 单个服务器的状态快照（routes-mcp 的 GET /servers 用）。 */
export interface McpServerBriefStatus {
  enabled: boolean
  connected: boolean
  toolCount: number
  lastError?: string
}

/** 测试连接结果。 */
export interface McpTestResult {
  ok: boolean
  tools: Array<{ name: string; description?: string }>
  toolCount: number
  error?: string
}

export class LittlyMcpManager {
  private readonly storage: LittlyStorage
  private readonly hub: LittlyHub
  private readonly log: (msg: string, ...args: unknown[]) => void
  private readonly live = new Map<string, LiveServer>()

  constructor(storage: LittlyStorage, hub: LittlyHub, log: (msg: string, ...args: unknown[]) => void) {
    this.storage = storage
    this.hub = hub
    this.log = log
  }

  listConfigs(): McpServerConfig[] {
    return parseServers(this.storage.getSetting(SETTINGS_KEY))
  }

  status(): McpServerStatus[] {
    return this.listConfigs().map((config) => {
      const l = this.live.get(config.name)
      return {
        config,
        state: l?.state ?? 'disconnected',
        tools: l?.tools ?? [],
        ...(l?.error !== undefined ? { error: l.error } : {}),
      }
    })
  }

  private save(configs: McpServerConfig[]): void {
    this.storage.setSetting(SETTINGS_KEY, JSON.stringify(configs))
  }

  /** 新增或更新一个服务器（同名即覆盖）；落库后立即尝试连接。 */
  async upsertServer(input: McpServerConfig): Promise<{ ok: boolean; error?: string }> {
    if (!NAME_RE.test(input.name)) return { ok: false, error: '服务器名只允许字母数字下划线连字符，1-32 位' }
    if (input.transport === 'stdio' && !input.command) return { ok: false, error: 'stdio 传输必须给出 command' }
    if (input.transport === 'streamable-http' && !input.url) return { ok: false, error: 'streamable-http 传输必须给出 url' }
    const configs = this.listConfigs().filter((c) => c.name !== input.name)
    configs.push(input)
    this.save(configs)
    await this.disconnect(input.name)
    if (input.enabled) await this.connect(input.name)
    return { ok: true }
  }

  /** 移除一个服务器（并断开）。 */
  async removeServer(serverName: string): Promise<{ ok: boolean; error?: string }> {
    const configs = this.listConfigs()
    if (!configs.some((c) => c.name === serverName)) return { ok: false, error: '服务器不存在' }
    this.save(configs.filter((c) => c.name !== serverName))
    await this.disconnect(serverName)
    return { ok: true }
  }

  /** 连接清单里的全部启用服务器。 */
  async connectAll(): Promise<void> {
    for (const config of this.listConfigs()) {
      if (!config.enabled) continue
      await this.connect(config.name)
    }
  }

  /** 连接一个服务器并把它的工具注册进 Littly 工具注册表。 */
  async connect(serverName: string): Promise<{ ok: boolean; error?: string }> {
    const config = this.listConfigs().find((c) => c.name === serverName)
    if (!config) return { ok: false, error: '服务器不存在' }
    const live: LiveServer = { client: null, tools: [], toolDetails: [], state: 'connecting' }
    this.live.set(serverName, live)
    try {
      const { Client } = await import('@modelcontextprotocol/client')
      const client = new Client(
        { name: 'littly-mcp', version: '0.1.0' },
        { capabilities: {}, versionNegotiation: { mode: 'auto' } },
      )
      let transport
      if (config.transport === 'stdio') {
        const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio')
        transport = new StdioClientTransport({
          command: config.command ?? 'bili',
          args: config.args ?? [],
          env: { ...process.env, ...(config.env ?? {}) } as Record<string, string>,
        })
      } else {
        const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client')
        transport = new StreamableHTTPClientTransport(new URL(config.url ?? ''), {
          requestInit: { headers: config.headers ?? {} },
        })
      }
      await client.connect(transport)
      live.client = client
      const response = await client.listTools(undefined, { cacheMode: 'refresh' })
      const tools: string[] = []
      for (const tool of response.tools) {
        const def = mcpToolDef(config.name, tool.name, tool.description ?? '', tool.inputSchema)
        this.hub.tools.registerChannelTool(def, async (args: Record<string, unknown>) => {
          const res = await client.callTool({ name: tool.name, arguments: args })
          const content = (res as { content?: unknown }).content
          const text = Array.isArray(content)
            ? content.map((c) => {
                const rec = c as { type?: string; text?: string }
                return rec.type === 'text' && typeof rec.text === 'string' ? rec.text : ''
              }).filter(Boolean).join('\n')
            : JSON.stringify(content ?? null)
          return { result: text || JSON.stringify(res) }
        })
        tools.push(def.function.name)
      }
      live.tools = tools
      live.toolDetails = response.tools.map((tool) => ({
        name: tool.name,
        ...(typeof tool.description === 'string' && tool.description !== '' ? { description: tool.description } : {}),
      }))
      live.state = 'connected'
      this.log('[mcp] 服务器 %s 已连接（%d 个工具）', config.name, tools.length)
      return { ok: true }
    } catch (err) {
      live.state = 'error'
      live.error = err instanceof Error ? err.message : String(err)
      this.log('[mcp] 服务器 %s 连接失败：%s', config.name, live.error)
      return { ok: false, error: live.error }
    }
  }

  /** 单个服务器的简要状态（未连接时 toolCount=0）。 */
  statusOf(serverName: string): McpServerBriefStatus {
    const config = this.listConfigs().find((c) => c.name === serverName)
    const live = this.live.get(serverName)
    return {
      enabled: config?.enabled === true,
      connected: live?.state === 'connected',
      toolCount: live?.tools.length ?? 0,
      ...(live?.error !== undefined ? { lastError: live.error } : {}),
    }
  }

  /**
   * 测试一个服务器：重连 + listTools，返回工具列表与可读错误（不抛异常）。
   * 用于 MCP 管理页的「测试连接」；成功后会保持连接（工具照常注册）。
   */
  async testServer(serverName: string): Promise<McpTestResult> {
    const config = this.listConfigs().find((c) => c.name === serverName)
    if (config === undefined) return { ok: false, tools: [], toolCount: 0, error: '服务器不存在' }
    await this.disconnect(serverName)
    const result = await this.connect(serverName)
    if (!result.ok) return { ok: false, tools: [], toolCount: 0, error: result.error ?? '连接失败' }
    const live = this.live.get(serverName)
    const tools = live?.toolDetails ?? []
    return { ok: true, tools, toolCount: tools.length }
  }

  /** 断开一个服务器（工具随之从注册表移除）。 */
  async disconnect(serverName: string): Promise<void> {
    const live = this.live.get(serverName)
    if (!live) return
    try {
      await live.client?.close()
    } catch {
      // 关闭失败忽略
    }
    live.client = null
    live.tools = []
    live.state = 'disconnected'
    this.live.delete(serverName)
  }

  /** 关闭全部连接（进程退出时调用）。 */
  async disconnectAll(): Promise<void> {
    for (const serverName of [...this.live.keys()]) await this.disconnect(serverName)
  }
}

export function apply(ctx: Context, config: Config): void {
  const manager = new LittlyMcpManager(
    ctx.littlyStorage as LittlyStorage,
    ctx.littlyHub as LittlyHub,
    (msg: string, ...args: unknown[]) => ctx.logger.info(msg, ...args),
  )
  ctx.provide('littlyMcp', manager)
  ctx.effect(() => {
    if (config.autoConnect) {
      void manager.connectAll().catch((err) => ctx.logger.warn('[mcp] 启动连接失败: %s', String(err)))
    }
    return () => {
      void manager.disconnectAll()
    }
  }, 'littly-mcp.connect')
  ctx.logger.info('littly mcp ready')
}
