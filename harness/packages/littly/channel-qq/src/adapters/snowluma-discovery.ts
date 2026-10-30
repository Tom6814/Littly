/**
 * 从 SnowLuma 本机安装目录自动发现 OneBot WS 端点（移植自 lane-bridge `snowluma-discovery.js`，MIT）。
 *
 * SnowLuma（默认 ~/SnowLuma 或 SNOWLUMA_HOME）把每个 QQ 账号的 OneBot 配置写在
 * `<home>/config/onebot_<uin>.json`；networks.wsServers[0] 给出 host/port/accessToken。
 * 仅读本地文件，不启动/不安装 SnowLuma。
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'

export interface DiscoveredEndpoint {
  wsUrl: string
  accessToken: string
  uin: string
  source: string
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

const CANDIDATE_HOMES = ['.snowluma', 'SnowLuma', 'snowluma']

/**
 * 自动发现 SnowLuma 的 OneBot WS 端点。
 * @param input.homeDir - SNOWLUMA_HOME；空则依次尝试 ~/.snowluma、~/SnowLuma、~/snowluma
 */
export function discoverSnowLumaEndpoint(input: { homeDir?: string; wsUrl?: string; accessToken?: string } = {}): DiscoveredEndpoint | null {
  const wsUrl = String(input.wsUrl ?? '')
  const accessToken = String(input.accessToken ?? '')
  const homes: string[] = []
  if (input.homeDir !== undefined && input.homeDir.trim() !== '') homes.push(input.homeDir.trim())
  else for (const candidate of CANDIDATE_HOMES) homes.push(path.join(homedir(), candidate))
  for (const home of homes) {
    const configDir = path.join(home, 'config')
    let entries: Array<import('node:fs').Dirent>
    try {
      entries = readdirSync(configDir, { withFileTypes: true })
    } catch {
      continue
    }
    const candidates = entries
      .filter((entry) => entry.isFile() && /^onebot_(\d+)\.json$/iu.test(entry.name))
      .map((entry) => ({ entry, uin: /^onebot_(\d+)\.json$/iu.exec(entry.name)?.[1] ?? '' }))
      .sort((a, b) => a.uin.localeCompare(b.uin))
    for (const { entry, uin } of candidates) {
      const file = path.join(configDir, entry.name)
      const config = readJson(file)
      const networks = config?.['networks'] as { wsServers?: Array<Record<string, unknown>> } | undefined
      const ws = networks?.wsServers?.[0]
      if (ws === undefined) continue
      const token = String(ws['accessToken'] ?? '')
      if (token === '' && accessToken !== '') continue
      const host = String(ws['host'] ?? '127.0.0.1')
      const port = Number(ws['port']) || 3001
      return {
        wsUrl: wsUrl !== '' ? wsUrl : `ws://${host}:${port}`,
        accessToken: accessToken !== '' ? accessToken : token,
        uin,
        source: file,
      }
    }
  }
  // 显式配置（wsUrl/accessToken）优先：即使本机没有 SnowLuma 安装目录也返回它。
  if (wsUrl !== '' || accessToken !== '') {
    return { wsUrl: wsUrl !== '' ? wsUrl : 'ws://127.0.0.1:3001', accessToken, uin: '', source: 'explicit' }
  }
  return null
}
