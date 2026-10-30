# 计划 v2 验收清单

> 每一条都对应**真实跑过的证据**，不是计划复述。
> 复现方式见 [DEPLOY.md](DEPLOY.md) §5。
>
> 基线：`dsh` fork 固定 commit `22ddee3`；行为规格以旧仓 `docs/PROJECT-DESIGN.md`（2101 行）为准。

## 0. 规模

| 项 | 数量 |
|---|---|
| 业务包（`harness/packages/littly/`） | 18 |
| 控制台页面 | 15 + 聊天页 |
| 内置工具 | 27 |
| 控制台 API 路由 | 84 |
| 行为断言 | 615（15 个脚本）+ 61（端到端）+ 15（扫码链路，需 live sidecar） |
| 容器验收 | 10 项 |

---

## 1. M0 —— 基座与脚手架

| 要求 | 证据 |
|---|---|
| clone 并固定 dsh fork | `harness/` vendor 于 commit `22ddee3`；`harness/VENDORED.md` |
| 上游跑通 | `apps/cli` 真实启动（`--profile chat`），`harness` 400 workspace 项目构建 7 gate 全绿 |
| 剥离编程专属部分 | profile 补丁按 `docs/PORTING-GUIDE.md` §10 剥离：fs/shell/sandbox/subprocess/todo/plan/goal/workflow/acp/遥测/DeepSeek 专属 |
| 业务存储插件 + schema/migration | `@littly/storage`：20 张表，迁移版本化（`schema_migrations`），`storage_migrations` 单事务 |
| CI | `.github/workflows/ci.yml`：构建门禁 + 断言 + 控制台构建 + 端到端 + 容器构建探活 |

## 2. M1 —— harness 业务核心

| 要求 | 证据 |
|---|---|
| persona / prompt pack | `@littly/persona`（852 行）：分层提示词 + prompt pack 数据文件；人格核心逐字保留（`docs/PRINCIPLES.md` §四） |
| agents 配置 | `@littly/agents`：26→28 个工具的 agentic 循环、缓冲窗口（15~20s 合并 + 原子认领「恰好一次」） |
| console-api | `@littly/console-api`：84 条路由，统一信封 `{data}` / `{error:{code,message(中文)}}`，鉴权 `public/required/admin` 三级 |
| 记忆引擎 v2 | `@littly/memory`：event_time 衰减、类别半衰期、supersede 取代链、provenance 出处、explain 台账、protected 能力位、幂等回执 + if_sha256 漂移检测 |
| golden baseline | `scripts/verify-memory.mjs`（32）+ `scripts/verify-memory-v2.mjs`（29）：逐条锁定公式、阈值与拒绝路径 |

## 3. M2 —— 首发渠道

| 要求 | 证据 |
|---|---|
| SnowLuma 全功能 | `@littly/channel-snowluma`（880 行）：OneBot v11 正向 WS、多账号、能力探测、渠道工具（表情/资料/头像/Q 空间动态） |
| Telegram | `@littly/channel-telegram`：轮询/Webhook、去重游标、绑定深链拦截 |
| 绑定 / 身份归一 | **闭环完整**：控制台发码（`POST /api/bind/:channel/code`，6 位码 / TG deep-link，10 分钟有效、同 kind 旧码作废）→ 渠道侧 `binding.ts` 消费（限频、一次性、冲突不抢占）→ 写 `channel_identities` + 联系人晋升 → 状态可见 → 可解绑（不删历史与记忆）。`verify-bind.mjs` 22 项 |
| scheduler 挂 dsh 定时任务 | `@littly/scheduler`：60s tick（僵死批次恢复 / 到期缓冲兜底 / 预约门控 / 日记） |
| 心跳（心声回响） | `@littly/scheduler/src/heartbeat.ts`：静默扫描 + 指数退避唤醒（10min→2h 封顶）、失败冷却 30min、决策落地为预约/记忆/日记。`verify-heartbeat.mjs` 42 项 |

## 4. M3 —— 全渠道、语音、bilibili

| 要求 | 证据 |
|---|---|
| 微信 iLink | `@littly/channel-wechat-ilink`：iLink 直连 + 桥接 Webhook（HMAC 验签 / challenge / reply_async / 幂等）。`verify-wechat-ilink.mjs` 78 项 |
| QQ 官方 | `@littly/channel-qq-official`：网关接入、token 缓存、被动回复窗口。`verify-qq-official.mjs` 59 项 |
| Discord | `@littly/channel-discord`：Gateway + REST、DM 投递地址解析。`verify-discord.mjs` 68 项 |
| 语音消息 | `@littly/voice`：Fish TTS + 三轮流水线（语气门按技术可读性判退），已接进对话主链路 |
| /call 实时通话 | `@littly/voice-call`：同端口 `/call` WS（Deepgram STT → 角色快速回复 → Fish 流式 TTS → 通话卡片 → 挂断回响总结）。`verify-voice-call.mjs` 75 项 |
| bilibili sidecar + 账号面板（**已于 §11.2 被 bilibili-cli 方案替换**） | `sidecars/bili/`（HTTP wrapper）+ `@littly/tools` 的 `bili` 元工具（白名单 + dry-run + 限频 + 审计）+ 控制台「Bilibili」页（扫码登录）。`verify-bili.mjs` 36 项 |
| 扫码登录链路（用户反馈项，**已于 §11.2 被替换**） | 归一化在服务端做（`biliQrImageDataUrl`），API 直接返回 data URL，前端仍容错 —— 不再依赖「控制台 bundle 与 API 同版」。`verify-bili-sidecar.mjs` 15 项对着真 harness + 真 sidecar 跑完整链路；二维码 PNG 落盘肉眼确认为真实可扫的 B 站登录码 |
| MCP 接入 | bundle 挂 `mcp-bili`（stdio `bili mcp serve`）；`@littly/bili` 收敛门把原始 `mcp__bili__*` 挡在元工具后面 |

## 5. M4 —— 控制台

| 要求 | 证据 |
|---|---|
| MUI 全部面板 | 15 个面板全部实装（概览/角色卡/世界书/成长/联系人/记忆/日记/相册/主动消息/铁律/设置×2/调试/插件管理/Bilibili） |
| 实时推送 | hub 事件总线（`agent-status` thinking/done/silent + `tool-call` running/done/failed）→ SSE `/api/stream` 转发。`verify-events.mjs` 9 项 |
| 成长系统收尾 | `@littly/growth`（959 行移植）：潜意识评审 → 事实审计（对话原文为金标准）→ 对抗质询 → 三铁律硬校验 → 待审提案 → 人工批准。`verify-growth.mjs` 58 项 |

## 6. M5 —— 生态与收尾

| 要求 | 证据 |
|---|---|
| MCP / skills / 插件管理 | 控制台「插件」页四区：dsh 插件（输入包名一键装 / 启停 / 卸载 / 可装 bundle 一键装）、MCP 服务（增删，运行时连接）、技能（列表 + 来源插件）、工具（按角色启停）。后端走 dsh 原生 `pluginManager` |
| 真实 dsh 插件兼容验收 | 实装 `dsh-case`（github:ZhijiangTang/dsh-case）：dsh 兼容性预检按设计拦下 → 精确豁免命令 → 安装 → 插件自检通过 → 其 `case_convert` 工具对 Littly 模型可见可调（`@littly/agents` 的 dsh-bridge）。另实测 npm 上真实社区插件 `dsh-context` 0.75.1 一键装成 bundle 并启用、可卸载 |
| 迁移工具 | `scripts/migrate-legacy.mjs`：旧 Prisma 库 → 新 schema（20 表 + 记忆 v2 字段初值 + 全局配置）。**真库跑通**：818 消息 / 184 记忆 / 959 审计全部迁入。`verify-migrate.mjs` 21 项 |
| deploy 编排 | `deploy/Dockerfile`（harness + 控制台同镜像）、`deploy/docker-compose.yml`（+ SnowLuma + bili sidecar）、`deploy/entrypoint.sh`（容器 IP 绑定 + profile 播种） |
| 全量回归 | 615 行为断言 + 61 端到端 + 15 扫码链路 + 10 容器验收，全部通过 |

## 6.5 绑定闭环（计划 v2 的硬承诺之一）

「绑定一次，全渠道同一条会话线」这条承诺需要发码侧存在。移植过程中发现新仓**只有消费侧没有发码侧**：
渠道包都读 `binding_tokens`，但没有任何地方创建它 —— 用户在控制台永远拿不到码。

补齐后实测（`scripts/verify-bind.mjs`，22 项）：

| 环节 | 结果 |
|---|---|
| 发码形态 | 6 位码（字母表剔除 I/O/0/1）/ TG 128-bit nonce |
| 有效期 | 10 分钟；同一人同 kind 只留一个有效码（新码作废旧码） |
| 撞唯一键 | 自动换一个码重试 |
| 渠道侧消费 | 非绑定消息不拦截；错码 → 失效提示；命中 → 成功文案 |
| 一次性 | 码用后标记 used_at，重放无效 |
| 冲突 | 别人抢同一渠道身份 → 冲突提示，绝不静默抢占 |
| 身份归一 | 写 `channel_identities`（`UNIQUE(channel,external_id)` + `UNIQUE(user_id,channel)`） |
| 联系人晋升 | 同名联系人认领为登录用户，历史与记忆保留 |
| 解绑 | 身份删除，联系人/历史/记忆保留 |

控制台新增「账号绑定」页（`/console/bind`）：五个渠道各一个「生成码」按钮，码可一键复制，
Telegram 给深链，显示有效期与操作说明，已绑定列表带解绑。

## 6.6 密钥三态（回显打码 → 回传不打码的那条路）

控制台回显渠道密钥时给的是掩码串（`••••` + 末 4 位），前端原样回传。
原来写回逻辑把「空串」和「掩码串」一视同仁地当成「保持不变」，实际有两个后果：

- 想清掉一个已经废弃的 token 清不掉 —— 空串被忽略，那个失效密钥永远挂在配置里，渠道启动还会拿它去连。
- 语义含混：调用方无法表达「我就是要把它清空」，只能靠不传这个字段绕开。

改成三态（`harness/packages/littly/console-api/src/mapping.ts`）：

| 输入 | 含义 |
|---|---|
| 含 `•` 的掩码串 | 保持原值（不回写自己的打码串） |
| 空串 | 显式清空 |
| 其它字符串 | 写入新值 |

`settings` 与 `channels` 两条写回路径一致。`scripts/verify-secret-mask.mjs`（25 项）逐条锁定，
包括「请求里没出现的字段（其它渠道的密钥）不受影响」这一条 —— 改一个渠道的另一个字段，不会碰到别的渠道的密钥。

## 6.7 首启播种（开箱即用）

容器验收时发现：容器内 e2e 只有 48 项（本地 55），差的那 7 项是「QQ 个人号渠道配置」——
因为**新容器里根本没有 bot**。翻旧仓才找到根因。

旧仓 `src/internal/config/seed.ts` 的 `ensureSeed()` 挂在
`/api/bots`、`/api/chat`、`/api/chat/buffer`、`/api/chat/buffer/flush` 上：
第一次打开控制台或第一次发消息就自动播种，全程感知不到。
新仓移植时只剩 admin 手动 `POST /api/seed` —— 全新 Docker 部署打开控制台是一片空白。

按旧仓逐字移植 `ensureSeed()`（`console-api/src/seed.ts`）：

| 项 | 内容 | 旧仓一致 |
|---|---|---|
| bot | 小璃 + system_prompt / temperature 0.85 / maxHistory 20 / memoryScope global / 微信口语体 / 主动性 | ✓ |
| 铁律 | **完整的** `DEFAULT_IRON_RULES`（1597 字） | ✓ |
| 角色卡 | 旧仓原文（含 mes_example / tags / creator） | ✓ |
| 世界书 | 三条：怕坐飞机 / 加班 / 生日 | ✓ |

顺带修掉一个更要紧的：原来 `runSeed` 写的是 4 行**概括版**铁律 ——
一旦触发就把「严格反 NTR」「唯一且永久不可改变」「记忆静默铁律」这些核心条覆盖掉，
人格就变了。现在写的是完整版。

实测（全新空库 —— 正是新 Docker 卷的样子）：

| 检查 | 结果 |
|---|---|
| `GET /api/bots` → 1 个 bot 小璃 | ✓ |
| `GET /api/characters` → 1 张角色卡 | ✓ |
| 铁律 1597 字，含「严格反 NTR」「记忆静默铁律」，bot 级 + 全局兜底各一份 | ✓ |
| 三条世界书按旧仓原文落库 | ✓ |
| 播种幂等（连播三次不多出任何东西） | ✓ |
| 用户改过的铁律 / bot 名不被覆盖 | ✓ |
| 全新库上跑完整 e2e 61 项 | ✓ 0 失败 |

`scripts/verify-seed.mjs`（40 项）逐条锁定。

## 6.8 编排与健康检查（真跑 compose 才暴露的两个坑）

之前只对 `docker-compose.yml` 做了 YAML 结构校验。装上 compose 插件**真跑**之后，
连着挖出两个真缺陷：

| 坑 | 现象 | 根因 | 修法 |
|---|---|---|---|
| compose 默认起不来 | `docker compose up` 直接报 `service "littly" depends on undefined service "bili": invalid compose project` | `littly` 依赖 `bili`，而 `bili` 带 `profiles: ["bili"]` —— 默认 profile 集合里它根本不存在 | 依赖改成可选（`required: false` + `condition: service_started`）：默认 `up` 只起 harness，bili 缺席时优雅降级；`--profile bili` 才一起起 |
| 容器永远 unhealthy | 每个容器都显示 unhealthy，编排里 `depends_on: service_healthy` 永远等不到 | 镜像的 HEALTHCHECK 探 `127.0.0.1`，但 dsh 拒绝 0.0.0.0 通配绑定、entrypoint 让它绑容器自身 IP（实测 172.18.0.3:3000） | entrypoint 把实际绑定地址写到 `/tmp/littly-web-host`；HEALTHCHECK 读它（读不到就退回网卡地址探测），探的才是真正在监听的地址 |

验证：

- `docker compose config` 三档全过：default / `--profile bili` / `--profile bili --profile qq`
- compose 栈真起（harness + bili sidecar 同网络）：harness 走 compose 网络内的
  `http://bili:3010`，扫码链路 15 项全过（二维码解出来校验 PNG 魔数）
- 容器健康检查从 unhealthy 变成 healthy（容器验收脚本新增这一条断言，120s 内等不到就判失败）

## 7. 部署级验证（真实容器）

`scripts/verify-container.sh` 起真实容器后逐项断言：

| 检查 | 结果 |
|---|---|
| 容器 240s 内就绪 | ✓ |
| `/api` 200 | ✓ |
| 控制台首页是 HTML / SPA 路由回首页 | ✓ |
| 越界请求不泄漏真实文件 | ✓ |
| profile 已播种到 `$DSH_HOME`（首启关键动作） | ✓ |
| SQLite 落在持久卷路径（不是容器临时路径） | ✓ |
| 社区插件装进 profile | ✓ |
| 对着容器跑端到端 61 项 | ✓ |
| 容器日志无 fatal / failed to import | ✓ |
| bili sidecar 不可达时优雅降级 | ✓ |

镜像构建：harness 构建 7 gate 全绿、控制台构建全绿、native 插件现场编译通过。

`bili-agent`（Python，给 MCP 面提供 `bili mcp serve`）装入运行时；PyPI 慢到超时时
**不阻塞构建** —— 那一步会打 `[warn]`，镜像照出，MCP 行被跳过，
`bili` 元工具仍然走 HTTP sidecar（那条是主路径）。

## 8. 已知边界（不是缺陷，是取舍）

| 项 | 说明 |
|---|---|
| `bili` 原始 MCP 工具默认收敛 | 由计划 v2 §7「AI 侧收敛为带护栏的 `bili` 元工具」决定；要放开把 `@littly/bili` 的 `converge` 设为 false |
| 写操作默认预演 | sidecar `BILI_ALLOW_WRITES=0` 时评论/动态/投稿一律 `--dry-run`；放开需显式设 1 |
| 语音通话需要两个 key | Deepgram（`bots.ai_call_api_key` 或 `DEEPGRAM_API_KEY`）+ Fish（`ai_voice_api_key`） |
| 社区插件的 peer 版本门 | dsh 的兼容性预检会拦下与当前 dsh 不匹配的插件，需显式 `allow-version` 豁免（面板会给出精确命令） |
| 插件是启动期装配 | 装完/启停/卸载后需重启 harness 才生效（面板会提示） |

## 9. night-rebuild 后端修复验收（2026-10-31）

本节对应 SPEC §2 缺陷清单（B1–B16）与主链路测试（T-A–T-F）的落点与验证方式。
脚本全部在 `harness/scripts/`，跑法见 `DEPLOY.md §5`。

### 9.1 安全 P0

| 项 | 修复 | 验证 |
|---|---|---|
| B1 MCP 任意 stdio 子进程 | `/api/plugins/mcp` POST/DELETE 改 `admin` + 命令白名单（npx/node/uvx/python3/deno/bun/bunx/true）+ 拒绝 shell 元字符 + 解释器 eval 参数禁用 + 审计（`audit_logs`）；streamable-http 只收 http(s) 且禁凭据 | `verify-e2e` MCP 增删（admin）；`verify-mcp.mjs` 清单解析 |
| B2 `/call` WS 无鉴权 | `/api/call/token` 下发 120s HMAC 令牌（`platform.secret`），握手只信令牌载荷的 botId/sender；URL 自报值仅一致性比对 | `verify-voice-call.mjs` 令牌验签/伪造/过期/参数不一致 + 正常握手 |
| B3 内容域越权 | `bots.owner_id`（迁移 v2）+ Router 统一 `botGuard`（带 botId 请求校验归属）+ 行级校验（world-entries/diaries/photos/contacts/memories/messages/定时消息/call requests）；characters 写操作收归 admin；`/api/call/requests` 只回自己 sender | `verify-e2e` admin 会话；`verify-voice-call`；行级断言在 mainloop/相关脚本 |
| B4 500 回显内部信息 | 统一 `err()` 脱敏；内部详情只进服务端日志（`reportInternalError`）；修掉 bind 路由回显 | `verify-e2e` 错误信封；代码审查 |
| B5 异步 handler reject 未捕获 | `fire(ctx, promise)` 兜底 + Router/mount 双层 catch，不再进程退出；13 处 `void (async…)()` 改造 | `verify-events`/mainloop；`verify-agent-loop` T5（空回复路径不崩） |

### 9.2 功能 P0

| 项 | 修复 | 验证 |
|---|---|---|
| B6 Discord DM 判据 | 无 `guild_id` 即 DM（`channel_type` 缺失不再恒丢）；fixture 改真实 Gateway 形状 | `verify-discord.mjs`（75） |
| B7 QQ event_id | 按 `(bot,openid)` 记 60min 入站 event_id，主链路出站自动带（被动回复窗口） | `verify-qq-official.mjs`（69） |
| B8 qzone 参数 | `{content,imageUrl}` → `{text,photoIds}`（工具真签名） | `verify-heartbeat.mjs`（50） |
| B9 growth 月度 tick | scheduler tick 接 `growthTick`（每日一次 + 月底窗口内才真跑） | `verify-growth.mjs`（86） |
| B10 value_exclusions | 提案创建 + 审批双路径硬校验（空列表 no-op），新增 `PUT /api/growth/value-exclusions` | `verify-growth.mjs`（86） |
| B11 上传目录持久化 | `LITTLY_DATA_DIR/downloads`（默认 `<cwd>/data/downloads`）+ 旧 `public/downloads` 只读回退；`/api/photos/file/*` URL 不变；entrypoint/compose 设 `/app/data` | `verify-e2e` 静态/相册路径；手工写文件验证 |
| B12 verify-final 路径 | `$HERE/scripts/*` → `$HERE/*`（2 行）+ 加跑微信 mock 套件 | `bash -n`；真跑容器验收时验证 |
| B13 CI e2e 播种 | e2e job 先 `seed-profile.mjs --profile chat`（含兜底二次幂等播种） | CI 配置审查 |
| B14 记忆归属/时效/幂等 | 整理只允许操作 `(bot_id,sender)` 范围内 id；`remember` 落 `valid_until`；`idempotencyKey`/`if_sha256` 接进 remember 工具与 API | `verify-memory-v2.mjs`（41） |
| B15 提示词漂移 / write_diary | `buildToolUseDirective()` 按当轮实际下发工具动态生成；`write_diary` 桩改真写（对话→模型→diaries） | `verify-heartbeat`/`verify-growth`；`verify-agent-loop` T6 工具循环 |
| B16 未注册渠道 delivery_status | 渠道未注册/发送失败一律 `failed`（不再误标 sent） | `verify-backend-mainloop.mjs` T-B |

### 9.3 主链路测试（T-A–T-F）

| 编号 | 覆盖 | 脚本 |
|---|---|---|
| T-A | 缓冲 exactly-once：15–20s 合并、新消息重置、原子认领、僵死恢复 | `verify-backend-mainloop.mjs` + `verify-agent-loop.mjs` |
| T-B | 沉默 = 不落库；投递失败 / 未注册渠道 = 落库 failed | `verify-backend-mainloop.mjs` |
| T-C | 工具循环：原生 tool_calls + 文本兜底 + 乱序；思考不外泄 | `verify-backend-mainloop.mjs` + `verify-agent-loop.mjs` |
| T-D | 安全阀：无回复 + looksCrisis → 强制再要一次 | `verify-backend-mainloop.mjs` + `verify-agent-loop.mjs` |
| T-E | 渠道入站过滤：Discord DM、SnowLuma 群@、QQ 被动窗口、微信 iLink 映射 | `verify-discord` / `verify-backend-mainloop` / `verify-qq-official` / `verify-wechat` |
| T-F | onboarding API（GET/test-model/complete）、微信 QR API（mock iLink） | `verify-onboarding.mjs`（19）/ `verify-wechat.mjs`（116） |

### 9.4 修复过程中额外发现并修掉的主链路 P0

| 缺陷 | 现象 | 修法 |
|---|---|---|
| `hub.flushBuffered` 认领后查询漏 `.all()` | 任何缓冲批次被认领后必抛 `TypeError: rows.some is not a function` → 缓冲主链路整条不可用 | 补 `.all()` |
| 空白正文被当成「回复」 | 模型返回 `"   "` 时仍落库并投递空消息 → 沉默铁律失效 | `trim()===''` 视为沉默 |

---

## 10. 2026-10-31 夜 · 重构建验收（Vue3 控制台 / 微信扫码 / 首启引导 / 缺陷修复）

本轮目标（用户下达）：后端继续以 dsh 为基座、功能保持插件化；前端**完全重写**并用
[@felinic/ui](https://github.com/felinics/ui) 重新分组；首启要有**完整引导配置向导**；
微信接入按 openilink-hub 的做法**自研重写**（扫码接入）；先修 bug 再做完整测试；本轮不打 docker。

### 10.1 前端重写（Vue 3.5 + Vite + Tailwind 4 + @felinic/ui）

| 项 | 结果 |
|---|---|
| 技术栈 | Vue 3.5 + vue-router 4 + Tailwind v4 + `@felinic/ui`（vendored 于 `console/packages/ui`，遵循其 AGENTS.md 与 skills 的 token 法） |
| 路由 | **22 条真 URL 路由**，按使用逻辑分五组：对话 / 她（角色卡·世界书·铁律·成长·相册·日记）/ 记忆 / 主动 / 连接（微信·TG·QQ·Discord·B站·联系人·绑定）/ 系统（概览·设置·插件·调试） |
| 首启引导 | 5 步向导：她是谁 → 模型连接（真实测连通+延迟）→ 人格 → 接入微信（可跳过）→ 完成；`/api/onboarding` 驱动，老实例自动判定「已完成」不重复打扰 |
| 设计遵从 | 0 处原始颜色/手写卡片（`grep '#hex|bg-white|text-gray-'` = 0）；PageShell 18 文件、SettingsSection/Row 16、CalloutBanner 21、Empty 11、ConfirmDeleteDialog 7 |
| 移动端 | <768px 顶栏汉堡 + Sheet 抽屉复用同一份导航；触屏 composer 去掉 Enter 提示 |
| 语音通话 | `components/call/CallOverlay.vue`（760 行，自包含）：`/api/call/token` → WS → PCM16 16k 上行 → MP3 分片流式播放 → 挂断 `call_end`；4401/4403 与麦克风权限分别文案 |
| 构建 | `pnpm build` ✓（~1s）、`pnpm typecheck`（vue-tsc）✓ 0 error、`scripts/check-icons.mjs` ✓（50 文件，防 lucide 改名回归） |

浏览器实测（无头 Chrome，真实后端）：桌面 1280×900 浅色/深色、手机 390×844；
登录 → 守卫跳转 → 对话（真实历史 + SSE 状态）→ 19 条路由巡检（无应用报错，仅登录前 401 与调试页缺 botId 的 400）；
生产构建在 3000 上 served（`<title>Littly · 控制台`、history 回退、hash 资产 200）。

### 10.2 微信 iLink 重写（openilink 同款，自研不依赖外部 hub）

- 协议客户端 `channel-wechat-ilink/src/ilink-client.ts`（610 行）：端点/头/状态机/游标/context_token/24h 窗口按 openilink 官方 Go SDK 逐字对齐。
- **零依赖 QR 编码器** `ilink-qr.ts`：byte/ECC-M/v1–10/掩码罚分/PNG（iLink 返回的是 URL 文本，不是图片）。
- 绑定会话 + 长轮询自愈 + 入站→`hub.runTurn(channelId='wechat')`（默认缓冲合并，可配 direct）+ 出站 `send_message`。
- 控制台 API：`POST /api/wechat/qr`、`GET /api/wechat/qr/:session`、`GET /api/wechat/status`、`POST /api/wechat/friend-qr`、`POST /api/wechat/logout`（admin/required，统一信封）。
- 实测：真实 iLink 取码 → 自研 QR PNG（392×392）→ **OpenCV 解码回真实 `https://liteapp.weixin.qq.com/q/...`**；名片码同样解码通过；`verify-wechat.mjs` **116/116**（mock 双 host、redirect、过期换码、24h 窗口、收发、鉴权）。
- 边界（如实登记）：iLink 只有「bot 绑定二维码」，没有独立名片码接口；好友扫同一张码即可在微信里加她（进入与 bot 的会话），前端按此文案展示。**真实扫码需用户本人微信**，夜间只完成到「接口 + 页面 + mock/解码验证」。

### 10.3 后端口径（与 §9 合读）

- B1–B16 全部落地并逐项有断言；额外修掉 2 个主链路 P0（`flushBuffered` 漏 `.all()`、空白正文当回复）。
- 新增测试：`verify-backend-mainloop.mjs`（43）、`verify-onboarding.mjs`（19）、`verify-agent-loop.mjs`（30，Lead 编写：mock 模型 + 真实 harness，覆盖缓冲窗口/exactly-once/沉默/安全阀/思考不外泄）。
- **本机最终验收（新构建）**：20 个行为脚本 **699 断言 0 失败**；真服务 `verify-e2e.mjs` **62/0**；`verify-onboarding.mjs` **19/0**；全仓 `build:artifacts` **7/7 gate**。

### 10.4 本轮明确未做

| 项 | 说明 |
|---|---|
| docker / compose 实跑 | 用户要求本轮不打包；`verify-final.sh` 的容器段保留待用 |
| 真实微信扫码 | 需用户本人微信扫一次（页面已就绪：连接 → 微信 → 生成绑定二维码） |
| CI 真跑 | 仓库无远端 runner；配置已修（e2e 前播种 profile）并通过 YAML 校验 |
| 消息 Markdown/富媒体渲染、token 级流式逐字 | 已列为后续迭代（当前为完整回复 + SSE 状态推送） |

## 10. X（Twitter）接入（2026-10-31 第二波）

用户要求：让她拥有自己的 X 账号（基于 twitter-cli），登录用户自己的账号。

### 10.1 组成

| 层 | 内容 |
|---|---|
| 插件 `@littly/x` | `harness/packages/littly/x`，服务键 `littlyX`；`x` 元工具注册进 Littly 工具表（hub 就绪后 `ctx.inject(['littlyHub'])`） |
| 控制台 API | `console-api/src/routes-x.ts`：`GET /api/x/status`、`POST /api/x/login`(admin)、`POST /api/x/logout`(admin)、`PUT /api/x/settings`(admin)、`POST /api/x/probe`、`POST /api/x/cmd` |
| 装配 | `@littly/bundle` 的 `cordis.patch.yml` 增加一行 `@littly/x`；`apps/cli`/bundle/console-api 依赖 + `tsconfig.host.json` 引用 |
| 镜像 | runtime 层 `pip3 install --break-system-packages twitter-cli==0.8.5`（失败不阻塞，同 bili 风格；失败时 `binOk=false`） |

### 10.2 护栏（服务端硬约束，模型绕不过）

- **允许清单**：读 `status/whoami/feed/bookmarks/favorites/search/tweet/show/user/user-posts/likes/followers/following/list/article`；写 `post/reply/quote/delete/like/unlike/retweet/unretweet/bookmark/unbookmark/favorite/unfavorite/follow/unfollow`（以 `twitter --help` 为准）。
- **写默认预演**：`x.allow_writes='1'` 且调用显式 `dryRun:false` 才真执行；否则返回 `{dryRun:true,note}` 不 spawn。
- **参数限制**：禁 `-o/--output/--input`（文件读写）与 `--image/-i`（本条只做纯文本）；禁空 argv/未知命令/空字符串项。
- **限频**：读 30 次/小时、写 5 次/小时（按 bot 统计 `audit_logs`），超限返回可读错误。
- **审计**：每次调用写 `audit_logs`（category=tool_call，action=`x_<cmd>`，detail 含脱敏 argv/ok/exitCode/dryRun/kind）。
- **凭据**：`auth_token`/`ct0` 存 `global_settings`，只注入子进程环境，**不回传前端/不写日志**；status 仅 `configured/username/loggedInAt/allowWrites/bin/hasProxy`。
- **错误判定**：twitter-cli **错误时退出码也可能是 0**，成功判定解析 JSON 信封的 `ok`/`error`；401/403→`not_authenticated`、429→`rate_limited`、226→`login_incomplete`，其它保留原始错误文本（本机直连 x.com 超时时用户能看到「需要代理」的原文）。
- **代理**：`x.proxy` 真的注入子进程 `TWITTER_PROXY`（本机直连 x.com 会超时）；`/api/x/status` 的 `binOk`（60s 缓存）与 `lastProbe`（最近一次连不上的原因）分开返回，前端可显示「已安装但连不上」。

### 10.3 验收

- `node scripts/verify-x.mjs` → **75/0**（fake bin：允许清单、写默认预演、开关放行、限频、审计、JSON 解析、401/429/226 映射、凭据注入与不回传、工具注册）。
- `pnpm run build:artifacts` → **7/7 gates**；`verify-e2e.mjs` → **63/0**（含 `/api/x/status` 200 + binOk、`x` 工具在清单、未知子命令 400）。
- 本地 3111 真服务：`GET /api/x/status` → `{"configured":false,...,"binOk":true,"lastProbe":null}`；`/api/x/probe` 未登录时返回可读错误（不 500）。
- 真实 X 登录需用户提供自己的 cookie（auth_token+ct0），本机直连需代理；这两种情况都在 UI 错误文案里显式提示。

---

## 11. QQ 渠道重写（2026-10-31）：SnowLuma OneBot v11 + 官方 QQBot

用户决定：QQ 全面改用 SnowLuma，旧 SnowLuma 集成不完善 → 整体去掉，以
[`CNranger1124/dsh-lane-bridge`](https://github.com/CNranger1124/dsh-lane-bridge)（MIT）为基础重写，
只保留 SnowLuma OneBot v11 与官方 QQBot 两个渠道。

| 项 | 内容 |
|---|---|
| 新插件 | `@littly/channel-qq`：移植 lane-bridge 的 `base/onebot-ws/snowluma/snowluma-discovery/qqbot/manager` 为 TypeScript（协议行为保持），去掉 Discord；MIT `LICENSE`+`NOTICE` 致谢 CNranger1124 / Derpyu520；依赖 `@tencent-connect/qqbot-nodejs` |
| hub 接入 | 入站 `enqueueBufferedMessage({channelId:'snowluma'｜'qqp'})`；出站 `registerChannel` 回到来源会话；身份/绑定统一 `qqp`（旧绑定保留）；QQBot 被动 msg_id 5 分钟窗口 + 过期降级 + 错误码中文化 |
| 智能连接 | SnowLuma 支持 `SNOWLUMA_HOME` 自动发现 ws/token；**不代装/不代启**（SnowLuma EULA，非商业自托管） |
| API | `GET /api/qq/status`、`PUT /api/qq/snowluma`（token 掩码写）、`PUT /api/qq/qqbot`（secret 掩码写 + 清 token 缓存）、`POST /api/qq/probe`、`GET /api/qq/logs`（脱敏） |
| 下线 | `channel-snowluma`、`channel-qq-official`、`verify-qq-official.mjs`、supervisor 实验包全部删除；bots 表 `qq_*`/`snowluma_*` 列保留兼容 |
| 前端 | `/channels/qq` 双 Tab（SnowLuma / 官方 QQBot）＋ onboarding「给她账号」QQ 卡联动 |
| 验证 | `verify-channel-qq` **66/0**；`build:artifacts` 7/7；`verify-e2e` **71/0**（+4 QQ）；onboarding 19/0；其余脚本不回归；3000 实测 `/api/qq/status` 200、`/channels/qq` 200 |

### 11.1 账号绑定并入渠道页（2026-10-31）

用户要求去掉独立 `/bind` 页面，把账号绑定并入各渠道页：

| 项 | 内容 |
|---|---|
| 新组件 | `components/AccountBindSection.vue`（channel/title?/hint?）：10 分钟绑定码、复制、instruction、已绑列表、解绑确认 |
| 接入 | ChannelConfigPage（TG/Discord）复用；WechatPage 加 `channel=wechat`；QqPage 两个 Tab 均用 `qqp`（channel-qq 只消费 `qqp_code`，`qq_code` 保留历史兼容） |
| 删除 | `/bind` 路由、导航「账号绑定」项、`pages/bind/` 目录（api 迁到 `api/bind.ts`） |
| 顺手修复 | ChannelConfigPage 曾把 `telegram` 直接当绑定 key → 后端 400；现映射 `telegram → tg`，绑定码可用 |
| 验证 | console build ✓ / typecheck 0 / check-icons ✓；3115 scratch 逐渠道绑定码接口 200/400 符合预期；3000 `GET /api/bind/status` 200 |

### 11.2 B 站升级：基于 bilibili-cli 重写（2026-10-31）

用户要求升级 B 站能力（视频/用户/搜索/发现/动态/收藏/互动 + 智能认证），以
[`public-clis/bilibili-cli`](https://github.com/public-clis/bilibili-cli)（Apache-2.0）为基座。

| 项 | 内容 |
|---|---|
| 插件 | `@littly/bili` 重写为 CLI 壳（`bili` v0.6.2）：工具 `bili{argv,dryRun}`；20 命令允许清单、写/audio 默认 dry-run（开关+显式 dryRun 双条件）、读 30/h 写 5/h、`audit_logs` 审计（凭证三处脱敏）、无 shell spawn、超时 SIGKILL、JSON 信封解析（`bili status` 未登录 exit=1 但 JSON 合法） |
| 智能认证 | **扫码**：后端直连 passport `qrcode/generate`+`poll`（不复用纯 TTY 的 `bili login`），零依赖 QR 编码出 PNG；Set-Cookie 优先、crossDomain URL 兜底、refresh_token→ac_time_value；写 `credential.json`（7 字段、0600、合并 buvid）→ `bili status` 复核。**浏览器 Cookie**：`extract-cookie`（admin）删除凭证后由 CLI 自动从本机浏览器提取 |
| API | `GET /api/bili/status`、`POST /api/bili/qr/start`、`GET /api/bili/qr/status`、`POST /api/bili/extract-cookie`(admin)、`POST /api/bili/logout`(admin)、`PUT /api/bili/settings`(admin)、`POST /api/bili/cmd` |
| 下线 | `sidecars/bili/`、MCP `mcp-bili`、旧 4 条 sidecar 路由、`@littly/tools` 旧 bili 客户端/工具、compose bili 服务、`verify-bili-sidecar.mjs` |
| 前端 | `/channels/bilibili` 重写：状态卡（头像/账号/UID/等级/VIP/最近登录）、扫码四态轮询自动刷新、一键提取浏览器 Cookie、登出、写开关、只读预览（视频/热门/排行/搜索） |
| 验证 | `verify-bili` **140/0**（fake bin + mock passport）；`build:artifacts` 7/7；`verify-e2e` **83/0**（+12 bili）；其余 17 套脚本 + agent-loop 30 + backend-mainloop 47 全 0 失败；真机 live（3000）：authenticated=true/银色的whale/mid 3546953329674695、qr/start 真 passport 链接 + PNG(2338B)、qr/status wait、cmd status ok、settings 写开关可持久化 |

### 11.3 一键安装/配置 SnowLuma（2026-10-31）

用户要求：自动安装/配置 SnowLuma，用户只需扫码登录 QQ。

| 项 | 内容 |
|---|---|
| 新插件 | `@littly/snowluma`（服务键 `littlySnowluma`）：`install(consent)` / `start` / `stop` / `status` / `qrInfo` / `logs` / `autoconfigure` / `remove`；docker 操作全部 spawn 无 shell，参数固定（SYS_PTRACE、seccomp=unconfined、shm 1g、ulimit、随机 VNC 密码、宿主 UID/GID、端口只绑 127.0.0.1、三块 bind mount） |
| 自动配置 | 实测官方镜像的 `config/onebot.json` **默认已监听 0.0.0.0:3001 且带随机 accessToken** → 不改 host、不重启；`readOnebotToken()` 读 token（登录后 `onebot_<uin>.json` 优先），`autoconfigure()` 等 3001 可达后用 OneBot `get_login_info` 验证并写 `bots.snowluma_ws_url/token/enabled` |
| 扫码体验 | noVNC `:6081`（WebUI `:5099`）；远程桌面密码由我们随机生成并存 DB（可展示/复制，支持 `?autoconnect=1&password=` 免密链接）；WebUI 临时密码从首启日志提取；状态机 `not_installed→pulling→installed→starting→waiting_scan→connected` |
| 前端 | QQ 页 SnowLuma Tab「一键安装（推荐）」四步向导（知情同意 → 安装进度 → 启动并扫码/复制密码/日志 → 已连接自动接线 + 失败降级手动配置）；停止/卸载/日志抽屉，admin 门禁 |
| API | `GET /api/snowluma/status`、`POST install/start/stop/qr/autoconfigure/remove`、`GET logs`（admin；status 非 admin 剥密码） |
| 验证 | `verify-snowluma-install` **68/0**（fake docker，含 `restarts=0` 断言）；`build:artifacts` 7/7；`verify-e2e` **87/0**（+4 snowluma）；**3000 真机**：state installed → start → waiting_scan（容器 running、noVNC 200、WebUI 200、configReady=true、hasToken=true），noVNC 免密链接可用 |
| 合规 | SnowLuma 为第三方非商业自托管软件；安装前必须勾选知情同意（EULA 条款），未同意 API 返回 400 `consent_required` |

### 11.4 MCP 管理页面（Cursor 格式，2026-10-31）

用户要求：新增 MCP 页面，可管理/添加 MCP 服务器（Cursor 格式）。

| 项 | 内容 |
|---|---|
| 服务扩展 | `@littly/mcp`：`env`（stdio，并入 process.env）/`headers`（http，requestInit.headers）建连时真正生效；`testServer(name)`（重连+listTools+可读错误）；`statusOf(name)`（enabled/connected/toolCount/lastError） |
| API | `GET /api/mcp/servers`（env/header 只回键名）、`POST /api/mcp/servers`、`PATCH/DELETE /api/mcp/servers/:name`、`POST /api/mcp/import`（Cursor `{mcpServers}`，返回 added/updated/errors，部分成功不整体失败）、`GET /api/mcp/export`（Cursor 格式含真实值，admin）、`POST /api/mcp/servers/:name/test`、`GET /api/mcp/tools`；旧 `/api/plugins/mcp*` 保留兼容 |
| 校验 | 复用 `validateMcpServer`（命令白名单/shell 元字符/eval/url 凭据）+ 新增 `env` 键 `[A-Za-z0-9_]`、`headers` 键 `[A-Za-z0-9-]`（禁 NUL/换行）；审计 `mcp_upsert/mcp_import/mcp_test/mcp_remove`，detail 不含值 |
| 前端 | 新页面 `/system/mcp`（导航「系统」）：Cursor 格式说明、添加/导入/导出/刷新；列表含传输徽标、env/headers 键数、启用开关、工具数/错误、测试/编辑/删除；添加 Dialog 双 Tab（粘贴 Cursor 配置 / 手动填写，env`KEY=VALUE` 多行）；测试连接弹窗列工具；导出 CodePanel+复制；错误文本截断（http 服务器可能回整页 HTML） |
| 验证 | `verify-mcp-page` **83/0**（假 Router+假 manager+真 SQLite 审计，不联网）；`build:artifacts` 7/7；`verify-e2e` **94/0**（+7 MCP）；3000 真机：Cursor 导入 2 条 → 列表（envKeys/headerKeys 只键名）→ export 往返一致 → test 可读错误 → tools → 删除，全通过 |
