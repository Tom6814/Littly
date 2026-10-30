# Littly

一个拟真 AI 伴侣系统：一个有独立人格、跨渠道存在、拥有长期记忆、会主动找你说话的角色。

> **本质不变**：她是一个真正的「人」，不是助手。harness、MCP、skills、插件、渠道——全部基础设施只有一个目的：
> **让她能链接更多东西，看到大千世界，学会更多东西，并且更方便 AI 调用、更适配 AI。**
> 任何改造若与此冲突，改造让步。见 [docs/PRINCIPLES.md](docs/PRINCIPLES.md)。

## 现在能跑什么

- **对话主链路**：入站缓冲窗口（15~20 秒合并、原子认领「恰好一次」模型调用）→ 分层提示词组装 → 27 个内置工具的 agentic 循环 → 拟人化分片投递。
  沉默 = 不落库，投递失败 = 落库但标 `failed`（两者在数据上可区分）。
- **记忆 v2**：五层记忆（短期 / 滚动摘要 / 活跃池 / 淡忘池 / 人格档案）、按 event_time 衰减、
  类别半衰期、supersede 取代链、provenance 出处、**explain 台账**、**protected 能力位**、
  **写入幂等回执 + if_sha256 漂移检测**、软删永不物理删除。
- **人格成长系统**：月度「潜意识」评审 → 事实审计（对话原文为金标准）→ 对抗质询（常开，职责是证伪）
  → 三铁律服务端硬校验（证据 ≥2 条 / 单维 ≤±1 级 / 总位移 ≤6 级 / 价值禁区）→ 待审提案 → 人工批准。
  角色卡永远只读；人格以档案形式按月漂移。
- **主动性双线**：预约/承诺线（履约等级 1/2/3）+ 心声回响线（静默扫描 + 指数退避唤醒）。
- **六个渠道**：**QQ（SnowLuma OneBot v11 + 官方 QQBot 双通道，同一插件）** · Telegram · **微信 iLink（扫码绑定 + 名片二维码：
  控制台出码 → 手机微信扫码确认 → 她就在微信里；照 openilink-hub/iLink 协议自研，不依赖外部 hub）**
  · QQ 官方 · Discord。绑定一次，全渠道同一条会话线。
- **实时语音通话**：同端口 `/call` WebSocket —— 浏览器 PCM → Deepgram 流式 STT → 角色快速回复
  → Fish 流式 TTS → 通话卡片 → 挂断后自动「回响」总结（记忆 + 待办）。
- **她自己的 X（Twitter）**：`x` 元工具走 twitter-cli（[jackwener/twitter-cli](https://github.com/jackwener/twitter-cli)，
  无官方 API key）——读 feed/搜索/用户/推文，写推文/回复/点赞/转推/关注默认**预演**，开启写开关后才真发；
  凭据是你自己的 X 登录 cookie（存 DB、不回显、不进日志），支持代理。
- **她自己的 B 站**：`bili` 元工具走 sidecar（子命令白名单 + 写操作默认预演 + 限频 + 审计），
  harness 同时挂上 bili 的 MCP 服务器；原始 MCP 工具由收敛门挡在元工具后面。
- **社区 dsh 插件可直接接入**：装完的插件注册的工具对她可见可调（dsh-bridge）。
- **首启引导（onboarding）**：全新部署打开控制台 → 5 步向导：她是谁 → 模型连接（真实测连通 + 延迟）
  → 人格 → **给她账号**（微信 / B 站 / Telegram / QQ / Discord / X，逐平台状态 + 内联快速配置，可跳过）
  → 完成；状态存 `global_settings.onboarding`，管理员可一键重置重走。
- **控制台（重写）**：Vue 3.5 + Vite + Tailwind 4 + [@felinic/ui](https://github.com/felinics/ui) 设计系统，
  22 条真 URL 路由按使用逻辑分五组——**对话 / 她（角色卡·世界书·铁律·成长·相册·日记）/ 记忆 / 主动 /
  连接（微信·Telegram·QQ·Discord·Bilibili·联系人·账号绑定）/ 系统（概览·设置·插件·调试）**；
  含 SSE 实时推送（思考态 / 工具阶段 / 沉默终止态）。

## 结构

| 目录 | 内容 |
|---|---|
| `harness/` | 基座：[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) fork（vendor 于固定 commit），继承插件系统 / MCP / skills / 定时任务 / LLM 适配器 |
| `harness/packages/littly/` | 业务插件（从旧项目逐行移植 / 本轮新增）：`storage` `persona` `memory` `agents` `tools` `voice` `voice-call` `growth` `scheduler` `console-api` `mcp` `bili` `x` + 渠道 `channel-qq`（SnowLuma + 官方 QQBot）`channel-telegram` `channel-wechat-ilink` `channel-discord` |
| `console/` | Vue 3.5 + Vite + Tailwind 4 + `@felinic/ui` 控制台（真 URL 路由，五组导航 + 首启引导；`packages/ui` 为 vendored 设计系统） |
| `sidecars/bili/` | bili-cli（bili-agent）HTTP wrapper sidecar —— AI 自己的 bilibili 账号 |
| `deploy/` | 容器编排（harness + SnowLuma + bili sidecar） |
| `docs/` | [宪法](docs/PRINCIPLES.md) · [移植指南](docs/PORTING-GUIDE.md) · [部署与验收](docs/DEPLOY.md) · [QQ / SnowLuma 接入](docs/SNOWLUMA-CONTRACT.md) · [bilibili 接入](docs/BILI-INTEGRATION.md) |

## 跑起来

```sh
# 容器（单容器 = harness + 控制台 + 业务库）
docker build -f deploy/Dockerfile -t littly-harness .
docker run -d -p 3000:3000 -v littly-data:/app/data littly-harness
# → http://localhost:3000/ ，注册第一个账号即管理员
# 打开即进入「首启引导」：填模型 → 确认她是谁 → 可选扫码接微信 → 完成；
# 首次打开控制台会自动播种：bot「小璃」+ 完整铁律 + 演示角色卡 + 三条世界书，
# 不用先去后台点任何东西就能直接开聊。
```

详见 [docs/DEPLOY.md](docs/DEPLOY.md)（编排、旧库迁移、社区插件接入、验收脚本清单）。

## 验收

```sh
cd harness && pnpm run build:artifacts      # 构建门禁（7 gate）
for s in scripts/verify-*.mjs; do node "$s"; done   # 行为断言（含 verify-wechat / 主链路）

# 控制台（Vue3）
cd console && pnpm install && pnpm run build   # 产物 dist/，由 console-api 托管
cd console && pnpm run dev                     # 5173，/api 代理到 3000
```

15 个脚本、615 条行为断言 + 61 条端到端 + 15 条扫码链路，覆盖记忆 v2、成长三铁律、
心跳退避、bili 护栏、dsh 插件桥、首启播种、密钥三态、五个渠道、通话协议、旧库迁移、
端到端真启动（含「容器重建不丢数据」）。

## 旧项目

行为参照仓库位于本机 `Downloads/workspace-a52450b8-…`（Next.js 单体），其 `docs/PROJECT-DESIGN.md`
是行为规格与缺陷清单的核对表；新系统逐行对照移植并修复 §18 全部缺陷。
迁移：`node harness/scripts/migrate-legacy.mjs <旧库> <新库>`。
