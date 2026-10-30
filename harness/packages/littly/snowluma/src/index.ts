/**
 * @littly/snowluma — SnowLuma 一键安装/配置插件。
 *
 * 与 @littly/channel-qq 的分工：
 * - channel-qq 只负责「连接与收发」（用户自己装好的 SnowLuma 实例）；
 * - 本插件负责「一键安装 + 启动 + noVNC 扫码信息 + OneBot 配置补丁 + 扫码后自动接线」，
 *   让用户只需要勾选 EULA → 点安装 → 打开远程桌面扫码。
 *
 * SnowLuma 是第三方非商业自托管软件：install/start 必须显式 consent（EULA §5.4）。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { LittlyStorage } from '@littly/storage'
import { createSnowlumaService, defaultDataDir, SNOWLUMA_CONTAINER, SNOWLUMA_IMAGE, type SnowlumaConfig, type SnowlumaService } from './service.ts'

export const name = 'littly-snowluma'

/** 依赖：业务存储（settings / bots 行）。 */
export const inject = ['littlyStorage']

export interface Config {
  dockerBin?: string
  image?: string
  containerName?: string
  /** bind mount 根目录；默认 LITTLY_DATA_DIR/snowluma。 */
  dataDir?: string
  webuiPort?: number
  novncPort?: number
  wsPort?: number
  /** 等待 onebot.json 的上限（毫秒）；默认 60000。 */
  configWaitMs?: number
  /** 单条 docker 命令超时（毫秒）；默认 180000。 */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  dockerBin: z.string(),
  image: z.string(),
  containerName: z.string(),
  dataDir: z.string(),
  webuiPort: z.number(),
  novncPort: z.number(),
  wsPort: z.number(),
  configWaitMs: z.number(),
  timeoutMs: z.number(),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    littlySnowluma: SnowlumaService
  }
}

/** 装配 SnowLuma 一键安装服务键 littlySnowluma。 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved: SnowlumaConfig = {
    dockerBin: (config.dockerBin ?? '').trim() || (process.env['DOCKER_BIN'] ?? '').trim() || 'docker',
    image: (config.image ?? '').trim() || (process.env['SNOWLUMA_IMAGE'] ?? '').trim() || SNOWLUMA_IMAGE,
    containerName: (config.containerName ?? '').trim() || SNOWLUMA_CONTAINER,
    dataDir: (config.dataDir ?? '').trim() || defaultDataDir(),
    webuiPort: config.webuiPort ?? 5099,
    novncPort: config.novncPort ?? 6081,
    wsPort: config.wsPort ?? 3001,
    configWaitMs: config.configWaitMs ?? 60_000,
    timeoutMs: config.timeoutMs ?? 180_000,
  }
  const service = createSnowlumaService(ctx.littlyStorage as LittlyStorage, resolved)
  ctx.provide('littlySnowluma', service)
  ctx.logger.info('littly snowluma install ready (docker=%s, image=%s, data=%s)', service.dockerBin, service.image, service.dataDir)
}

export {
  createSnowlumaService, SnowlumaError, randomPassword, extractWebuiPassword, maskSecrets,
  buildRunArgs, defaultDataDir,
  SNOWLUMA_IMAGE, SNOWLUMA_CONTAINER, SNOWLUMA_KEYS,
} from './service.ts'
export type {
  SnowlumaService, SnowlumaStatus, SnowlumaState, SnowlumaConfig, SnowlumaLogsResult,
  SnowlumaQrInfo, SnowlumaAutoconfigureResult, SnowlumaContainerInfo, WebSocketLike,
} from './service.ts'
