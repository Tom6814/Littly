# 12 · 整夜构建计划（M0–M7）

> 前置：[01-VISION.md](01-VISION.md) §5、[02-ARCHITECTURE.md](02-ARCHITECTURE.md)、[MEMOH-FORK-ASSESSMENT.md](MEMOH-FORK-ASSESSMENT.md) §8/§9、[11-TESTING.md](11-TESTING.md)。
> 形态：一个人、一台 Mac、一个通宵；先地基后功能，每个 checkpoint 必须可运行、可测试、可回退。

## 1. 前提

### 1.1 机器与软件

| 项 | 要求 | 检查 |
|---|---|---|
| 机器 | Apple Silicon Mac，≥16GB 内存，≥60GB 空闲 | `sysctl -n hw.memsize`、`df -h` |
| Docker Desktop | ≥4.30，分配 ≥8 CPU / 12GB；SnowLuma 需 privileged + `SYS_PTRACE` + `seccomp=unconfined` | `docker info` |
| Go | 1.25.7（与 `go.mod` 一致） | `go version` |
| Node/pnpm | Node ≥22，pnpm 10（corepack） | `node -v && pnpm -v` |
| 工具 | git、jq、curl、`psql`（可选）、Playwright 浏览器 | `git --version` |
| 端口 | 8082(web)、8080(server)、5432(pg)、3001(OneBot)、6081(noVNC)、5099(SnowLuma WebUI) | `lsof -i :8082` |

### 1.2 分叉与目录（决定）

- **新仓库 + 新目录**：`~/littly-v2`，从 Memoh `v0.13.1` 起；`~/littly` 保留设计文档与旧项目归档，不混入 v2 代码。理由：当前目录是旧 TS 项目，原地硬分叉会污染历史与依赖。
- 保留 `upstream` remote 与分叉 tag，便于以后 diff；不 force push。

```bash
git clone https://github.com/felinics/Memoh.git ~/littly-v2
cd ~/littly-v2
git checkout v0.13.1
git switch -c littly/v2
git tag upstream-v0.13.1
git remote add upstream https://github.com/felinics/Memoh.git
mkdir -p ~/LittlyData/{pg,vault,workspace,snowluma,backups,logs}
cp -R ~/littly/docs/v2 ~/littly-v2/docs/v2   # 设计文档随代码走
```

### 1.3 基线检查（M0 之前）

```bash
go mod download && go build ./cmd/agent
pnpm install && pnpm -C apps/web build
docker compose -f docker-compose.yml config           # 预构建镜像口径
docker compose -f docker/docker-compose.yml config    # 本地构建口径
docker compose -f docker/docker-compose.yml up -d --build   # 上游基线
# M0 产出 docker/docker-compose.local.yml 后改用：
# docker compose -f docker/docker-compose.local.yml up -d --build
curl -fsS http://127.0.0.1:8080/health

# Mac 开发口径（若 Compose 内嵌 containerd 不可用）：原生 server + Docker Desktop workspace
cp conf/app.local.toml conf/config.local.toml   # 改 database=postgres、container.backend=docker、addr=:8080
CONFIG_PATH=conf/config.local.toml go run ./cmd/agent serve
```

基线跑通的定义：能登录 web、能发一条消息、能打开工作台文件面板；失败先修环境，不进入 M1。

### 1.4 配置与密钥

- **产品配置唯一**：`conf/littly.yaml`（schema 校验，UI 编辑写 DB override）；`config.toml` 仅保留进程级基础设施（DB DSN、端口、数据目录、runtime），UI 不暴露、文档不称为"配置"。
- 密钥只经环境变量/挂载 secrets 注入，`littly.yaml` 用 `${VAR}` 引用；`conf/littly.local.yaml` 进 `.gitignore`。
- 模型 key 缺失时允许 **mock 模式**（`LITTLY_LLM=mock`）跑通全链路，但验收报告必须标注"mock 模型"，不得冒充真实模型。

### 1.5 许可与来源

- `LICENSE` 换为 AGPL-3.0；`NOTICE` 写明：Memoh、`github.com/felinics/Memoh`、v0.13.1、分叉日期、修改范围；README 顶部保留来源与许可证。
- 上游版权头不删；新增文件用 AGPL 头；第三方依赖按其许可保留。
- 对外提供服务时提供源码（保留 `.git` 或源码包）。

## 2. 里程碑

### M0 分叉与基线（目标 90 分钟）

- 任务：完成 §1.2–§1.5；把 `docs/v2` 纳入仓库；建立 `docs/v2/BUILD-LOG.md`（时间/commit/测试/阻塞）；跑通基线；从上游 compose 派生 `docker/docker-compose.local.yml`（postgres/server/web/snowluma）；建立 `docker/docker-compose.test.yml` 骨架（postgres + mock-llm + mock-onebot + fake-workspace）；给 `apps/web` 补 `typecheck` script（`vue-tsc --noEmit`）并安装 Playwright（root devDependency + chromium/webkit）跑空测试；**实测 workspace runtime**（优先 `docker` backend + Docker Desktop；Compose 内嵌 containerd 作备选；`local` 仅最后兜底），结论与命令写入 `BUILD-LOG.md`；CI 增加 Go build/test + web typecheck/build。
- 文件：`.github/workflows/`、`NOTICE`、`README.md`、`docker/docker-compose.local.yml`、`docker/docker-compose.test.yml`、`conf/config.local.toml`、`package.json`（root，Playwright）、`apps/web/package.json`、`playwright.config.ts`、`docs/v2/`。
- 命令：§1.3；`pnpm -C apps/web typecheck`；`pnpm exec playwright install chromium webkit`；`git commit -m "chore: fork Memoh v0.13.1 as Littly v2 baseline"`。
- 退出：`docker compose up` 或原生 server（docker backend）可登录；`go build ./...` 通过；web typecheck/build 通过；本地等价命令通过（push 后 CI 绿）；runtime 结论（docker/apple/containerd/local）写入 `BUILD-LOG.md`；`git tag cp-m0`。

### M1 单实例一个人（目标 90 分钟）

- 任务：迁移 `littly_persona/traits/state/channel_accounts`；启动创建唯一 person；`/api/bootstrap`；删除多 Bot **管理**路由与 UI（列表/创建/切换/详情），保留 `/bots/:personId/{container,sessions,messages,...}` 作为内部资源路径且不在 UI 暴露；auth 简化为管理员 + 联系人（邀请/绑定，无租户/角色矩阵）；渠道唯一账号与 `account_ref` 非空唯一校验（应用层 + 启动检查，不新增 03 字段）；onboarding 接入；**SnowLuma 适配器最小闭环**（OneBot WS 连接/收发/`self_id` 守卫/去重，先用 mock OneBot 验收）。
- 文件：`internal/person/`、`internal/persona/`、`internal/channel/adapters/snowluma/`、`internal/handlers/bootstrap.go`、`db/postgres/migrations/`、`apps/web/src/router.ts`、`components/sidebar/`、`pages/onboarding/`。
- 命令：`go test ./internal/person/... ./internal/handlers/...`；`pnpm -C apps/web typecheck`。
- 退出：只有一个她；`GET /api/bootstrap` 返回 person/onboarding；无法创建第二个；渠道重复返回 409；mock OneBot 能收发一条；导航只剩六面。

### M2 生活引擎骨架（目标 90 分钟）

- 任务：迁移 state/interests/goals/intentions/activities/activity_logs/threads + `littly_wakeups`；实现 `internal/life/{clock,state,interests,goals,planner,activity,wake}`；**唤醒调度器（16 §5：self/fallback/event；reason 必填；保底抖动；无固定 tick）**；醒来决策/活动执行/日志；Today API；mock LLM 可跑。
- 文件：`internal/life/*`、`internal/agent/background/`、`internal/handlers/today.go`、`db/postgres/queries/life.sql`。
- 命令：`go test ./internal/life/... -count=1`；`scripts/seed-dev.sh`；`curl /api/today`。
- 退出：tick 能生成今日意向并启动一个活动；activity_log 有 plan/step/result；Today 返回状态/活动/时间线；重启后状态不丢。

### M3 记忆 v2（目标 90 分钟）

- 任务：`internal/memoryvault`（vault 原子写/读/索引/墓碑/重建）；`littly_memories` + staging + diaries + dream_reports；检索与可见性硬过滤；Dream 流程；替换上游 memory provider；SELF/人物卡种子；记忆 API。
- 文件：`internal/memoryvault/*`、`internal/life/sleep.go`、`internal/handlers/memory.go`、`db/postgres/queries/memory.sql`。
- 命令：`go test ./internal/memoryvault/... -tags=integration`；`scripts/rebuild-index.sh`。
- 退出：对话/活动写入 vault + 索引；检索注入；private 不出现在任何检索/详情；Dream 产出报告；清空 PG 可从 vault 重建。

### M4 工作台活动（目标 90 分钟）

- 任务：按 M0 的 runtime 结论定本地默认（优先 `docker`，其次 `containerd`，`local` 兜底）；活动执行器接文件/终端/浏览器工具；artifact 登记；活动日志；暂停/继续/恢复；快照（`littly_workspace_snapshots`）；Workbench API 与 UI 面板接线。
- 文件：`internal/workbench/*`、`internal/workspace/`（上游适配）、`internal/life/activity.go`、`internal/handlers/artifacts.go`、`db/postgres/migrations/0007_workbench.sql`、`apps/web/src/pages/workbench/`。
- 命令：`go test -tags=contract ./internal/workbench/...`；docker backend 冒烟，local 兜底再跑一次。
- 退出：一个自主活动真实产出文件；artifact 可查/可下载；快照可建/可回滚；杀掉 server 后活动可恢复；桌面不可用时有明确说明。

### M5 回复与主动性（目标 75 分钟）

- 任务：`internal/attention` + `internal/reply`；traits/关系/状态/内容评分；动作映射；`reply_decisions` 留痕；重要关系保底；紧急例外；打断/恢复；主动消息（内容门槛/why_now/重要人保底/审批；无生活频率配额）；`explain_later`；唤醒工具 `wake_after`/`wake_at`（reason 必填）；出站 outbox（06 §5.11）与 `littly_channel_events`（08）；若 M1 只完成 mock，这里补真实 SnowLuma 收发。
- 文件：`internal/attention/`、`internal/reply/`、`internal/life/social.go`、`internal/agent/decision/`、`internal/channel/adapters/snowluma/`、`handlers/reply.go`、`db/postgres/migrations/0008_channels.sql`。
- 命令：`go test ./internal/reply/... ./internal/attention/... -count=3`。
- 退出：高冷可连续已读不回；粘人几乎都回；重要人保底；紧急例外；决策全部留痕；主动消息有具体内容、不刷屏。

### M6 UI 六面（目标 90 分钟）

- 任务：`MainLayout`/`LittlyNav` + 六面页面与子路由；Today 聚合与聊天；她的 tabs；记忆检索/人物/threads/staging/dream；工作台 dockview；世界渠道/联系人/社交/技能；设置模型/健康/预算/备份/部署/刹车；全局状态与 SSE；响应式与 Safari 冒烟。
- 文件：`apps/web/src/pages/{today,her,memory,workbench,world,settings}/`、`components/{common,memory,world}/`、`lib/api/`。
- 命令：`pnpm -C apps/web typecheck && pnpm exec vitest run --project web && pnpm -C apps/web build`。
- 退出：六面可达；A12 冒烟通过；空/错误/未配置/模型异常/渠道断开都有明确 UI；无第七个导航项。

### M7 收口与验收（目标 75 分钟）

- 任务：配置 schema/启动预检（无效模型退出 78）；健康检查；预算/审计；备份/刹车；`scripts/dev-up.sh`/`dev-down.sh`/`dev-reset.sh`、`scripts/acceptance.sh`、`scripts/demo.sh`；崩溃恢复；性能初测；`BUILD-REPORT.md`；演示脚本彩排。
- 文件：`internal/configx/`、`internal/healthcheck/`、`scripts/`、`docs/v2/BUILD-REPORT.md`。
- 命令：`scripts/acceptance.sh`（连续 3 次）；`scripts/demo.sh`。
- 退出：A1–A11 全绿；A12 通过；`docker compose down -v` 后从零可复现；报告含 commit/测试日志/已知问题。

## 3. 整夜执行顺序

### 3.1 时间盒（建议 20:30 开始）

| 时间 | 阶段 | checkpoint（commit + tag） |
|---|---|---|
| 20:30–22:00 | M0 分叉/基线/CI | `cp-m0` |
| 22:00–23:30 | M1 单实例 + onboarding | `cp-m1` |
| 23:30–01:00 | M2 生活引擎 | `cp-m2` |
| 01:00–02:30 | M3 记忆/Dream | `cp-m3` |
| 02:30–04:00 | M4 工作台 | `cp-m4` |
| 04:00–05:15 | M5 回复/主动 | `cp-m5` |
| 05:15–06:45 | M6 六面 UI | `cp-m6` |
| 06:45–08:00 | M7 验收/报告 | `cp-m7` + `v2.0.0-local.1` |
| 08:00–08:30 | 演示彩排 + 交付 | — |

每个 checkpoint 固定动作：`gofmt` → 相关测试 → `pnpm -C apps/web typecheck` → 提交 → 打 tag → 更新 `BUILD-LOG.md`（完成/未完成/下步/风险）。**测试不过不进入下一阶段**；若只是个别非关键用例，记录并隔离，主干必须绿。

### 3.2 并行与串行

- 串行：M0→M1→M2 必须顺序（schema/接口依赖）。
- 可并行：M2 的 `life` 纯逻辑与 M3 的 `memoryvault` 可在不同分支/终端并行，但 M3 的 API 依赖 M1 的 person；M6 的静态壳可在 M2 后开始，数据接线等 M3/M4/M5。
- 单人执行时**不要开多分支合并**；按表顺序，避免半夜解冲突。若用两个 agent：一个后端（M2–M5），一个前端（M6 壳/组件），checkpoint 时合并，禁止同时改 `router.ts`/`LittlyNav`。

### 3.3 失败回退

- 代码：`git stash` 或 `git reset --hard cp-<last>`；只回退未提交/本阶段提交，不回退已打 tag。
- 数据库：迁移只增不删；失败先 `pg_dump` 备份，再 `git reset` + 重建测试库；不在夜间写 down migration。
- 卡点超过 45 分钟：降级为 mock/stub（如工作台用 fake、QQ 用 mock），记录到 `BUILD-LOG.md`，继续后续；**不得**用假数据冒充完成。
- 环境崩：先保代码（commit），再修 Docker/端口；`docker compose down` 不清 volume。

### 3.4 禁止事项

- 不迁移旧数据、不读旧库、不合并旧 per-person 记忆；不部署服务器。
- 不把密钥/QQ 登录态/token 提交进 git；不把 `conf/littly.local.yaml` 入库。
- 不关闭/跳过失败测试，不改 `-run` 过滤冒充全绿，不用 `--no-verify`。
- 不删除上游 NOTICE/版权头，不 force push，不改写已 tag 的提交。
- 不启用市场/ACP/多租户代码路径；不新开第七个导航面。
- 不把宿主机敏感目录挂进工作台；不以 root 在宿主机执行她的命令。
- 不在没有 checkpoint 的情况下连续写 3 小时；不凌晨改 schema 方向。

## 4. Definition of Done 与交付物

### 4.1 DoD（对应 01 §5）

1. 本地 `docker compose up` 可登录、可聊天；QQ（SnowLuma）可收发（无真实账号时以 mock 验收并标注）。
2. 无人对话时她执行 ≥1 个自主活动，有产出物和活动日志。
3. 高冷可已读不回；粘人几乎都回；重要关系保底；紧急例外。
4. private 记忆不出现在 web 任何列表/搜索/详情（404）。
5. 甲的私事不出现在乙的对话/提示词；人物卡体现关系。
6. 重启后状态/活动/记忆/产出不丢；未完成活动可继续。
7. `go test ./...`、PG 集成、契约、前端 typecheck/vitest/build、e2e、`scripts/acceptance.sh` 全绿（连续 3 次）。
8. 一份产品配置可解释模型/渠道/行为；无效模型启动即失败（退出码 78），未配置进入 setup 而非崩溃。

### 4.2 交付物

- 分支 `littly/v2`；每个里程碑一个 commit + tag；最终 tag `v2.0.0-local.1`。
- `docs/v2/BUILD-REPORT.md`：commit、环境、测试命令与结果、覆盖率、已知问题、与 01 的逐条对照、mock 使用声明。
- `test-results/`（脱敏）：单测/集成/e2e 日志、截图、验收输出。
- `scripts/dev-up.sh`、`dev-down.sh`、`dev-reset.sh`、`acceptance.sh`、`demo.sh`、`seed-dev.sh`。
- 演示步骤（§6）与一份 5 分钟录屏（可选）。
- AGPL `LICENSE`、`NOTICE`、README 来源说明。

## 5. 风险与预案

| 风险 | 概率 | 预案 |
|---|---|---|
| Mac Docker 嵌套 containerd 不可用 | 高 | M0 实测；优先 `docker` backend（02/07），Compose 内嵌 containerd 失败则改原生 server；`local` 仅最后兜底（FORK §7.2）。API/UI 不变；桌面/浏览器按 runtime 降级并在 UI 说明；结论回写 02 §2 |
| Go/前端依赖装不上 | 中 | 钉 tag/lockfile；先用 `go build ./cmd/agent` + `pnpm install --frozen-lockfile`；不升级主版本；预留 30 分钟 |
| 模型 key 缺失/额度不足 | 中 | `LITTLY_LLM=mock` 跑通全链路；验收标注 mock；真实 key 只用于最后演示，不写日志 |
| SnowLuma 在 Docker Desktop 无法 ptrace/扫码 | 中 | 先 mock OneBot 契约；真实 QQ 作为加分项；失败则 Web 渠道完成验收，QQ 标"未验证"并写清原因 |
| 时间不够 | 高 | 砍功能顺序：相册/声音 → 社交 → 桌面/浏览器打磨 → 成长 UI；**不砍**隐私、回复决策、可见性、崩溃恢复、验收脚本 |
| 测试慢/不稳定 | 中 | 固定 compose PG；e2e 只跑关键路径；flaky 隔离；验收可 `--only` |
| pgvector 维度/扩展问题 | 低 | 维度可配 + 重建；失败降级词法检索（显式标记） |
| 迁移把旧库改坏 | 低 | 只对新建 `littly_*` 表做 additive migration；旧库只备份；每晚 `pg_dump` |
| 端口冲突 | 低 | `.env` 覆盖 8082/8080/5432/3001/6081；先 `lsof` |
| AGPL 遗漏 | 低 | M0 完成 LICENSE/NOTICE；M7 检查 README/页脚/关于页 |

## 6. 本地验证与演示脚本

### 6.1 一键起停

```bash
scripts/dev-up.sh          # compose up + 等健康 + 打印地址
scripts/dev-down.sh        # 停服务，保留数据
scripts/dev-reset.sh       # 仅测试环境：down -v + 重新 seed（需确认）
```

### 6.2 验收命令

```bash
scripts/acceptance.sh                       # 全部场景，连续 3 次
scripts/acceptance.sh --only=privacy        # 单项
go test -race ./internal/...
LITTLY_TEST_DATABASE_URL=... go test -tags=integration ./internal/db/... ./internal/memoryvault/...
pnpm -C apps/web typecheck && pnpm exec vitest run --project web && pnpm -C apps/web build
docker compose -f docker/docker-compose.test.yml up -d --build
pnpm exec playwright test
```

### 6.3 演示（10 分钟）

1. `scripts/dev-up.sh`；打开 `http://127.0.0.1:8082`，登录。
2. Today：展示四维状态、当前活动、时间线；点"暂停/继续"，看日志。
3. 发一条消息：展示流式回复与工具卡；再发灌水消息，展示"没回"卡片与原因（高冷种子）。
4. 她：改一个 trait、看 SELF、批准一条成长提案（若有）。
5. 记忆：搜索一个主题，打开详情看 vault 出处；用私密 nonce 搜索，展示 0 结果与 404；说明文件只在服务器。
6. 工作台：打开她刚写的文件；开终端 `ls`；看产出物与快照。
7. 世界：渠道卡状态、测试、账号归属；现场尝试把同一账号配到第二个渠道，展示 409 阻断。
8. 设置：模型测试、健康检查、预算、刹车开关。
9. 崩溃恢复：`docker compose restart server`，刷新 Today，活动仍在/可继续。
10. 收尾：`scripts/acceptance.sh` 输出全绿；打开 `BUILD-REPORT.md` 对照 01 §5。

### 6.4 收工判定

只有同时满足才可结束：§4.1 的 8 条 DoD + A1–A12 全绿 + 演示步骤可复现 + `BUILD-REPORT.md` 写完 + 数据已备份。任何一条不满足，记录为"未完成"而不是"基本完成"。
