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

1. 运行时状态已落到 PostgreSQL `littly_state`（JSONB，迁移 `0173`），容器重启/重建后从 PG 恢复；Markdown vault 仍是记忆真相。规范化 `littly_people/memories/...` 子表与 memory provider 替换仍未完成（M3 剩余）。
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

## M3 进度：PostgreSQL 持久化

- 新增迁移 `db/postgres/migrations/0173_littly_state.{up,down}.sql`。
- `internal/littly/store/pg.go`：启动时 `CREATE TABLE IF NOT EXISTS littly_state`，读取/写入单行 JSONB（person_id=`owner`）；本地 `state.json` 保留为镜像/回退。
- 注入：`provideLittlyHandler(log, *pgxpool.Pool)` → `app.WithPool`。
- 验证：
  - `select person_id, jsonb_array_length(data->'memories'), jsonb_array_length(data->'messages') from littly_state` → `owner|9|6`
  - `docker restart memoh-server` 后 `/api/today` 仍返回 6 条消息、9 条记忆。
  - `/api/health` 新增 `storage: {postgres:true, vault_ok:true}`。

## M3 进度：规范化表

迁移 `0174_littly_domain_tables` 新增并同步以下表（每次状态保存事务内 delete+insert，单实例数据量小）：

`littly_people` · `littly_memories` · `littly_activities` · `littly_artifacts` · `littly_heartbeats` · `littly_heartbeat_runs` · `littly_reply_decisions` · `littly_outbox` · `littly_events` · `littly_diaries` · `littly_dreams`

实测（部署后一次聊天触发保存）：

```text
people|1
memories|11
activities|0
heartbeats|15
runs|16
replies|4
events|50
diaries|3
```

## M3 进度：人格桥接（Memoh 原生 prompt）

- 新包 `internal/littly/agentctx`：读取 `LITTLY_DATA_DIR/config.json`，生成稳定的 persona section。
- `internal/agent/runtime/native/prompt_sections.go` 注入 `system.littly_persona`（排在 bot identity 之后，RetentionPreferred）。
- 只含 name/bio/SELF/style/boundaries；另注入最近 6 条非私密记忆 `system.littly_memory`（私密永不进入 prompt）。
- 测试：`internal/littly/agentctx` 单测 + `internal/agent/runtime/native` 全包测试通过。

## M4 进度：自主活动

- `RunSoloActivity`：有 LLM 时她自选 kind/title 并写第一人称笔记；无 LLM 时降级为“整理最近的想法”。
- 产出：`home/notes/<时间>-<标题>.md` + `littly_artifacts` + `littly_activities` + 一条 public 记忆。
- API：`POST /littly/api/activities/run`；Today 页有“让她自己做点事”入口。
- 实测返回：`kind=organize, title=把记忆检索方法记成三步, status=done`，artifact 落盘。

## M4 进度：自动节奏

- `tickLife`：每 10s 检查，白天（`day_start`~`day_end`）且无运行中活动、最近一次活动超过 3 小时 → 自动 `RunSoloActivity`；每天 `Memory.DreamHour`（默认 3 点）自动 `RunDream`（同日只跑一次）。
- 与心跳/LLM 调用互斥（`heartRunning` 检查）；设置页可调「自主活动间隔」（0=关）与 Dream 整点，`LITTLY_AUTO_ACTIVITY=0` 仍可整体关闭。
- 单测：`TestLifeTickDueRules`（白天/夜间、3 小时冷却、Dream 同日只一次）。

## M4 进度：工作台终端

- 新工具 `terminal_exec` + `POST /littly/api/terminal`：在她的 workspace 下执行 `sh -c`，默认 10s（UI 15s）、输出上限 16KB；由 `workbench.allow_shell` 控制。
- 设置页新增“工作台”卡（目录 / allow_shell / allow_network）；Workbench 页新增终端面板。
- 实测：`pwd; echo hello-from-terminal; ls` → `/opt/memoh/data/littly/workspace
hello-from-terminal
home
scripts
skills`。
- 单测 `TestTerminalToolGatedAndRuns`：未开启报错、开启后执行成功。

## M3 进度：memory provider 桥

- 新包 `internal/littly/memprovider`：在 Memoh 默认 memory provider 外做只读桥接。
- `Search` / `OnBeforeChat` 合并 `state.json` 中非私密记忆（关键词/最新/重要性），其余方法全部 delegate 上游。
- 核心注册：`registry.Register("__builtin_default__", littlymem.Wrap(defaultProvider))`。
- 单测：私密过滤、关键词搜索、OnBeforeChat 上下文合并、无 state 时透传。
- 限制：这是桥接，不是 provider 合同级替换；写入/抽取仍走上游 builtin。

## M4 进度：浏览器

- compose 新增 `browser` sidecar（`chromedp/headless-shell`，内部 9222，经 socat 转发到 9223）。
- 工具 `browser_open` + API `POST /littly/api/browser`、`GET /littly/api/browser/status`；支持读 `document.body.innerText`、截图存 `home/browser/*.png` 并登记 artifact。
- 处理了 Chrome DevTools 的 Host/WebSocket 限制：HTTP 用 `Host: localhost`，WS 用自定义 `net.Dialer` 连接 sidecar。
- 实测打开内部 `/littly/` 页面，返回正文 + `home/browser/20261107-031336.png` artifact。
- 单测：非 http(s) URL 拒绝。

## M5 进度：SnowLuma 容器

- 已启动 `littly-snowluma`（`motricseven7/snowluma:v2.2.1`，`SYS_PTRACE`，`memoh_memoh-network`），端口 `3001`（OneBot WS）/`5099`（WebUI）/`6081`（noVNC）。
- onebot token 从容器 `/app/data/config/onebot.json` 读取并写入 Littly 配置；`ws_url=ws://littly-snowluma:3001`。
- 当前状态：OneBot WS 在 QQ 登录前不监听，`/api/health` 显示 `connected:false, last_error: connection refused`；扫码入口已可用，登录后自动重连。
- 用户操作：打开 `http://127.0.0.1:6081/vnc.html` 扫码，再把 QQ 号填入设置页。

## UI 截图

- `docs/v2/screenshots/today.png`：今天页（状态、心跳、聊天、事件、活动）。
- `docs/v2/screenshots/settings.png`：重排后的设置页（基本/模型/心跳/QQ/健康/关于）。

浏览器实测：Headless Chrome 1440×1100，`/littly/#/today` 与 `/littly/#/settings` 均能渲染；健康点显示“她 · 正常”，不再停留在“连接中”。

## 设置/渠道体验

- 设置页“模型”卡新增 **测试模型连接**：`POST /littly/api/test-model` 做一次极小 completion，返回模型名/延迟/回复；避免只看到配置不验证。
- SnowLuma 状态新增 `state=waiting_login`：OneBot WS 未监听时显示“等待扫码登录”，不再只显示裸 connection refused。
- 设置页副标题更新为 基本 / 模型 / 心跳 / QQ / 工作台 / 健康 / 关于。

## 记忆/人物录入

- `POST /littly/api/people`：手动添加联系人（默认 manual 渠道、自动 external id）。
- `POST /littly/api/memories`：手动写一条记忆（默认 public）。
- UI：世界页联系人录入行、记忆页“记下”行。
- 单测 `TestCreatePersonAndMemoryAPIs`。

## 记忆面：日记视图

- `GET /littly/api/diaries`；记忆页新增“日记”标签，按时间倒序展示 Dream 写下的日记（day/mood/content/summary）。
- 单测 `TestDiariesAPI`。

## 回归测试：六面 API e2e

`TestAPIEndToEnd` 用 httptest 串起：bootstrap / health / chat / today / config / terminal / test-model / activities/run / activities / artifacts / people / memories / heartbeat / heartbeat schedule / world / file write/list/content/raw / events / archive，全部 200。

## 最终镜像验证（从源码构建，不靠 docker cp）

```text
docker build -f docker/Dockerfile.server.local -t memohai/server:latest .   → Successfully built 04cf3c62aab0（含 browser sidecar、raw file、memory provider bridge、日记视图）
docker compose up -d --force-recreate server                                 → memoh-server Healthy
schema_migrations: 174|f (clean)
GET /            → 302 → /littly/
GET /littly/     → 200
GET /littly/api/health → status ok, model deepseek-flash, storage {postgres:true, vault_ok:true}
GET /littly/api/bootstrap → workbench {allow_shell:true, auto_activity_minutes:180}, memory {dream_hour:3}
GET /littly/api/today → 8 messages, 12 memories, 1 activity (from Postgres)
POST /littly/api/terminal {"command":"echo image-ok; pwd"} → image-ok + /opt/memoh/data/littly/workspace
POST /littly/api/test-model → {"ok":true,"model":"deepseek-flash","latency_ms":656,"reply":"ok"}
GET /littly/api/health → snowluma.state=waiting_login（登录前预期）
GET /littly/api/browser/status → Chrome/157，ok=true
POST /littly/api/browser {"url":"http://memoh-web:8082/littly/","screenshot":true}
→ title=Littly · 她, screenshot=home/browser/20261107-032522.png
GET /littly/api/files/raw?path=home/browser/...png → 200 image/png
POST /littly/api/test-model → ok deepseek-flash
GET /littly/api/browser/status → Chrome/157 ok=true
GET /littly/api/health → snowluma.state=waiting_login
```

构建过程中 colima 磁盘一度写满（`No space left on device`），用 `docker image prune -f` 清理 dangling 镜像后恢复；迁移重跑成功，版本 174。
