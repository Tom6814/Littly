# Memoh 硬分叉评估（v2 底座）

> 状态：设计稿 v0.1（2026-11-06）· 基于本地克隆的 Memoh `main`（2026-11-06 快照）做的第一轮结构评估。
> 结论：**可行，但要按"换掉哲学、保留基础设施"的方式改**；上游请钉 release（v0.13 系列），硬分叉维护。

---

## 1. 对象与事实

| 项 | 事实 |
|---|---|
| 仓库 | `github.com/felinics/Memoh`，AGPL-3.0（GitHub API 确认） |
| 版本 | v0.13 系列（docs 标注 v0.13；安装脚本钉 release tag） |
| 活跃度 | 2.8k star / 266 fork；2026-11-06 仍有提交 |
| 后端 | **Go**（624,806 行，含测试）；PostgreSQL 18（仅支持 Postgres）；可选 pgvector 记忆向量 |
| 前端 | Vue 3 + TS（208,844 行）；`apps/web` 345 个 `.vue` 文件；`apps/desktop` |
| 工作区 | 支持 `containerd` / `docker` / `apple` 三种 backend（官方 compose 用 containerd；本地 Mac 优先 docker）；文件/终端/Node/Python/浏览器/可视化桌面；快照/导入导出 |
| 渠道 | 渠道 worker 进程（`memoh-channel`）：Telegram/Discord/Slack/Lark/微信/QQ/飞书/钉钉/LINE/企微等 |
| 其他 | Schedule(cron)、Hooks、Skills、MCP、Connect-It 连接器、审批、ACL、上下文压缩、记忆 provider 接口 |
| 部署 | Docker Compose：postgres + pgvector + migrate + server + channel + web（+ connect-it / webhook-tunnel） |

---

## 2. 模块地图（Go 侧）

| 目录 | 规模 | 作用 | 我们的处理 |
|---|---|---|---|
| `internal/agent/` | 221,844 行 | agent 循环（turn/context/decision/tool/background/…） | **改**：注入生活引擎、人格上下文、回复决策 |
| `internal/channel/` | 92,393 行 | 渠道适配、入站/出站、权限 | **留**（精简渠道集合） |
| `internal/handlers/` | 56,616 行 | HTTP API | 改：单 person、生活/记忆/工作台端点 |
| `internal/db/` | 42,754 行 | 数据访问（sqlc） | 改：新增 v2 表；保留迁移机制 |
| `internal/workspace/` | 15,516 行 | 工作区桥（bridge/exec/文件） | 留 |
| `internal/memory/` | 13,522 行 | 记忆 provider 接口 + storefs/wikistore + memllm | **换实现**：我们的自传记忆 provider |
| `internal/bots/` / `botworkspace` / `botbackup` | ~9k 行 | Bot 生命周期/工作区/备份 | 改：单 person 化（保留备份/恢复能力） |
| `internal/schedule/` `hooks/` `skills/` `mcp/` `apps/` | 中度 | 定时、钩子、技能、MCP、应用市场 | 留（市场可关） |
| `internal/container/` `display/` | ~5k 行 | 容器/桌面 | 留 |
| `apps/web` | 345 Vue | 管理台 + workspace 面板 | **重做页面 IA**，保留文件/终端/桌面组件 |
| `crates/` | Rust | 桌面/容器驱动（细节待确认） | 留，尽量不碰 |
| `db/` + `sqlc.yaml` | — | SQL 迁移与代码生成 | 沿用 |

---

## 3. 保留 / 改造 / 删除 / 新增

### 保留（直接受益，不重造）
- 工作台：containerd 容器、文件系统、终端、Node/Python、浏览器、可视化桌面、快照、导入导出、后台任务；
- 渠道 worker + 各平台适配；
- Schedule / Hooks / Skills / MCP / 上下文压缩 / 工具输出截断；
- 审批、信任、审计、预算/限制的骨架；
- Vue 前端框架与 workspace 面板、Markdown 渲染、文件/终端/桌面组件；
- Postgres 迁移机制与 Compose 部署。

### 改造
1. **多 Bot → 单实例一个人**
   - bots 表/列表/切换 → `person`（单行）；渠道配置只属于她；
   - 多用户 ACL → 管理员（你）+ 联系人（people）；去掉租户/团队/角色矩阵；
   - Bot 详情页 → 她的页面（今天/她/记忆/工作台/世界/设置）。
2. **Agent 循环 → 生活引擎**
   - `internal/agent/background` 接生活 tick；`decision` 前置回复决策；`context` 注入常驻认知层；
   - 新包 `internal/life`（时钟/状态/兴趣/计划/活动/睡眠整理）。
3. **记忆 provider → 自传式 vault**
   - 实现 `internal/memory/adapters.Provider`；底层用 `storefs`/`wikistore` 或新 store；
   - 废弃 per-person 库/旧表/crossPool。
4. **配置统一**
   - 旧项目 `bots` 64 列 + 24 个 global_settings 键 → 一份 typed config（schema 化，UI 自动渲染）；
   - 模型按用途分离（chat/growth/vision/embedding/tts），保存时校验、启动预检、失败可见；
   - 渠道账号唯一归属（防多角色共号复发）。
5. **UI 六面**：今天 / 她 / 记忆 / 工作台 / 世界 / 设置；正文见 §6。
6. **渠道语义**：她的世界（关系/隐私/语气），不是"多用户 Bot 平台"。

### 删除（或默认关闭）
- 多 Bot 创建/切换/头像列表、Bot 市场概念；
- 多用户/团队/租户 ACL、市场（supermarket）入口、ACP coding agents（Codex/Claude Code 接入）；
- 连接器 Connect-It（默认关，后续按需）；
- 旧的"任务/待办"心智（保留 schedule 作为她的计划执行器，而不是用户任务系统）。

### 新增
- `internal/life`：Life Engine（见 LIFE-ENGINE.md）；
- `internal/persona`：SELF/人物卡/边界/性格 traits；
- `internal/memoryauto`：记忆写入选路、可见性、睡眠整理（Dream）；
- `internal/social`：社交节律（发帖/看 feed/互动）；
- `internal/attention`：注意力/打断/回复决策；
- `internal/health`：健康检查（模型/渠道/账号唯一性/预算）。

---

## 4. 单实例改造清单（DB/API/UI）

| 域 | 现状 | v2 |
|---|---|---|
| 实体 | bots（多行） | `person`（单行）+ `people`（联系人） |
| 认证 | 多用户 + ACL | 管理员 + 联系人（渠道身份映射） |
| 渠道 | 每 bot 各自配置 | 单 person 的账号配置（唯一） |
| 会话 | bot×会话 | 她 × 人/群 会话（保留多会话） |
| 工作区 | 每 bot 一个 | 每实例一个（她的电脑） |
| 记忆 | memory provider/bot | 她的 vault（一份） |
| 定时 | bot schedule | 她的 schedule/生活 tick |
| 页面 | Bot 管理台 | 六面生活台 |

> 具体表结构/迁移脚本在实现阶段产出；本轮不动任何旧数据。

---

## 5. 生活引擎插点（Go）

```
internal/life/
  clock.go        # 时区/作息/睡眠窗口
  state.go        # 四维 + attention + 衰减/恢复
  interests.go    # 兴趣/目标/演化
  planner.go      # 今日意向/活动块/重规划
  activity.go     # 活动类型/选择算法/执行/日志
  sleep.go        # 睡眠时计算（Dream/日记/明日计划）
  social.go       # 发帖/互动节律
  reply_policy.go # 回复决策（性格/关系/状态/内容）
```

- 触发：`internal/agent/background`（tick）+ schedule（活动/睡眠）+ 事件（消息/活动完成）；
- 对话：`internal/agent/context` 注入常驻层（SELF/人物卡/最近生活/状态/检索记忆）；
- 回复：`internal/agent/decision` 前置 reply_policy；决定"回/晚回/不回/稍后回"；
- 工具：workspace 文件/终端/浏览器 + 社交工具；
- 观测：handlers 暴露"她的一天/活动/回复决策/记忆/隐私分层"。

---

## 6. UI 六面

| 面 | 回答 | 内容 |
|---|---|---|
| **今天** | 她现在怎么样？ | 状态、时间线、会话、她正在做的事、待续活动、主动消息、日记预览 |
| **她** | 她是谁？ | 人设卡、SELF、成长、声音、相册、性格 traits |
| **记忆** | 她记得什么？ | 时间线检索、人物卡、threads、暂存/睡眠整理、可见性 |
| **工作台** | 她在用什么电脑？ | 文件、终端、浏览器/桌面、活动日志、产出物、快照 |
| **世界** | 她怎么和外界联系？ | 渠道（唯一归属）、联系人、社交账号、工具/技能/MCP |
| **设置** | 系统怎么运转？ | 模型/凭据、健康检查、预算、数据备份、部署、许可 |

- 复用 Memoh 的 workspace 文件/终端/桌面组件；重写导航与首页；
- 聊天侧栏可显示"她正在做什么"（活动状态），像 AI Town 的状态面板。

---

## 7. 服务器评估

### 7.1 组件与资源大头

| 组件 | 内存估算 | 说明 |
|---|---|---|
| PostgreSQL 18 | 0.3–0.8 GB | 主库 |
| pgvector | 0.3–0.8 GB | 记忆向量（可选，可合并） |
| server (Go) | 0.3–0.6 GB | 含 agent 循环 |
| channel worker | 0.1–0.3 GB | 渠道连接 |
| web (nginx) | <0.1 GB | 静态 |
| containerd + workspace 容器 | 1.5–3 GB | 文件/终端/Node/Python |
| Chromium（有头浏览器/桌面） | 1–2 GB | 开着桌面时的大头 |
| 系统/缓存 | 1 GB+ | |
| **合计** | **4–8 GB（轻载），8–12 GB（浏览器/桌面常开）** | 不含模型（走 API） |

### 7.2 建议

| 项 | 最低 | 推荐 | 说明 |
|---|---|---|---|
| CPU | 4 vCPU | 8 vCPU | 容器/浏览器/Postgres |
| 内存 | 8 GB | 16 GB | 浏览器+桌面常开建议 16 GB |
| 磁盘 | 80 GB SSD | 120 GB+ | 镜像、workspace、快照、备份 |
| GPU | 不需要 | — | LLM 走 API；本地模型另算 |
| 网络 | 稳定出网 | — | 浏览器/搜索/渠道 |

- 现服务器 **2 vCPU / 3.9 GB 不够**（能启动，浏览器/桌面会 OOM）；
- 降配路径：Memoh 支持 **trusted local workspace**（不起容器，直接在宿主机跑），单用户能省 CPU/内存，但安全边界变弱（agent 直接执行宿主机命令）；建议先按 containerd 评估，后续再决定。
- 建议先在 Mac 本机用 Memoh 做体验/资源基准，再决定云规格；部署脚本/Compose 可直接复用。

---

## 8. 工程策略

1. **分叉方式**：`git clone` 上游 → 新仓库（如 `littly-v2`）→ 从 v0.13 系列 tag 起；保留 `upstream` remote，记录分叉点。
2. **修改原则**：新能力尽量放新包（`internal/life` 等）；核心文件改动最小化并写清楚理由；每季度 diff 上游 commit，人工评估可合并的修复。
3. **许可证**：v2 整体 **AGPL-3.0**；保留 Memoh 版权与来源说明；新增 `NOTICE`；文档注明分叉来源与时间。
4. **品牌**：项目名/UI 品牌改成 Littly；上游 issue/PR 不外发，除非回馈社区。
5. **融合策略（不是移植）**：
   - **以 Memoh 的 Go 后端为骨架**做改造，Littly 的差异化能力（自传记忆、生活引擎、人格回复、成长、工作台驱动、健康/防复发）作为**新包/新表/新接口**长在 Memoh 的模块结构里；
   - 旧项目的 TS 代码/设计只作为**参考与测试语义来源**，不逐行搬迁、不搬旧架构与技术债；
   - 前端 Vue 设计/页面可复用到 `apps/web`（同栈）；
   - 旧库仅备份，不迁移。

---

## 9. 里程碑（建议）

| 阶段 | 交付 | 验收 |
|---|---|---|
| **M0** 分叉与基线 | 新仓库、v0.13 基线、构建/Compose 跑通、许可证/NOTICE、文档入库 | `docker compose up` 可登录；CI 构建通过 |
| **M1 单实例一个人** | person 单行、去多 Bot/多用户 ACL、渠道唯一归属、基础设置 | 只有一个"她"；渠道配置唯一；老板/联系人可用 |
| **M2 生活引擎骨架** | internal/life：时钟/状态/兴趣/计划/活动选择；后台 tick | 她能生成今日意向并执行一个活动（mock/真实） |
| **M3 记忆 v2** | SELF/人物卡/domains/可见性/检索/Dream | 对话记忆正确注入；隐私过滤；夜间整理 |
| **M4 工作台活动** | 活动执行（文件/浏览器/文档）、产出物、活动日志、恢复 | 她能写一篇文档/整理相册并留下可查看产出 |
| **M5 回复与主动性** | reply_policy（性格驱动）、主动消息、打断/恢复 | 高冷人格可已读不回；重要人保底；主动有内容 |
| **M6 UI 六面** | 今天/她/记忆/工作台/世界/设置 | 全流程可操作；AI 状态可见 |
| **M7 部署与迁移准备** | 新服务器、监控/健康检查、备份、旧数据快照 | 线上可跑；备份/回滚演练通过 |

---

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 上游快速迭代，分叉落后 | 钉 tag；每季度 diff；只改必要核心；新增功能独立包 |
| 83 万行代码理解成本 | 按域切入（agent/memory/workspace/channel），先跑通再改 |
| 单实例改造碰核心（bots/ACL/UI） | 先垂直切片验证；保留多租户代码路径但默认关闭，逐步删 |
| 资源不足（浏览器/桌面） | 8C/16G 起步；trusted workspace 备选；浏览器按需启停 |
| AGPL 义务 | 仓库/分发按 AGPL；保留上游版权；对外服务提供源码 |
| 回复策略导致"被冷落"体验 | 可配置保底/重要联系人；决策留痕；她事后能解释 |
| 生活引擎空转/烧钱 | 预算、活动频率上限、睡眠时计算、低价值活动降级 |
| 旧数据迁移冲动 | 本轮只备份；迁移单独立项，先做只读导入器 |

---

## 11. 开放问题

1. 分叉后仓库放哪（新 GitHub 仓库 vs 本仓库新增目录）？
2. trusted local workspace 是否作为默认（省资源）还是可选（安全优先）？
3. 渠道集合先保留哪些（QQ/微信/TG/Discord/飞书/…）？
4. 记忆 provider 用 Markdown vault + 索引（我们的方案）还是直接改造 Memoh 的 storefs/wikistore？
5. v2 是否保留"技能/应用市场"概念（她学技能 vs 用户装应用）？
6. 旧角色（优香/鲸鱼娘/11）的归档形态：导出 JSON + 只读备份，还是作为"她过去认识的人"的人物卡？
