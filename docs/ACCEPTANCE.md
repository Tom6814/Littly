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
| 内置工具 | 28 |
| 控制台 API 路由 | 84 |
| 行为断言 | 541（13 个脚本）+ 48（端到端） |
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
| bilibili sidecar + 账号面板 | `sidecars/bili/`（HTTP wrapper）+ `@littly/tools` 的 `bili` 元工具（白名单 + dry-run + 限频 + 审计）+ 控制台「Bilibili」页（扫码登录）。`verify-bili.mjs` 30 项 |
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
| 全量回归 | 541 行为断言 + 48 端到端 + 10 容器验收，全部通过 |

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
| 对着容器跑端到端 48 项 | ✓ |
| 容器日志无 fatal / failed to import | ✓ |
| bili sidecar 不可达时优雅降级 | ✓ |

镜像构建：harness 构建 7 gate 全绿、控制台构建全绿、native 插件现场编译通过、bili-agent（Python）装入运行时。

## 8. 已知边界（不是缺陷，是取舍）

| 项 | 说明 |
|---|---|
| `bili` 原始 MCP 工具默认收敛 | 由计划 v2 §7「AI 侧收敛为带护栏的 `bili` 元工具」决定；要放开把 `@littly/bili` 的 `converge` 设为 false |
| 写操作默认预演 | sidecar `BILI_ALLOW_WRITES=0` 时评论/动态/投稿一律 `--dry-run`；放开需显式设 1 |
| 语音通话需要两个 key | Deepgram（`bots.ai_call_api_key` 或 `DEEPGRAM_API_KEY`）+ Fish（`ai_voice_api_key`） |
| 社区插件的 peer 版本门 | dsh 的兼容性预检会拦下与当前 dsh 不匹配的插件，需显式 `allow-version` 豁免（面板会给出精确命令） |
| 插件是启动期装配 | 装完/启停/卸载后需重启 harness 才生效（面板会提示） |
