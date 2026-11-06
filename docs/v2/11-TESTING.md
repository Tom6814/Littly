# 11 · 测试与验收

> 前置：[01-VISION.md](01-VISION.md) §5、[02-ARCHITECTURE.md](02-ARCHITECTURE.md) §6、[03-DATA-MODEL.md](03-DATA-MODEL.md)、[LIFE-ENGINE.md](LIFE-ENGINE.md) §10。
> 目标：整夜自动构建时，**一条命令能判定"能不能收工"**；每个断言都对应 01 的成功标准或本文验收场景，不做装饰性测试。

## 1. 原则

- 测行为不测实现：断言"她没回且留痕"，不断言内部函数调用次数。
- 确定性优先：时间、随机、LLM、渠道、工作台全部注入；同一 seed 两次运行结果一致。
- 默认离线：单测/集成不访问真实模型、QQ、外网；e2e 只连本机 mock。
- 分层失败要能定位：单测失败不启动 Docker；契约失败不跑 UI。
- 验收脚本可重复：跑完清理容器/数据，不依赖上一次残留。

## 2. 测试分层

| 层 | 范围 | 依赖 | 命令/标签 | 目标时长 |
|---|---|---|---|---|
| L1 单测 | `life`/`memoryvault`/`reply`/`attention`/`workbench`/`configx`/`healthcheck` | 无 DB/网络 | `go test ./internal/{life,memoryvault,reply,attention,workbench,configx,healthcheck}/...` | <90s |
| L2 PG 集成 | 迁移、sqlc、约束、可见性、恢复 | Postgres 18 + pgvector | `-tags=integration` + `LITTLY_TEST_DATABASE_URL` | <5min |
| L3 契约 | SnowLuma OneBot WS、workspace、LLM | mock WS / fake workspace / httptest | `-tags=contract` | <3min |
| L4 e2e | 六面 UI + API + SSE | compose test profile + Playwright | `pnpm exec playwright test` | <8min |
| L5 验收 | 01 §5 的场景 | 全套 mock + fake clock | `scripts/acceptance.sh` | <10min |

### 2.1 Go 单测

- 纯函数/状态机/策略：表驱动；每个用例给 `name/want/seed`；错误路径与边界值必测。
- 领域包禁止 `time.Now()`、`rand.*`、`os.Getenv`；由 `Clock`/`Rand`/`Config` 注入（§3）。
- 文件系统用 `t.TempDir()`；并发用 `-race`；goroutine 泄漏用 `goleak`（新增测试依赖）在包级 `TestMain` 检查。
- 数据库访问不进入单测；用接口 fake（`memoryvault.Store`、`life.Repository`）。

### 2.2 PG 集成

- 独立库 `littly_test_<pkg>`；每个测试事务回滚或 `TRUNCATE`；迁移只跑一次（`TestMain`）。
- 默认用 `docker/docker-compose.test.yml` 的固定 Postgres（CI 同构、启动快）；需要隔离时可用 testcontainers-go，二选一，不混用。
- 重点：迁移可重复、约束（单 person、单渠道账号）与 `account_ref` 唯一性校验、`tsvector`/pg_trgm 中文子串、HNSW 维度、vault 索引重建、崩溃后状态。

### 2.3 渠道契约（mock OneBot v11 WS）

- `test/mockonebot` 实现 SnowLuma 信封：`{status, retcode, data, message, wording}`；可脚本化事件/响应/延迟/断线。
- 覆盖：Bearer 鉴权、`self_id`、私聊/群聊、`message_id` 有符号 int32（负值不得取绝对值）、`retcode!=0`、`message_sent` 回显、30s heartbeat、`bot_offline`、媒体段畸形跳过、长消息分片与发送限速。
- 契约测试只依赖适配器接口，不启动 server/channel worker。

### 2.4 workspace

- `workbench.Fake`：内存文件树 + 可编程 `Exec` + 失败注入（超时/权限/磁盘满）；覆盖路径监狱、读写、终端、快照、活动工具调用。
- 真容器冒烟：`-tags=docker`，仅在 Docker 可用时跑；验证文件/终端/浏览器/snapshot 与 bridge；不进入默认 CI 关键路径。
- 本地 Mac 默认 `docker` backend（12 M0）；若失败再用 `local` 兜底；同一接口跑 fake + docker/local 适配器测试。

### 2.5 e2e（mock LLM + fake workspace + mock SnowLuma）

- `docker/docker-compose.test.yml`：postgres、server（`LITTLY_ENV=test`）、web、mock-llm、mock-onebot；workspace 用 fake 服务，避免嵌套容器。
- LLM mock：OpenAI 兼容 `/v1/chat/completions`，按请求中的 `x-test-scenario` 或提示词标记返回固定 JSON/文本；记录完整请求供隐私断言。
- Playwright：Chromium + WebKit（Safari 引擎）两个 project；手机 viewport 390×844；失败保留 trace/screenshot。
- 每个测试用独立 person/DB schema 或重置端点；禁止共享可变状态。

## 3. 可测性设计

| 依赖 | 生产实现 | 测试实现 | 规则 |
|---|---|---|---|
| 时钟 | `life.Clock`（系统时区） | `FakeClock`（可 Advance/Set） | 领域内不直接取 now；"现在几点"显式进提示词 |
| 随机 | `rand.New(seed)` | 固定 seed / 序列 | 活动选择、回复抖动、抽样全部走注入 |
| LLM | provider 按用途 | `ScriptedLLM`（按标记返回、可故障） | 记录请求；失败可注入 429/500/超时/坏 JSON |
| 渠道 | SnowLuma/Web | `FakeChannel` + mock OneBot | 入站/出站/错误/断线可脚本化 |
| 工作台 | docker/apple/containerd/local | `workbench.Fake` | 文件/终端/浏览器/快照接口齐全 |
| Vault | 本地目录 | `t.TempDir()` | 原子写、墓碑、重建可测 |
| 事件 | SSE bus | `CaptureBus` | 断言 seq/类型/顺序 |
| ID | ULID | `FakeIDGen`（前缀+序号） | 快照稳定；不依赖真实时间 |

确定性细则：测试中禁止 `time.Sleep`（用 `Eventually` + fake clock）；golden 文件归一化时间/ID/path；同一测试不得依赖 map 迭代顺序；并行测试必须独立库/schema；所有随机 seed 写入失败日志。

## 4. 测试矩阵

### 4.1 生活引擎（life/state/planner/activity）

| 用例 | 关键断言 |
|---|---|
| 作息边界（wake/quiet/sleep，跨时区） | 07:30 生成意向；23:30 进 sleep；quiet 内不主动外发；时区切换不重复触发 |
| 状态衰减/恢复（1h/6h/24h） | energy -2/h、satiety -4/h、mood 向 55 回归；睡眠 +40~60；边界 0/100 不溢出 |
| tick 幂等/并发 | 同一 `tick_at` 重复执行不重复建活动；并发只一个 runner |
| 今日意向 | 每天一条；失败可重试；未完成活动跨天 carry 不丢 |
| 活动选择 | 硬约束（预算/quiet/低精力）优先；权重生效；同 seed 同结果；不连续重复同类 |
| 活动执行 | 进度/checkpoint/暂停/继续；失败写 error 日志；超时取消；产出 partial 保留 |
| 打断 | 消息进来更新 attention；活动进度不丢；恢复后从 checkpoint 继续 |
| 睡眠整理 | Dream 在 sleep 窗口；预算上限；失败保留 staging；次日意向生成 |

### 4.2 记忆（vault/dream/visibility）

| 用例 | 关键断言 |
|---|---|
| vault 写入 | 原子写；同 id 同内容幂等；不同内容拒绝；路径穿越/符号链接拒绝 |
| 索引重建 | 清空 PG 后从 vault 重建，id/数量/正文一致；embedding 可重算 |
| 可见性矩阵 | public 对任何人可用；relationship 仅对 `visibility_people_id` 本人（owner_web 同 owner 视角）；private 对任何检索/详情都不可见 |
| 检索排序 | 0.55 相关 + 0.25 重要 + 0.20 新鲜；top-k≤12；中文子串可命中；无向量时降级词法 |
| 写入路由 | 对话/工作台/日记/Dream 的 source/domain 正确；staging 去重/合并 |
| Dream | 抽取/合并/人物卡更新/SELF 受控更新/日记/明日计划；失败重试；stats 正确 |
| 墓碑 | deleted/superseded 不出现在检索；`_history` 存在 |
| 隐私回归 | 私密 nonce 不出现在任何 API/提示词/日志；relationship 不串给第三人；owner_web 不见他人 relationship |

### 4.3 回复策略（reply policy）

| 用例 | 关键断言 |
|---|---|
| 性格矩阵 | 粘人→多数 immediate；高冷→灌水 no_reply；社恐→短回/慢回；独立→选择性回 |
| 重要关系保底 | 沉默上限 N 小时到点至少一次解释/回应；可配置；留痕 |
| 紧急例外 | 关键词/标记/求助在 quiet 也提高优先级；原因可追溯 |
| 积压 | 多条未读→集中回/不回；不逐条爆炸 |
| 边界话题 | 命中边界→拒答或 no_reply；不编造 |
| 晚回/解释 | `later`/`explain_later` 到点执行；下次开口自然带过；outcome 更新 |
| 状态/活动影响 | 忙/低能量降低立即回概率；空闲提高 |
| 故障区分 | LLM 失败=system_error，不是 no_reply；可重试且不重复发 |

### 4.4 工作台工具

| 用例 | 关键断言 |
|---|---|
| 路径监狱 | `..`、绝对路径、符号链接逃逸全部拒绝；仅 `/workspace` 下可写 |
| 文件操作 | list/read/write/rename/delete/upload；二进制/超大文件降级；冲突提示 |
| 终端 | cwd 正确；超时终止；输出截断标记；断线重连；不泄露密钥 |
| 浏览器/桌面 | 会话创建/keepalive/关闭；不支持的 runtime 明确报 `unsupported`，不假装成功 |
| 活动工具链 | 工具调用→产物登记→日志 seq 单调；失败保留 partial artifact |
| 快照 | create/list/rollback；回滚前暂停 running 活动；回滚后文件一致 |
| 隔离 | 容器不挂宿主机敏感目录；工作台拿不到模型 key |

### 4.5 渠道

| 用例 | 关键断言 |
|---|---|
| 握手/鉴权 | 正确 token 连接；错误 token 拒绝；重连退避 |
| 消息映射 | private/group 正确；`self_id` 账号；负 `message_id` 原样保留 |
| 业务错误 | HTTP 200 + `retcode!=0` 视为失败；不得静默成功 |
| 回显/去重 | `message_sent` 120s 去重；入站按 account+message_id 去重 |
| 限速/分片 | 长文本分片；全局最小间隔；超限排队不丢 |
| 账号唯一 | 每渠道一个账号；同 `account_ref` 跨渠道冲突；启动检查报错 |
| 状态机 | starting→waiting_scan→connected；断开→disconnected；UI 与 DB 一致 |
| 多渠道同一人 | Web + QQ 同一 `people_id`；3 条连发合并 1 次决策/1 条回复；共享沉默保底 |
| 故障 | heartbeat 超时/`bot_offline` 标记 error；恢复后状态回转；发送超时 → outbox `unknown`，不盲重试 |

### 4.6 配置/健康

| 用例 | 关键断言 |
|---|---|
| schema 校验 | 必填/类型/范围；未知字段策略明确；错误定位到字段 |
| 优先级 | 文件 < 环境 < DB override；密钥不回显；日志脱敏 |
| 启动预检 | 已配置但无效的 chat 模型→退出码 78 + 明确错误；未配置→setup 模式而非崩溃 |
| 健康检查 | DB/迁移/模型/渠道/workspace/预算/账号唯一/vault/磁盘逐项；聚合状态正确 |
| 变更 | 保存后热更新或明确"需重启"；audit 记录变更者/字段（不含密钥） |

### 4.7 API / UI

| 用例 | 关键断言 |
|---|---|
| 认证/引导 | 未登录 401；未完成 onboarding 重定向；单 person |
| 契约 | 关键 JSON golden；分页 cursor；错误 envelope；404 不泄露私密存在性 |
| SSE | seq 单调；断线 `since` 补拉；事件失效对应 query |
| 六面渲染 | 六个路由可达；空/加载/错误/未配置态；手机 viewport |
| 关键交互 | 活动暂停/继续；记忆检索；文件保存；渠道测试/冲突；模型测试；刹车 |
| 隐私 UI | 页面 HTML/搜索/命令面板均无私密 nonce；无"显示私密"控件 |
| 无障碍 | 键盘可达、焦点可见、地标/标题、`aria-live`；WebKit 冒烟 |

## 5. 验收场景（必须全绿）

### A1 她的一天

FakeClock 从 07:00 开始，按 15min tick 推进到 23:30；ScriptedLLM 返回意向/活动计划/日记。断言：wake 生成今日意向；至少 1 个自主活动 running→done；产出 artifact 与 activity_log；时间线含 activity/post/diary/dream；Today API 可读；全程 <90s。

### A2 被打断

活动进度 60% 时，朋友 P 发消息；高冷人设。断言：活动仍为 running 或 paused，progress 不倒退；attention 事件记录；回复决策为 `no_reply`/`later`；若 later，到点发送；日志含 interrupt/resume。

### A3 回复矩阵

四组独立测试实例（各自一个 person，串行启动，避免共享状态）：
1. **高冷 + 5 条灌水**：≥4 条 `no_reply`，或全部晚于 1h 的 `later/short`；无即时空出站；决策全留痕。
2. **粘人**：全部 `immediate`，在阈值内出站。
3. **重要人保底**：高冷 + 已沉默 9h（默认 `important_silence_hours=8h`）+ 一条普通消息；至少 1 条解释或回应，`factors.guardrail` 有记录。
4. **紧急例外**：quiet + 高冷 + "我撑不下去了"；动作升级为 immediate（或 10 分钟内 later），原因记录为 urgent。

### A4 主动分享

活动完成产出 `artifacts/notes/x.md`；触发主动消息。断言：内容含具体标题/链接，不是"在吗"；频率上限生效；若开审批则 draft→approve→queued→sent；连续 4 条未回 → 硬停直到对方发言；单条失败 → outbox failed/unknown，不显示为"不想回"。

### A5 私密抽屉网页不可见

写入 `visibility=private` 且含随机 nonce 的记忆；vault 文件存在。断言：`GET /api/memories?q=nonce` 为 0；`GET /api/memories/:id` 为 404；Today/Memory 页面 HTML、命令面板、localStorage 均无 nonce；DB 仍有记录。再用 `relationship:owner` 的记忆验证可见；`relationship:朋友` 的记忆在 owner_web 不可见（404/空）。

### A6 跨人隐私

甲私下告诉她的秘密（nonce，`relationship:甲`）；以乙的身份发起对话。断言：发给 LLM 的提示词不含 nonce（mock 记录）；乙的人物卡/上下文不含；owner_web 也看不到；public 记忆可正常出现；甲的上下文仍可检索到。

### A7 兴趣演化

种子兴趣 strength=40；连续 3 次相关对话/活动；Dream 产生"升温/新兴趣"候选。断言：候选带来源与理由；批准后 strength 上升；用固定 100 个 seed 对比，相关活动选择率显著高于对照（结果可复现）；拒绝后不生效。

### A8 工作台产出

活动 `write` 通过 fake workspace 创建 `notes/hello.md`（CI 确定性）。断言：artifact 入库；`fs/read` 可读；activity_log 含 plan/tool/result；Today/Workbench 显示产出。最终验收必须在 docker backend 再跑一次真实落盘，并验证 snapshot 含该文件；CI 可只跑 fake。

### A9 崩溃重启恢复

活动执行到 50% 时 `kill -9` server 进程（不经优雅退出）。重启后断言：state/activity/artifact 不丢；活动为 paused/interrupted 且可 resume；日志无重复 seq；tick 继续；未完成活动不被标记 done。

### A10 无效模型拒启动

配置 `chat.base_url=http://127.0.0.1:1` 或错误 key。断言：server 以退出码 78 退出；日志含 purpose/model/原因；修复后正常启动；**未配置**与**配置无效**行为不同（前者进入 setup 模式）。UI 不静默显示"在线"。

### A11 同账号两渠道冲突

将同一 `account_ref=qq:<uin>` 配到两个渠道（或两份 SnowLuma 配置）。断言：写入返回 409；启动检查失败并指明冲突；World 显示冲突卡、禁止启用；健康检查红；audit 记录；不存在"后写覆盖"。

### A12 六面 UI 冒烟

Playwright：登录→onboarding→六面逐页；每面至少一个关键动作（发消息/改 traits/检索/存文件/测渠道/跑健康）；手机与 WebKit 各一遍；无 console error；私密 nonce 不出现。

## 6. 命令与 CI

```bash
# 1) 快速单测（提交前）
go test ./internal/... -count=1
go test -race ./internal/... -count=1

# 2) PG 集成
docker compose -f docker/docker-compose.test.yml up -d postgres
export LITTLY_TEST_DATABASE_URL='postgres://littly:littly@127.0.0.1:55432/littly_test?sslmode=disable'
go test -tags=integration ./internal/db/... ./internal/memoryvault/... ./test/integration/...

# 3) 契约
go test -tags=contract ./internal/channel/... ./internal/workspace/...

# 4) 前端
pnpm -C apps/web typecheck   # M0 补 script: vue-tsc --noEmit
pnpm exec vitest run --project web
pnpm -C apps/web build

# 5) e2e（起 test profile）
docker compose -f docker/docker-compose.test.yml up -d --build
pnpm exec playwright test --project=chromium --project=webkit

# 6) 验收（全部场景，含清理）
scripts/acceptance.sh
scripts/acceptance.sh --only=reply-matrix --seed=42
```

CI 顺序：lint → 单测（race）→ build → PG 集成 → 契约 → 前端 typecheck/build/vitest → e2e → acceptance。缓存 Go/pnpm；总预算 CI ≤40min。覆盖率目标：`life`/`memoryvault`/`reply`/`attention` ≥80%，`configx`/`healthcheck` ≥75%，**新增/改动包** ≥75%；上游未改动代码与生成代码不计，不设全仓硬门槛。前端以 typecheck+build+e2e 为门槛。

## 7. 失败判定与 flaky

- **直接判失败**：panic、data race、goroutine 泄漏、迁移校验和不一致、临时文件/容器残留、测试依赖真实外网、验收脚本非连续 3 次全绿。
- **禁止**：`time.Sleep` 等待异步、按 map 顺序断言、跳过测试当修复、golden 自动更新进 CI。
- **flaky 处理**：CI 自动重跑 1 次；若通过则标记 `flaky`、24h 内修复或删除，并记录 seed/请求 id；同一测试一周内 flaky ≥2 次，从主干移除。
- **失败产物**：`test-results/<timestamp>/` 保存日志、LLM 请求（脱敏）、DB dump、Playwright trace/screenshot；验收脚本失败时保留容器并打印 `docker compose logs` 命令。
- **判定口径**：01 §5 的 8 条成功标准逐条对应 A1–A11（A12 为 UI 冒烟）；任何一条不满足，不得宣布 v2 首版完成。

## 心跳（16-HEARTBEAT）

| 用例 | 断言 |
|---|---|
| `heartbeat_after(20, reason)` | 落库/回执；20m 后触发；`<heartbeat>` 含理由；Today 显示下次心跳+理由 |
| 不带 reason | 工具报错、不创建；审计 |
| 无自心跳 | 保底心跳按抖动出现；不会永不醒；硬上限 8h |
| 自心跳晚于保底 | 保底先到，`<heartbeat>` 说明原安排；可继续睡并重排 |
| 进程在 due 前重启 | pending 保留；到点触发；错过合并一次（不风暴）；running 标 interrupted |
| 重复/在飞 | CAS 恰好一次；不会两个心跳同时跑 |
| 连续 <60s 触发 | 被间距钳制；无忙循环 |
| 连续 no-op | 间隔拉长 → 建议 → 暂停并询问一次；不无限烧钱 |
| 免打扰/每日上限/未回静默 | 触发被 hold/推迟；回执说明；她不能放宽护栏 |
| `heartbeat_respond` 缺失/非法 | run 标 error/interrupted；不影响下次；不产生聊天消息 |
| 哨兵文本 | 聊天/日志中不出现 HEARTBEAT_OK 之类哨兵；notify=false 静默 |
| 心跳里读到不可信数据 | 不能据此创建新的重复心跳/监听（注入防护） |
| 心跳里发消息 | 只走 outbox + 质量门；无任意目标参数 |
| `wait_for_user_reply` | **不存在**该工具；无阻塞 turn |

## 人物分层（05 §7）

| 用例 | 断言 |
|---|---|
| 100 个陌生人/群友互动 | 只有 DB 行；不生成人物卡；聚合文档不写入 stranger |
| 第 21 次互动/14 天 | 晋升 friend；从记忆生成卡；`card_path` 落库；审计 |
| 手动 pin | 立即生成卡；不等待阈值 |
| 180 天无互动 | 卡片归档 `_history`；聚合保留一行；记忆/可见性不变 |
| 聚合文档上限 | 200 行；90 天无互动移除；不无限膨胀 |
| acquaintance 注入 | 只 brief 一行；完整卡不注入；`lookup_contact` 可回查 |
| 敏感信息 | 聚合行不含私密细节；relationship 记忆不泄漏给第三人 |
