/**
 * @littly/mail — 给 AI 绑定邮箱后的 IMAP/SMTP 能力插件。
 *
 * 组成：
 * 1. `littlyMail` 服务（凭据 / status / test / 带护栏的 run）→ console-api 路由与 `mail` 工具共用；
 * 2. 模型工具 `mail`：command+params，写操作默认 dry-run，护栏全在 service 内。
 *
 * 安全：密码只存 DB / 只进服务端连接，status 不回传；日志/审计/错误一律遮罩。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { LittlyStorage } from '@littly/storage'
import { createMailService, type MailService } from './service.ts'
import { registerMailTool, type MailToolRegistryLike } from './tool.ts'

export const name = 'littly-mail'

/** 依赖：dsh 工具服务（预留）+ 业务存储。 */
export const inject = ['tools', 'littlyStorage']

export interface Config {
  /** 附件根目录；默认 LITTLY_DATA_DIR/mail。 */
  dataDir?: string
}

export const Config: z<Config> = z.object({
  dataDir: z.string(),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    littlyMail: MailService
  }
}

/** 装配：提供服务键 littlyMail，并在 hub 就绪后注册 `mail` 工具。 */
export function apply(ctx: Context, config: Config = {}): void {
  const service = createMailService(ctx.littlyStorage as LittlyStorage, {
    ...(config.dataDir !== undefined && config.dataDir.trim() !== '' ? { dataDir: config.dataDir.trim() } : {}),
  })
  ctx.provide('littlyMail', service)
  ctx.inject(['littlyHub'], (child) => {
    const hub = (child as unknown as { littlyHub?: MailToolRegistryLike }).littlyHub
    if (hub === undefined) return
    registerMailTool(hub, service)
    child.logger.info('littly mail tool registered')
  })
  ctx.logger.info('littly mail ready (dataRoot=%s)', service.dataRoot)
}

export {
  createMailService, MailError, resolveAccount, maskMailSecrets, safeAttachmentName,
  truncateText, addressText, defaultMailRoot, MAIL_KEYS, MAIL_LIMITS,
} from './service.ts'
export type {
  MailService, MailStatus, MailAccountView, MailTestResult, MailServiceOptions,
  MailImapClientLike, MailSmtpLike, ParsedMailLike, ResolvedAccount,
} from './service.ts'
export { MAIL_TOOL, registerMailTool } from './tool.ts'
