#!/bin/sh
# Littly harness 容器入口：把容器自身 IP 解析出来交给 dsh webserver
# （dsh 拒绝 0.0.0.0 通配绑定；文档建议以 hostname -i 的 Pod/容器地址为准）。
set -e
HOST_IP="$(hostname -i 2>/dev/null | awk '{print $1}')"
export DSH_WEB_HOST="${DSH_WEB_HOST:-$HOST_IP}"
[ -n "$DSH_WEB_HOST" ] || export DSH_WEB_HOST=127.0.0.1
echo "[littly] webserver bind: ${DSH_WEB_HOST}:${PORT:-3000}"
exec node apps/cli/lib/bin.js --profile chat "$@"
