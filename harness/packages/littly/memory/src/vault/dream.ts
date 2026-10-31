/**
 * Dream：暂存区后台整理 + PROFILE/RULES 生成 + 报告。
 *
 * 触发：staging≥25 且距上次≥30min / 每日 03:00 / 手动。
 * 保护：同一 vault 并发锁（_meta/dream.lock，30min 陈旧可抢占）；token 预算（默认 60k）；
 * 失败保留 staging（可重试）；条目文件原子写；绝不物理删除原文（只墓碑）。
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  atomicWrite, appendJsonl, clearStaging, ensureVault, listAllEntries, listStaging,
  rewriteEntryFile, writeProfile, writeRules, writeTombstone, writeEntryFile, type StagingRecord, type VaultPaths,
} from './store.ts'
import type { VaultIndex } from './index-db.ts'
import { normalizeWriteInput, type VaultEntry, type VaultWriteInput, WRITABLE_DOMAINS } from './types.ts'

export const DREAM_MIN_STAGING = 25
export const DREAM_MIN_INTERVAL_MS = 30 * 60_000
export const DREAM_LOCK_STALE_MS = 30 * 60_000
export const PROFILE_BUDGET = 2000
export const DREAM_TOKEN_BUDGET = 60_000


export interface DreamLlm {
  /** 把整理 prompt 发给模型，返回 JSON 文本。 */
  complete(prompt: string): Promise<string>
}

export interface DreamReport {
  id: string
  botId: string
  contactId: string
  at: string
  added: number
  merged: number
  superseded: number
  archived: number
  durationMs: number
  tokens: number
  status: 'ok' | 'error' | 'locked' | 'skipped'
  error: string
  profileChars: number
  profileTruncated: boolean
}

export interface DreamDeps {
  paths: VaultPaths
  index: VaultIndex
  llm: DreamLlm
  embed?: ((texts: string[]) => Promise<number[][]>) | null
  now?: () => Date
  tokenBudget?: number
  log?: (msg: string, ...args: unknown[]) => void
}

// ---------------- PROFILE / RULES ----------------

/** 生成 PROFILE 自动区内容（≤2000 字，超预算显式标注截断）。 */
export function buildProfileMarkdown(_paths: VaultPaths, index: VaultIndex, now: Date, budget: number = PROFILE_BUDGET, scope: { botId: string; contactId: string }): { markdown: string; chars: number; truncated: boolean; entryCount: number } {
  const rows = index.entriesWithLabels(scope, { limit: 500 }, now)
  const active = rows.filter((r) => r.state === 'active')
  const archived = rows.filter((r) => r.state === 'archived' || r.state === 'superseded' || r.state === 'expired')
  const lines: string[] = []
  lines.push(`> 自动生成于 ${now.toISOString()}；依据 ${active.length} 条有效条目（index build ${index.getMeta('build_id') || 'n/a'}）。人工可在自动区外补充。`)
  lines.push('')
  lines.push('## 概览')
  for (const domain of WRITABLE_DOMAINS) {
    const inDomain = active.filter((r) => r.domain === domain)
    if (inDomain.length === 0) continue
    const latest = inDomain.slice(0, 3).map((r) => `「${r.title}」(${r.eventLabel})`).join('、')
    lines.push(`- **${domain}**（${inDomain.length} 条）：最近 ${latest}`)
  }
  if (active.length === 0) lines.push('- （暂无有效条目）')
  lines.push('')
  lines.push('## 近期')
  for (const domain of WRITABLE_DOMAINS) {
    const recent = active.filter((r) => r.domain === domain).slice(0, 3)
    if (recent.length === 0) continue
    lines.push(`### ${domain}`)
    for (const r of recent) lines.push(`- ${r.title} —— ${r.eventLabel}${r.provenance === 'inferred' ? '（推断）' : ''}`)
  }
  lines.push('')
  lines.push('## 相处规则')
  const rules = active.filter((r) => r.domain === 'feedback')
  if (rules.length === 0) lines.push('- （暂无）')
  else for (const r of rules.slice(0, 10)) lines.push(`- ${r.title}`)
  lines.push('')
  lines.push('## 规模')
  lines.push(`- 有效 ${active.length} 条；失效/墓碑 ${archived.length} 条；共 ${rows.length} 条。`)
  let markdown = lines.join('\n')
  let truncated = false
  if ([...markdown].length > budget) {
    truncated = true
    const sliced = [...markdown].slice(0, Math.max(0, budget - 60)).join('')
    markdown = `${sliced}\n…（已截断：完整内容见 domains/ 与 threads/；共 ${[...lines.join('\n')].length} 字）`
  }
  return { markdown, chars: [...markdown].length, truncated, entryCount: active.length }
}

/** 生成 RULES.md 自动区（feedback 规则汇总）。 */
export function buildRulesMarkdown(_paths: VaultPaths, index: VaultIndex, now: Date, scope: { botId: string; contactId: string }): string {
  const rows = index.entriesWithLabels(scope, { domain: 'feedback', limit: 200 }, now).filter((r) => r.state === 'active')
  const lines: string[] = ['> 自动生成（来自 feedback 域条目）；人工可在自动区外补充。', '']
  if (rows.length === 0) lines.push('（暂无明确偏好/雷点）')
  for (const r of rows) lines.push(`- ${r.title}（${r.eventLabel}）`)
  return lines.join('\n')
}

/** 刷新 PROFILE.md / RULES.md（自动区替换，区间外人工内容保留）。 */
export function refreshProfileFiles(paths: VaultPaths, index: VaultIndex, now: Date, scope: { botId: string; contactId: string }, budget: number = PROFILE_BUDGET): { chars: number; truncated: boolean } {
  ensureVault(paths)
  const profile = buildProfileMarkdown(paths, index, now, budget, scope)
  writeProfile(paths, profile.markdown)
  writeRules(paths, buildRulesMarkdown(paths, index, now, scope))
  return { chars: profile.chars, truncated: profile.truncated }
}

// ---------------- 并发锁 ----------------

interface LockInfo { pid: number; at: number }
export function acquireDreamLock(paths: VaultPaths, now: Date, staleMs = DREAM_LOCK_STALE_MS): { ok: true; file: string } | { ok: false; reason: string } {
  ensureVault(paths)
  const file = join(paths.metaDir, 'dream.lock')
  if (existsSync(file)) {
    try {
      const info = JSON.parse(readFileSync(file, 'utf8')) as LockInfo
      if (now.getTime() - Number(info.at) < staleMs) return { ok: false, reason: `已有整理在进行中（pid=${info.pid}，开始于 ${new Date(info.at).toISOString()}）` }
    } catch {
      // 损坏锁视为陈旧
    }
  }
  atomicWrite(file, JSON.stringify({ pid: process.pid, at: now.getTime() } satisfies LockInfo))
  return { ok: true, file }
}

export function releaseDreamLock(paths: VaultPaths): void {
  try { rmSync(join(paths.metaDir, 'dream.lock'), { force: true }) } catch { /* ignore */ }
}

// ---------------- LLM prompt / 解析 ----------------

/** 估算 token（粗粒度：约 4 字符 = 1 token，中文按 2 字符 ≈ 1 token 保守取 3 字符/token）。 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3)
}

/** 构造整理 prompt（给 growth/chat 模型）。 */
export function buildDreamPrompt(records: StagingRecord[], recentEntries: VaultEntry[], tokenBudget: number): { prompt: string; usedRecords: StagingRecord[]; tokens: number } {
  const system = [
    '你是记忆整理器。把「暂存候选」抽取为长期记忆条目，输出严格 JSON 数组（不要 markdown 代码块）。',
    `可用域：${WRITABLE_DOMAINS.join(' / ')}。`,
    '每条字段：{"domain","kind":"about-user|agent-note|rule","title","body","event_time"(ISO 带时区，可省略),"event_raw"(原话)，"importance"(1-5),"provenance":"user-stated|observed|inferred","volatility":"stable|state","tags":[],"thread":"", "supersedes":["要取代的旧条目 id"]}',
    '规则：事实用 about-user；用户明确偏好/雷点用 feedback 域 + rule；推测用 notes 域 + agent-note（provenance=inferred）；重复/同义条目合并；被新事实取代的旧条目填 supersedes；不要编造。',
  ].join('\n')
  const existing = recentEntries.slice(0, 40).map((e) => `- ${e.id} [${e.domain}] ${e.title}`).join('\n')
  let prompt = `${system}\n\n## 已有条目（可用于 supersede/去重）\n${existing || '（无）'}\n\n## 暂存候选\n`
  const used: StagingRecord[] = []
  for (const record of records) {
    const piece = `- id=${record.id} source=${record.source_ref} content=${record.content}\n`
    if (estimateTokens(prompt + piece) > tokenBudget) break
    prompt += piece
    used.push(record)
  }
  prompt += '\n只输出 JSON 数组。'
  return { prompt, usedRecords: used, tokens: estimateTokens(prompt) }
}

/** 从模型输出里稳健提取 JSON 数组。 */
export function parseDreamOutput(text: string): Array<Record<string, unknown>> {
  const trimmed = text.trim()
  const candidates: string[] = []
  const start = trimmed.indexOf('[')
  const end = trimmed.lastIndexOf(']')
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1))
  candidates.push(trimmed)
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (Array.isArray(parsed)) return parsed.filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object')
    } catch {
      // try next
    }
  }
  throw new Error('模型输出不是合法 JSON 数组')
}

// ---------------- 整理主流程 ----------------

export interface ConsolidateOptions {
  reason: 'threshold' | 'daily' | 'manual'
  maxRecords?: number
  budgetChars?: number
}

/** 运行一次整理（失败保留 staging；成功清空已处理 staging）。 */
export async function runDream(deps: DreamDeps, options: ConsolidateOptions): Promise<DreamReport> {
  const now = (deps.now ?? (() => new Date()))()
  const botId = deps.paths.botDir.split(/[\\/]/u).pop() ?? ''
  const contactId = deps.paths.contactDir.split(/[\\/]/u).pop() ?? ''
  const started = Date.now()
  const reportId = randomUUID()
  const base: DreamReport = {
    id: reportId, botId, contactId, at: now.toISOString(), added: 0, merged: 0, superseded: 0, archived: 0,
    durationMs: 0, tokens: 0, status: 'ok', error: '', profileChars: 0, profileTruncated: false,
  }
  const lock = acquireDreamLock(deps.paths, now)
  if (lock.ok === false) {
    return { ...base, status: 'locked', error: lock.reason }
  }
  try {
    ensureVault(deps.paths)
    const staging = listStaging(deps.paths).filter((r) => r.status === 'pending')
    if (staging.length === 0) {
      return { ...base, status: 'skipped', error: '暂存区为空' }
    }
    const scope = { botId, contactId }
    const existingEntries = listAllEntries(deps.paths).map((x) => x.entry)
    const tokenBudget = deps.tokenBudget ?? DREAM_TOKEN_BUDGET
    const { prompt, usedRecords, tokens: promptTokens } = buildDreamPrompt(staging, existingEntries, tokenBudget)
    let items: Array<Record<string, unknown>>
    try {
      const output = await deps.llm.complete(prompt)
      items = parseDreamOutput(output)
    } catch (error) {
      deps.log?.('[memory-vault] Dream LLM 失败: %s', String(error))
      return { ...base, status: 'error', error: `整理模型调用/解析失败：${error instanceof Error ? error.message : String(error)}`, durationMs: Date.now() - started, tokens: promptTokens }
    }
    const result = applyDreamItems(deps, scope, items, existingEntries, now)
    // 重建索引（以文件为准，保证一致性）
    const items2 = listAllEntries(deps.paths)
    deps.index.rebuildScope(botId, contactId, items2.map(({ entry, relPath }) => ({ entry, relPath, lineNo: 1 })), now)
    if (deps.embed !== undefined && deps.embed !== null) {
      try {
        const active = items2.filter(({ entry }) => entry.superseded_by === null)
        const vectors = await deps.embed(active.map(({ entry }) => `${entry.title}\n${entry.body}`))
        active.forEach(({ entry }, i) => { const vec = vectors[i]; if (Array.isArray(vec) && vec.length > 0) deps.index.setVector(entry.id, 'embed', vec) })
      } catch (error) {
        deps.log?.('[memory-vault] Dream 向量刷新失败（不阻断）: %s', String(error))
      }
    }
    const profile = refreshProfileFiles(deps.paths, deps.index, now, scope)
    // 报告
    const report: DreamReport = {
      ...base,
      ...result,
      status: 'ok',
      error: '',
      durationMs: Date.now() - started,
      tokens: promptTokens + estimateTokens(JSON.stringify(items)),
      profileChars: profile.chars,
      profileTruncated: profile.truncated,
    }
    appendJsonl(join(deps.paths.metaDir, 'dream-log.jsonl'), { ...report, reason: options.reason })
    deps.index.insertDreamReport({
      id: report.id, bot_id: botId, contact_id: contactId, at: report.at, added: report.added, merged: report.merged,
      superseded: report.superseded, archived: report.archived, duration_ms: report.durationMs, tokens: report.tokens,
      status: report.status, error: '',
    })
    // 清空已处理的 staging（仅训练成功的批次）
    clearStaging(deps.paths, usedRecords.map((r) => r.id))
    deps.index.syncStaging(botId, contactId, [])
    return report
  } catch (error) {
    return { ...base, status: 'error', error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started }
  } finally {
    releaseDreamLock(deps.paths)
  }
}

/** 把 LLM 抽取结果写成条目（幂等/合并/取代/墓碑），返回计数。 */
function applyDreamItems(deps: DreamDeps, scope: { botId: string; contactId: string }, items: Array<Record<string, unknown>>, existingEntries: VaultEntry[], now: Date): { added: number; merged: number; superseded: number; archived: number } {
  let added = 0
  let merged = 0
  let superseded = 0
  let archived = 0
  const byId = new Map(existingEntries.map((e) => [e.id, e]))
  const activeByTitle = new Map(existingEntries.filter((e) => e.superseded_by === null).map((e) => [`${e.domain}\u0000${e.title}`, e]))
  for (const raw of items.slice(0, 100)) {
    const domain = String(raw['domain'] ?? '').trim()
    const title = String(raw['title'] ?? '').trim()
    const body = String(raw['body'] ?? '').trim()
    if (domain === '' || title === '' || body === '') continue
    if (!(WRITABLE_DOMAINS as readonly string[]).includes(domain)) continue
    const normalized = `${domain}\u0000${title}`
    if (activeByTitle.has(normalized)) { merged++; continue }
    let entry: VaultEntry
    try {
      const input: VaultWriteInput = {
        domain,
        title,
        body,
        ...(typeof raw['kind'] === 'string' ? { kind: raw['kind'] } : {}),
        ...(typeof raw['event_time'] === 'string' ? { event_time: raw['event_time'] } : {}),
        ...(typeof raw['event_raw'] === 'string' ? { event_raw: raw['event_raw'] } : {}),
        ...(typeof raw['provenance'] === 'string' ? { provenance: raw['provenance'] } : {}),
        ...(typeof raw['volatility'] === 'string' ? { volatility: raw['volatility'] } : {}),
        ...(typeof raw['importance'] === 'number' ? { importance: raw['importance'] } : {}),
        ...(Array.isArray(raw['tags']) ? { tags: raw['tags'].map(String) } : {}),
        ...(typeof raw['thread'] === 'string' ? { thread: raw['thread'] } : {}),
        ...(Array.isArray(raw['supersedes']) ? { supersedes: raw['supersedes'].map(String) } : {}),
        source: 'chat',
        source_ref: `dream:${scope.botId}`,
      }
      entry = normalizeWriteInput(input, () => now)
    } catch (error) {
      deps.log?.('[memory-vault] Dream 条目校验失败（跳过）: %s', String(error))
      continue
    }
    const written = writeEntryFile(deps.paths, entry)
    if (written.created) added++
    else if (written.duplicate) merged++
    // supersede 旧条目
    for (const oldId of entry.supersedes) {
      const old = byId.get(oldId)
      if (old === undefined || old.superseded_by !== null) continue
      const updated: VaultEntry = { ...old, superseded_by: entry.id, valid_until: entry.event_time }
      // 生命周期字段（superseded_by/valid_until）走专用重写；正文仍 append-only
      rewriteEntryFile(deps.paths, updated)
      superseded++
      writeTombstone(deps.paths, old, '被新条目取代', entry.id)
      archived++
    }
    activeByTitle.set(normalized, entry)
  }
  return { added, merged, superseded, archived }
}

/** 是否应自动触发整理。 */
export function dreamDue(stagingCount: number, lastDreamAt: string, now: Date): boolean {
  if (stagingCount < DREAM_MIN_STAGING) return false
  const last = lastDreamAt === '' ? 0 : Date.parse(lastDreamAt)
  return Number.isNaN(last) || now.getTime() - last >= DREAM_MIN_INTERVAL_MS
}
