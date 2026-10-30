#!/bin/sh
# Littly harness 容器入口：把容器自身 IP 解析出来交给 dsh webserver
# （dsh 拒绝 0.0.0.0 通配绑定；文档建议以 hostname -i 的 Pod/容器地址为准）。
set -e
HOST_IP="$(hostname -i 2>/dev/null | awk '{print $1}')"
export DSH_WEB_HOST="${DSH_WEB_HOST:-$HOST_IP}"
[ -n "$DSH_WEB_HOST" ] || export DSH_WEB_HOST=127.0.0.1
echo "[littly] webserver bind: ${DSH_WEB_HOST}:${PORT:-3000}"
# 把实际绑定的地址落一个文件：healthcheck 是守护进程另起的 exec，
# 拿不到 entrypoint 的 export（docker exec 里 DSH_WEB_HOST 也是空的）。
# HEALTHCHECK 读这个文件才能探到真正在监听的那个地址。
echo "$DSH_WEB_HOST" > /tmp/littly-web-host
# B11：上传/生成文件（相册/文档/语音/头像）落持久卷 —— 与 SQLite 同卷，容器重建不丢。
export LITTLY_DATA_DIR="${LITTLY_DATA_DIR:-/app/data}"

# profile 播种：DSH_HOME 在持久卷上，首启没有 profile 目录时 dsh --profile 会直接失败。
# 从镜像里的 profiles/<name> 复制到 $DSH_HOME/profiles/<name>（幂等，不覆盖用户改动）。
node scripts/seed-profile.mjs --profile "${LITTLY_PROFILE:-chat}" || \
  echo "[littly] 警告：profile 播种失败，继续启动（dsh 可能报 profile 不存在）"
exec node apps/cli/lib/bin.js --profile "${LITTLY_PROFILE:-chat}" "$@"
