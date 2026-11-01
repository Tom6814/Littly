/**
 * §内心状态 — 纯规则的「此刻状态」小状态机（零 LLM 成本）。
 *
 * 设计参照 AstrBot self_evolution 的 persona_sim 思想（CC BY-NC 4.0，仅借鉴机制，代码全部重写）：
 * 把「她此刻累不累 / 想不想说话 / 心情如何」从模型手里拿走，交给一个确定性的数值模型；
 * 模型只负责把数值翻译成一句自然旁白（narrate），并让旁白影响语气与主动性。
 *
 * 四维：energy（活力）/ mood（心情）/ socialNeed（社交需求）/ satiety（饱腹），均为 0-100。
 * 时间推演按小时线性衰减：energy -2/h、satiety -4/h、socialNeed +3/h、mood 以 1/h 向 55 回归。
 * 互动事件（user_message / bot_spoke / ignored / rest）在推演后的状态上直接加减。
 *
 * 持久化落在 global_settings 的 `inner_state:<botId>`（JSON），坏数据一律 fail-open 回初始值。
 * 为避免「每轮对话都写一次库」，自动路径（load / record）最多每小时落库一次；事件在内存
 * 缓存中立即生效，下次落库时一并写入。显式 saveInnerState 不受节流限制（初始化/测试用）。
 */
import type { LittlyStorage } from '@littly/storage'

/** 一小时毫秒数。 */
const HOUR_MS = 3_600_000

/** 心情自然回归的目标值（不喜不悲的基线）。 */
export const MOOD_BASELINE = 55

/** 四维初始值（新角色第一次被读取时使用）。 */
export const INNER_STATE_INITIAL = Object.freeze({
  energy: 60,
  mood: 60,
  socialNeed: 40,
  satiety: 60,
})

/** 纯数值面（不含时间戳）。 */
export interface InnerStateValues {
  energy: number
  mood: number
  socialNeed: number
  satiety: number
}

/** 内心状态：四个 0-100 的维度 + 最后一次推演/事件的时间（ISO 字符串）。 */
export interface InnerState extends InnerStateValues {
  updatedAt: string
}

/** 能产生状态变化的事件。 */
export type InnerEvent = 'user_message' | 'bot_spoke' | 'ignored' | 'rest'

/** 事件对四维的增量（未列出的维度不变）。 */
const EVENT_EFFECTS: Record<InnerEvent, Partial<InnerStateValues>> = {
  user_message: { mood: 6, energy: -3, socialNeed: -22, satiety: -1 },
  bot_spoke: { energy: -4, socialNeed: -15, mood: 2 },
  ignored: { mood: -5, socialNeed: 6 },
  rest: { energy: 20, satiety: -6 },
}

/** 持久化只需要 global_settings 的键值面（便于测试注入 fake storage）。 */
export interface InnerStateStore {
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
}

interface CacheEntry {
  state: InnerState
  /** 最近一次真正落库的 epoch ms；自动路径据此做「每小时最多一次」节流。 */
  lastSavedAt: number
}

/**
 * 进程内缓存：同一次进程里 load / record 共享最新状态，事件不必每轮写库。
 * 以 storage 实例为键（WeakMap），测试里不同的临时库互不污染。
 */
const cacheByStore = new WeakMap<InnerStateStore, Map<string, CacheEntry>>()

function cacheFor(storage: InnerStateStore): Map<string, CacheEntry> {
  let cache = cacheByStore.get(storage)
  if (!cache) {
    cache = new Map()
    cacheByStore.set(storage, cache)
  }
  return cache
}

/** global_settings 里的键名。 */
export function innerStateKey(botId: string): string {
  return `inner_state:${botId}`
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 100) return 100
  return value
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function timeOf(now: Date): number {
  const t = now.getTime()
  return Number.isFinite(t) ? t : Date.now()
}

function isoOf(now: Date): string {
  return new Date(timeOf(now)).toISOString()
}

/** 新状态的工厂（updatedAt = now）。 */
export function createInitialInnerState(now = new Date()): InnerState {
  return { ...INNER_STATE_INITIAL, updatedAt: isoOf(now) }
}

/**
 * 按经过的小时数推演状态（纯函数，不写库、不读库）。
 *
 * - energy -2/h、satiety -4/h、socialNeed +3/h
 * - mood 以 1/h 向 55 回归（高于 55 就降，低于 55 就升，不会越过基线）
 * - 全部 clamp 到 0-100
 * - now 早于 updatedAt（时钟回拨）或时间戳非法时不推演，原样返回
 */
export function advance(state: InnerState, now: Date): InnerState {
  const from = Date.parse(state.updatedAt)
  const to = timeOf(now)
  if (!Number.isFinite(from) || to <= from) return { ...state }
  const hours = (to - from) / HOUR_MS
  const mood = state.mood > MOOD_BASELINE
    ? Math.max(MOOD_BASELINE, state.mood - hours)
    : state.mood < MOOD_BASELINE
      ? Math.min(MOOD_BASELINE, state.mood + hours)
      : MOOD_BASELINE
  return {
    energy: round2(clampPercent(state.energy - 2 * hours)),
    mood: round2(clampPercent(mood)),
    socialNeed: round2(clampPercent(state.socialNeed + 3 * hours)),
    satiety: round2(clampPercent(state.satiety - 4 * hours)),
    updatedAt: new Date(to).toISOString(),
  }
}

/**
 * 把一个事件叠加到状态上（纯函数，不修改入参）。
 * 未识别的事件（JS 调用方绕过类型）原样返回，保证 fail-open。
 */
export function applyEvent(state: InnerState, event: InnerEvent): InnerState {
  const delta = EVENT_EFFECTS[event]
  if (!delta) return { ...state }
  return {
    energy: round2(clampPercent(state.energy + (delta.energy ?? 0))),
    mood: round2(clampPercent(state.mood + (delta.mood ?? 0))),
    socialNeed: round2(clampPercent(state.socialNeed + (delta.socialNeed ?? 0))),
    satiety: round2(clampPercent(state.satiety + (delta.satiety ?? 0))),
    updatedAt: state.updatedAt,
  }
}

interface NarrationCue {
  score: number
  text: string
  tail: string
}

/**
 * 把数值翻译成 1-2 句中文「此刻状态」旁白（纯函数，确定性）。
 *
 * 只挑阈值命中、信息量最大的 2-3 项，不直接把数字念出来；每项带一句行为倾向，
 * 让模型知道这份状态该怎样影响语气与主动性。
 */
export function narrate(state: InnerState): string {
  const cues: NarrationCue[] = []
  const push = (score: number, text: string, tail: string): void => {
    cues.push({ score, text, tail })
  }

  if (state.energy <= 25) push(90, '累得厉害，眼皮都沉', '不太想主动开口，回话也会短一点')
  else if (state.energy <= 45) push(62, '有点累，精神头不太足', '不太想主动开口，回话也会短一点')
  else if (state.energy >= 82) push(78, '精神头很足，身上有劲', '整个人是松快的，愿意多聊几句')

  if (state.mood <= 28) push(92, '心里闷闷的，高兴不起来', '对什么都提不起兴致，语气会淡一些')
  else if (state.mood <= 42) push(64, '心情有点低落', '对什么都提不起兴致，语气会淡一些')
  else if (state.mood >= 76) push(70, '心情挺轻快', '看什么都顺眼些，说话也软一点')
  else if (state.mood >= 64) push(57, '心情还不错', '看什么都顺眼些，说话也软一点')

  if (state.socialNeed >= 72) push(88, '好久没跟人说话了，心里空落落的', '有点想主动找人说点什么')
  else if (state.socialNeed >= 55) push(60, '有点想找人聊两句', '有点想主动找人说点什么')
  else if (state.socialNeed <= 20) push(55, '刚跟人聊过，心里没那么空', '')

  if (state.satiety <= 28) push(86, '肚子饿得发慌，很想吃点东西', '心思有点被饿意牵着走')
  else if (state.satiety <= 42) push(61, '肚子有点饿', '心思有点被饿意牵着走')
  else if (state.satiety >= 85) push(60, '吃得饱饱的，很踏实', '整个人懒洋洋的，不想动')

  if (cues.length === 0) return '此刻状态平平，不累也不亢奋，心里还算安静。'

  // score 降序；同分时保持上面的固定维度顺序（Array#sort 在现代 V8 是稳定排序）。
  cues.sort((a, b) => b.score - a.score)
  const picked = cues.slice(0, 3)
  const sentence = `此刻${picked.map((cue) => cue.text).join('，')}。`
  // 三项已经够长时不再追加行为倾向，保持 1-2 句。
  const tail = picked.length < 3 ? (picked[0]?.tail ?? '') : ''
  return tail ? `${sentence}${tail}。` : sentence
}

function parseInnerState(raw: string | null): InnerState | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    const numbers = [record['energy'], record['mood'], record['socialNeed'], record['satiety']]
    if (!numbers.every((value) => typeof value === 'number' && Number.isFinite(value))) return null
    const updatedAt = typeof record['updatedAt'] === 'string' ? Date.parse(record['updatedAt']) : NaN
    if (!Number.isFinite(updatedAt)) return null
    return {
      energy: round2(clampPercent(record['energy'] as number)),
      mood: round2(clampPercent(record['mood'] as number)),
      socialNeed: round2(clampPercent(record['socialNeed'] as number)),
      satiety: round2(clampPercent(record['satiety'] as number)),
      updatedAt: new Date(updatedAt).toISOString(),
    }
  } catch {
    return null
  }
}

function normalizeForSave(state: InnerState, now: Date): InnerState {
  const at = timeOf(now)
  const stamp = Date.parse(state.updatedAt)
  return {
    energy: round2(clampPercent(state.energy)),
    mood: round2(clampPercent(state.mood)),
    socialNeed: round2(clampPercent(state.socialNeed)),
    satiety: round2(clampPercent(state.satiety)),
    // 不接受未来时间戳：落库时的状态「截至现在」。
    updatedAt: !Number.isFinite(stamp) || stamp > at ? new Date(at).toISOString() : new Date(stamp).toISOString(),
  }
}

function ensureEntry(storage: InnerStateStore, botId: string, now: Date): CacheEntry {
  const cache = cacheFor(storage)
  const cached = cache.get(botId)
  if (cached) {
    cached.state = advance(cached.state, now)
    return cached
  }

  const parsed = parseInnerState(storage.getSetting(innerStateKey(botId)))
  const at = timeOf(now)
  if (!parsed) {
    // 不存在或坏数据：初始化并立刻保存一次（后续写入走小时级节流）。
    const state = createInitialInnerState(now)
    storage.setSetting(innerStateKey(botId), JSON.stringify(state))
    const entry: CacheEntry = { state, lastSavedAt: at }
    cache.set(botId, entry)
    return entry
  }

  const state = advance(parsed, now)
  const entry: CacheEntry = { state, lastSavedAt: Date.parse(parsed.updatedAt) }
  cache.set(botId, entry)
  return entry
}

/** 自动路径的小时级落库节流；由 updatedAt/最近落库时间控制。 */
function persistIfDue(storage: InnerStateStore, botId: string, entry: CacheEntry, now: Date): void {
  const at = timeOf(now)
  if (at - entry.lastSavedAt < HOUR_MS) return
  storage.setSetting(innerStateKey(botId), JSON.stringify(entry.state))
  entry.lastSavedAt = at
}

/**
 * 读取并推进到 now。状态不存在时初始化并保存；存在且距上次落库 ≥1 小时时顺带落库。
 * 坏 JSON / 坏形状一律按「不存在」处理，回到初始值（fail-open）。
 */
export function loadInnerState(
  storage: InnerStateStore | LittlyStorage,
  botId: string,
  now = new Date(),
): InnerState {
  const stateStore = storage as InnerStateStore
  const entry = ensureEntry(stateStore, botId, now)
  persistIfDue(stateStore, botId, entry, now)
  return entry.state
}

/** 显式保存（不受小时节流限制）。会 clamp 越界值、拒绝未来时间戳。 */
export function saveInnerState(
  storage: InnerStateStore | LittlyStorage,
  botId: string,
  state: InnerState,
  now = new Date(),
): void {
  const stateStore = storage as InnerStateStore
  const normalized = normalizeForSave(state, now)
  stateStore.setSetting(innerStateKey(botId), JSON.stringify(normalized))
  cacheFor(stateStore).set(botId, { state: normalized, lastSavedAt: timeOf(now) })
}

/**
 * 记录一次事件：先推进到 now，再叠加事件；自动落库最多每小时一次。
 * 返回事件后的最新状态（当前进程内立即可见）。
 */
export function recordInnerEvent(
  storage: InnerStateStore | LittlyStorage,
  botId: string,
  event: InnerEvent,
  now = new Date(),
): InnerState {
  const stateStore = storage as InnerStateStore
  const entry = ensureEntry(stateStore, botId, now)
  const stampedAt = Math.max(Date.parse(entry.state.updatedAt) || 0, timeOf(now))
  const next: InnerState = {
    ...applyEvent(entry.state, event),
    updatedAt: new Date(stampedAt).toISOString(),
  }
  entry.state = next
  persistIfDue(stateStore, botId, entry, now)
  return next
}
