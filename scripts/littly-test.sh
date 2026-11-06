#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export GOFLAGS="${GOFLAGS:-}"
echo "== go build =="
GOPROXY="${GOPROXY:-https://goproxy.cn,direct}" GOSUMDB="${GOSUMDB:-off}" go build ./cmd/agent
echo "== littly core tests =="
go test -timeout 300s ./internal/littly/...
echo "== Memoh core touched packages =="
go test -timeout 300s ./internal/server ./internal/agent/runtime/native ./internal/memory/...
echo "== race (littly) =="
go test -race -timeout 300s ./internal/littly/...
echo "ALL OK"
