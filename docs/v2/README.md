# Littly v2 设计文档（讨论稿）

> 状态：**设计稿 v0.1（2026-11-06）· 尚未实现**
> 这一组文档记录"把 Littly 重做成一个人"的方向、依据与改造方案。实现前允许大改；实现后以代码为准。

## 一句话

**她不是 personal agent，她是一个人：有自己的人生、自己的电脑、自己的朋友与判断。**

## 已拍板的决策（Owner 确认）

| # | 决策 | 说明 |
|---|---|---|
| D1 | **一个实例 = 一个人** | 取消多 bot/多角色；其余角色数据归档+导出，不物理删除 |
| D2 | **硬分叉 Memoh 作为底座** | 接受 Go + Vue 3 + PostgreSQL + containerd 技术栈；AGPL-3.0 可接受 |
| D3 | **把旧项目的部分代码/设计搬过来** | 后端 TS 逻辑移植为 Go；Vue 页面设计与组件可复用；旧测试用例可移植 |
| D4 | **记忆改成"她的人生"** | 自传式记忆 + 人物卡 + 可见性；废弃 per-person 记忆库与 legacy memories 双轨 |
| D5 | **旧数据只备份、不迁移** | v2 首版不导入历史数据；迁移作为独立项目后置 |
| D6 | **隐私三层** | 公开（网页可见）/ 私密抽屉（仅服务器文件可翻，网页无入口）/ 她主动展示；不做加密抽屉 |
| D7 | **自由生活 + 刹车** | 日常自由；钱/账号安全/批量外发/删数据/不可逆操作需刹车 |
| D8 | **兴趣与目标：种子 + 演化** | 人设给种子；之后从记忆/经历里长出来、可增减 |
| D9 | **回复不保证** | 别人说话是否回复、多久回、回不回，由**性格/关系/状态/当下在做什么**共同决定 |

## 文档索引

1. [LIFE-ENGINE.md](LIFE-ENGINE.md) —— 生活引擎与记忆/人格/工作台的设计（核心）
2. [MEMOH-FORK-ASSESSMENT.md](MEMOH-FORK-ASSESSMENT.md) —— Memoh 硬分叉评估、改造清单、服务器与里程碑
3. 本文 —— 决策与索引

## 调研依据（外部）

- *Generative Agents: Interactive Simulacra of Human Behavior*（Stanford，[arXiv:2304.03442](https://arxiv.org/pdf/2304.03442.pdf)）：记忆流、反思、分层计划
- [AI Town](https://github.com/a16z-infra/ai-town)：Generative Agents 的可运行实现（TS/Convex）
- [Concordia](https://github.com/google-deepmind/concordia)：DeepMind 生成式社会模拟（Game Master / Entity-Component）
- *Characterizing LLM-driven Social Network: The Chirper.ai Case*（[arXiv:2504.10286](https://arxiv.org/abs/2504.10286)）：6.5 万 AI 角色、770 万 AI 帖子的社交网络
- [Letta: Sleep-time Compute](https://www.letta.com/blog/sleep-time-compute)：睡眠时间后台整理与预计算
- [Project Sid 报道](https://gigazine.net/gsc_news/en/20241202-minecraft-ai-civilization-project-sid/)：1000 个 agent 的长期社会模拟
- [Agentopia 介绍](https://cloud.tencent.com.cn/developer/article/2705087)：智能体社会中的长期生活模拟与学习

> 以上项目仅**借鉴思想与机制**，各自许可证不同；不复用其代码（除非单独评估并遵守各自许可）。

## 我们与它们的关系

| 项目 | 它们是什么 | 我们借什么 | 我们不做什么 |
|---|---|---|---|
| AI Town / Generative Agents | 小镇居民模拟 | 记忆流、反思、分层计划 | 不做游戏世界/小镇渲染 |
| Concordia | 社会模拟框架 | 组件化 agent、环境反馈 | 不做研究型 GM 框架 |
| Chirper.ai | 纯 AI 社交网络 | 自主发帖/社交节律 | 不追求规模，不做低质刷屏 |
| Letta | 记忆 OS | 睡眠时计算 | 不用它的产品形态 |
| Memoh | 多 Agent 工作台平台 | 工作台容器、渠道、Schedule、Hooks、Skills、审批 | 不要多 Bot/多用户/生产力任务框 |
| AstrBot | 聊天机器人平台 | 渠道抽象、插件/技能、未来任务概念 | 不要"定时任务=主动"的模型 |
| coding harness（DSH/Pi/fx） | 终端编码 Agent | 工具循环/Provider 经验 | 不做编程 Agent；她只是用电脑的人 |

## 与旧项目的关系

- 旧仓库（TS + dsh + SQLite + Vue console）**作为参考与资产库保留**，v2 不复用其运行时；
- 可搬运资产：记忆 vault 设计、成长三铁律、内心状态机、Dream 流程、渠道适配经验、控制台信息架构、测试用例语义；
- 旧数据：**只备份**（DB + memory + 配置），v2 不导入。

## 下一步

见 [MEMOH-FORK-ASSESSMENT.md](MEMOH-FORK-ASSESSMENT.md) §10 里程碑。第一个里程碑是"单实例一个人 + 工作台 + 一天活动 + 聊天"的垂直切片。
