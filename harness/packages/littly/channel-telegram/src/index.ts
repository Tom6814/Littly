/**
 * @littly/channel-telegram — Telegram 渠道插件（仅轮询模式）。
 *
 * - 每个启用的 bot（tg_enabled=1 且有 token）一个长轮询 monitor：getUpdates，
 *   offset 持久化到 bots.tg_last_update_id（先推进游标再处理，旧行为：单条失败不卡队列）。
 * - 入站 → handleTelegramMessage → hub.enqueueBufferedMessage（缓冲窗口由 hub 调度）。
 * - 出站 → hub.registerChannel('tg', { sendText })：拟人化分条由 hub 完成，本插件只发单条。
 * - 自愈：60s 幂等扫描 bots 表，补启缺失的 monitor（进程重启 / bot 后台启用均覆盖）。
 * - Webhook 模式暂不实现（今晚只做 polling），配置为 webhook 时打警告。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { BotRow, LittlyStorage } from '@littly/storage'
import type { LittlyHub } from '@littly/agents'
import { handleTelegramMessage, type TgChannelDeps } from './inbound.ts'
import { resolveTgChatId, tgCall, tgGetMe, tgSendMessage, type TgUpdate } from './telegram.ts'

export const name = 'littly-channel-telegram'

export const inject = ['littlyStorage', 'littlyHub']

export interface Config {
  /** 轮询间隔（毫秒），下限 500 */
  pollIntervalMs: number
}

export const Config: z<Config> = z.object({
  pollIntervalMs: z.number().default(3000),
})

const SELF_HEAL_MS = 60_000

// botId → monitor 状态（进程内）
interface MonitorState {
  stopped: boolean
}
const monitors = new Map<string, MonitorState>()

// botId → { token, username } 缓存（getMe 结果；token 变更自动失效）
interface UsernameCache {
  token: string
  username: string
}
const usernameCache = new Map<string, UsernameCache>()

// webhook 警告去重（自愈每 60s 扫一次，同一 bot 只警告一次）
const webhookWarned = new Set<string>()

type TgPluginDeps = TgChannelDeps

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// --- bot username 懒取（群聊 @提及门需要；持久化到 bots.tg_username） ---

async function getBotUsername(deps: TgPluginDeps, bot: BotRow): Promise<string> {
  const cached = usernameCache.get(bot.id)
  if (cached && cached.token === bot.tg_bot_token) return cached.username
  if (bot.tg_username) {
    usernameCache.set(bot.id, { token: bot.tg_bot_token, username: bot.tg_username })
    return bot.tg_username
  }
  let username = ''
  try {
    const me = await tgGetMe(bot.tg_bot_token)
    username = me.username ?? ''
    if (username) {
      deps.storage.prepare('UPDATE bots SET tg_username = ? WHERE id = ?').run(username, bot.id)
      deps.log('[telegram] 已缓存 bot username: @%s (bot=%s)', username, bot.name)
    }
  } catch (err) {
    deps.log('[telegram] getMe 失败 (bot=%s): %s', bot.name, String(err))
  }
  // 失败也缓存空值，避免每条群消息都打一次 getMe
  usernameCache.set(bot.id, { token: bot.tg_bot_token, username })
  return username
}

// --- 轮询 ---

async function pollOnce(deps: TgPluginDeps, bot: BotRow, state: MonitorState): Promise<void> {
  const updates = (await tgCall<TgUpdate[]>(bot.tg_bot_token, 'getUpdates', {
    offset: bot.tg_last_update_id + 1,
    timeout: 0,
    limit: 20,
    allowed_updates: ['message'],
  })) ?? []
  for (const u of updates) {
    // 先推进 offset 再处理：即使单条处理失败也不卡死队列（旧行为）
    deps.storage.prepare('UPDATE bots SET tg_last_update_id = ? WHERE id = ?').run(u.update_id, bot.id)
    if (!u.message) continue
    try {
      await handleTelegramMessage(deps, bot, u.message)
    } catch (err) {
      deps.log('[telegram] 处理消息失败 (bot=%s): %s', bot.name, String(err))
    }
    if (state.stopped) return
  }
}

async function runMonitor(deps: TgPluginDeps, botId: string, pollIntervalMs: number): Promise<void> {
  const state: MonitorState = { stopped: false }
  if (monitors.has(botId)) return
  monitors.set(botId, state)
  try {
    for (;;) {
      if (state.stopped) return
      // 每轮重读 bot 行：后台被禁用/删除时自行退出（自愈负责补启）
      const bot = deps.storage.prepare('SELECT * FROM bots WHERE id = ?').get(botId) as BotRow | undefined
      if (!bot || !bot.tg_enabled || !bot.tg_bot_token) return
      try {
        await pollOnce(deps, bot, state)
      } catch (err) {
        deps.log('[telegram] 轮询失败 (bot=%s): %s', bot.name, String(err))
      }
      if (state.stopped) return
      await sleep(pollIntervalMs)
    }
  } finally {
    if (monitors.get(botId) === state) monitors.delete(botId)
  }
}

// --- 自愈：补启缺失 monitor（幂等） ---

async function ensureMonitors(deps: TgPluginDeps, pollIntervalMs: number): Promise<number> {
  const bots = deps.storage
    .prepare("SELECT * FROM bots WHERE tg_enabled = 1 AND tg_bot_token != ''")
    .all() as BotRow[]
  let started = 0
  for (const bot of bots) {
    if (bot.tg_mode === 'webhook') {
      if (!webhookWarned.has(bot.id)) {
        webhookWarned.add(bot.id)
        deps.log('[telegram] bot=%s 配置为 webhook 模式：webhook 暂未实现，请改用 polling', bot.name)
      }
      continue
    }
    if (monitors.has(bot.id)) continue
    void runMonitor(deps, bot.id, pollIntervalMs).catch((err) => {
      deps.log('[telegram] monitor 启动失败 (bot=%s): %s', bot.name, String(err))
    })
    started++
  }
  return started
}

// --- 出站（hub 逐片调用；本函数只发单条） ---

export async function sendTgText(
  deps: TgPluginDeps,
  botId: string,
  sender: string,
  text: string,
): Promise<{ ok: boolean; sent?: number | undefined; error?: string | undefined }> {
  const bot = deps.storage
    .prepare('SELECT tg_bot_token, tg_enabled FROM bots WHERE id = ?')
    .get(botId) as Pick<BotRow, 'tg_bot_token' | 'tg_enabled'> | undefined
  if (!bot || !bot.tg_enabled || !bot.tg_bot_token) throw new Error('Telegram 未启用')
  const chatId = resolveTgChatId(deps.storage, botId, sender)
  if (chatId == null) throw new Error('没有数字 chat_id（对方需要先给 bot 发过一条消息）')
  await tgSendMessage(bot.tg_bot_token, chatId, text)
  return { ok: true, sent: 1 }
}

// --- 插件入口 ---

export function apply(ctx: Context, config: Config): void {
  const storage = ctx.littlyStorage as LittlyStorage
  const hub = ctx.littlyHub as LittlyHub
  const pollIntervalMs = Math.max(500, Math.round(config.pollIntervalMs) || 3000)
  const log = (msg: string, ...args: unknown[]): void => ctx.logger.info(msg, ...args)
  const deps: TgPluginDeps = {
    storage,
    hub,
    log,
    getBotUsername: (bot) => getBotUsername(deps, bot),
  }

  hub.registerChannel('tg', {
    sendText: (botId, sender, text) => sendTgText(deps, botId, sender, text),
  })
  // TODO(M2)：sendPhoto（相册图 sendPhoto API）与 typing 指示器暂不实现

  // 自愈：60s 幂等扫描
  ctx.effect(() => {
    const timer = setInterval(() => {
      void ensureMonitors(deps, pollIntervalMs).catch((err) => log('[telegram] 自愈失败: %s', String(err)))
    }, SELF_HEAL_MS)
    return () => {
      clearInterval(timer)
      for (const state of monitors.values()) state.stopped = true
      monitors.clear()
    }
  }, 'littly-channel-telegram.self-heal')

  void ensureMonitors(deps, pollIntervalMs).catch((err) => log('[telegram] 启动失败: %s', String(err)))
  ctx.logger.info('littly telegram channel ready (pollInterval=%dms)', pollIntervalMs)
}
