/**
 * 拟人化分片（旧 sink/humanize.ts 逐字移植）。
 */
export interface HumanizeConfig {
  enabled: boolean
  maxSplits: number
  perPieceDelayMs: number
  totalDelayCapMs: number
}

export const DEFAULT_HUMANIZE: HumanizeConfig = {
  enabled: true,
  maxSplits: 6,
  perPieceDelayMs: 1200,
  totalDelayCapMs: 6000,
}

export function splitHumanized(text: string, cfg: HumanizeConfig = DEFAULT_HUMANIZE): string[] {
  if (!text) return []
  if (!cfg.enabled) return [text]

  const rawPieces = text.split(/\n+/).map((s) => s.trim()).filter(Boolean)

  const refined: string[] = []
  for (const piece of rawPieces) {
    if (!/[。！？!?；;]/.test(piece)) {
      refined.push(piece)
      continue
    }
    const sub = piece.split(/(?<=[。！？!?；;])/).map((s) => s.trim()).filter(Boolean)
    for (const s of sub) {
      if (s.length < 8 && refined.length > 0) {
        refined[refined.length - 1] += s
      } else {
        refined.push(s)
      }
    }
  }

  if (cfg.maxSplits > 0 && refined.length > cfg.maxSplits) {
    const head = refined.slice(0, cfg.maxSplits - 1)
    const tail = refined.slice(cfg.maxSplits - 1).join('\n')
    return [...head, tail]
  }
  return refined
}

export function pieceDelays(count: number, cfg: HumanizeConfig = DEFAULT_HUMANIZE): number[] {
  if (count <= 1) return []
  const base = cfg.perPieceDelayMs
  const budget = cfg.totalDelayCapMs
  const slots = count - 1
  let per = Math.min(base, Math.floor(budget / slots))
  per = Math.max(per, 0)
  return Array(slots).fill(per)
}

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((r) => setTimeout(r, ms))
}

/** 旧 ai/humanize-style.ts — 聊天收尾槽位风格块（逐字）。 */
export const HUMANIZE_CHAT_STYLE = `【说话像真人】短句长句随意交错，偶尔用"嗯""对""其实吧"开头。不要列一二三、不要开头总结、结尾不要升华或提问式收束。情绪有起伏：可以烦躁、可以敷衍、可以懒得多说，别每条都热情周到。用词选具体不选抽象，允许自我更正（"不对，应该是…"）。允许碎片句：话不用说完、单个"嗯""哼""…"也算一条。但总量要克制：一次回复发出来就是 2~5 条，把想说的并进几条里，绝不一字一停连环发十几条（那是刷屏，不是真人）。不追求逻辑闭环，说不完就留到下次更自然。以上规则自然流露，别机械执行到位——太均匀本身就是机器味。`
