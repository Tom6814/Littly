#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="${HOME}/.local/bin:${PATH}"
export DOCKER_BUILDKIT=0
echo "== build server =="
docker build -f docker/Dockerfile.server.local -t memohai/server:latest .
echo "== build web =="
docker build -f docker/Dockerfile.web.local -t memohai/web:latest .
echo "== build desktop =="
docker build -f docker/Dockerfile.desktop -t memohai/desktop:latest .
echo "== up =="
docker compose up -d
echo "UI: http://127.0.0.1:8082/littly/"
