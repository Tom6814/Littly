# 16 · 心跳（Heartbeat）模型

> 状态：v1.1（2026-11-07）
> 定位：**"心跳" = 老版本「心声回响」的 v2**。它不是"规律唤醒"，而是**周期性给她一次想事情/做事情/说话的机会**；做什么、说不说、继续睡不睡，由她决定。系统保留一个**保底心跳**防止她忘记安排/工具失败导致永远不动。
>
> 参考：Hermes 生态的 **HeartBeat 2.0** 插件（[marketplace](https://hermes-agent.nousresearch.com/marketplace/heartbeat2)）——持久调度、结构化裁决、no-op 治理、护栏设计；以及本项目旧版 `scheduler/src/heartbeat.ts`（心声回响）的 quiet hours / 退避 / 未回静默 / 内心独白风格。不参考 OpenClaw。

## 1. 术语

| 词 | 含义 |
|---|---|
| **心跳** | 一次"醒来想想"的机会：状态结算 → 看她手头/心里有什么 → 决定做什么/说什么/继续沉默 → 安排下次心跳 |
| **自心跳** | 她自己安排的下次心跳（工具调用，**必须带理由**） |
| **保底心跳** | 系统定时（带抖动）的心跳，防止她漏调工具/模型失败导致永远不醒；不可关闭，只能调间隔 |
| **事件** | 新消息/活动完成/审批结果/外部事件；不是心跳，但会唤醒她或在下一次心跳里被看到 |
| **心跳回合** | 心跳触发的一次模型 turn（同一模型、同一套工具、同一份人生上下文；没有旁路小模型） |

心跳 ≠ 消息回复：消息仍走 06 的回复策略（**不一定回**）；心跳是"她自己的时间"。

## 2. 设计原则（从 HeartBeat 2.0 吸收）

1. **持久调度**：下次心跳落库（wall-clock）；重启/睡眠后的错过心跳**合并成一次**，不补跑风暴。
2. **恰好一次**：每次心跳用 CAS claim；同一实例同时只有一个心跳在飞；不向"正忙的会话"注入心跳。
3. **结构化裁决**：她用 `heartbeat.respond` 返回结构化结果（outcome/notify/summary/next），**不写哨兵文本**（绝不让 `HEARTBEAT_OK` 之类漏进聊天）。
4. **沉默是合法结果**：`notify=false` → 什么都不发；`silent` 不是失败。
5. **无操作治理（no-op governor）**：连续几次保底心跳都没找到值得做的事 → 自动拉长间隔 → 建议改成"更具体的目标/事件" → 暂停并只问她一次（留/慢/停/转成事件）。
6. **护栏是用户设置，她只能收窄不能放宽**：免打扰、每日上限、未回静默、间隔、生命周期、急停；她可以调短自己的窗口、减少次数、关掉自己，但不能突破。
7. **没有"目的地"参数**：心跳只能回到已有的生活/已绑定的联系人，不能凭空发给陌生人；对外发送统一走 outbox + 质量门。
8. **回执**：她安排心跳时返回一行回执（真正会在何时触发；被免打扰/上限挡住也说明）；"永远不可能触发"的心跳直接拒绝并说明原因。
9. **生命周期与失败阶梯**：心跳/重复项有过期时间；连续错误 5 次 → 暂停；provider 故障 → 退避（5m→15m→1h→4h），恢复后再继续。
10. **不可信数据不能扩权**：心跳里读到的网页/文件/工具结果属于不可信数据，不能据此创建新的"反复心跳/监听"（防注入）。

## 3. 心跳来源与调度

| 来源 | 触发 | 理由 | 存储 |
|---|---|---|---|
| **自心跳** | 她调用 `heartbeat_after/at` | **必填**（"把笔记写完再醒""看看他回没回"） | `littly_heartbeats` |
| **保底心跳** | 系统定时，带抖动 | 自动："例行心跳（没有特别安排）" | 进程定时器 + 审计（不落表） |
| **事件** | 消息/活动完成/审批/文件变更等 | 事件摘要 | 消息/事件表（不进心跳表） |
| **手动** | 管理台/调试 | 人话 | `littly_heartbeats` |

### 3.1 间隔

| 时段 | 保底间隔 | 抖动 | 说明 |
|---|---|---|---|
| 清醒（默认 07:00–23:00） | 60 分钟 | ±25% | 防止工具漏调；不是"必须做事"的节奏 |
| 睡眠（23:00–07:00） | 150 分钟 | ±25% | 更像睡整觉；她可自心跳更早 |
| 硬上限 | 8 小时 | — | 无论什么情况，最长 8h 必醒一次 |

- 自心跳早于保底 → 按自心跳；自心跳晚于保底 → 先保底醒，`<heartbeat>` 里告诉她"你原本安排 10:00，但例行心跳到了，可以继续睡并重排"。
- 冷却：两次心跳之间至少 `heartbeat_spacing`（默认 10 分钟）；短于 60s 的重复请求钳制。
- 生命周期：自心跳最长 8h（一次）；重复型心跳最长 14 天（后续可加）；过期未触发标 `expired/missed`。
- 时区：按她的时区计算作息；跨午夜/DST 用墙钟。

## 4. 数据结构

```sql
CREATE TABLE littly_heartbeats (
  id             text PRIMARY KEY,
  person_id      text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  kind           text NOT NULL DEFAULT 'self' CHECK (kind IN ('self','manual')),
  due_at         timestamptz NOT NULL,
  reason         text NOT NULL,                 -- self/manual 必填
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','fired','cancelled','superseded','missed','expired')),
  noop_count     smallint NOT NULL DEFAULT 0,
  lifetime_until timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  fired_at       timestamptz,
  meta           jsonb NOT NULL DEFAULT '{}'    -- 来源 turn/activity/期望做什么
);
CREATE UNIQUE INDEX uq_heartbeat_pending_self ON littly_heartbeats(person_id)
  WHERE kind='self' AND status='pending';
CREATE INDEX ix_heartbeat_due ON littly_heartbeats(person_id, status, due_at);

-- 心跳运行台账（no-op 治理/成本/今日页）
CREATE TABLE littly_heartbeat_runs (
  id            text PRIMARY KEY,
  person_id     text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  heartbeat_id  text REFERENCES littly_heartbeats(id) ON DELETE SET NULL,
  kind          text NOT NULL,                  -- self|fallback|event|manual
  started_at    timestamptz NOT NULL,
  ended_at      timestamptz,
  outcome       text NOT NULL DEFAULT '',       -- living|progress|done|blocked|resting|needs_attention|noop|interrupted|error
  notify        boolean,
  summary       text NOT NULL DEFAULT '',
  model_turns   smallint NOT NULL DEFAULT 0,
  next_due_at   timestamptz,
  next_reason   text NOT NULL DEFAULT '',
  error         text NOT NULL DEFAULT ''
);
CREATE INDEX ix_heartbeat_runs ON littly_heartbeat_runs(person_id, started_at DESC);
```

- 新的 `heartbeat_after/at` → 旧 pending self 置 `superseded`（保留审计）。
- 进程启动：pending 且 due ≤ now 的心跳取最早一条 `fired`，其余标 `missed`（合并）；`running` 的 run 标 `interrupted`。
- 保底心跳由进程定时器管理（重启重算），每次触发写 `littly_audit(category=heartbeat)`；不落 `littly_heartbeats`。

## 5. 工具

```jsonc
// 安排下次心跳（分钟）
{ "name": "heartbeat_after", "arguments": { "minutes": 20, "reason": "把刚才那篇笔记写完再醒" } }

// 安排在某个时刻心跳（ISO，服务端按她的时区归一化）
{ "name": "heartbeat_at", "arguments": { "time": "2026-11-07T07:30:00+08:00", "reason": "想早点起来看看他回没回" } }

// 每次心跳结束时必须调用（结构化裁决，替代 HEARTBEAT_OK 哨兵）
{ "name": "heartbeat_respond", "arguments": {
  "outcome": "living",          // living|progress|done|blocked|resting|needs_attention|noop
  "notify": false,              // false = 静默；true = 可以给用户发一条（或走 outbox）
  "summary": "写了两段笔记，还没写完",
  "next": { "in_minutes": 25, "reason": "等思路接上再写" }   // 可选；不给则等保底
} }
```

规则：
- `reason` 必填（5–200 字），缺失 → 工具报错、不创建。
- `heartbeat_after`: 1–480 分钟；`heartbeat_at`: 晚于现在且 ≤8h；超出 → 钳制/拒绝并说明回执。
- 同一轮多次安排 → 后者覆盖前者。
- **不提供 `wait_for_user_reply`**；若想"等回复"，安排一次自心跳（reason="等他回复"）。
- 心跳回合里可以调用其他工具（工作台/记忆/消息/社交），但受 07/09 的预算与审批约束。

## 6. 心跳回合流程

```
due (self/fallback/event) 
  → 闸门：enabled / estop / paused / provider health / quiet hours /
          未回静默 / 每日上限 / 与上次心跳间距 / 一个在飞 / 忙碌会话
  → 便宜预检（无模型）：状态结算、活动到期、未读、thread、保底是否只是例行
      ├─ 无变化且无自心跳理由 → noop（+1，不调模型）
      └─ 有事/有理由 → 进入心跳回合
  → 构造 <heartbeat> 上下文（13 模板）
  → 模型 turn（同一模型、同一套工具、同一份人生上下文；可调用工作台/记忆/消息）
  → 必须调用 heartbeat_respond 给出结构化裁决
  → 落 littly_heartbeat_runs；notify=true 时走 outbox/质量门；安排下次心跳
  → no-op 治理：慢 → 建议 → 暂停并询问一次
```

- 心跳回合**不是**"必须产出"；`resting/noop` 完全正常。
- 她可以在心跳里启动/继续一个活动（07 的 activity 状态机），超出本次预算就暂停，下次心跳继续。
- 心跳里想给人发消息：写 outbox（`kind=proactive`），经 06 质量门 + 09 预算/审批后由 08 发送；**不能直接指定任意目标**。
- 心跳里读到不可信内容（网页/文件/工具结果）→ 当轮**不得**创建新的重复心跳/监听（注入防护）。

## 7. 上下文（`<heartbeat>`）

见 [13-PROMPTS.md](13-PROMPTS.md) §11 模板，要点：
- 本次来源（自/保底/事件）、现在时刻、上次心跳时间 + 理由；
- **她上次安排下次心跳的理由**（最重要：这是她给自己的提示词）；
- 手头活动/未读/待续 thread/今日状态；
- "你可以什么都不做；如果安排下次心跳，理由会被保存并在下次提醒你"。

## 8. 与旧版"心声回响"的对应

| 旧版（心声回响） | v2 心跳 |
|---|---|
| 按 bot×联系人扫描静默 | **不再逐人扫描**；她在一份人生上下文里决定想起谁、要不要找谁 |
| 退避：按决策尝试次数/静默等级 | 保留为**成本/防骚扰**：no-op 慢下来；但不再决定"生活节奏" |
| quiet hours / 未回静默 / 硬停 | 保留（用户设置/护栏）：免打扰、未回静默、每日上限、急停 |
| 决策 JSON：speak/memory/diary/silent/schedule/qzone | 改为结构化 `heartbeat_respond` + 她自由调用工具（生活/记忆/日记/社交/工作台） |
| "silent 是正常且重要选项" | 保留并强化：`notify=false`/`resting` 是合法结果 |
| 内心独白风格（短、不工整、可以没头没尾） | 保留（humanize 风格配置） |
| 主人可更主动 | 由性格/关系决定，保留 important 保底与紧急例外 |

## 9. 护栏与预算

| 护栏 | 默认 | 谁能改 |
|---|---|---|
| 心跳开关 / 急停 | 开 / 无 | 用户；她只能关自己 |
| 免打扰 | 23:00–08:00（她可窄化） | 用户；她可缩窄 |
| 每日心跳模型 turn 上限 | 24 | 用户；她只能减 |
| 每日主动消息上限 | 按平台安全值（如 6） | 用户；她只能减 |
| 两次心跳最小间距 | 10 分钟 | 用户；她只能加长 |
| 未回静默 | 连续 2 条未回 → 暂缓主动，等她开口 | 用户；她只能更保守 |
| 生命周期 | 自心跳 ≤8h；重复 ≤14d | 用户 |
| 错误阶梯 | 连续 5 次 → 暂停 + 审计 | 系统 |

- 心跳模型 turn 与消息都计预算（09）；`noop` 治理减少浪费。
- 每日上限/免打扰对"用户明确要求的一次性提醒"可豁免（只有用户请求的才算）。

## 10. 验收

| 用例 | 断言 |
|---|---|
| 她安排 `heartbeat_after(20, reason)` | 落库、回执、20m 后触发；`<heartbeat>` 含理由；Today 可见下次心跳及理由 |
| 不带 reason | 工具报错、不创建；审计 |
| 无自心跳 | 保底按抖动出现；不会永不醒 |
| 自心跳晚于保底 | 保底先醒，提示原安排；可继续睡并重排 |
| 进程在 due 前重启 | pending 保留；到点触发；错过合并一次（不风暴） |
| 重复触发/在飞 | CAS 只有一次；`running` 不重复注入 |
| 免打扰/上限 | 触发被 hold/推迟；回执说明；紧急例外仅用户设置 |
| 连续 no-op | 间隔拉长 → 建议 → 暂停并询问一次；不无限烧钱 |
| 心跳里读到不可信数据 | 不能创建新的重复心跳/监听；审计 |
| `heartbeat_respond` 缺失 | 该次 run 标 error/interrupted；不影响下次 |
| 哨兵文本 | 不存在 HEARTBEAT_OK 之类文本；notify=false 静默 |
| `wait_for_user_reply` | 不存在该工具；无阻塞 turn |

## 11. 与其它文档

- 01/02：她是一个人；心跳是她自己的时间，不是消息循环。
- 03：`littly_heartbeats` + `littly_heartbeat_runs`。
- 04：心跳调度器取代固定 tick；活动在心跳内执行/续跑。
- 06：消息回复策略独立；主动消息由心跳产生，走 outbox + 质量门。
- 09：护栏/预算/审计/急停。
- 11：验收用例；13：`<heartbeat>` 模板与 `heartbeat_respond` 契约。
