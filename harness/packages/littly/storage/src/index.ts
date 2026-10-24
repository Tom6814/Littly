/**
 * Littly 业务存储插件：单 SQLite 文件（node:sqlite DatabaseSync，与 dsh 自身
 * storage-sqlite 同驱动，零原生依赖），承载旧项目 20 表的业务 schema。
 *
 * 刻意不走 dsh storage-domain 的 typed-KV：业务面需要关系查询
 * （会话窗口、记忆双池、到期任务），KV 语义不适配（移植指南 §14 的取舍说明）。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MIGRATIONS } from './schema.ts'

export * from './rows.ts'
export { MIGRATIONS }

export const name = 'littly-storage'

declare module '@deepseek-ai/cordis' {
  interface Context {
    littlyStorage: LittlyStorage
  }
}

export interface Config {
  /** SQLite 文件路径（相对 cwd）。 */
  file: string
}

export const Config: z<Config> = z.object({
  file: z.string().default('data/littly.db'),
})

export interface Statement {
  run(...params: unknown[]): { changes: number | bigint }
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

export class LittlyStorage {
  readonly db: DatabaseSync

  constructor(ctx: Context, config: Config) {
    mkdirSync(dirname(config.file), { recursive: true })
    this.db = new DatabaseSync(config.file)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    this.migrate(ctx)
  }

  private migrate(ctx: Context): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
    // BEGIN IMMEDIATE 串行化：HMR/双实例同时打开同一文件时，后到者阻塞至先到者
    // 提交，再重读 applied —— 竞态下 v1 DDL 不会重复执行。
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const applied = new Set(
        this.db.prepare('SELECT version FROM schema_migrations').all().map((r) => (r as { version: number }).version),
      )
      for (const m of MIGRATIONS) {
        if (applied.has(m.version)) continue
        this.db.exec(m.sql)
        this.db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(m.version, new Date().toISOString())
        ctx.logger.info('migration applied: v%d', m.version)
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  prepare(sql: string, ...params: unknown[]): Statement {
    const stmt = this.db.prepare(sql)
    const bound = params.length > 0 ? params : null
    return {
      run: (...more: unknown[]) => stmt.run(...([...(bound ?? []), ...more] as never[])) as { changes: number | bigint },
      get: (...more: unknown[]) => stmt.get(...([...(bound ?? []), ...more] as never[])),
      all: (...more: unknown[]) => stmt.all(...([...(bound ?? []), ...more] as never[])),
    }
  }

  /** 单条 JSON 取值便捷读（global_settings 等键值面）。 */
  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM global_settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO global_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  }

  close(): void {
    this.db.close()
  }
}

export function apply(ctx: Context, config: Config): void {
  const storage = new LittlyStorage(ctx, config)
  ctx.provide('littlyStorage', storage)
  ctx.effect(() => () => storage.close(), 'littly-storage.close')
  ctx.logger.info('littly storage ready at %s', config.file)
}
