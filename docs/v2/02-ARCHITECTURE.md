# 02 · 系统架构（v2 · 本地优先）

> 目标读者：实现者。读完应能知道代码放在哪、进程怎么跑、数据怎么流、改哪里。

## 1. 基座：Memoh 硬分叉

- 仓库：从 `github.com/felinics/Memoh`（AGPL-3.0）v0.13 系列 tag 分叉 → 新仓库 `littly-v2`（或本仓 `v2/` 目录，二选一，见 [12-BUILD-PLAN.md](12-BUILD-PLAN.md)）。
- 保留：工作台（containerd/docker workspace、文件/终端/浏览器/桌面）、渠道 worker、Schedule、Hooks、Skills、MCP、审批、上下文压缩、Vue 3 前端。
- 改造：多 Bot → 单 person；多用户 ACL → 管理员 + 联系人；记忆 → 自传式 vault；Agent 循环 → 生活引擎；UI → 六面；配置 → 单一 typed config。
- 保留上游版权/来源说明；新增 `NOTICE`。

## 1.5 融合策略：以 Memoh 为骨架，不是移植旧代码

- **骨架**：Memoh 的 Go 后端（agent/channel/workspace/schedule/skills/MCP/审批/配置/迁移）保留并作为基础。
- **长进去**：Littly 的差异化能力作为**新包/新表/新接口**实现（`internal/life`、`persona`、`memoryvault`、`attention`、`reply`、`social`、`healthcheck`、`configx`），复用 Memoh 的 DB 迁移、渠道、工作台工具、审批与 UI 组件。
- **参考而非搬运**：旧项目 TS 代码只作为行为参考、测试语义与可复用素材（Vue 页面可拷到 `apps/web`）；不把旧后端结构移植进 Go，不继承旧技术债（64 列 bots 表、双记忆、多 bot 等）。
- **判定标准**：如果某个旧功能需要"原样搬一个 TS 模块"才能工作，优先在 Memoh 的模型里重写；只有纯前端/纯提示词/纯测试用例可以直接复用。

## 2. 进程与部署（本地 Docker Compose）

```
┌─────────────────────────── Mac (Docker Desktop) ───────────────────────────┐
│                                                                            │
│  web (Vue3, nginx)  :8082 ──► server (Go) :8080                            │
│                                │   ├─ agent 循环（对话）                    │
│                                │   ├─ life 引擎（后台 tick/活动/睡眠）       │
│                                │   ├─ memory vault 服务                     │
│                                │   └─ 审批/预算/审计/健康                   │
│                                ├─► postgres:18 (主库)                       │
│                                ├─► pgvector (记忆向量, 可合并)              │
│                                ├─► workspace runtime (docker backend)      │
│                                │      └─ 她的电脑容器（文件/终端/浏览器）    │
│                                └─► vault 目录（Markdown 真相，bind mount）  │
│                                                                            │
│  channel worker (Go) ◄──► server（内部 RPC）                                │
│    ├─ SnowLuma OneBot WS ──► littly-snowluma 容器（QQ 客户端 + noVNC）      │
│    └─ Web 渠道（直连 server）                                               │
│                                                                            │
│  数据卷：pgdata / vault / workspace / snowluma / backups                    │
└────────────────────────────────────────────────────────────────────────────┘
```

- **本地优先**：Mac 上用 Docker Desktop。Memoh v0.13.1 实际支持 `containerd` / `docker` / `apple` 三种 workspace backend（以源码 `internal/container/factory.go` 为准）：本地默认优先 `docker`（server 原生运行 + `CONFIG_PATH=conf/config.local.toml`），`apple` 备选；`containerd` 留给服务器；`local/trusted` 仅兜底（安全边界见 09）。M0 实测后以实测为准。
- **资源模式**：默认"按需启动工作台"（浏览器/桌面要用时才起），后台活动若需要工作台则启动容器，空闲超时停止；快照保留。
- **单实例**：server 强制一个 person；启动时若无 person 则进入初始化（onboarding）。
- **QQ**：`littly-snowluma` 容器（`motricseven7/snowluma:v2.2.1`）提供 OneBot v11 WS `ws://127.0.0.1:3001`，noVNC `6081`。channel worker 内实现 **SnowLuma 适配器**（Go），单账号归属。

## 2.5 API 路由约定

- 浏览器统一 `/api/*`；nginx 去掉 `/api` 前缀后转给 Go，因此 **Go 路由注册不带 `/api`**。
- 新端点（Go 裸路径）：`/today`、`/her/persona`、`/memories`、`/world/channels`、`/config`、`/health`（前端 `/api/today` 等）。
- 上游 Memoh 端点保持原路径：`/bots/:id/container/fs|terminal|display|snapshots`、`/bots/:id/sessions|messages`、`/auth/login`；前端不暴露 `bot_id/person_id` 概念。
- 健康：Go `/health`（公开精简，供 Docker healthcheck）与 `/health/checks`（JWT 详细）；前端 `/api/health`、`/api/health/checks`。

## 3. 仓库结构（分叉后）

```
littly-v2/
  cmd/                    # memoh 原入口（server/channel/migrate/bridge/...）
  internal/               # 上游 Go 包（保留/改造）
    agent/                # 对话 turn/context/decision/tool/background
    channel/              # 渠道框架 + 适配器
    db/  handlers/  workspace/  container/  display/
    memory/               # 上游记忆 provider 接口（我们替换实现）
    schedule/ hooks/ skills/ mcp/ providers/ ...
    # ===== 以下为 Littly 新增 =====
    person/               # 单 person、初始化、身份
    persona/              # traits/SELF/人物卡/提示词组装
    life/                 # 生活引擎（clock/state/interests/planner/activity/sleep/social）
    memoryvault/          # 自传式 vault（Markdown 真相 + PG 索引 + 检索 + Dream）
    attention/            # 注意力/打断/回复决策
    reply/                # 回复策略（可并入 attention）
    social/               # 发帖/互动节律
    healthcheck/          # 模型/渠道/账号唯一性/预算
    configx/              # typed config + 校验 + 迁移
  db/                     # SQL 迁移（新增 lib 表；上游表保留）
  conf/                   # 本地配置样例（config.toml + littly.yaml）
  apps/web/               # Vue 3 控制台（六面）
  packages/               # 前端共享包（保留上游）
  docker/                 # 本地 compose + workspace 镜像
  docs/                   # 本设计文档
  scripts/                # 开发/测试脚本
```

- **修改原则**：新增能力放新包；上游核心文件（agent/turn、channel、workspace）尽量小改，改动写注释标明 `LITTLY:` 便于以后 diff 上游。
- **sqlc**：沿用上游 `db/` + `sqlc.yaml`；新表查询代码生成。
- **前端**：复用上游文件/终端/桌面、Markdown、审批、设置组件；重写导航与今天/她/记忆/工作台/世界/设置页面。

## 4. 数据流

### 4.1 对话（入站）

```
channel worker（SnowLuma/Web）
  → 入站规范化（dedupe by account+message_id；身份映射 people）
  → server: agent/turn
      → attention：更新注意力/状态（谁找她、重不重要、她在忙什么）
      → reply policy：决定 回/晚回/不回/已读不回/事后解释
          ├─ 不回：记录 reply_decisions，结束（可选稍后提醒）
          └─ 回：组装上下文（SELF+人物卡+最近生活+检索记忆+状态+当前对话）
                → LLM（聊天模型 + 工具）
                → 工具循环（工作台/记忆/社交/日程）
                → 出站消息 → 渠道
      → 记忆暂存（staging）+ 状态更新 + 关系变化
```

### 4.2 生活（后台）

```
wake（self/fallback/event；无固定 tick；见 [16-HEARTBEAT.md](16-HEARTBEAT.md)）
  → 推进状态（衰减/恢复）
  → 读今日意向/活动队列/threads
  → 若空闲且有精力 → 选择活动（fitness）→ 创建 activity（running）
  → 执行活动（工作台工具 / 后台任务 / 浏览器）
  → 产出 artifact + activity_log → 记忆 staging → 状态变化
  → 可能触发：主动消息 / 社交发帖 / 继续下一个活动 / 休息
夜间 sleep 窗口
  → Dream：记忆整理、反思、人物卡更新、SELF 更新、日记、明日意向
```

### 4.3 配置/健康

```
启动 → configx 加载（文件 + DB override）→ schema 校验
     → 模型预检（按用途）→ 渠道检查（唯一账号）→ 生活引擎恢复（未完成活动）
     → /health（浏览器 /api/health）暴露状态；失败不静默
```

## 5. 关键边界与不变量

| 不变量 | 实现位置 |
|---|---|
| 单实例单 person | 启动检查 + DB 唯一约束 |
| 单渠道单账号归属 | `channel_accounts` 唯一索引 + 启动检查 |
| 记忆可见性硬过滤 | memoryvault 检索层（不靠模型） |
| 模型按用途校验 | configx + healthcheck |
| 工作台路径监狱 | workspace 工具层（仅允许 `/workspace` 下） |
| 不可逆动作刹车 | 审批/trust 层 |
| 回复决策留痕 | reply_decisions |
| 旧数据不迁移 | 不写导入器；备份脚本 |

## 6. 可测试性设计（为整夜自动构建）

- **时钟注入**：life/clock 用 `Clock` 接口；测试可快进"一天"。
- **LLM 注入**：provider 层可替换为 mock（返回 JSON 决策/文本）。
- **渠道注入**：channel worker 可接 mock OneBot WS server。
- **工作台注入**：workspace 工具接口可 mock（本地不启动容器也能跑单元/集成测试）。
- **数据库**：集成测试用 Docker Postgres（或 testcontainers）；单测用接口 mock。
- **确定性**：随机数（活动选择/回复抖动）注入 seed。

## 7. 本地开发命令（目标形态）

```bash
# 一次性
cp conf/littly.example.yaml conf/littly.yaml   # 填 API key
docker compose -f docker/docker-compose.local.yml up -d

# 迭代
docker compose logs -f server
go test ./internal/...
go test ./internal/life/... ./internal/memoryvault/...
pnpm -C apps/web dev        # 前端（代理到 8080）

# 验收
scripts/acceptance.sh       # 启动 mock LLM/OneBot + 跑场景
```

## 8. 安全模式（本地）

- 本地视为**受信宿主机**（你拥有机器）；工作台仍是**路径监狱 + 命令白名单/审计 + 资源预算**。
- 工作台容器不挂载宿主机敏感目录；vault 以只读/受限方式挂给 workspace（如需要）。
- 密钥只存 server 加密存储/环境变量；不进入工作台；不进日志。
- 外部动作（发帖/发消息/邮件）默认走审批或限速；一键停机/禁网。
- 不承诺"防服务器管理员"的隐私；网页端隐藏私密抽屉即可。

## 9. 观测

- 日志：结构化（JSON），带 person/session/activity/reply_decision id。
- 审计：`audit_logs`（配置变更、审批、渠道、模型失败、活动执行、发帖）。
- 健康：`/health`（浏览器 `/api/health`；DB/迁移、模型、渠道、workspace、预算、账号唯一性）。
- UI：今天页显示"她在做什么/为什么没回"。

## 10. AGPL 合规

- 仓库 LICENSE 改为 AGPL-3.0；保留 Memoh 版权声明与来源（README/NOTICE）。
- 对外提供服务时按 AGPL 提供源码（部署时保留 `.git` 或源码包）。
- 第三方依赖按其许可保留；不复制 incompatible 代码。
