#!/usr/bin/env bash
# 最终验收：容器验收 + compose 编排实跑。
# 用法：harness/scripts/verify-final.sh [image]
set -uo pipefail

IMAGE="${1:-littly-harness:test}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OVERRIDE=/tmp/compose-override.yml
FAIL=0

echo "############ 1) 容器验收 ############"
if "$HERE/verify-container.sh" "$IMAGE" 3488; then
  echo ">>> 容器验收：通过"
else
  echo ">>> 容器验收：失败"
  FAIL=1
fi

echo
echo "############ 2) compose 编排实跑 ############"
cat > "$OVERRIDE" <<'EOF'
services:
  littly:
    ports: !override ["3100:3000"]
  bili:
    ports: !override ["3110:3010"]
EOF
cd "$ROOT"
# 用新镜像重建整栈（连卷一起清 —— 要验的是「全新部署」）
docker compose -f deploy/docker-compose.yml -f "$OVERRIDE" --profile bili down -v > /dev/null 2>&1
docker compose -f deploy/docker-compose.yml -f "$OVERRIDE" --profile bili up -d --no-build 2>&1 | tail -3

READY=0
for i in $(seq 1 90); do
  if curl -sf "http://127.0.0.1:3100/api" > /dev/null 2>&1; then READY=1; break; fi
  sleep 2
done
echo ">>> compose harness 就绪：$([ "$READY" = "1" ] && echo 是 || echo 否)"
[ "$READY" = "1" ] || FAIL=1

if [ "$READY" = "1" ]; then
  echo ">>> 容器健康状态：$(docker inspect littly-harness --format '{{.State.Health.Status}}' 2>/dev/null)"
  echo
  echo "--- compose 栈内 e2e（先注册管理员，首个用户即 admin）---"
  curl -s -o /dev/null -w "register=%{http_code}\n" -X POST "http://127.0.0.1:3100/api/auth/register" \
    -H 'content-type: application/json' -d '{"username":"owner","password":"owner-pass-123"}'
  if LITTLY_E2E_USER=owner LITTLY_E2E_PASS=owner-pass-123 node "$HERE/verify-e2e.mjs" 3100; then
    echo ">>> compose 栈内 e2e：通过"
  else
    echo ">>> compose 栈内 e2e：失败"; FAIL=1
  fi
  echo
  echo "--- compose 网络内 bili 扫码链路（harness → http://bili:3010）---"
  if node "$HERE/verify-bili-sidecar.mjs" 3100; then
    echo ">>> 扫码链路：通过"
  else
    echo ">>> 扫码链路：失败"; FAIL=1
  fi
  echo
  echo "--- 微信 iLink mock 套件（绑定/收发/窗口）---"
  if node "$HERE/verify-wechat.mjs"; then
    echo ">>> 微信 mock：通过"
  else
    echo ">>> 微信 mock：失败"; FAIL=1
  fi
fi

echo
if [ "$FAIL" = "0" ]; then
  echo "===== 最终验收全部通过 ====="
else
  echo "===== 有失败项 ====="
fi
exit "$FAIL"
