# Littly v2

> 她不是 personal agent，她是一个人：有自己的人生、自己的电脑、自己的朋友与判断。

Littly v2 是 **Memoh（AGPL-3.0）的硬分叉**。Memoh 提供服务器、Web 外壳、渠道与工作台；本仓库在其上实现了 Littly 的核心：单实例一个人、人格驱动的回复、自传式记忆、人物分层/回收站、心跳（心声回响 v2）、工作台文件与 SnowLuma QQ。

## 现在已经能跑

- **六面 UI**：`/littly/` — 今天 / 她 / 记忆 / 工作台 / 世界 / 设置（旧的设置入口 `/settings`、`/bots` 已重定向到新 UI）。
- **她主动活着**：心跳（保底 + 自心跳）有理由、结构化裁决、no-op 治理；会自己安排下一次醒来。每日 `DreamHour`（默认 03:00）自动整理；白天闲置（默认 180 分钟，可在设置页调，0=关）会自己做一件小事；Dream 整点也可在设置页改。
- **不是每条消息都回**：性格 traits + 关系 + 状态 + 消息内容 → 立即回 / 短回 / 晚点回 / 不回；决策留痕。
- **记忆**：Markdown vault（SELF/domains/日记/人物卡）+ JSON 索引；记忆/人物/日记/回收站四个标签；可见性 public/relationship/private，私密抽屉网页端不可见。
- **人物分层**：重要的人一人一卡；泛泛之交一行；90/180 天淡出进入**可搜索回收站**；她可以主动 `recall_person` 搜到再恢复（不自动恢复）。世界页支持手动录入联系人，记忆页支持手动记一条。
- **工作台**：她的文件（路径监狱）、产物 artifact、活动记录、**终端**（`allow_shell` 开关，限时/限输出，危险命令需主人批准）、**浏览器**（headless Chrome sidecar，可读正文/截图存档）、**快照/恢复**（工作台文件 tar.gz）；她可以自己选题做一件小事（LLM 写笔记，无 LLM 时降级），留下活动与产出。
- **SnowLuma QQ**：OneBot v11 WebSocket 客户端（登录/私聊/群聊@/去重/发送），设置页可配；账号唯一归属，不换号。SnowLuma 容器已接入，noVNC `:6081` 扫码、WebUI `:5099`。
- **设置已重排**：基本 / 模型 / 心跳 / QQ 渠道 / 健康 / 关于；不再把多 Bot/多用户/市场/ACP 塞进一个入口。

## 运行

需要一个 Docker 运行时（本机用 colima 也可）：

```bash
# 1) 构建（首次会下载 Go/npm 依赖）
docker build -f docker/Dockerfile.server.local -t memohai/server:latest .
docker build -f docker/Dockerfile.web.local    -t memohai/web:latest .

# 2) 配置
cp conf/app.docker.toml config.toml          # 修改 admin 密码 / jwt_secret
cp .env.example .env                          # 填 LITTLY_API_KEY、DB/RPC 密钥
printf 'LITTLY_API_KEY=%s\n' 'sk-...' >> .env # DeepSeek key，不提交

# 3) 起服务
docker compose up -d

# 4) 打开
open http://127.0.0.1:8082/littly/
```

- API key 通过 `LITTLY_API_KEY` 注入 server；不落库、不回显。
- 她的数据在容器卷 `memoh_data:/opt/memoh/data/littly`（JSON + `vault/` + `workspace/`）。
- 旧 Memoh 管理台仍可从 `/login` 进入（工作台/渠道等上游能力），默认入口是新 UI。

## 测试

```bash
./scripts/littly-test.sh             # build + littly tests + server/native/memory + race
./scripts/littly-build.sh            # 构建 server/web 镜像并 compose up
```

或手动：

```bash
go test ./internal/littly/... ./internal/server ./internal/agent/runtime/native ./internal/memory/...
go test -race ./internal/littly/...
go build ./cmd/agent
```

`docs/v2/BUILD-REPORT.md` 记录了本次实现范围、验证命令与已知缺口；截图在 `docs/v2/screenshots/`。

## 目录

- `internal/littly/app/`：v2 核心（persona、chat、memory vault、people/archive、heartbeat、workbench tools、SnowLuma、六面 UI embed）。
- `cmd/agent/littly.go`：把 v2 核心挂到 Memoh server（同一进程、同一数据卷）。
- `internal/server/server.go`：加入 `/littly` 公开路由与单实例 bot 创建拦截（`LITTLY_SINGLE_PERSON=0` 可关）。
- `docker/nginx-app.conf`：`/` → `/littly/`；`/settings`、`/bots` 重定向。
- `docs/v2/`：完整设计文档（产品/架构/数据模型/生活引擎/记忆/人格回复/心跳/UI/测试/构建）。

## 核心桥接

- `internal/littly/agentctx` 把 Littly 的姓名/SELF/说话方式/边界注入 Memoh 原生 agent 的 system prompt（`system.littly_persona`），并把最近 6 条非私密记忆作为 `system.littly_memory` 注入；平台里的 agent 也以“她”的身份工作、记得她最近经历过什么。
- 只注入稳定人格字段，不把高频记忆塞进 system prompt，避免 prompt cache 抖动；记忆仍通过工具/检索走。

## 与设计文档的差距（诚实记录）

- 运行时状态持久化到 Memoh PostgreSQL：`littly_state`（JSONB，迁移 `0173`）+ **规范化镜像表** `littly_people/memories/activities/artifacts/heartbeats/heartbeat_runs/reply_decisions/outbox/events/diaries/dreams`（迁移 `0174`）；Markdown vault 仍是记忆真相。memory provider 替换仍未完成。
- 尚未替换 Memoh 的 builtin memory provider / agent 上下文；Littly 聊天走自己的 prompt/工具循环。Memoh 工作台/容器/渠道作为平台保留。
- 工作台活动执行目前是文件+产物级别；终端/浏览器/桌面活动、快照、Dream 夜间自动调度尚未接入。
- SnowLuma 已实现协议与 mock 测试，尚未在真实 QQ 扫码登录下跑通；需要 SnowLuma 容器与账号。
- 这些对应 `docs/v2/12-BUILD-PLAN.md` 的 M3/M4/M5 剩余项。

## 许可与来源

- 本仓库整体 AGPL-3.0；保留 Memoh 版权与来源（`README.memoh.md`、`NOTICE`）。
- 分叉自 `github.com/felinics/Memoh`（v0.13 系列，2026-11-06 快照）。
- 设计参考：Generative Agents / Letta sleep-time / Hermes HeartBeat 2.0 / 旧版「心声回响」。
