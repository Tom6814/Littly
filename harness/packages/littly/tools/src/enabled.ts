/**
 * 工具按角色启停（控制台「插件管理」面板的写侧）。
 *
 * 存 global_settings：`tools.disabled.<botId>` → JSON 字符串数组（被停用的工具名）。
 * 停用 = 该角色的这一轮不下发这个工具给模型；工具本身仍在注册表里，随时可开回来。
 */
import type { LittlyStorage } from '@littly/storage'

export function disabledToolsKey(botId: string): string {
  return `tools.disabled.${botId}`
}

/** 读某个角色被停用的工具名集合。 */
export function getDisabledTools(storage: LittlyStorage, botId: string): Set<string> {
  const raw = storage.getSetting(disabledToolsKey(botId))
  if (!raw) return new Set<string>()
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set<string>()
    return new Set(parsed.filter((x): x is string => typeof x === 'string' && x !== ''))
  } catch {
    return new Set<string>()
  }
}

/** 写某个角色被停用的工具名集合（覆盖式）。 */
export function setDisabledTools(storage: LittlyStorage, botId: string, names: string[]): void {
  const clean = [...new Set(names.filter((n) => n !== ''))]
  storage.setSetting(disabledToolsKey(botId), JSON.stringify(clean))
}

/** 单个工具的启停切换，返回切换后的集合。 */
export function toggleDisabledTool(
  storage: LittlyStorage,
  botId: string,
  toolName: string,
  enabled: boolean,
): Set<string> {
  const current = getDisabledTools(storage, botId)
  if (enabled) current.delete(toolName)
  else current.add(toolName)
  setDisabledTools(storage, botId, [...current])
  return current
}
