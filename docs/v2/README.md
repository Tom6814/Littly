# Littly v2 · 设计文档集

> 状态：**设计基线 v1.0（2026-11-07）· 实现前定稿，允许实现中修订**
> 原则：先设计完整，再整夜实现；本地优先，服务器后置。

## 一句话

**她不是 personal agent，她是一个人：有自己的人生、自己的电脑、自己的朋友与判断。**

## 已拍板决策

| # | 决策 | 说明 |
|---|---|---|
| D1 | **一个实例 = 一个人** | 取消多 bot/多角色；其余角色数据归档+导出，不物理删除 |
| D2 | **硬分叉 Memoh 作为底座** | 继承工作台/渠道/调度/技能/MCP/审批；改造为单实例 |
| D3 | **AGPL-3.0** | v2 整体按 AGPL-3.0；保留 Memoh 版权与来源说明 |
| D4 | **基于 Memoh 后端改造、融合旧项目特点** | 不逐行移植旧 TS：以 Memoh 的 Go 后端为骨架，把 Littly 的差异化能力（自传记忆/生活引擎/人格回复/成长/工作台驱动等）在 Memoh 的模块与数据模型里重新实现；旧代码/设计仅作参考与测试语义，Vue 设计可复用 |
| D5 | **记忆 = 她的人生** | 自传式 vault + 人物卡 + 可见性；废弃 per-person 库与 legacy memories |
| D6 | **可见性三档** | `public` / `relationship:<people_id>` / `private`（私密抽屉：网页无入口，仅服务器文件可翻）；"她主动展示"= 把 artifact 作为消息附件发出来，不新增枚举；不做加密抽屉 |
| D7 | **自由生活 + 刹车** | 日常自主；钱/账号安全/批量外发/删数据/不可逆操作刹车 |
| D8 | **兴趣与目标：种子 + 演化** | 人设给种子；从记忆/经历里长出来、可增减 |
| D9 | **回复不保证** | 回不回/多久回由性格、关系、状态、当下在做什么共同决定 |
| D10 | **本地优先** | 先在 Mac（Docker Desktop）上完整跑通；服务器后续再评估 |
| D11 | **QQ 用 SnowLuma** | OneBot v11，单账号归属，复用旧项目的 SnowLuma 适配协议 |
| D12 | **旧数据只备份** | v2 首版不迁移历史；旧库/记忆/配置打包备份，迁移单独立项 |
| D14 | **人物认知分层** | 身份行每个渠道联系人都保留（身份/可见性/回复必需）；**人物卡只给 important/friend/intimate**；泛泛之交写进一份 `people/acquaintances.md`（一人一行，上限+老化）；stranger 只有 DB 行；晋升/降级可逆 |
| D13 | **心跳模型** | 只有**心跳**可以有规律（fallback 抖动）；行动/互动无生活频率表；她可 `heartbeat_after/heartbeat_at` 自心跳（reason 必填）；系统保底心跳防漏；**不做阻塞式 wait_for_user_reply**（见 16） |

## 文档索引

| 文件 | 内容 | 状态 |
|---|---|---|
| [01-VISION.md](01-VISION.md) | 产品愿景、体验、范围、成功标准 | 完成 |
| [02-ARCHITECTURE.md](02-ARCHITECTURE.md) | 系统架构、分叉结构、进程模型、本地部署、API 约定 | 完成 |
| [03-DATA-MODEL.md](03-DATA-MODEL.md) | Postgres 数据模型（**实现基准**）、vault 文件格式、扩展、迁移 | 完成 |
| [LIFE-ENGINE.md](LIFE-ENGINE.md) | 生活引擎设计（认知/记忆/作息/活动/回复策略/睡眠） | 设计 |
| [04-LIFE-ENGINE-IMPL.md](04-LIFE-ENGINE-IMPL.md) | 生活引擎实现规格（tick/算法/接口/状态机/伪代码） | 完成 |
| [05-MEMORY.md](05-MEMORY.md) | 记忆写入/检索/Dream/可见性/索引/隐私实现 | 完成 |
| [06-PERSONA-REPLY.md](06-PERSONA-REPLY.md) | 人格 traits、提示词组装、回复决策算法、主动消息 | 完成 |
| [07-WORKBENCH.md](07-WORKBENCH.md) | 她的工作台：目录/工具/活动执行/后台任务/安全 | 完成 |
| [08-WORLD-CHANNELS.md](08-WORLD-CHANNELS.md) | 渠道（含 SnowLuma QQ）、人物/身份、社交 | 完成 |
| [09-CONFIG-SECURITY.md](09-CONFIG-SECURITY.md) | 统一配置 schema、模型校验、健康检查、审批/预算/审计 | 完成 |
| [10-UI.md](10-UI.md) | 六面 UI、路由、组件、状态、API | 完成 |
| [11-TESTING.md](11-TESTING.md) | 测试矩阵、夹具、验收场景、本地命令 | 完成 |
| [12-BUILD-PLAN.md](12-BUILD-PLAN.md) | M0–M7 里程碑、整夜执行顺序、Definition of Done | 完成 |
| [13-PROMPTS.md](13-PROMPTS.md) | 系统提示词/回复决策/计划/梦境/记忆抽取模板 | 完成 |
| [14-ARCHIVE-MIGRATION.md](14-ARCHIVE-MIGRATION.md) | 旧数据备份/角色归档/未来导入预案 | 完成 |
| [15-PROMPT-ENGINEERING.md](15-PROMPT-ENGINEERING.md) | 提示词工程规范（分层/JSON 契约/预算/评测/安全/版本） | 完成 |
| [16-HEARTBEAT.md](16-HEARTBEAT.md) | **心跳模型**：self/fallback/event 心跳、reason 必填、保底心跳、结构化裁决、no-op 治理、不做阻塞等待 | 完成 |
| [MEMOH-FORK-ASSESSMENT.md](MEMOH-FORK-ASSESSMENT.md) | Memoh 分叉评估（模块地图、服务器、风险） | 评估 |

## 调研依据

- *Generative Agents*（[arXiv:2304.03442](https://arxiv.org/pdf/2304.03442.pdf)）与 [AI Town](https://github.com/a16z-infra/ai-town)：记忆流/反思/分层计划
- [Concordia](https://github.com/google-deepmind/concordia)：生成式社会模拟（GM/Entity-Component）
- *Characterizing LLM-driven Social Network: Chirper.ai*（[arXiv:2504.10286](https://arxiv.org/abs/2504.10286)）：AI 社交网络行为
- [Letta sleep-time compute](https://www.letta.com/blog/sleep-time-compute)：睡眠时记忆整理
- [Project Sid 报道](https://gigazine.net/gsc_news/en/20241202-minecraft-ai-civilization-project-sid/)、[Agentopia 介绍](https://cloud.tencent.com.cn/developer/article/2705087)

## 术语

| 术语 | 含义 |
|---|---|
| 她 / person | 这个实例里唯一的那个人 |
| 人物卡 / people | 她对某个真人/联系人的理解（一页纸） |
| 记忆 / memory | 她的自传式经历/感受/知识（Markdown 真相 + PG 索引） |
| 生活引擎 / life | 作息、状态、兴趣、计划、活动、睡眠整理 |
| 工作台 / workbench | 她的电脑：文件/终端/浏览器/桌面（Memoh workspace） |
| 回复策略 / reply policy | 是否回、何时回、怎么回（性格驱动） |
| 可见性 / visibility | public / relationship:<id> / private / display |
| 睡眠时计算 / dream | 夜间后台整理（记忆、日记、人物卡、明日计划） |
| SnowLuma | QQ 的 OneBot v11 网关（单账号） |
