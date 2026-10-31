/**
 * 记忆 vault 控制台端点（Markdown 真相 + 派生索引；与旧 /api/memories* 并存，旧接口不动）。
 *
 * 字段契约与 fe-core vault 记忆页对齐：
 * - profile → {profile, updatedAt, truncated, budget}
 * - domains → {domains:[{domain,label,count,activeCount,readme,latest:[{entryId,title,timeLabel}]}]}
 * - entries → {entries:[{entryId,title,domain,timeLabel,eventLabel,recordedLabel,valid,kind,importance,tags,thread}], total}
 * - entry → {entry:{...上述, body, path, sourceRef, supersededBy, supersedes[], related[], provenance, volatility, eventRaw, history?}}
 * - search → {results:[{entryId,domain,title,timeLabel,score,layer,path,line}], count}
 * - staging → {items:[{id,content,sourceRef,createdAt,status}], count}
 * - consolidate → {ok, report:{added,merged,invalidated,archived,tokens,durationMs}, status}
 * - dream/status → {running,lastRunAt,nextRunAt,lastReport,lastError}
 * - migrate → {ok,migrated,skipped,profileRebuilt}
 *
 * 标记失效：PUT /api/memory/entries/:id {invalid:true, validUntil?} 等价 memory_forget（写墓碑 + 重建索引/档案）；
 * 另提供 POST /api/memory/entries/:id/forget 同语义。
 */
import { json, err, bodyRecord, reqBool, reqNum, reqStr, type ApiRequest } from './http.ts'
import { queryStr } from './deps.ts'
import type { RegisterFn } from './deps.ts'
import { VaultError, type MemoryVault } from '@littly/memory'

function unavailable(res: Parameters<typeof err>[0]): void {
  err(res, 501, 'memory_vault_unavailable', '记忆 vault 未装配（@littly/memory 未加载）')
}

function failVault(res: Parameters<typeof err>[0], error: unknown): void {
  if (error instanceof VaultError) {
    err(res, error.status, error.code, error.message)
    return
  }
  const rec = error as { status?: unknown; code?: unknown; message?: unknown }
  if (typeof rec?.status === 'number' && typeof rec?.code === 'string' && typeof rec?.message === 'string') {
    err(res, rec.status, rec.code, rec.message)
    return
  }
  err(res, 500, 'memory_vault_failed', error instanceof Error ? error.message : '记忆 vault 操作失败')
}

function scopeOf(ctx: ApiRequest, botId?: string, contactId?: string): { scope: { botId: string; contactId: string }; error?: string } {
  const bot = (botId ?? queryStr(ctx, 'botId') ?? '').trim()
  const contact = (contactId ?? queryStr(ctx, 'contactId') ?? '').trim() || (ctx.user?.id ?? '')
  if (bot === '') return { scope: { botId: '', contactId: '' }, error: '缺少 botId' }
  if (contact === '') return { scope: { botId: bot, contactId: '' }, error: '缺少 contactId（默认取当前登录用户）' }
  return { scope: { botId: bot, contactId: contact } }
}

function entryView(row: Record<string, unknown>): Record<string, unknown> {
  return {
    entryId: row['entryId'],
    title: row['title'],
    domain: row['domain'],
    timeLabel: row['eventLabel'],
    eventLabel: row['eventLabel'],
    recordedLabel: row['recordedLabel'],
    valid: row['state'] === 'active',
    state: row['state'],
    kind: row['kind'],
    importance: row['importance'],
    tags: [],
    thread: '',
  }
}

export const registerMemoryVaultRoutes: RegisterFn = (r, d) => {
  const handle = (ctx: { res: Parameters<typeof err>[0] }): MemoryVault | null => {
    const vault = d.memoryVault
    if (vault === undefined) { unavailable(ctx.res); return null }
    return vault
  }

  // 档案
  r.get('/api/memory/profile', 'required', (ctx) => {
    const vault = handle(ctx)
    if (vault === null) return
    const parsed = scopeOf(ctx)
    if (parsed.error !== undefined) { err(ctx.res, 400, 'bad_scope', parsed.error); return }
    const rebuild = (queryStr(ctx, 'rebuild') ?? '') === 'true'
    if (rebuild && ctx.user?.role !== 'admin') { err(ctx.res, 403, 'forbidden', '重建档案需要管理员'); return }
    try {
      const profile = vault.profile(parsed.scope, { rebuild })
      json(ctx.res, 200, { data: { profile: profile.markdown, updatedAt: profile.updatedAt, truncated: profile.truncated, budget: 2000, entryCount: profile.entryCount } })
    } catch (error) { failVault(ctx.res, error) }
  })

  // 9 域地图
  r.get('/api/memory/domains', 'required', (ctx) => {
    const vault = handle(ctx)
    if (vault === null) return
    const parsed = scopeOf(ctx)
    if (parsed.error !== undefined) { err(ctx.res, 400, 'bad_scope', parsed.error); return }
    try { json(ctx.res, 200, { data: { domains: vault.domains(parsed.scope) } }) } catch (error) { failVault(ctx.res, error) }
  })

  // 条目列表
  r.get('/api/memory/entries', 'required', (ctx) => {
    const vault = handle(ctx)
    if (vault === null) return
    const parsed = scopeOf(ctx)
    if (parsed.error !== undefined) { err(ctx.res, 400, 'bad_scope', parsed.error); return }
    const domain = queryStr(ctx, 'domain') ?? ''
    const limit = Math.min(200, Math.max(1, Number(queryStr(ctx, 'limit') ?? '50') || 50))
    const offset = Math.max(0, Number(queryStr(ctx, 'offset') ?? '0') || 0)
    try {
      const all = vault.entries(parsed.scope, { ...(domain !== '' ? { domain } : {}), limit: 1000, offset: 0 })
      const page = all.slice(offset, offset + limit)
      json(ctx.res, 200, { data: { entries: page.map((row) => entryView(row as unknown as Record<string, unknown>)), total: all.length } })
    } catch (error) { failVault(ctx.res, error) }
  })

  // 条目详情
  r.get('/api/memory/entries/:entryId', 'required', (ctx) => {
    const vault = handle(ctx)
    if (vault === null) return
    const parsed = scopeOf(ctx)
    if (parsed.error !== undefined) { err(ctx.res, 400, 'bad_scope', parsed.error); return }
    try {
      const entry = vault.getEntry(parsed.scope, ctx.params['entryId'] ?? '')
      json(ctx.res, 200, { data: { entry: { ...entryView(entry as unknown as Record<string, unknown>), body: entry.body, path: entry.path, sourceRef: entry.source_ref, supersededBy: entry.superseded_by, supersedes: entry.supersedes, related: entry.related, provenance: entry.provenance, volatility: entry.volatility, eventRaw: entry.event_raw, history: entry.tombstone } } })
    } catch (error) { failVault(ctx.res, error) }
  })

  // 条目编辑（admin）+ invalid 标记失效
  r.put('/api/memory/entries/:entryId', 'admin', (ctx) => {
    const vault = handle(ctx)
    if (vault === null) return
    const parsed = scopeOf(ctx)
    if (parsed.error !== undefined) { err(ctx.res, 400, 'bad_scope', parsed.error); return }
    const body = bodyRecord(ctx.body)
    const entryId = ctx.params['entryId'] ?? ''
    try {
      const invalid = reqBool(body, 'invalid') === true
      if (invalid) {
        const validUntil = reqStr(body, 'validUntil')
        const result = vault.forget(parsed.scope, entryId, reqStr(body, 'reason') ?? '用户标记失效', validUntil ?? undefined)
        json(ctx.res, 200, { data: { ok: true, entry: entryView(result.entry as unknown as Record<string, unknown>) } })
        return
      }
      const updated = vault.update(parsed.scope, entryId, {
        ...(reqStr(body, 'title') !== undefined ? { title: reqStr(body, 'title') as string } : {}),
        ...(reqStr(body, 'body') !== undefined ? { body: reqStr(body, 'body') as string } : {}),
        ...(Array.isArray(body['tags']) ? { tags: (body['tags'] as unknown[]).map(String) } : {}),
        ...(reqNum(body, 'importance') !== undefined ? { importance: reqNum(body, 'importance') as number } : {}),
        ...(Array.isArray(body['related']) ? { related: (body['related'] as unknown[]).map(String) } : {}),
        ...(reqStr(body, 'thread') !== undefined ? { thread: reqStr(body, 'thread') as string } : {}),
      })
      json(ctx.res, 200, { data: { ok: true, entry: entryView(updated as unknown as Record<string, unknown>) } })
    } catch (error) { failVault(ctx.res, error) }
  })

  // 标记失效（显式端点，与 PUT invalid 等价）
  r.post('/api/memory/entries/:entryId/forget', 'admin', (ctx) => {
    const vault = handle(ctx)
    if (vault === null) return
    const parsed = scopeOf(ctx)
    if (parsed.error !== undefined) { err(ctx.res, 400, 'bad_scope', parsed.error); return }
    const body = bodyRecord(ctx.body)
    try {
      const result = vault.forget(parsed.scope, ctx.params['entryId'] ?? '', reqStr(body, 'reason') ?? '用户要求遗忘', reqStr(body, 'validUntil') ?? undefined)
      json(ctx.res, 200, { data: { ok: true, entry: entryView(result.entry as unknown as Record<string, unknown>) } })
    } catch (error) { failVault(ctx.res, error) }
  })

  // 检索
  r.get('/api/memory/search', 'required', async (ctx) => {
    const vault = handle(ctx)
    if (vault === null) return
    const parsed = scopeOf(ctx)
    if (parsed.error !== undefined) { err(ctx.res, 400, 'bad_scope', parsed.error); return }
    const q = (queryStr(ctx, 'q') ?? queryStr(ctx, 'query') ?? '').trim()
    if (q === '') { err(ctx.res, 400, 'bad_request', '缺少检索词 q'); return }
    const domain = queryStr(ctx, 'domain') ?? undefined
    const limit = Math.min(50, Math.max(1, Number(queryStr(ctx, 'limit') ?? '10') || 10))
    try {
      const results = await vault.search(parsed.scope, q, { ...(domain !== undefined && domain !== '' ? { domain } : {}), limit })
      json(ctx.res, 200, {
        data: {
          results: results.map((hit) => ({
            entryId: hit['entryId'], domain: hit['domain'], title: hit['title'], timeLabel: hit['timeLabel'],
            score: hit['score'], layer: hit['matchedLayer'], path: hit['path'], line: hit['line'],
          })),
          count: results.length,
        },
      })
    } catch (error) { failVault(ctx.res, error) }
  })

  // 暂存区
  r.get('/api/memory/staging', 'required', (ctx) => {
    const vault = handle(ctx)
    if (vault === null) return
    const parsed = scopeOf(ctx)
    if (parsed.error !== undefined) { err(ctx.res, 400, 'bad_scope', parsed.error); return }
    try {
      const records = vault.staging(parsed.scope)
      json(ctx.res, 200, { data: { items: records.map((r) => ({ id: r.id, content: r.content, sourceRef: r.source_ref, createdAt: r.created_at, status: r.status })), count: records.length } })
    } catch (error) { failVault(ctx.res, error) }
  })

  // 手动整理
  r.post('/api/memory/staging/consolidate', 'admin', async (ctx) => {
    const vault = handle(ctx)
    if (vault === null) return
    const parsed = scopeOf(ctx)
    if (parsed.error !== undefined) { err(ctx.res, 400, 'bad_scope', parsed.error); return }
    try {
      const report = await vault.consolidate(parsed.scope, { reason: 'manual' })
      json(ctx.res, 200, {
        data: {
          ok: report.status === 'ok' || report.status === 'skipped',
          status: report.status,
          error: report.error,
          report: {
            added: report.added, merged: report.merged, invalidated: report.superseded,
            archived: report.archived, tokens: report.tokens, durationMs: report.durationMs,
          },
        },
      })
    } catch (error) { failVault(ctx.res, error) }
  })

  // Dream 状态
  r.get('/api/memory/dream/status', 'required', (ctx) => {
    const vault = handle(ctx)
    if (vault === null) return
    const parsed = scopeOf(ctx)
    if (parsed.error !== undefined) { err(ctx.res, 400, 'bad_scope', parsed.error); return }
    try { json(ctx.res, 200, { data: vault.dreamStatus(parsed.scope) }) } catch (error) { failVault(ctx.res, error) }
  })

  // 迁移旧 memories
  r.post('/api/memory/migrate', 'admin', (ctx) => {
    const vault = handle(ctx)
    if (vault === null) return
    const body = bodyRecord(ctx.body)
    const botId = reqStr(body, 'botId') ?? queryStr(ctx, 'botId') ?? undefined
    try {
      const result = vault.migrate({ ...(botId !== undefined && botId.trim() !== '' ? { botId: botId.trim() } : {}) })
      json(ctx.res, 200, { data: { ok: true, migrated: result.migrated, skipped: result.skipped, scopes: result.scopes, profileRebuilt: result.migrated > 0 } })
    } catch (error) { failVault(ctx.res, error) }
  })
}
