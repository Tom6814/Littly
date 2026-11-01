#!/usr/bin/env node
/**
 * 内心状态机验证（参照 AstrBot self_evolution 的纯规则 persona_sim 思想，代码为独立重写）。
 * 运行：node scripts/verify-inner-state.mjs
 *
 * 覆盖：四维初始值 / 小时衰减与 clamp / 事件效果与纯函数性 / narrate 阈值·确定性·1-2 句 /
 *       持久化 roundtrip（fake + 临时 SQLite）/ 每小时最多落库一次 / 坏 JSON fail-open /
 *       层装配顺序 / 身份确认行 / buildPrompt 集成。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LittlyStorage } from '../packages/littly/storage/src/index.ts'
import { LittlyPersona } from '../packages/littly/persona/src/index.ts'
import {
  advance,
  applyEvent,
  createInitialInnerState,
  INNER_STATE_INITIAL,
  innerStateKey,
  loadInnerState,
  narrate,
  recordInnerEvent,
  saveInnerState,
} from '../packages/littly/persona/src/inner-state.ts'
import {
  assembleSystemPrompt,
  buildCurrentContactLayer,
  buildInnerStateLayer,
  buildPersonaLayers,
} from '../packages/littly/persona/src/layers.ts'

let pass = 0
let fail = 0
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? `（${detail}）` : ''}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? `（${detail}）` : ''}`) }
}
const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps
const sentenceCount = (text) => text.split(/[。！？]/).map((s) => s.trim()).filter(Boolean).length

const t0 = new Date('2026-11-01T08:00:00+08:00')
const t0Iso = t0.toISOString()
const hoursLater = (h) => new Date(t0.getTime() + h * 3_600_000)
const stateAt = (h) => advance(createInitialInnerState(t0), hoursLater(h))

class FakeStore {
  constructor(entries = new Map()) {
    this.values = new Map(entries)
    this.writes = 0
  }
  getSetting(key) { return this.values.get(key) ?? null }
  setSetting(key, value) { this.writes++; this.values.set(key, value) }
}

console.log('== 初始值 ==')
{
  const initial = createInitialInnerState(t0)
  ok(initial.energy === 60 && initial.mood === 60 && initial.socialNeed === 40 && initial.satiety === 60, '初始值 60/60/40/60')
  ok(initial.updatedAt === t0Iso, 'updatedAt 初始化为 now')
  ok(INNER_STATE_INITIAL.energy === 60 && Object.isFrozen(INNER_STATE_INITIAL), 'INNER_STATE_INITIAL 只读导出')
  ok([initial.energy, initial.mood, initial.socialNeed, initial.satiety].every((v) => v >= 0 && v <= 100), '四维都在 0-100')
}

console.log('== 小时衰减 ==')
{
  const one = stateAt(1)
  ok(one.energy === 58, 'energy -2/h')
  ok(one.mood === 59, 'mood 向 55 回归 1/h')
  ok(one.socialNeed === 43, 'socialNeed +3/h')
  ok(one.satiety === 56, 'satiety -4/h')
  ok(one.updatedAt === hoursLater(1).toISOString(), 'updatedAt 推进到 now')

  const half = stateAt(0.5)
  ok(half.energy === 59 && half.mood === 59.5 && half.socialNeed === 41.5 && half.satiety === 58, '半小时按比例衰减')

  const twelve = stateAt(12)
  ok(twelve.energy === 36, '12h energy 60→36')
  ok(twelve.socialNeed === 76, '12h socialNeed 40→76（越过孤独阈值）')
  ok(twelve.mood === 55, '12h mood 恰好回归到 55，不越过基线')

  const thirty = stateAt(30)
  ok(thirty.mood === 55, 'mood 长期保持 55（不会跌破基线）')

  const day = stateAt(24)
  ok(day.socialNeed === 100, 'socialNeed 上限 clamp 到 100')
  ok(day.satiety === 0, 'satiety 下限 clamp 到 0')

  const long = stateAt(72)
  ok(long.energy === 0, 'energy 下限 clamp 到 0')

  const negative = { energy: 10, mood: 10, socialNeed: 90, satiety: 10, updatedAt: t0Iso }
  const recovered = advance(negative, hoursLater(10))
  ok(recovered.energy === 0 && recovered.satiety === 0, '低值继续衰减不会变成负数')
  ok(recovered.socialNeed === 100, '高值继续增长不会超过 100')
  ok(recovered.mood === 20, 'mood 低于 55 时按 1/h 回升')

  const same = advance(createInitialInnerState(t0), t0)
  ok(same.energy === 60 && same.updatedAt === t0Iso, 'now == updatedAt 时状态不变')

  const rollback = advance(createInitialInnerState(t0), hoursLater(-2))
  ok(rollback.energy === 60 && rollback.updatedAt === t0Iso, '时钟回拨不产生反向推演')

  const invalid = advance({ ...createInitialInnerState(t0), updatedAt: 'not-a-time' }, hoursLater(5))
  ok(invalid.energy === 60 && invalid.updatedAt === 'not-a-time', '非法 updatedAt fail-open 原样返回')
}

console.log('== 事件效果 ==')
{
  const initial = createInitialInnerState(t0)
  const user = applyEvent(initial, 'user_message')
  ok(user.mood === 66 && user.energy === 57 && user.socialNeed === 18 && user.satiety === 59, 'user_message：mood+6/energy-3/social-22/satiety-1')

  const spoke = applyEvent(initial, 'bot_spoke')
  ok(spoke.energy === 56 && spoke.socialNeed === 25 && spoke.mood === 62 && spoke.satiety === 60, 'bot_spoke：energy-4/social-15/mood+2')

  const ignored = applyEvent(initial, 'ignored')
  ok(ignored.mood === 55 && ignored.socialNeed === 46 && ignored.energy === 60, 'ignored：mood-5/social+6')

  const rest = applyEvent(initial, 'rest')
  ok(rest.energy === 80 && rest.satiety === 54 && rest.mood === 60, 'rest：energy+20/satiety-6')

  const capped = applyEvent({ energy: 99, mood: 99, socialNeed: 1, satiety: 2, updatedAt: t0Iso }, 'user_message')
  ok(capped.energy === 96 && capped.mood === 100 && capped.socialNeed === 0 && capped.satiety === 1, '事件后 clamp 到 0-100')

  const untouched = createInitialInnerState(t0)
  applyEvent(untouched, 'user_message')
  ok(untouched.mood === 60 && untouched.socialNeed === 40, 'applyEvent 不修改入参（纯函数）')

  const unknown = applyEvent(initial, 'not_an_event')
  ok(unknown !== initial && unknown.mood === 60, '未知事件 fail-open（返回副本）')
}

console.log('== narrate（阈值 / 确定性 / 句数）==')
{
  const initialText = narrate(createInitialInnerState(t0))
  ok(initialText.includes('状态平平'), '初始状态给平淡旁白')
  ok(initialText === narrate(createInitialInnerState(t0)), 'narrate 确定性：同状态同文本')
  ok(!/\d/.test(initialText), '旁白不出现数字（不直译数值）')
  ok(sentenceCount(initialText) >= 1 && sentenceCount(initialText) <= 2, '旁白 1-2 句')

  const lonelyTired = stateAt(12)
  const tiredText = narrate(lonelyTired)
  ok(tiredText.includes('累'), 'energy<=45 出现疲惫口吻')
  ok(tiredText.includes('想') && tiredText.includes('说话'), 'socialNeed>=72 出现想找人说话的念头')
  ok(tiredText.includes('饿'), 'satiety<=28 出现饿意')
  ok(tiredText === narrate(lonelyTired), '固定时钟推演后旁白确定')
  const cueHits = ['累', '想找人', '饿', '闷', '精神'].filter((word) => tiredText.includes(word)).length
  ok(cueHits <= 3, '最多挑 3 项状态（命中主题 ≤3）')
  ok(tiredText.length <= 120, '旁白保持短句，不堆成状态清单')
  ok(sentenceCount(tiredText) >= 1 && sentenceCount(tiredText) <= 2, '多阈值命中仍保持 1-2 句')

  const low = narrate({ energy: 20, mood: 20, socialNeed: 80, satiety: 20, updatedAt: t0Iso })
  ok(low.includes('闷') || low.includes('低落'), 'mood 低出现情绪低落口吻')

  const high = narrate({ energy: 90, mood: 90, socialNeed: 30, satiety: 60, updatedAt: t0Iso })
  ok(high.includes('精神') && high.includes('轻快'), '高活力高心情出现正面口吻')

  const hungry = narrate({ energy: 60, mood: 60, socialNeed: 40, satiety: 30, updatedAt: t0Iso })
  ok(hungry.includes('饿'), '低饱腹出现饿意')

  const boundary45 = narrate({ energy: 45, mood: 55, socialNeed: 40, satiety: 60, updatedAt: t0Iso })
  const boundary46 = narrate({ energy: 46, mood: 55, socialNeed: 40, satiety: 60, updatedAt: t0Iso })
  ok(boundary45 !== boundary46 && boundary45.includes('累'), 'energy 阈值 45 是边界（45 命中 / 46 不命中）')

  const userText = narrate(applyEvent(createInitialInnerState(t0), 'user_message'))
  ok(userText.includes('心情') && userText.includes('刚跟人聊过'), 'user_message 后旁白体现心情与社交满足')
}

console.log('== 持久化：fake storage / 每小时最多落库一次 ==')
{
  const store = new FakeStore()
  const first = loadInnerState(store, 'bot-1', t0)
  ok(first.energy === 60 && store.writes === 1, '不存在的状态初始化并保存一次')
  const raw = store.getSetting(innerStateKey('bot-1'))
  ok(raw && JSON.parse(raw).updatedAt === t0Iso, '落库 key=inner_state:<botId> 且为合法 JSON')

  const second = loadInnerState(store, 'bot-1', hoursLater(0.5))
  ok(second.energy === 59 && store.writes === 1, '同一小时内再次 load 不写库（内存推进）')

  const afterEvent = recordInnerEvent(store, 'bot-1', 'user_message', hoursLater(0.5))
  ok(close(afterEvent.socialNeed, 19.5) && afterEvent.updatedAt === hoursLater(0.5).toISOString(), 'record 返回事件后状态且带 now 时间戳')
  ok(store.writes === 1, '同一小时内记录事件不写库（节流）')

  const flushed = loadInnerState(store, 'bot-1', hoursLater(1.1))
  ok(store.writes === 2, '距上次落库 ≥1h 才再次写库')
  ok(flushed.mood > 62 && flushed.socialNeed < 25, '落库内容包含上一小时事件的效果')

  // 模拟进程重启：新 storage 实例从同一份值读取
  const reopened = new FakeStore(new Map(store.values))
  const roundtrip = loadInnerState(reopened, 'bot-1', hoursLater(1.1))
  ok(close(roundtrip.energy, flushed.energy) && close(roundtrip.mood, flushed.mood), '进程重启后从 JSON 恢复状态（roundtrip）')

  const explicit = new FakeStore()
  saveInnerState(explicit, 'bot-2', { energy: 12, mood: 88, socialNeed: 77, satiety: 34, updatedAt: t0Iso }, t0)
  const explicitRead = loadInnerState(new FakeStore(explicit.values), 'bot-2', t0)
  ok(explicitRead.energy === 12 && explicitRead.mood === 88 && explicitRead.socialNeed === 77, 'saveInnerState 显式 roundtrip')

  const badJson = new FakeStore()
  badJson.setSetting(innerStateKey('bot-3'), '{not json')
  const failOpen = loadInnerState(badJson, 'bot-3', t0)
  ok(failOpen.energy === 60 && failOpen.mood === 60 && failOpen.socialNeed === 40 && failOpen.satiety === 60, '坏 JSON fail-open 回初始值')
  ok(JSON.parse(badJson.getSetting(innerStateKey('bot-3'))).energy === 60, '坏 JSON 已被初始值覆盖')

  const badShape = new FakeStore()
  badShape.setSetting(innerStateKey('bot-4'), JSON.stringify({ energy: '60', mood: 60, socialNeed: 40, satiety: 60, updatedAt: t0Iso }))
  ok(loadInnerState(badShape, 'bot-4', t0).energy === 60, '字段类型不对 fail-open 回初始值')

  const noStamp = new FakeStore()
  noStamp.setSetting(innerStateKey('bot-5'), JSON.stringify({ energy: 10, mood: 20, socialNeed: 30, satiety: 40 }))
  ok(loadInnerState(noStamp, 'bot-5', t0).energy === 60, '缺 updatedAt fail-open 回初始值')

  const outOfRange = new FakeStore()
  outOfRange.setSetting(innerStateKey('bot-6'), JSON.stringify({ energy: 120, mood: -5, socialNeed: 999, satiety: 50, updatedAt: t0Iso }))
  const clamped = loadInnerState(outOfRange, 'bot-6', t0)
  ok(clamped.energy === 100 && clamped.mood === 0 && clamped.socialNeed === 100 && clamped.satiety === 50, '越界持久化值 clamp 到 0-100')
}

console.log('== 持久化：临时 SQLite（global_settings）==')
const dir = mkdtempSync(join(tmpdir(), 'littly-inner-state-'))
let sqliteStorage
{
  const file = join(dir, 'inner.db')
  sqliteStorage = new LittlyStorage({ logger: { info: () => {} } }, { file })
  const st = loadInnerState(sqliteStorage, 'bot-sql', t0)
  ok(st.energy === 60 && sqliteStorage.getSetting(innerStateKey('bot-sql')) !== null, '真实 SQLite 初始化写入 global_settings')

  recordInnerEvent(sqliteStorage, 'bot-sql', 'bot_spoke', hoursLater(0.2))
  const advanced = loadInnerState(sqliteStorage, 'bot-sql', hoursLater(1.2))
  const persisted = JSON.parse(sqliteStorage.getSetting(innerStateKey('bot-sql')))
  ok(persisted.energy === advanced.energy && persisted.socialNeed === advanced.socialNeed, '真实 SQLite 小时级落库内容与内存一致')
  sqliteStorage.close()
}

console.log('== 层装配 / 身份确认 ==')
{
  const contact = {
    id: 'c-1', bot_id: 'bot-i', sender: 'wxid-linwan', name: '林晚', brief: '老朋友', profile: '',
    external_id: '', is_owner: 0, blocked: 0, user_id: null, channel: 'wechat', tg_username: '',
    metadata: '{}', created_at: t0Iso, updated_at: t0Iso,
  }
  const currentContactLayer = buildCurrentContactLayer(contact, [])
  ok(
    currentContactLayer.includes('【身份确认】现在和你说话的人就是「林晚」（微信）'),
    '联系人层含身份确认行（名字+渠道）',
  )
  ok(currentContactLayer.includes('历史里提到的其他名字/旧联系人不是当前说话者'), '身份确认行含防串档说明')

  const unknownContactLayer = buildCurrentContactLayer(null, [])
  ok(unknownContactLayer.includes('「这个人」'), 'contact 为空时身份确认用「这个人」')

  const innerLayer = buildInnerStateLayer('此刻有点累，想找人说话。')
  ok(innerLayer.includes('# 内心状态') && innerLayer.includes('此刻有点累，想找人说话。'), 'buildInnerStateLayer 包含 narrate 文本')
  ok(innerLayer.includes('状态只影响语气与主动性，不要向对方报数值'), '内心状态层含「不报数值」约束')
  ok(buildInnerStateLayer('   ') === '', '空旁白不产生层')

  const assembled = assembleSystemPrompt({
    worldBefore: [],
    worldbook: [],
    currentContact: 'CURRENT-CONTACT',
    innerState: 'INNER-STATE',
    historyDigest: 'DIGEST',
  })
  const iContact = assembled.indexOf('CURRENT-CONTACT')
  const iInner = assembled.indexOf('INNER-STATE')
  const iDigest = assembled.indexOf('DIGEST')
  ok(iContact >= 0 && iInner > iContact && iDigest > iInner, '层顺序：当前联系人 → [2.45] 内心状态 → 滚动摘要')

  const layers = buildPersonaLayers({
    bot: { id: 'bot-i', name: '小满', memory_scope: 'global', ai_model: '', system_prompt: '' },
    rule: null,
    character: null,
    worldEntries: [],
    contacts: [contact],
    relations: [],
    currentContact: contact,
    currentMemories: [],
    innerStateText: innerLayer,
    haystack: '',
    channel: 'wechat',
  })
  ok(layers.innerState === innerLayer && layers.currentContact.includes('【身份确认】'), 'buildPersonaLayers 透传内心状态层')
}

console.log('== buildPrompt 集成 ==')
{
  const file = join(dir, 'prompt.db')
  const storage = new LittlyStorage({ logger: { info: () => {} } }, { file })
  storage.prepare('INSERT INTO bots (id, name, created_at) VALUES (?, ?, ?)').run('bot-i', '小满', t0Iso)
  storage.prepare(
    'INSERT INTO contacts (id, bot_id, sender, name, brief, channel, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
  ).run('c-1', 'bot-i', 'wxid-linwan', '林晚', '老朋友', 'wechat', t0Iso, t0Iso)

  const persona = new LittlyPersona(storage)
  const built = persona.buildPrompt({ botId: 'bot-i', sender: 'wxid-linwan', channel: 'wechat', haystack: '', focusText: '在吗' })
  ok(built !== null, 'buildPrompt 返回提示词')
  ok(built.layers.innerState?.includes('# 内心状态'), 'buildPrompt 注入 [2.45] 内心状态层')
  ok(built.layers.innerState?.includes('心情还不错') && built.layers.innerState?.includes('刚跟人聊过'), 'buildPrompt 本轮按 user_message 更新状态')
  ok(built.system.includes('【身份确认】现在和你说话的人就是「林晚」（微信）'), '系统提示词含身份确认行')
  ok(built.system.indexOf('# 正在和你聊天的这个人') < built.system.indexOf('# 内心状态'), '系统提示词中内心状态位于当前联系人之后')

  const editable = persona.editableLayers({ botId: 'bot-i', sender: 'wxid-linwan', channel: 'wechat', haystack: '' })
  ok(editable.some((layer) => layer.id === 'innerState' && layer.name.includes('[2.45]')), '可编辑层清单包含 [2.45] 内心状态')
  storage.close()
}

rmSync(dir, { recursive: true, force: true })
console.log(`\n${fail === 0 ? '全部通过' : '存在失败'}：${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
