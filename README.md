# Littly

一个拟真 AI 伴侣系统：一个有独立人格、跨渠道存在、拥有长期记忆、会主动找你说话的角色。

> **本质不变**：她是一个真正的「人」，不是助手。harness、MCP、skills、插件、渠道——全部基础设施只有一个目的：
> **让她能链接更多东西，看到大千世界，学会更多东西，并且更方便 AI 调用、更适配 AI。**
> 任何改造若与此冲突，改造让步。见 [docs/PRINCIPLES.md](docs/PRINCIPLES.md)。

## 结构

| 目录 | 内容 |
|---|---|
| `harness/` | 基座：[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) fork（vendor 于固定 commit），继承插件系统 / MCP / skills / 定时任务 / LLM 适配器 |
| `plugins/core/` | 业务插件（从旧项目逐行移植）：persona · memory · agents · scheduler · identity · growth · voice · storage · console-api |
| `plugins/channels/` | 渠道插件：snowluma（QQ 账号，全功能）· telegram · wechat-ilink · qq-official · discord |
| `console/` | React 19 + MUI 控制台 |
| `sidecars/bili/` | bili-cli fork（MCP sidecar，AI 自己的 bilibili 账号） |
| `skills/` | 内置 skills |
| `deploy/` | 容器编排（harness + snowluma + bili） |

## 里程碑

M0 脚手架 → M1 harness 业务核心（对话主链路 + 记忆 v2）→ M2 首发渠道（SnowLuma/Telegram）→ M3 全渠道与语音、bilibili → M4 控制台全量 → M5 插件生态与收尾。

## 旧项目

行为参照仓库位于本机 `Downloads/workspace-a52450b8-…`（Next.js 单体），其 `docs/PROJECT-DESIGN.md` 是行为规格与缺陷清单的核对表；新系统逐行对照移植并修复 §18 全部缺陷。
