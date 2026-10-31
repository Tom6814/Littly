/**
 * 模型工具：memory_profile / memory_rules / memory_domains / memory_index / memory_search /
 * memory_get / memory_write / memory_stage / memory_forget。
 *
 * 放在 vault 门面之上，只做参数整形与可读错误；所有护栏（路径/校验/去重/append-only/墓碑）
 * 都在服务层。旧 remember/recall 保留不变（兼容既有提示词），新提示词优先用 memory_*。
 */
import type { MemoryVault } from './service.ts'

/** 工具定义结构面（与 @littly/tools 的 ToolDef 等价；本地声明避免 memory→tools 的环/工程引用）。 */
export interface MemoryToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** 工具执行上下文结构面（botId + sender=联系人）。 */
export interface MemoryToolExecCtx {
  botId: string
  sender: string
  botName?: string
  channelId?: string
}

/** hub 工具注册表最小结构面（避免依赖 @littly/agents 具体类型）。 */
export interface MemoryToolRegistryLike {
  tools: {
    registerChannelTool(def: MemoryToolDef, exec: (args: Record<string, unknown>, ctx: MemoryToolExecCtx) => Promise<{ result: string }>): void
  }
}

const S = (description: string): { type: 'string'; description: string } => ({ type: 'string', description })

export const MEMORY_TOOLS: MemoryToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'memory_profile',
      description: '读取当前用户的常驻记忆档案（PROFILE.md）。会话开始时先调用一次，了解 TA 的稳定事实/偏好/近期状态。可传 rebuild=true 从条目重建。',
      parameters: { type: 'object', properties: { rebuild: { type: 'boolean', description: '是否重建档案（默认 false）' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_rules',
      description: '读取相处规则（RULES.md：用户明确表达过的偏好/雷点，来自 feedback 域）。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_domains',
      description: '9 域记忆地图：每域条目数、最近更新与自述。用于决定去哪一域找/写。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_index',
      description: '按域列条目（id/标题/自然语言时间标签/是否有效）。可选 domain 过滤。',
      parameters: { type: 'object', properties: { domain: S('域：about-user/interests/projects/life/relationships/feedback/notes/health/history'), limit: { type: 'number', description: '最多条数（默认 20）' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_search',
      description: '跨域检索长期记忆（FTS 关键词 + 向量语义，RRF 融合）。返回条目 id/域/标题/时间标签/分数/文件路径与行号。',
      parameters: { type: 'object', properties: { query: S('检索词/问题'), domain: S('可选：限定域'), limit: { type: 'number', description: '最多条数（默认 8）' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_get',
      description: '展开一条记忆（正文/发生与记录时间自然语言/取代链/来源消息/墓碑）。',
      parameters: { type: 'object', properties: { entryId: S('条目 id（memory_search/index 返回）') }, required: ['entryId'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_write',
      description: '写一条长期记忆（append-only，自动去重/校验 domain/kind/时间）。同 id 不同内容会被拒绝；取代旧条目用 supersedes。想轻量记录候选请用 memory_stage。',
      parameters: {
        type: 'object',
        properties: {
          domain: S('域：about-user/interests/projects/life/relationships/feedback/notes/health'),
          title: S('一句话标题'),
          body: S('正文（Markdown，不要写死时间戳）'),
          kind: S('about-user（事实）/agent-note（推断）/rule（feedback 规则）'),
          event_time: S('事件发生时间 ISO 8601（带时区）；缺省=现在'),
          event_raw: S('用户原话（可选）'),
          importance: { type: 'number', description: '1-5，默认 3' },
          provenance: S('user-stated/observed/inferred'),
          volatility: S('stable/state'),
          tags: { type: 'array', items: { type: 'string' }, description: '标签' },
          thread: S('线索名（跨条目关联）'),
          supersedes: { type: 'array', items: { type: 'string' }, description: '被这条取代的旧 entry id' },
          source_ref: S('来源（如 message:<uuid>）'),
        },
        required: ['domain', 'title', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_stage',
      description: '把候选记忆写入暂存区 _staging（聊天中轻量调用，不阻塞）；后台 Dream 会批量整理成正式条目。',
      parameters: { type: 'object', properties: { content: S('候选记忆内容（一句话或一段）'), source_ref: S('来源消息 id（可选）') }, required: ['content'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_forget',
      description: '遗忘一条记忆：标记失效并写墓碑（不物理删除原文，保留「曾经是真的」）。',
      parameters: { type: 'object', properties: { entryId: S('要遗忘的条目 id'), reason: S('原因（可选）') }, required: ['entryId'] },
    },
  },
]

function ok(value: unknown): { result: string } { return { result: JSON.stringify({ ok: true, ...(value as Record<string, unknown>) }) } }
function bad(error: unknown): { result: string } {
  const rec = error as { code?: unknown; message?: unknown }
  return { result: JSON.stringify({ ok: false, error: { code: String(rec?.code ?? 'memory_failed'), message: String(rec?.message ?? error) } }) }
}

/** 注册全部 memory_* 工具。 */
export function registerMemoryTools(hub: MemoryToolRegistryLike, vault: MemoryVault): void {
  const reg = (name: string, exec: (args: Record<string, unknown>, ctx: MemoryToolExecCtx) => Promise<{ result: string }>): void => {
    const def = MEMORY_TOOLS.find((t) => t.function.name === name)
    if (def !== undefined) hub.tools.registerChannelTool(def, exec)
  }
  const scope = (ctx: MemoryToolExecCtx): { botId: string; contactId: string } => ({ botId: ctx.botId, contactId: ctx.sender })

  reg('memory_profile', async (args, ctx) => {
    try {
      const profile = vault.profile(scope(ctx), { rebuild: args['rebuild'] === true })
      return ok({ profile: profile.markdown, updatedAt: profile.updatedAt, truncated: profile.truncated, budget: 2000, entryCount: profile.entryCount })
    } catch (error) { return bad(error) }
  })
  reg('memory_rules', async (_args, ctx) => {
    try {
      const rules = vault.rules(scope(ctx))
      return ok({ rules })
    } catch (error) { return bad(error) }
  })
  reg('memory_domains', async (_args, ctx) => {
    try {
      return ok({ domains: vault.domains(scope(ctx)) })
    } catch (error) { return bad(error) }
  })
  reg('memory_index', async (args, ctx) => {
    try {
      const rows = vault.entries(scope(ctx), { ...(typeof args['domain'] === 'string' ? { domain: args['domain'] } : {}), limit: Math.min(100, Number(args['limit']) || 20) })
      return ok({ entries: rows.map((r) => ({ entryId: r.entryId, domain: r.domain, title: r.title, timeLabel: r.eventLabel, valid: r.state === 'active', kind: r.kind, importance: r.importance })) })
    } catch (error) { return bad(error) }
  })
  reg('memory_search', async (args, ctx) => {
    try {
      const results = await vault.search(scope(ctx), String(args['query'] ?? ''), { ...(typeof args['domain'] === 'string' ? { domain: args['domain'] } : {}), limit: Math.min(50, Number(args['limit']) || 8) })
      return ok({ results })
    } catch (error) { return bad(error) }
  })
  reg('memory_get', async (args, ctx) => {
    try {
      return ok({ entry: vault.getEntry(scope(ctx), String(args['entryId'] ?? '')) })
    } catch (error) { return bad(error) }
  })
  reg('memory_write', async (args, ctx) => {
    try {
      const written = vault.write(scope(ctx), {
        domain: String(args['domain'] ?? ''),
        title: String(args['title'] ?? ''),
        body: String(args['body'] ?? ''),
        ...(typeof args['kind'] === 'string' ? { kind: args['kind'] } : {}),
        ...(typeof args['event_time'] === 'string' ? { event_time: args['event_time'] } : {}),
        ...(typeof args['event_raw'] === 'string' ? { event_raw: args['event_raw'] } : {}),
        ...(typeof args['importance'] === 'number' ? { importance: args['importance'] } : {}),
        ...(typeof args['provenance'] === 'string' ? { provenance: args['provenance'] } : {}),
        ...(typeof args['volatility'] === 'string' ? { volatility: args['volatility'] } : {}),
        ...(Array.isArray(args['tags']) ? { tags: args['tags'].map(String) } : {}),
        ...(typeof args['thread'] === 'string' ? { thread: args['thread'] } : {}),
        ...(Array.isArray(args['supersedes']) ? { supersedes: args['supersedes'].map(String) } : {}),
        ...(typeof args['source_ref'] === 'string' ? { source_ref: args['source_ref'] } : {}),
      })
      return ok({ entryId: written.entry.id, domain: written.entry.domain, path: written.path, created: written.created, duplicate: written.duplicate, superseded: written.superseded })
    } catch (error) { return bad(error) }
  })
  reg('memory_stage', async (args, ctx) => {
    try {
      const result = vault.stage(scope(ctx), String(args['content'] ?? ''), typeof args['source_ref'] === 'string' ? args['source_ref'] : '')
      return ok(result)
    } catch (error) { return bad(error) }
  })
  reg('memory_forget', async (args, ctx) => {
    try {
      const result = vault.forget(scope(ctx), String(args['entryId'] ?? ''), typeof args['reason'] === 'string' ? args['reason'] : '用户要求遗忘')
      return ok(result)
    } catch (error) { return bad(error) }
  })
}
