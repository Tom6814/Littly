# AstrBot 插件调研与借鉴记录

> 调研日期：2026-11-01。目标：横向对比 6 个 AstrBot 插件，判断哪些设计值得吸收进 Littly。
> 结论原则：**只吸收思想/参数/算法，不复制代码或整段提示词**（见文末合规说明）。

## 调研对象

| 仓库 | 定位 | License | 结论 |
|---|---|---|---|
| [NickCharlie/astrbot_plugin_self_learning](https://github.com/NickCharlie/astrbot_plugin_self_learning) | 人格自学习 / 长期记忆（已委托 livingmemory） | AGPL-3.0 | 借鉴三阶段遗忘、情绪学习闸门、两级触发 |
| [lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory](https://github.com/lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory) | 「对话即记忆」自动管线 | AGPL-3.0 | 借鉴检索加权与写前去重合并、会话窗口总结 |
| [Renyus/astrbot_plugin_self_evolution](https://github.com/Renyus/astrbot_plugin_self_evolution) | 人格演化 | CC BY-NC 4.0 | 借鉴纯规则「内心状态机」思路；其整段重写 system prompt 的做法不可取 |
| [Pancakes-Labs/astrbot_plugin_proactive_chat](https://github.com/Pancakes-Labs/astrbot_plugin_proactive_chat) | 主动消息 | AGPL-3.0 | 借鉴未回硬停、随机区间排期、生成期丢弃过期回复 |
| [anka-afk/astrbot_plugin_meme_manager](https://github.com/anka-afk/astrbot_plugin_meme_manager) | 表情包管理 | MIT | 可移植：相册语义化 + `meme:<id>` 选图协议（下一阶段） |
| [chenluQwQ/astrbot_plugin_bilibili_ai_bot](https://github.com/chenluQwQ/astrbot_plugin_bilibili_ai_bot) | B 站内容接入 | AGPL-3.0 | 借鉴边界设计：严格输出协议、不可信内容包裹、工具预算（下一阶段） |

## 已吸收（本轮，clean-room 重写）

### 记忆（`harness/packages/littly/memory`）
- **检索加权**：RRF 相关性之外加入 `importance` 与 `event_time` 衰减（按 domain 半衰期、`volatility=state` 快速衰减），替代纯 RRF 排序。
- **Dream 触发从 AND 改 OR**：`staging≥25` 或「有暂存且超过冷却时间」都会整理，低流量联系人不再永远不整理。
- **修复写路径清空向量**：`memory_write/update/forget` 重建索引时保留未变化条目的向量，避免搜索静默退化为纯 FTS。

### 主动消息（`harness/packages/littly/scheduler`）
- **修复心跳退避统计**：按唤醒/决策尝试次数退避（silent、gate-cancelled 也计入），避免静默期每 60s 唤醒 LLM。
- **未回硬停**：连续 4 条主动消息未获回复后暂停主动排期，直到用户再次发言。
- **随机区间排期**：下一次主动消息在 `[min,max]` 区间内随机，消除固定节拍感。

## 明确不抄
- self_evolution 的「模型整段重写 system prompt、无 diff/无回滚」——反证我们的提议-审批+铁律校验路线。
- livingmemory 的 3D 图谱双路 rerank、以 `max(create_time,last_access)` 重置衰减。
- bilibili_ai_bot 的双写 JSON/SQLite 架构（其 schema.sql 是未完成的 v2 目标）。
- 任何仓库的代码与提示词原文（见合规说明）。

## 下一阶段候选（按性价比）
1. **相册语义化 + `meme:<id>` 选图协议**（meme_manager，MIT，可移植）：相册图片 caption/tags/向量 + 工具返回候选白名单，防模型编造图片 ID。
2. **外部内容不可信包裹**（bilibili_ai_bot 思想）：B 站/推特等工具输出注入 prompt 前包裹为 untrusted data，接社交评论前必须做。
3. **小时级内心状态机**（self_evolution 思想）：energy/mood/social_need/satiety 四维 + 小时衰减 + 心理旁白注入，零 LLM 成本，补足「为什么是现在主动说话」的依据。
4. **两级记忆整合触发**（self_learning 思想）：计数 OR 冷却之外，再加事件快通道（重要事件立即触发整理）。

## 合规说明
- 上述借鉴仅使用公开的设计思想、算法与参数；代码、提示词、数据结构均按本项目风格独立实现。
- AGPL-3.0 / CC BY-NC 4.0 仓库代码**未复制**进本仓库；因此本项目仍按根目录 `LICENSE`（MIT）分发。
- `meme_manager`（MIT）若后续移植代码，需在 `THIRD-PARTY-NOTICES.md` 标注来源与版权。
