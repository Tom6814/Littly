/**
 * §成长档案 — 潜意识评估器（月度评审 + 手动触发）。
 *
 * 逐字移植自旧项目 src/internal/growth/evaluator.ts（仅 DB 访问层改为 SQL）。
 * 流程：守卫(月底窗口/本月已评/pending) → 证据收集 → 潜意识评审(无人格身份,
 * 方向中立, 允许 noChange) → 事实审计 → 对抗质询实例(常开) → 服务端铁律硬校验 →
 * 落库 pending 提案。提案永不静默生效（D9），等用户审批。
 * fail-open：任何失败只审计日志，绝不阻断调用方管线。
 */
import type { LittlyStorage } from '@littly/storage'
import { chatComplete, getAIConfig, type ChatMessage } from '@littly/llm'
import { cardDigestText, ensureGrowthProfile } from './dimensions.ts'
import { auditEvidence } from './audit.ts'
import {
  MAX_LEVEL_STEP,
  MAX_TOTAL_DISPLACEMENT,
  MIN_EVIDENCE_PER_CHANGE,
  PROPOSAL_EXPIRY_MS,
  parseDimensions,
  parseChanges,
  validateProposalChanges,
  validateValueExclusions,
} from './types.ts'
import { isMonthEndWindow, nextMonthEnd, shanghaiMonthKey, fmtShanghai } from './timing.ts'
import {
  activeProfile,
  createProposal,
  expireStaleProposals,
  firstProfile,
  lastTouchProposal,
  listProposalsByStatus,
  pendingProposal,
  setProposalStatus,
  writeAudit,
} from './store.ts'
import type { GrowthChange, AdversarialVerdict } from './types.ts'

const EVAL_MAX_TOKENS = 2000
const ADVERSARIAL_MAX_TOKENS = 600
const EVIDENCE_MEM_CAP = 120

export type EvalTrigger = 'monthly' | 'event' | 'manual'

export interface EvalOutcome {
  status: 'created' | 'nochange' | 'skip' | 'adversarial-rejected' | 'error'
  reason: string
  proposalId?: string
}

interface EvalBotRow {
  id: string
  name: string
  character_id: string | null
  ai_model: string
}

interface EvalCharacterRow {
  id: string
  data: string
}

interface EvalMemoryRow {
  id: string
  category: string
  importance: number
  content: string
  created_at: string
}

interface EvalDiaryRow {
  date: string
  content: string
}

interface EvalContactRow {
  name: string
  sender: string
  brief: string
  is_owner: number
}

/** 潜意识专用模型：全局 growth_model 优先，未配置则回退到角色聊天模型。 */
async function resolveGrowthModel(storage: LittlyStorage, fallback?: string): Promise<string> {
  const cfg = await getAIConfig(storage)
  return cfg.growthModel || fallback || cfg.chatModel || ''
}

/**
 * 月度定时入口：scheduler tick 调用。对所有挂了角色卡的 bot：
 * 先确保档案存在（seed），再按每月月底窗口评审。
 */
export async function growthTick(
  storage: LittlyStorage,
  now = new Date(),
): Promise<{ evaluated: number; created: number }> {
  let evaluated = 0
  let created = 0
  try {
    expireStaleProposals(storage)
    const bots = storage
      .prepare("SELECT * FROM bots WHERE character_id IS NOT NULL AND character_id != ''")
      .all() as unknown as EvalBotRow[]
    for (const bot of bots) {
      try {
        await ensureGrowthProfile(storage, bot.id, bot.ai_model || undefined)
        const outcome = await runGrowthEvaluation(storage, bot.id, 'monthly', now)
        if (outcome.status !== 'skip' && outcome.status !== 'error') evaluated++
        if (outcome.status === 'created') created++
      } catch (e) {
        console.warn(`[growth] tick failed for ${bot.id}:`, e instanceof Error ? e.message : e)
      }
    }
  } catch (e) {
    console.warn('[growth] tick scan failed:', e instanceof Error ? e.message : e)
  }
  return { evaluated, created }
}

/** 单次评审。trigger=manual 时豁免间隔守卫（其余守卫保留）。 */
export async function runGrowthEvaluation(
  storage: LittlyStorage,
  botId: string,
  trigger: EvalTrigger,
  now = new Date(),
): Promise<EvalOutcome> {
  const bot = storage.prepare('SELECT * FROM bots WHERE id = ?').get(botId) as EvalBotRow | undefined
  if (!bot?.character_id) return { status: 'skip', reason: '未绑定角色卡' }
  const character = storage.prepare('SELECT * FROM characters WHERE id = ?').get(bot.character_id) as EvalCharacterRow | undefined
  if (!character) return { status: 'skip', reason: '角色卡不存在' }
  const cardText = cardDigestText(character.data)
  if (!cardText) return { status: 'skip', reason: '角色卡内容为空' }

  // --- 守卫 ---
  const pending = pendingProposal(storage, botId)
  if (pending) return { status: 'skip', reason: '已有待审提案，先处理再评审' }

  const active = activeProfile(storage, botId)
  if (!active) return { status: 'skip', reason: '尚无成长档案（先生成初始档案）' }

  // 被取消的提案视为从未发生：不参与成长事件计时，不影响后续评审（§取消无后效）
  const lastTouchCandidates = [
    new Date(active.created_at).getTime(),
    (() => {
      const p = lastTouchProposal(storage, botId, active.created_at)
      return p ? new Date(p.created_at).getTime() : undefined
    })(),
  ].filter((t): t is number => typeof t === 'number')
  const lastTouch = lastTouchCandidates.length
    ? Math.max(...lastTouchCandidates)
    : new Date(active.created_at).getTime()

  if (trigger === 'monthly') {
    // 每月月底（中国时区）结算：窗口 = 本月最后一天 22:00 ~ 次月 3 日（补跑）。
    if (!isMonthEndWindow(now)) {
      return { status: 'skip', reason: `下次评审：${fmtShanghai(nextMonthEnd(now))}（每月月底）` }
    }
    // 本月是否已评审：最近一次非 cancelled 提案是否落在这个自然月
    const lastReview = lastTouchProposal(storage, botId, active.created_at)
    if (lastReview && shanghaiMonthKey(new Date(lastReview.created_at)) === shanghaiMonthKey(now)) {
      return { status: 'skip', reason: '本月已完成评审' }
    }
  }

  // --- 证据收集（时间窗：上次成长事件 → 现在） ---
  const windowStartIso = new Date(lastTouch).toISOString()
  const memRows = storage
    .prepare(
      "SELECT id, category, importance, content, created_at FROM memories WHERE bot_id = ? AND deleted_at IS NULL AND created_at >= ? AND (importance >= 3 OR category IN ('thought','value','relationship')) ORDER BY created_at DESC LIMIT ?",
    )
    .all(botId, windowStartIso, EVIDENCE_MEM_CAP) as unknown as EvalMemoryRow[]
  const diaries = storage
    .prepare('SELECT date, content FROM diaries WHERE bot_id = ? AND date >= ? ORDER BY date ASC')
    .all(botId, windowStartIso) as unknown as EvalDiaryRow[]
  const contacts = storage
    .prepare('SELECT name, sender, brief, is_owner FROM contacts WHERE bot_id = ?')
    .all(botId) as unknown as EvalContactRow[]

  const mems = memRows.reverse() // 时间正序
  if (mems.length === 0 && diaries.length === 0) {
    return { status: 'skip', reason: '本期没有可用的经历材料' }
  }

  const validEvidenceIds = new Set(mems.map((m) => m.id))
  const evidenceLines = mems.map((m) => `[${m.id}] (${m.category}·${m.importance}★·${m.created_at.slice(0, 10)}) ${m.content}`)
  const diaryLines = diaries.map((d) => `【${d.date.slice(0, 10)} 日记】${d.content.slice(0, 400)}`)
  const contactLines = contacts.map((c) => `${c.is_owner ? '★主人' : '联系人'} ${c.name || c.sender}：${c.brief || '（暂无简介）'}`)

  const baseDims = parseDimensions(active.dimensions)
  const dimsText = baseDims.map((d) => `- ${d.key} ${d.level}/5 —— ${d.desc}`).join('\n')
  const lifeStageText = active.life_stage ? `\n人生阶段：${active.life_stage}` : ''

  // --- 潜意识评审 ---
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `你是她的潜意识——她内心深处的一部分，她自己意识不到你的存在，你也不等同于她本人。

你不是她，也不是观察她的旁观者。你不带入她的人格、性格、情绪或立场，不用她的口吻思考，不替她做任何决定。你只是感知她的经历，然后如实沉淀：这些经历正在改变她人格底层的哪些倾向。她永远不会知道你在运作，也不需要知道。

你的工作不是评价她、评判她，也不是以她的身份说话。你只是感受：这段时间在她身上发生了什么，那会在她身上留下什么痕迹。

最重要的原则：
- 你只能依据【经历材料】里的真实内容。材料里没有的事，一律当作没有发生；你不知道的事，就是不知道。绝不脑补、补全、虚构任何细节。
- 变化没有任何方向限制，也完全没有倾向。人可以因经历变得更温柔、更勇敢，也可以变得更冷漠、更封闭、更多疑、更偏执。正面、负面、中性——全都可能，你不需要偏向任何一边，不需要替她"变得更好"，也不需要"避免她变坏"。你要做的只是顺着事实本身的指向：事实把她的经历推向哪个方向，你就如实沉淀哪个方向。
- 性格是她的底色，经历是刻痕。底色很难变，刻痕会积累。风平浪静就没有痕迹——没有足够的支撑时，宁可不变，也不要为了交差而虚构变化。
- noChange（changes 为空）是完全正常且常见的结果——大多数月份，她身上并没有可沉淀的变化。输出空 changes 不是失败，是如实；不要为了"显得有进展"而硬凑变化。

下面的材料用来让你理解"她是谁"：角色卡是她的人格设定，成长档案是她目前沉淀出的样子，经历材料是这段时间真实发生过的事。你读这些材料是为了感知她，不是为了成为她，也不要把这些设定当成你自己的身份。

【沉淀规则】（服务端会硬校验，违反整单作废）
1. 每条沉淀必须来自至少 ${MIN_EVIDENCE_PER_CHANGE} 条真实经历佐证（用材料里方括号中的完整编号）。
2. 单个维度一次最多变化 ±${MAX_LEVEL_STEP} 级（当前共 ${baseDims.length} 维）。
3. 所有维度相对出厂基线的总位移不能超过 ${MAX_TOTAL_DISPLACEMENT} 级。
4. 触及她核心价值的变化直接不做。

【输出】只回 JSON，不要任何其他文字：
{"majorEvents":"这段时间里真正的大事，一句话","lifeStage":"若她的人生阶段变了写新的，否则原样抄回","changes":[{"dimension":"维度名","fromLevel":n,"toLevel":n,"toDesc":"变化后这个等级的行为表现","evidenceIds":["编号"],"reasoning":"这段经历把她的倾向推向哪个方向、为什么"}]}`,
    },
    {
      role: 'user',
      content: `【角色卡】\n${cardText}\n\n【当前状态 · 成长档案 v${active.version}】\n${dimsText}${lifeStageText}\n\n【本期时间窗】${windowStartIso.slice(0, 10)} → 至今\n\n【经历材料（可引用的证据）】\n${evidenceLines.join('\n') || '（无）'}\n\n【日记摘录（背景参考，不可作为证据引用）】\n${diaryLines.join('\n') || '（无）'}\n\n【联系人近况】\n${contactLines.join('\n') || '（无）'}\n\n请评审她的成长。`,
    },
  ]

  // 潜意识专用模型：全局 growth_model 优先，未配置则回退到角色聊天模型。
  // 评审 / 事实审计 / 对抗质询统一走这个模型（角色本人写报告仍用聊天模型）。
  const model = await resolveGrowthModel(storage, bot.ai_model || undefined)
  let raw = ''
  try {
    const res = await chatComplete(storage, messages, { model, temperature: 0.4, maxTokens: EVAL_MAX_TOKENS })
    const match = res.content.match(/\{[\s\S]*\}/)
    if (!match) return { status: 'error', reason: '潜意识评审未返回有效 JSON' }
    raw = match[0]
  } catch (e) {
    return { status: 'error', reason: `潜意识评审失败: ${e instanceof Error ? e.message : e}` }
  }

  let j: { majorEvents?: string; lifeStage?: string; changes?: unknown }
  try {
    j = JSON.parse(raw) as typeof j
  } catch {
    return { status: 'error', reason: '评审 JSON 解析失败' }
  }
  const changes: GrowthChange[] = parseChanges(JSON.stringify(j.changes ?? []))
  if (changes.length === 0) {
    writeAudit(storage, botId, 'evaluate_nochange', `trigger=${trigger}`)
    return { status: 'nochange', reason: '本期无变化' }
  }

  // --- 服务端硬校验（第一道：评估器输出本身，含出厂基线总位移） ---
  const seed = firstProfile(storage, botId)
  const seedDims = seed && seed.version !== active.version ? parseDimensions(seed.dimensions) : null
  const v1 = validateProposalChanges(baseDims, seedDims, changes, validEvidenceIds)
  // B10：价值禁区硬校验（空列表 = 明确 no-op）—— 触碰禁区的维度整条剔除。
  const vZone = validateValueExclusions(active.value_exclusions, changes)
  const allErrors = [...v1.errors, ...vZone.errors]
  let kept = changes.filter(
    (c) => !allErrors.some((err) => err.includes(c.dimension)),
  )
  if (kept.length === 0) {
    writeAudit(storage, botId, 'evaluate_invalid', `errors=${allErrors.join('; ')}`)
    return { status: 'adversarial-rejected', reason: `全部变更未通过铁律校验: ${allErrors.join('; ')}` }
  }

  // --- 事实审计（§幻觉治理）：对照对话原文逐条核实证据，失真证据剔除 ---
  const auditEvidenceTexts = kept
    .flatMap((c) => c.evidenceIds)
    .map((id) => {
      const m = mems.find((mm) => mm.id === id)
      return m ? `[${m.id}] (${m.category}·${m.importance}★) ${m.content}` : `[${id}]`
    })
  const audit = await auditEvidence(storage, botId, auditEvidenceTexts, model)
  const rejectedEvidence = new Set(audit.rejectEvidenceIds)
  let droppedByAudit = 0
  kept = kept.map((c) => {
    const survived = c.evidenceIds.filter((id) => !rejectedEvidence.has(id))
    if (survived.length < c.evidenceIds.length) droppedByAudit++
    // 证据被剔除后数量可能不足铁律二，这里只剔除证据，铁律二在下方按最终 keep 重放
    return { ...c, evidenceIds: survived }
  })
  kept = kept.filter((c) => c.evidenceIds.length >= MIN_EVIDENCE_PER_CHANGE)
  if (audit.verdict === 'reject' && kept.length === 0) {
    writeAudit(storage, botId, 'evaluate_invalid', `audit rejected all: ${audit.issues.join('; ')}`)
    return { status: 'adversarial-rejected', reason: `全部证据未通过事实审计: ${audit.issues.join('; ') || '无法证实'}` }
  }

  // --- 对抗质询实例（常开，第二道独立审查） ---
  const cited = kept.flatMap((c) => c.evidenceIds)
  const citedTexts = mems.filter((m) => cited.includes(m.id)).map((m) => `[${m.id}] ${m.content}`)
  const adversarial = await runAdversarial(storage, cardText, dimsText, kept, citedTexts, model)
  const survivors = kept.filter((c) => !adversarial.rejectDimensions.includes(c.dimension))
  if (survivors.length === 0) {
    writeAudit(storage, botId, 'adversarial_reject', `issues=${adversarial.issues.join('; ')}`)
    return { status: 'adversarial-rejected', reason: `对抗质询否决全部变更: ${adversarial.issues.join('; ') || '证据不支持'}` }
  }
  kept = survivors

  // --- 落库 pending 提案（永不静默生效） ---
  const proposal = createProposal(storage, {
    botId,
    basedVersion: active.version,
    changes: JSON.stringify(kept),
    meta: {
      trigger,
      adversarial,
      majorEvents: typeof j.majorEvents === 'string' ? j.majorEvents : '',
      lifeStageNext: typeof j.lifeStage === 'string' ? j.lifeStage.slice(0, 200) : '',
      evidenceIds: [...new Set(kept.flatMap((c) => c.evidenceIds))],
    },
    evaluatorModel: model,
    expiresAt: new Date(Date.now() + PROPOSAL_EXPIRY_MS).toISOString(),
  })
  writeAudit(
    storage,
    botId,
    'propose',
    `trigger=${trigger} base=v${active.version} changes=${kept.length} droppedByAdv=${changes.length - kept.length} droppedByAudit=${droppedByAudit}`,
  )
  return { status: 'created', reason: '已生成待审提案', proposalId: proposal.id }
}

async function runAdversarial(
  storage: LittlyStorage,
  cardText: string,
  dimsText: string,
  changes: GrowthChange[],
  citedTexts: string[],
  model?: string,
): Promise<AdversarialVerdict> {
  const fallback: AdversarialVerdict = { verdict: 'pass', rejectDimensions: [], issues: ['质询实例不可用，放行（服务端硬校验仍生效）'] }
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `你是独立质询实例，与提出人格变化提案的评审互不从属。你的职责是证伪，不是补充。

逐条审查以下人格变化提案，重点质疑：
1. 证据真的支持这个变化吗？还是仅仅相关？（聊过两次旅行 ≠ 性格变外向）
2. 变化是否触及角色的核心价值与性格底色？底色级变化需要压倒性证据。
3. 幅度合理吗？一个月内 ±1 级是否被证据充分撑起？
4. 是否存在积极偏见嫌疑——把中性的经历解读成了正面成长？
5. 禁捕清单：是否把「一次未解决的失败」「一时的负面情绪」错误地固化为永久特质？（人可以暂时消沉，但不能因为一周的挫折就永久「自卑 -1」）

铁律：你只能依据【被引证据原文】判断。原文里没有出现的事实，一律视为不存在。不要补全、不要脑补。

只回 JSON：
{"verdict":"pass","rejectDimensions":[],"issues":["整体意见"]}
{"verdict":"reject","rejectDimensions":["维度名"],"issues":["每个被否维度一条理由"]}`,
    },
    {
      role: 'user',
      content: `【角色卡】\n${cardText}\n\n【当前档案】\n${dimsText}\n\n【待审变更】\n${JSON.stringify(changes, null, 2)}\n\n【被引证据原文】\n${citedTexts.join('\n') || '（无）'}\n\n请质询。`,
    },
  ]
  try {
    const res = await chatComplete(storage, messages, { model, temperature: 0.3, maxTokens: ADVERSARIAL_MAX_TOKENS })
    const match = res.content.match(/\{[\s\S]*\}/)
    if (!match) return fallback
    const j = JSON.parse(match[0]) as Record<string, unknown>
    return {
      verdict: j['verdict'] === 'reject' ? 'reject' : 'pass',
      rejectDimensions: Array.isArray(j['rejectDimensions'])
        ? j['rejectDimensions'].filter((x: unknown): x is string => typeof x === 'string')
        : [],
      issues: Array.isArray(j['issues']) ? j['issues'].filter((x: unknown): x is string => typeof x === 'string') : [],
    }
  } catch {
    return fallback
  }
}

export { expireStaleProposals, listProposalsByStatus, setProposalStatus }
