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

echo "== 容器重建不丢数据（持久卷）=="
# 「不丢数据」是硬承诺：容器删了重建（不是重启），卷还在，数据必须在。
# 这里真删一次容器再起一个，验证卷里的库确实承载了业务数据。
FATAL_BEFORE=$(docker logs "$NAME" 2>&1 | grep -icE "fatal|failed to import" || true)
COOKIE_JAR="/tmp/littly-verify-cookie-$$.txt"
rm -f "$COOKIE_JAR"
curl -s -c "$COOKIE_JAR" -o /dev/null -X POST "http://127.0.0.1:${PORT}/api/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"username\":\"${E2E_USER}\",\"password\":\"${E2E_PASS}\"}"
marker="persist-$$-$(date +%s)"
created=$(curl -s -b "$COOKIE_JAR" -X POST "http://127.0.0.1:${PORT}/api/bots" \
  -H 'content-type: application/json' -d "{\"name\":\"${marker}\"}")
bot_id=$(printf '%s' "$created" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
if [ -z "$bot_id" ]; then
  ok 0 "写入标记 bot（响应：${created}）"
else
  ok 1 "写入标记 bot ${marker}"
  # 删掉容器（保留卷）→ 重新起一个
  docker rm -f "$NAME" > /dev/null 2>&1 || true
  docker run -d --name "$NAME" \
    -p "${PORT}:3000" \
    -v "littly-verify-data-$$:/app/data" \
    -e TZ=Asia/Shanghai \
    "$IMAGE" > /dev/null
  READY2=0
  for i in $(seq 1 120); do
    if curl -sf "http://127.0.0.1:${PORT}/api" > /dev/null 2>&1; then READY2=1; break; fi
    sleep 2
  done
  ok "$READY2" "重建后的容器 240s 内就绪"
  # 重新登录（会话 cookie 跟着容器一起没了，库还在）
  curl -s -c "$COOKIE_JAR" -o /dev/null -X POST "http://127.0.0.1:${PORT}/api/auth/login" \
    -H 'content-type: application/json' \
    -d "{\"username\":\"${E2E_USER}\",\"password\":\"${E2E_PASS}\"}"
  after=$(curl -s -b "$COOKIE_JAR" "http://127.0.0.1:${PORT}/api/bots")
  case "$after" in
    *"${marker}"*) ok 1 "重建后标记 bot 还在（数据在卷里，没丢）" ;;
    *) ok 0 "重建后标记 bot 还在（响应：${after}）" ;;
  esac
  # 顺带确认首启播种是幂等的：重建后不会多出第二个小璃
  chars=$(curl -s -b "$COOKIE_JAR" "http://127.0.0.1:${PORT}/api/characters")
  count=$(printf '%s' "$chars" | grep -o '"name":"小璃"' | wc -l | tr -d ' ')
  ok "$([ "$count" = "1" ] && echo 1 || echo 0)" "重建后角色卡仍只有 1 张（播种幂等，实际 ${count}）"
fi
rm -f "$COOKIE_JAR"

echo "== 容器日志无致命错误 =="
fatal=$(docker logs "$NAME" 2>&1 | grep -icE "fatal|failed to import" || true)
total_fatal=$((FATAL_BEFORE + fatal))
ok "$([ "$total_fatal" = "0" ] && echo 1 || echo 0)" "无 fatal / failed to import（重建前后合计 $total_fatal 条）"

echo
echo "结果: $PASS 通过, $FAIL 失败"
[ "$FAIL" = "0" ] || exit 1
