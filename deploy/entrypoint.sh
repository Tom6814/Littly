#!/bin/sh
# Littly harness 容器入口：把容器自身 IP 解析出来交给 dsh webserver
# （dsh 拒绝 0.0.0.0 通配绑定；文档建议以 hostname -i 的 Pod/容器地址为准）。
set -e
HOST_IP="$(hostname -i 2>/dev/null | awk '{print $1}')"
export DSH_WEB_HOST="${DSH_WEB_HOST:-$HOST_IP}"
[ -n "$DSH_WEB_HOST" ] || export DSH_WEB_HOST=127.0.0.1
echo "[littly] webserver bind: ${DSH_WEB_HOST}:${PORT:-3000}"
# profile 播种：DSH_HOME 在持久卷上，首启没有 profile 目录时 dsh --profile 会直接失败。
# 从镜像里的 profiles/<name> 复制到 $DSH_HOME/profiles/<name>（幂等，不覆盖用户改动）。
node scripts/seed-profile.mjs --profile "${LITTLY_PROFILE:-chat}" || \
  echo "[littly] 警告：profile 播种失败，继续启动（dsh 可能报 profile 不存在）"
exec node apps/cli/lib/bin.js --profile "${LITTLY_PROFILE:-chat}" "$@"
