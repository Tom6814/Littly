/**
 * B11：上传/生成文件的持久化目录。
 *
 * 修复前所有写文件（相册照片、文档、语音、头像）都落在 `<cwd>/public/downloads`：
 * 本地开发没问题，但容器里 cwd=/app、卷挂的是 /app/data —— 重建容器/升级镜像即丢文件。
 *
 * 修复后统一走 `LITTLY_DATA_DIR/downloads`（默认 `<cwd>/data/downloads`）：
 * - 容器入口设置 `LITTLY_DATA_DIR=/app/data`（挂载卷），与 SQLite 同卷；
 * - 对外 URL 完全不变（仍是 `/api/photos/file/<分类>/<文件名>`），前端无需改动。
 */
import { join, resolve } from 'node:path'

/** 业务数据根目录：LITTLY_DATA_DIR（容器=/app/data），默认 <cwd>/data。 */
export function littlyDataDir(): string {
  const raw = process.env['LITTLY_DATA_DIR']?.trim() ?? ''
  return raw !== '' ? resolve(raw) : resolve(process.cwd(), 'data')
}

/** 上传/生成文件根目录（= <data>/downloads）。 */
export function downloadsDir(): string
export function downloadsDir(...segments: string[]): string
export function downloadsDir(...segments: string[]): string {
  return join(littlyDataDir(), 'downloads', ...segments)
}
