#!/usr/bin/env bash
# 容器验收：真起容器、真探活、真调 API、真拿控制台首页。
#
# 用法：harness/scripts/verify-container.sh [image] [port]
#   image 默认 littly-harness:test
#   port  默认 3488
#
# 退出码非 0 = 验收失败。
set -euo pipefail

IMAGE="${1:-littly-harness:test}"
PORT="${2:-3488}"
NAME="littly-verify-$$"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0

ok() {
  if [ "$1" = "1" ]; then PASS=$((PASS + 1)); echo "  ✓ $2"; else FAIL=$((FAIL + 1)); echo "  ✗ $2"; fi
}

cleanup() {
  docker rm -f "$NAME" > /dev/null 2>&1 || true
  docker volume rm "littly-verify-data-$$" > /dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== 起容器 =="
docker rm -f "$NAME" > /dev/null 2>&1 || true
docker volume create "littly-verify-data-$$" > /dev/null
docker run -d --name "$NAME" \
  -p "${PORT}:3000" \
  -v "littly-verify-data-$$:/app/data" \
  -e TZ=Asia/Shanghai \
  "$IMAGE" > /dev/null

echo "== 等待就绪 =="
READY=0
for i in $(seq 1 120); do
  if curl -sf "http://127.0.0.1:${PORT}/api" > /dev/null 2>&1; then READY=1; break; fi
  sleep 2
done
ok "$READY" "容器在 240s 内就绪"
if [ "$READY" != "1" ]; then
  echo "--- 容器日志 ---"
  docker logs "$NAME" 2>&1 | tail -40
  echo "结果: $PASS 通过, $FAIL 失败"
  exit 1
fi

echo "== 健康与静态资源 =="
code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/api")
ok "$([ "$code" = "200" ] && echo 1 || echo 0)" "/api 200（实际 ${code}）"

code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/")
ok "$([ "$code" = "200" ] && echo 1 || echo 0)" "控制台首页 200（实际 ${code}）"

body=$(curl -s "http://127.0.0.1:${PORT}/")
case "$body" in
  *"<!doctype html>"*) ok 1 "首页是 HTML" ;;
  *) ok 0 "首页是 HTML" ;;
esac

code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/console/bili")
ok "$([ "$code" = "200" ] && echo 1 || echo 0)" "SPA 路由回首页（实际 ${code}）"

echo "== profile 播种（首启必须发生）=="
seeded=$(docker exec "$NAME" sh -c 'ls "$DSH_HOME/profiles/chat/package.json" > /dev/null 2>&1 && echo yes || echo no')
ok "$([ "$seeded" = "yes" ] && echo 1 || echo 0)" "profile 已播种到 DSH_HOME"

echo "== 业务库落盘 =="
dbfile=$(docker exec "$NAME" sh -c 'ls "$LITTLY_DB_FILE" > /dev/null 2>&1 && echo yes || echo no')
ok "$([ "$dbfile" = "yes" ] && echo 1 || echo 0)" "SQLite 落在持久卷路径"

echo "== 社区 dsh 插件在容器里可用 =="
plugin=$(docker exec "$NAME" sh -c 'ls "$DSH_HOME/profiles/chat/node_modules/dsh-case/index.js" > /dev/null 2>&1 && echo yes || echo no')
ok "$([ "$plugin" = "yes" ] && echo 1 || echo 0)" "dsh-case 已安装进 profile"

echo "== 端到端断言（对着容器跑）=="
# 容器里的业务库在容器自己的卷上，测试脚本没法直接提权。
# 所以这里先在容器里注册一个**首个用户**（首个用户即管理员 —— 见 auth.ts createUser），
# 再让 e2e 用这个账号登录，管理类断言才是真的在测管理路径。
E2E_USER="e2e_admin_$$"
E2E_PASS="e2e-pass-123"
reg_code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:${PORT}/api/auth/register" \
  -H 'content-type: application/json' \
  -d "{\"username\":\"${E2E_USER}\",\"password\":\"${E2E_PASS}\"}")
if [ "$reg_code" = "200" ]; then
  if LITTLY_E2E_USER="$E2E_USER" LITTLY_E2E_PASS="$E2E_PASS" node "$HERE/scripts/verify-e2e.mjs" "$PORT"; then
    ok 1 "verify-e2e 全过"
  else
    ok 0 "verify-e2e 全过"
  fi
else
  echo "  （预注册管理员失败：${reg_code}，改用容器内的默认账号路径）"
  if node "$HERE/scripts/verify-e2e.mjs" "$PORT"; then
    ok 1 "verify-e2e 全过"
  else
    ok 0 "verify-e2e 全过"
  fi
fi

echo "== 容器日志无致命错误 =="
fatal=$(docker logs "$NAME" 2>&1 | grep -icE "fatal|failed to import" || true)
ok "$([ "$fatal" = "0" ] && echo 1 || echo 0)" "无 fatal / failed to import（实际 $fatal 条）"

echo
echo "结果: $PASS 通过, $FAIL 失败"
[ "$FAIL" = "0" ] || exit 1
