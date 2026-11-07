#!/usr/bin/env node
/**
 * lucide-vue-next 图标名校验（本地开发辅助，非构建钩子）。
 * 背景：lucide 的图标名会随版本重命名/删除（如 AutoFixHigh → WandSparkles，
 * HistoryEdu 已不存在）。Vite 构建时才会以 MISSING_EXPORT 报错，浪费一轮集成。
 *
 * 用法：node scripts/check-icons.mjs
 * 退出码：0 = 全部存在；1 = 有缺失（列出文件与图标名）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const lucideEntry = join(root, 'node_modules/lucide-vue-next/dist/esm/lucide-vue-next.js')

let bundle = ''
try {
  bundle = readFileSync(lucideEntry, 'utf8')
} catch {
  console.error(`找不到 ${lucideEntry}，先运行 pnpm install`)
  process.exit(2)
}

// 入口文件用 `export { X as Y }` 或 `export { default as Y }` 形式导出。
const exported = new Set([...bundle.matchAll(/\bas\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]))

const IGNORE_DIRS = new Set(['node_modules', 'dist', '.git', 'packages'])
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (IGNORE_DIRS.has(entry)) continue
    const path = join(dir, entry)
    const st = statSync(path)
    if (st.isDirectory()) out.push(...walk(path))
    else if (path.endsWith('.vue') || path.endsWith('.ts')) out.push(path)
  }
  return out
}

const files = walk(join(root, 'src'))
const problems = []

for (const file of files) {
  const source = readFileSync(file, 'utf8')
  const imports = source.match(/import\s*\{([^}]+)\}\s*from\s*['"]lucide-vue-next['"]/g) ?? []
  for (const statement of imports) {
    const names = statement
      .replace(/import\s*\{/, '')
      .replace(/\}\s*from[\s\S]*/, '')
      .split(',')
      .map((n) => n.trim().split(/\s+as\s+/)[0])
      .filter(Boolean)
    for (const name of names) {
      if (!exported.has(name)) problems.push({ file: relative(root, file), name })
    }
  }
}

if (problems.length === 0) {
  console.log(`✓ lucide 图标全部存在（扫描 ${files.length} 个文件）`)
  process.exit(0)
}

for (const p of problems) console.error(`✗ ${p.file}: ${p.name} 不是 lucide-vue-next 的导出`)
console.error(`\n共 ${problems.length} 处缺失图标。可换用相近的现有图标（搜索：grep "as Wand" node_modules/lucide-vue-next/dist/esm/lucide-vue-next.js）。`)
process.exit(1)
