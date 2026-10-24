#!/usr/bin/env bash
# Littly 开发引导：仓库本地 DSH_HOME + 链接 chat profile + 启动。
# 依赖解析走 dsh 的双锚点：bundle 从启动器安装本体（apps/cli 的 node_modules）解析，
# 故 profile 本身零依赖（不要在 profile 目录里跑 pnpm install）。
# 前置：根目录 `pnpm run build:artifacts` 已产出 apps/cli/lib/bin.js。
# 用法：scripts/littly-dev.sh [dsh 参数...]（如 --dump-config 验证组合树）
set -euo pipefail
cd "$(dirname "$0")/.."

export DSH_HOME="${DSH_HOME:-$PWD/.dsh-home}"
mkdir -p "$DSH_HOME/profiles"
ln -sfn "$PWD/profiles/chat" "$DSH_HOME/profiles/chat"

exec node apps/cli/lib/bin.js --profile chat "$@"
