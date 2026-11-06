# Littly v2 · 实现与验证报告

日期：2026-11-07（本地）
基线：Memoh v0.13 系列（2026-11-06 快照，AGPL-3.0）

## 实现范围

- `internal/littly/`：单实例 person、traits、人格回复决策、自传记忆 vault、人物分层/回收站、心跳（fallback/self/事件语义 + reason + 结构化裁决 + no-op 治理）、工作台文件工具/artifact/活动、SnowLuma OneBot v11 WS 客户端、六面嵌入式 UI。
- 核心接入：`cmd/agent/littly.go` 注册为 Memoh server 的 `server.Handler`；`internal/server/server.go` 加入 `/littly` 公开路由与单实例 bot 创建拦截。
- 入口：nginx `/` → `/littly/`；`/settings`、`/bots` 重定向；web 镜像重建。
- 配置：`LITTLY_API_KEY`、`LITTLY_DATA_DIR` 注入 compose；`/opt/memoh/data/littly` 持久化。

## 验证

| 项 | 结果 |
|---|---|
| `go build ./cmd/agent`（darwin + linux/arm64） | 通过 |
| `go test ./internal/littly/...` | 通过（聊天回退、人物归档/回收站、记忆可见性、心跳裁决/理由、路径监狱、SnowLuma WS/去重、性格回复、持久化、HTTP bootstrap/chat） |
| 镜像构建（server/web，legacy builder + 国内镜像源） | 通过 |
| `docker compose up`：postgres/pgvector/migrate/server/web/channel | 通过（server/channel healthy；web 启动） |
| `/` → `/littly/` | 302 |
| `/littly/api/bootstrap` | 200 |
| 真实 DeepSeek `deepseek-flash` 对话 | 通过（返回自然回复；`model` 确认 deepseek-flash） |
| 心跳手动触发 | 通过（`heartbeat_runs` 记录 outcome/summary；自心跳带理由） |
| Dream | 通过（`ok`，抽取记忆 + 日记） |
| 文件写入/产物 | 通过（`home/notes/hello.md` + artifact） |
| SnowLuma mock WS 私聊/去重 | 通过 |

## 已知缺口

1. 持久化是 JSON + Markdown vault，未落到设计的 PostgreSQL `littly_*` 表（M3 剩余）。
2. 未替换 Memoh builtin memory provider / agent context；Littly 聊天使用独立 prompt/工具循环。
3. 工作台活动仍是文件/产物级；终端/浏览器/桌面/快照与夜间 Dream 自动调度未接入（M4 剩余）。
4. SnowLuma 真实 QQ 扫码登录未验证；协议与 mock 测试已过（M1/M5 剩余）。
5. 旧的 Memoh 多 Bot 管理仍可通过 `/login` 访问（已从默认入口移除、创建 API 有单实例拦截），尚未做数据库级单行约束。

## 结论

达到“本地可运行、可对话、能自己心跳、人物/记忆/回收站可用、设置重排、QQ 协议就绪”的垂直切片，测试通过；完整设计中的 PG 索引、Memoh agent 深度替换、工作台/QQ 实机仍在后续里程碑。

## 交付

- 分支：`littly-v2`（orphan，无 Memoh 历史）
- 仓库：https://github.com/Tom6814/Littly/tree/littly-v2
- 本地运行：`docker compose up -d` → http://127.0.0.1:8082/littly/
- 本地验证环境：colima 4 CPU / 6GB；Docker Hub 经国内镜像源。

### 最终测试记录（2026-11-07 01:5x）

```text
$ go test ./internal/littly/... ./internal/server
ok  github.com/felinics/memoh/internal/littly/app   1.478s
ok  github.com/felinics/memoh/internal/server       (cached)
$ go build ./cmd/agent
ok
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8082/
302        # -> /littly/
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8082/littly/
200
$ curl -s http://127.0.0.1:8080/littly/api/health
{"status":"ok","model":"deepseek-flash","heartbeat_paused":false,...}
$ curl -X POST .../littly/api/chat -d '{"content":"你好，我是主人"}'
{"reply":"嘿，这么晚还没睡？...","replied":true,"action":"immediate","reason":"重要的人"}
```

### 运行中的容器

`memoh-postgres` (healthy) · `memoh-pgvector` (healthy) · `memoh-server` (healthy) · `memoh-channel` (healthy) · `memoh-web` (up)
