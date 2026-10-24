#!/usr/bin/env bash
# Littly 开发引导：仓库本地 DSH_HOME + 链接 chat profile + 安装 profile 依赖 + 构建 CLI。
# 用法：scripts/littly-dev.sh [dsh 参数...]（例如 --dump-config 验证组合树）
set -euo pipefail
cd "$(dirname "$0")/.."

export DSH_HOME="${DSH_HOME:-$PWD/.dsh-home}"
mkdir -p "$DSH_HOME/profiles"
ln -sfn "$PWD/profiles/chat" "$DSH_HOME/profiles/chat"

# profile 依赖是 file: 相对链接（指回 monorepo），pnpm 按真实路径解析
( cd "$DSH_HOME/profiles/chat" && pnpm install )

# dsh bin 指向构建产物 lib/bin.js，先确保 CLI 已构建
pnpm --filter @deepseek-ai/dsh run build

exec node apps/cli/lib/bin.js --profile chat "$@"
