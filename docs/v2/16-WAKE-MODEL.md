# 16 · 唤醒模型（Wake Model）

> 状态：v1.0（2026-11-07）· 取代 04 §2 的固定 5 分钟 tick 与"生活节奏表"。
> 核心：**只有"唤醒"可以有规律（带抖动）；醒来做什么、做多久、要不要再睡，由她决定。**

## 1. 决策

| # | 决策 |
|---|---|
| W1 | 取消"固定 tick + 活动频率表"；行动与对外互动不设生活节奏 |
| W2 | 她可以调用工具**自己安排下一次唤醒**，并**必须附带理由**（"我为什么要在那时醒"） |
| W3 | 系统保留**保底唤醒**（regular fallback，带抖动），防止她忘记调用工具/模型输出失败导致永远不醒 |
| W4 | **不做**阻塞式 `wait_for_user_reply`；消息天然异步，等待用"事件 + 自唤醒"表达 |
| W5 | 保留技术性刹车（平台限速、预算、重要关系保底），但不是生活频率 |

## 2. 唤醒来源

| 来源 | 触发 | 理由 |
|---|---|---|
| **self** | 她在本轮调用 `wake_after` / `wake_at` | 用户/她自己填写的理由（必填，落库） |
| **fallback** | 系统定时（抖动） | 自动理由："例行醒来（没有特别安排）"；她的"小心思"保底 |
| **event** | 新消息/活动完成/审批结果/外部事件 | 事件类型 + 发送人/内容摘要；是否回/是否醒由回复策略与性格决定 |
| **manual** | 管理员/调试 API | 人话理由 |

> event 不写入 `littly_wakeups`（有消息表/事件表），但会输出同一种 `<wake>` 上下文。

## 3. 数据结构

```sql
CREATE TABLE littly_wakeups (
  id          text PRIMARY KEY,
  person_id   text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'self' CHECK (kind IN ('self','fallback','manual')),
  due_at      timestamptz NOT NULL,
  reason      text NOT NULL,                 -- self/manual 必填；fallback 自动
  status      text NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','fired','cancelled','superseded','missed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  fired_at    timestamptz,
  meta        jsonb NOT NULL DEFAULT '{}'    -- 来源 turn/activity/expected follow-up
);
CREATE UNIQUE INDEX uq_wakeup_pending_self ON littly_wakeups(person_id)
  WHERE kind='self' AND status='pending';    -- 同一时刻只有一个自唤醒
CREATE INDEX ix_wakeup_due ON littly_wakeups(person_id, status, due_at);
```

- 新的 `wake_after/wake_at` → 旧 pending self 置 `superseded`（审计保留）。
- 进程启动：`pending AND due_at <= now` 的唤醒 → 取最早一条 `fired` 触发一次（合并），其余标 `missed`（去重，避免补跑风暴）。
- 保底唤醒不落 `littly_wakeups`（由进程内定时器/上游 schedule 管理，重启重算），但每次触发写 `littly_audit(category=wake)`。

## 4. 工具

```jsonc
// wake_after：过 N 分钟叫醒我（N = 1..480）
{ "name": "wake_after", "arguments": { "minutes": 20, "reason": "把刚才那篇笔记写完再醒" } }

// wake_at：在某个时刻叫醒我（ISO 时间，服务端按她的时区归一化）
{ "name": "wake_at", "arguments": { "time": "2026-11-07T07:30:00+08:00", "reason": "想早点起来看看他回没回" } }
```

规则：
- `reason` **必填**，5–200 字；缺失/为空 → 工具报错，让她补（不执行）。
- 服务端校验：`minutes` 1–480；`time` 必须晚于现在且 ≤ 8h；超过 → 钳制并返回提示。
- 同一轮多次调用 → 以后者覆盖前者（旧 superseded）。
- 调度成功返回 `{ok, wakeAt, wakeInMinutes, reason}`；她可以引用它。
- **不提供** `wait_for_user_reply`；如她想"等回复"，用 `wake_after({minutes, reason:"等他回复"})`。

## 5. 保底唤醒（fallback）

| 时段 | 默认间隔 | 抖动 | 说明 |
|---|---|---|---|
| 清醒（默认 07:00–23:00） | 60 分钟 | ±25% | 防止工具漏调/模型失败没人醒 |
| 睡眠（23:00–07:00） | 150 分钟 | ±25% | 更接近人的睡整觉；她可自唤醒更早 |
| 硬上限 | 8 小时 | — | 无论什么情况，最长 8h 必醒一次 |

- fallback 到点时，如果她的 self 唤醒安排在**更早**，按 self 醒；如果 self 安排在**更晚**，按 fallback 醒，并在 `<wake>` 里告诉她："你原本安排了 10:00 醒，但例行检查到了，可以继续睡（重新安排理由）"。
- fallback 不可被关闭（只可调间隔）；避免"她设置了一个 8h 睡眠后，进程/工具出问题永远不醒"。

## 6. 唤醒上下文（注入提示词）

```text
<wake>
本次唤醒：self | fallback | event
现在：2026-11-07 15:20（Asia/Shanghai，周五）
上次唤醒：14:05（理由：把笔记写完）
你当时安排的下次唤醒理由：把笔记写完再醒（15:00 已到） / （未安排，例行检查）
手头：正在写《…》第 3 段（60%）；未读消息 1（tori）；待续 thread 2
现在你要决定：继续手头的事 / 开始别的事 / 休息 / 先处理消息。
如果安排下次唤醒，必须说明为什么要在那个时间醒——这个理由会保存，并在醒来时提醒你。
</wake>
```

- `<wake>` 放在系统提示词后的固定位置（不是每条消息），由 `wake_context` 参数注入；不打印给用户。
- 事件唤醒时，`<wake>` 里附事件摘要（谁、什么、是否紧急）。
- 理由会持久化；Today 页展示"下次唤醒：15:00 · 想继续写笔记"；如理由重要，Dream 可把它写成一条 memory。

## 7. 与对话/消息的关系

- 新消息是事件，**不取消**保底唤醒，也不强制她醒；由回复策略决定"回/晚回/不回/稍后解释"（06）。
- 她可以在"睡着/在忙"时选择不理；重要关系保底/紧急消息可升级唤醒。
- 她发的消息如果期待回复：可以在发送后 `wake_after` 定一个"看看他回没回"的唤醒；不要阻塞等待。
- 消息在 fallback 窗口内到达时，按事件唤醒处理；处理完后恢复到既有的 self/fallback 计时。

## 8. 与生活/活动/计划/Dream 的关系

- 活动只在唤醒 turn 内规划/执行/暂停；没有"每 N 分钟检查一次"的固定 tick。
- 状态推进（衰减/恢复）在唤醒时结算；`last_wake_at` 为锚点；事件（消息/活动结束）即时结算。
- 新一天/睡眠后她可以自己决定"今天想做什么"（生成意向）；没有"必须每天 7 点生成"的强规则；fallback 保证她至少会醒。
- Dream/日记：由她在唤醒时决定（或 fallback 的夜间唤醒时提示"要不要整理今天"）；不做"凌晨 3 点强制 Dream"。用户也可配置允许系统在夜间 fallback 里自动执行 Dream（可选）。

## 9. 与"频率"有关的东西怎么处理

- **删除**：活动频率、发帖频率、主动消息每日配额、回复节奏等"生活节奏表"。
- **保留（不是生活节奏）**：
  1. 平台/技术限速（QQ 单会话 ≥2s/条、全局每分钟上限等）；
  2. 模型/活动预算（每小时最多多少次唤醒/多少 token）；
  3. 重要关系保底（沉默上限内至少一次解释/回应）；
  4. 反骚扰硬刹车（同一人短时间大量消息 → 审计/暂停，可配置）。
- 主动消息由她决定；质量门（有具体内容、有 `why_now`）保留，避免"在吗"。

## 10. 与 04 文档的关系（覆盖声明）

**本文件取代**：
- 04 §2.2 的"tick 基线 5m"与固定节奏；
- 04 §2.5 的 tick 顺序（改为 wake 顺序：结算状态 → 读 wake 上下文 → 她决策 → 执行/安排下一次 → 落库）；
- 06 §6 的"频率与队列"配额（改为 §9 的刹车）；
- 08 §6 的主动消息配额（保留通道限速，配额改为质量门 + 刹车）；
- 12 M2 的"后台 tick 与 schedule 二选一"（改为唤醒调度器）。

未变：状态/兴趣/活动/记忆/回复策略/工作台/渠道/安全等其余部分。

## 11. 验收

| 用例 | 断言 |
|---|---|
| 她调用 `wake_after(20, reason)` | 落库 pending、20 分钟后触发；`<wake>` 含理由 |
| 不带 reason | 工具报错、不创建唤醒 |
| 无 self 安排 | fallback 按间隔出现；不会永不醒 |
| self 安排晚于 fallback | 先 fallback 醒；可继续睡/重新安排 |
| 进程在唤醒前重启 | pending 保留；到点触发；过期合并一次 |
| 连续快速 wake（<60s） | 被钳制/拒绝，不忙循环 |
| 睡眠时段 | fallback 间隔变大；可在 8h 内自唤醒 |
| 消息到达时她在睡 | 不强制醒；按回复策略；重要人可升级 |
| 她安排下次唤醒但模型输出失败 | 工具未执行 → fallback 兜底；审计 |
| 不做阻塞等待 | 不存在 wait_for_user_reply 工具；消息不会挂起 turn |
