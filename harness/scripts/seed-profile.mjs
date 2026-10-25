#!/usr/bin/env node
/**
 * profile 播种：把镜像/仓库里的 profile 目录落到 $DSH_HOME/profiles/<name>。
 *
 * 为什么需要：dsh 的 profile 是 $DSH_HOME 下的一等公民（包解析的第一现场），
 * 但开发时我们用软链把它指回仓库（改一处两处生效）。容器里没有这根软链，
 * DSH_HOME 又在持久卷上 —— 首启若不播种，`dsh --profile chat` 直接报
 * “profile chat does not exist”。
 *
 * 行为（幂等，可重复执行）：
 * 1. 目标目录不存在 → 从源目录复制清单文件（package.json / cordis.patch.yml /
 *    cordis.yml / pnpm-lock.yaml / compatibility.json）。
 * 2. 目标已存在 → 不覆盖用户改过的 package.json 与 cordis.patch.yml；
 *    只把源目录里「目标缺少的依赖」补进 package.json（用户加的保留）。
 * 3. profile 声明了依赖（社区 dsh 插件等）而目标缺 node_modules → 装一次。
 *
 * 用法：node scripts/seed-profile.mjs [--profile chat] [--source profiles/chat]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const harnessRoot = resolve(here, '..')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}

const profileName = arg('profile', 'chat')
const dshHome = process.env['DSH_HOME'] ?? join(process.env['HOME'] ?? '.', '.dsh')
const sourceDir = isAbsolute(arg('source', ''))
  ? arg('source', '')
  : resolve(harnessRoot, arg('source', join('profiles', profileName)))
const targetDir = join(dshHome, 'profiles', profileName)

console.log(`[seed] profile=${profileName}`)
console.log(`[seed]   source: ${sourceDir}`)
console.log(`[seed]   target: ${targetDir}`)

if (!existsSync(sourceDir)) {
  console.error(`[seed] 源 profile 不存在：${sourceDir}`)
  process.exit(1)
}

const COPY_FILES = ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-lock.yaml', 'compatibility.json']

mkdirSync(targetDir, { recursive: true })

const targetManifestPath = join(targetDir, 'package.json')
const hadManifest = existsSync(targetManifestPath)

if (!hadManifest) {
  for (const file of COPY_FILES) {
    const from = join(sourceDir, file)
    if (existsSync(from)) cpSync(from, join(targetDir, file))
  }
  console.log('[seed] 首次播种：已复制 profile 清单文件')
} else {
  // 已有 profile：只补齐源里有、目标缺的依赖与 bundle（用户改过的保留）
  const source = JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf8'))
  const target = JSON.parse(readFileSync(targetManifestPath, 'utf8'))
  let changed = false
  const sourceDeps = source.dependencies ?? {}
  target.dependencies = target.dependencies ?? {}
  for (const [name, spec] of Object.entries(sourceDeps)) {
    if (target.dependencies[name] === undefined) {
      target.dependencies[name] = spec
      changed = true
      console.log(`[seed] 补依赖：${name}@${spec}`)
    }
  }
  const sourceBundles = source.dsh?.profile?.bundles ?? []
  const targetBundles = target.dsh?.profile?.bundles ?? []
  for (const bundle of sourceBundles) {
    if (!targetBundles.includes(bundle)) {
      targetBundles.push(bundle)
      changed = true
      console.log(`[seed] 补 bundle：${bundle}`)
    }
  }
  if (changed) {
    target.dsh = target.dsh ?? {}
    target.dsh.profile = { ...(target.dsh.profile ?? {}), bundles: targetBundles }
    writeFileSync(targetManifestPath, `${JSON.stringify(target, undefined, 2)}\n`)
  }
  // 缺的文件照补（patch / 锁文件 / 豁免记录）
  for (const file of COPY_FILES) {
    if (file === 'package.json') continue
    const from = join(sourceDir, file)
    const to = join(targetDir, file)
    if (existsSync(from) && !existsSync(to)) {
      cpSync(from, to)
      console.log(`[seed] 补文件：${file}`)
    }
  }
}

// profile 依赖安装（社区 dsh 插件等）：
//   镜像里已经装好的（profiles/<name>/node_modules）→ 直接复制，不用 pnpm
//   运行时才改的依赖 → 退回 pnpm install
const manifest = JSON.parse(readFileSync(targetManifestPath, 'utf8'))
const deps = Object.keys(manifest.dependencies ?? {})
if (deps.length > 0 && !existsSync(join(targetDir, 'node_modules'))) {
  const sourceModules = join(sourceDir, 'node_modules')
  if (existsSync(sourceModules)) {
    console.log(`[seed] 复制镜像里已装好的 profile 依赖：${deps.join(', ')}`)
    cpSync(sourceModules, join(targetDir, 'node_modules'), { recursive: true })
  } else {
    console.log(`[seed] 安装 profile 依赖：${deps.join(', ')}`)
    try {
      execFileSync('pnpm', ['install', '--prod=false'], { cwd: targetDir, stdio: 'inherit' })
    } catch (err) {
      console.error(`[seed] profile 依赖安装失败（不阻塞启动）：${err instanceof Error ? err.message : String(err)}`)
      console.error('[seed] 该 profile 的外部插件将不可用（dsh 会把对应 bundle 标记为 skipped）')
    }
  }
} else if (deps.length > 0) {
  console.log('[seed] profile 依赖已就位')
}

console.log('[seed] 完成')
