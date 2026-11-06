# 04 · 生活引擎实现规格（Life Engine Implementation）

> 定位：把 [LIFE-ENGINE.md](LIFE-ENGINE.md) 的设计落成可编码规格；数据字段以 [03-DATA-MODEL.md](03-DATA-MODEL.md) 为唯一基准。文中 **扩展建议** 表示 03 当前没有、默认不实现；采用前先改 03。
> 本文不覆盖：回复内容与提示词（06/13）、工作台工具实现（07）、渠道发送（08）、记忆抽取算法（05）。
> **唤醒模型已由 [16-WAKE-MODEL.md](16-WAKE-MODEL.md) 取代**：本文 §2 的固定 5 分钟 tick/节奏表作废；唤醒由 self/fallback/event 驱动，行动由她在醒来时决定；§3 起其余部分保留，"tick"概念替换为 "wake"。
## 1. 包与文件划分
新增 `internal/life/`，只依赖抽象接口；上游用带 `LITTLY:` 注释的薄适配层注入实现，避免 04 反向依赖 handlers/channel/workspace。

| 文件 | 职责 | 关键类型/函数 |
|---|---|---|
| `life.go` | Engine 装配、tick 编排、启停、崩溃恢复 | `Engine`、`Tick`、`Start/Stop`、`Snapshot` |
| `clock.go` | 时区、作息窗口、phase、可注入时钟 | `Clock`、`Rhythm`、`PhaseAt` |
| `state.go` | 四维推进（衰减/恢复/事件）、落库、旁白 | `State`、`Advance`、`ApplyEvent`、`StateRepo` |
| `interests.go` | 兴趣有效强度、触碰上限、候选/升温/休眠 | `InterestService`、`Effective`、`Touch` |
| `goals.go` | 目标状态机、进度、逾期 | `GoalService`、`Transition` |
| `planner.go` | 每日意向生成/校验/回退、日切、候选来源 | `Planner`、`EnsureIntention`、`RollDay` |
| `activity.go` | 活动模型、fitness、硬约束、状态机、CRUD | `Activity`、`Selector`、`Transition` |
| `runner.go` | 租约、步骤、检查点、预算/超时/重试、续跑 | `Runner`、`Lease`、`StepResult` |
| `sleep.go` | 睡眠窗口与 Dream 编排（记忆步骤委托 05） | `Dreamer`、`DreamKey`、`DreamTasks` |
| `social.go` | 主动/社交触发、频率闸门、outreach 队列 | `ProactiveGate`、`OutreachSink` |
| `interrupt.go` | 入站打断、attention、暂停/恢复指令 | `NoteInbound`、`Interrupt`、`ActivityState` |
| `config.go` | `LifeConfig` 默认值与校验 | `Config`、`Validate()` |
| `events.go` | 事件唤醒去抖、tick 报告 | `WakeReason`、`TickReport` |

```go
package life

type Engine struct {
	personID string
	clock    Clock
	rhythm   Rhythm
	cfg      Config
	repo     Repo          // state/intention/activity/interest/goal/thread/budget
	brain    Brain         // 结构化决策；prompt 由 13 提供
	tools    Toolbox       // 工作台/社交工具；07/08 实现
	dream    DreamTasks    // 记忆步骤；05 实现
	outreach OutreachSink  // 主动消息投递；06/08 实现
	wake     chan WakeReason
}

type Clock interface{ Now() time.Time; NewTimer(d time.Duration) Timer } // fake clock 快进
type Timer interface{ C() <-chan time.Time; Stop() bool }
```

`brain` 只收 JSON 契约、不拼提示词；`tools` 只暴露 `Available/Invoke`；`dream` 只暴露分步任务。这样 04 可单测，且不越权写 05/06/07/08。
## 2. 时钟、作息与唤醒（固定 tick 已由 16 取代）

> 以下 2.1 相位/作息仍有效；2.2 的"5m tick"与 2.5 的 tick 顺序作废，请按 [16-WAKE-MODEL.md](16-WAKE-MODEL.md) 实现 self/fallback/event 唤醒。
### 2.1 时区与 phase
时区取 `littly_persona.timezone`，加载失败回退 `Asia/Shanghai` 并报 health 警告；作息按配置的本地时刻解释，支持跨午夜。

| phase | 判定（本地时间，优先级从高到低） | 行为 |
|---|---|---|
| `sleep` | `[sleep, wake)` 跨午夜区间 | 不选活动；能量恢复；Dream |
| `wake` | 起床后 60 分钟 | 生成意向、看消息、轻活动 |
| `quiet` | `[quiet_start, wake)`（睡眠外） | 不主动外发；允许 rest/低强度 |
| `day` | 其余 | 正常活动 |

`wake`/`sleep` 每天加 ±`sleep_jitter`（默认 20m）确定性抖动，`seed = hash(personID, 本地日期)`，避免机械感。phase 不落库，每次由 `clock.Now()` 计算；`littly_state.last_tick_at` 是唯一推进锚点。

### 2.2 tick 频率与事件唤醒（作废·见 16）

> 本小节被 [16-WAKE-MODEL.md](16-WAKE-MODEL.md) 取代：不再有 5m tick；唤醒由 self/fallback/event 驱动。以下仅保留"事件去抖/合并"的思想可复用。
基线 `tick: 5m`；每轮结束计算 `next = min(now+5m, 下一个 phase 边界)`，保证起床/入睡准点。事件唤醒：入站消息规范化后、活动完成/失败、审批结果、workspace 就绪、手动 API；事件 5 秒去抖合并，只补一次 tick。测试直接调 `Tick(ctx, at)`，不启动循环。

### 2.3 与上游 `background` / `schedule` 的取舍
| 方案 | 取舍 |
|---|---|
| A. 每 tick 写一条上游 schedule cron 行 | 持久、UI 可见；但行数膨胀，事件唤醒仍要旁路，Dream 重试语义差 |
| B. `internal/agent/background` 常驻循环 + DB 锁 | 事件驱动、单写者、易重试；重启靠 `last_tick_at` 补偿 |

**推荐 B**。`background` 注册一个 worker：`Start` 起循环、`Stop` 取消，tick 不阻塞聊天。`internal/schedule` 只保留她自己的日历/承诺提醒（`due_at` 到点等），life 不依赖；如为入睡/起床写保险 schedule，必须与循环幂等（同一 tick 只执行一次）。

### 2.4 幂等、并发与租约
- **单 tick**：连接级 `pg_try_advisory_xact_lock(hashtext('life:tick:'||person_id))`，拿不到返回 `skipped_busy`；进程内再加互斥。状态与 `last_tick_at` 同事务提交；`at - last_tick_at < 60s` 跳过（phase 边界除外）。
- **单活动**：`pg_try_advisory_lock(hashtext('life:act:'||activity_id))` 由 runner 专用连接持有，崩溃断连自动释放；runner 每 30s 写 heartbeat（`littly_activity_logs` + `updated_at`）。
- **收割**：每 tick 扫 `status='running'` 且最后日志早于 `stale_after`（默认 3m）的活动 → `paused` + `resume{reason:"crash"}`；能拿到锁才算真死，拿不到说明还在跑。
- **补偿**：`gap = now - last_tick_at` 上限 `catchup_cap: 24h`，以 ≤15 分钟子步按相位积分（跨睡眠也恢复），不补跑每次 tick；时钟回拨（`now < last_tick_at`）直接重置并审计，不产生负衰减。

### 2.5 唤醒顺序（伪代码·按 16 修订）

> 固定 tick 顺序作废；按 16：结算状态 → 读 wake 上下文 → 她决策 → 执行/安排下一次唤醒 → 落库。下例仅示意事务/幂等结构。
```text
Tick(at):
  lock tick or return skipped
  st = loadState(); advanceState(st, st.last_tick_at, at)   # 相位感知，含睡眠恢复
  if phase(at)==sleep: dream.MaybeStart(at); saveState(st,at); return
  if crossed(sleep→wake) or no intention(today): planner.EnsureIntention(today)
  if localDate(at)!=localDate(st.last_tick_at): planner.RollDay(at); budgets.ResetDaily(at)
  runner.ReapStale(); runner.ResumePausedDue(at)
  if a:=repo.GetRunning(); a!=nil { runner.Heartbeat(a) } else { selector.MaybeStart(at) }
  state.MaybeMealOrRest(at); social.EvaluateTriggers(at)
  saveState(st, at)   # state + state_event + last_tick_at 同事务
```

活动启动必须在状态事务提交**之后**（先落 `current_activity_id` 再起 runner）；半途崩溃由收割器还原为 `paused`。
## 3. 状态
### 3.1 速率与公式
存 `smallint`，计算用 `float64`；每 ≤15 分钟子步积分，写入四舍五入，误差 ≤0.5。

| 维度 | 清醒 | 睡眠 | 说明 |
|---|---|---|---|
| energy | −2.0/h | +6.0/h | 休息/吃饭在事件表按次结算 |
| mood | 向 55 回落 1.0/h | 向 60 回落 1.5/h | 只回落差值，不越过目标 |
| social_need | +3.0/h | +1.0/h | 封顶 100 |
| satiety | −4.0/h | −1.5/h | 封底 0 |

```text
energy  = clamp(energy + (−2.0 + hungerRate) * dt_h, 0, 100)
mood    = mood + sign(T − mood) * min(|T − mood|, regressRate * dt_h)  # T=55 醒 / 60 睡
social  = clamp(social + socialRate * dt_h, 0, 100)
satiety = clamp(satiety − satietyRate * dt_h, 0, 100)
hungry(satiety<20): mood −1.0/h；energy 额外 −0.5/h；活动容量 ×0.7
starving(satiety==0): 活动容量 ×0.4；fitness 的 state_fit ×0.5
```

活动期间按类型扣 energy（§5.3），活动结束结算，不在 tick 重复扣。**修复旧 bug**：睡眠/休息/吃饭都走恢复分支；`sleep→wake` 实睡 ≥5h 则 `energy=max(energy,70)`（<5h 保底 55）。单测模拟 7 天，energy 必须始终在 40–100。

### 3.2 落库策略
每 tick 任一维度变化 ≥0.5 或 phase 变化 → 写 `littly_state`，否则只提交 `last_tick_at`。事件型变化（消息、回复、活动结束、打断、吃饭）立即在同一事务写 `littly_state` + `littly_state_events`；`delta` 用 `{"energy":-1.2,...}`，`kind` 取 `decay|message|activity|rest|sleep|meal|interrupt|dream`。每个 tick 生成 `tick_id`（ULID）供日志/审计。精确小数残留：**扩展建议** 增加 `littly_state.carry jsonb`；首版接受 ±0.5。

### 3.3 事件影响表
| 事件 | energy | mood | social_need | satiety | 说明 |
|---|---|---|---|---|---|
| 收到重要的人消息 | 0 | +2 | −4 | 0 | 未回也算被联系 |
| 完成一次回复/聊天 | −1 | +3 | −12 | 0 | 按长度 −8..−20 |
| 被关心/被夸 | 0 | +6 | −3 | 0 | 单日同类上限 +12 |
| 争吵/被冒犯 | −2 | −10 | +5 | 0 | 可开 `littly_threads(kind='conflict')` |
| 被冷落（重要人 24h 未理） | 0 | −5 | +6 | 0 | 每 24h 最多一次 |
| 活动成功 | −cost | +4 | 0 | −1 | cost 见 §5.3 |
| 活动失败 | −cost/2 | −3 | 0 | −1 | 记录原因 |
| 被打断 | 0 | −1 | 0 | 0 | 每日累计上限 −4 |
| 吃饭（rest 子类 meal） | +3 | +2 | 0 | +30 | 20–40 分钟 |
| 休息 30 分钟 | +7 | +1 | 0 | −1 | rest 的 cost，只结算一次 |
| 发帖/主动分享 | −1 | +2 | −8 | 0 | 见 §8 |
| 睡醒结算 | 见公式 | +2 | +2 | 0 | satiety 已含睡眠速率 |

delta 先相加再 clamp；`littly_audit(category='activity'|'social', ...)` 只记不可逆/外部动作，纯状态变化进 `littly_state_events`。rest/meal 不套用“活动成功 +4”；成功/失败的 `cost` 与 §5.3 只结算一次。

### 3.4 对外接口
```go
type Readiness struct{ Reply, Work float64 } // 0..1，供 06
type ToneHints struct{ Warmth, Verbosity, Patience float64; Tired, Hungry bool }

func (e *Engine) Snapshot(ctx context.Context) (Snapshot, error) // state/phase/activity/intention
func (e *Engine) Readiness(s Snapshot) Readiness
func (e *Engine) ToneHints(s Snapshot) ToneHints
func (e *Engine) ActivityCapacity(s Snapshot, k ActivityKind) float64

ReplyReadiness = clamp(0.30 + 0.45*energy/100 + 0.25*mood/100 − busy*0.35 − hungry*0.10, 0, 1)
WorkCapacity   = clamp((energy−minEnergy[k])/(100−minEnergy[k]), 0, 1) * (0.6+0.4*mood/100)
```

`busy=1` 当活动 `running` 且 `progress>10`，`hungry=1` 当 satiety<20。是否回复仍由 06 的 traits/关系决定，life 只提供状态输入。
## 4. 兴趣、目标、意向
### 4.1 兴趣演化
字段全部用 03 的 `littly_interests`，不新增 status 值。

- **有效强度（惰性衰减，幂等）**：`idleDays = max(0, floor((now-last_touched_at)/24h) − 1)`；`effective = clamp(strength − decay_per_day*idleDays, 0, 100)`。读时计算，Dream 物化回 `strength`；同一时刻重复调用结果一致。
- **触碰**：`strength = min(100, effective + delta)`，`last_touched_at=now`，`status='active'`；单条兴趣每日累计 ≤ +10（按 `littly_state_events(kind='interest_touch')` 当日求和）。
- delta：对话提及 +2、主动查资料 +3、活动成功 +5（产出物再 +1）、失败/放弃 −6、Dream 反思点名 +3。
- **候选**：Dream 从 05 的反思/记忆聚类取主题，7 天内 ≥3 条或 3 天内 ≥2 次对话 → `strength=25, source=evolved`；与现存 topic 三元组相似度 >0.6 视为同一兴趣并合并 summary。每日新增 ≤2，active ≤10，超出把最低 effective 置 `dormant`。
- **试探**：候选 48h 内必须有一次 probe 活动（`detail.interest_id`）；成功升温并转常规，失败/取消连续 2 次 → `dormant`。
- **状态**：effective <25 且 idle ≥7d → `dormant`；被触碰 → active 且 +10；effective <10 且 idle ≥30d → `archived`；`source='seed'` 只能人工归档。archived 不再进候选。

### 4.2 目标状态机
只允许：`active↔paused`、`active|paused→done`、`active|paused→abandoned`；`done/abandoned` 为终态（人工重开需审计）。`progress` 仅由活动完成（单次 +10..25）或 Dream 复盘更新，单调不减；`priority` 1–5，1 最高。`due_at` 过期不自动放弃，只提高紧迫度；连续 14 天逾期在 Dream 报告标 `stale` 并降权。Dream 可新建 `kind in (project,wish)` 每日 ≤1；seed 的 `long_term` 修改/放弃需 owner 审批。

### 4.3 每日意向
- **时间**：本地日首次进入 `wake` 生成；若已过 `wake+90m` 或当天缺失则立即生成。`UNIQUE(person_id, day)` + `ON CONFLICT DO NOTHING` 后重读，保证一天一条。
- **调用**：`purpose=decision`，≤1 次/天，超时 30s，重试 2 次（5s/20s）；prompt 用 **13-PROMPTS.md §4“活动规划提示词”**，输入 ≤1200 tok、输出 ≤500 tok、温度 0.7。
- **输出契约**：`{day, main_intent, mood_note, planned:[2..4]{activityKind,title,why}, blocks:[{start,minutes,kind,title,why,needs_workspace}], carry_over:[]}`；planned 落 `littly_intentions.planned`，blocks 转 `littly_activities(planned, scheduled_for 提示)`，不是硬日程；carry_over 并入 threads/候选。
- **校验/回退**：非法 JSON、kind 越界、planned 为空 → 13 的规则计划：`rest` + 一个低精力 `organize|write`（各 45 分钟），`degraded=true`；回退也写库。
- **日切**：新意向生成时昨日 `status='carried'`；未完成活动保持原状态，跨天不丢。planned 仅作为候选 +6 分。

### 4.4 与 threads 的关系
threads 是候选紧迫度来源与产出回写目标：`due_at` 逾期=1.0、24h 内=0.8、open 且有 `next_step`=0.4、waiting=0.2。活动完成后更新 `next_step/summary`；冲突解决则 `resolved`；长期无动作且过期 30 天 → `abandoned`（Dream 决定，审计）。03 的活动表无 thread 外键，首版把 `thread_id` 放 `littly_activities.detail` 与 `littly_activity_logs.detail`；**扩展建议** 增加 `littly_activities.thread_id text REFERENCES littly_threads(id)`。
## 5. 计划与活动
### 5.1 候选来源
每日意向 planned/blocks、到期 threads、effective ≥40 的兴趣、active goals、`social_need≥75`、维护节律（每周 organize/backup 各 ≤1）、生理需求（satiety≤25 → meal；energy≤20 → rest）。单轮候选 ≤20；候选携带 `interest_id/goal_id/thread_id`（存 activity.detail），blocks 的 start/minutes 只作 `scheduled_for` 提示。

### 5.2 fitness 与硬约束
```text
score = 100 * (0.32*interest + 0.22*goal + 0.15*state + 0.12*social
             + 0.10*thread + 0.09*novelty) + intentionBonus(6) + N(0, 8)
interest = 最高匹配兴趣的 effective/100
goal     = max over goals( (6-priority)/5 * (100-progress)/100 )
state    = ActivityCapacity(kind) * satietyFactor
social   = social kind ? social_need/100 : 0.5
thread   = §4.4 的最高分
novelty  = 1 - 最近 3 个活动中同 kind 的占比
```

硬约束 `eligible()`：phase 允许、`energy ≥ minEnergy[kind]`、`satiety ≥ 15`（rest 除外）、无 running 活动、`max_concurrent=1`、日启动数 < `daily_cap`（默认 8）、预算余量、`scheduled_for` 已到、quiet 不启动 social、安全档位允许；`satietyFactor = clamp(satiety/40, 0.3, 1)`。用 `softmax(score/T=12)` 在前 3 名抽取；测试注入固定 seed 时结果确定。平手按 thread 紧迫度、`scheduled_for`、kind 字典序。

### 5.3 活动类型
| kind | 工具（07/08） | 典型时长 | energy/h | 默认 token | 产出 |
|---|---|---|---|---|---|
| learn | 浏览器、搜索、笔记 | 20–45m | 4 | 40k | note |
| research | 浏览器、搜索、文件 | 30–90m | 5 | 60k | doc |
| organize | 文件/清单 | 15–45m | 6 | 30k | file |
| write | 文件、文档导出 | 30–90m | 5 | 80k | doc |
| create | 生图、代码执行、文件 | 30–90m | 7 | 100k | image/project |
| maintain | 文件、记忆工具 | 15–30m | 4 | 30k | note |
| social | 渠道/社交工具 | 5–15m | 3 | 10k | post |
| rest | 无（meal 为子类） | 15–60m | −14（恢复） | 0 | 无 |

`minEnergy`：learn/write 25，research/organize/maintain 30，create/social 40，rest 0；高强度 = create/organize。

### 5.4 活动状态机
```text
planned ──start──▶ running ──done──▶ done
   │                 │  ├─fail──▶ failed
   │                 │  └─pause─▶ paused ──resume──▶ running
   │                 │              └─cancel──▶ cancelled
   └─cancel──────────────────────────────────▶ cancelled
```

合法迁移仅上述；每次迁移写 `littly_activity_logs(kind='plan'|'result'|'interrupt'|'resume')`，更新 `started_at/ended_at/progress/log_summary`，同步 `littly_state.current_activity_id`（开始置、终态清）。非法迁移返回错误，不静默改状态。`done` 必须有产出或明确 `log_summary`，否则按 `failed` 收尾，杜绝“假装做了”。

### 5.5 执行、预算、超时、重试
- **plan**：1 次 `brain.PlanActivity`（07 §4.2，`goal + steps[≤8]`）持久化为 `kind='plan'`；可重规划 ≤2 次，不覆盖旧日志。
- **切片**：runner 每轮最多跑 90 秒或 2 步即让出，活动跨多 tick；每步 ≤3 次工具调用、单个工具 60s（07 §4.2），每步写检查点（`kind='step'`，含 `stepsDone/ms/tool/ok`）。`progress = min(95, round(100*done/total))`，done 时 100。
- **预算**（`littly_activities.budget`，读改写由租约保护）：`{"tokens":60000,"maxMinutes":90,"maxSteps":40,"maxToolCalls":80,"used":{"tokens":0,"minutes":0,"steps":0,"toolCalls":0,"attempt":0}}`；tokens 按 provider usage，minutes 只计实际执行时间（暂停不计）。
- **超时**：单步 120s；`used.minutes ≥ maxMinutes` 或 steps/toolCalls 超限时，若 `progress≥20` 且 `attempt<3` → `paused`，否则 `failed(reason='budget_exhausted')`；同一活动恢复 ≤3 次。
- **重试**：瞬时错误 3 次（5s/20s/60s 退避）；planning 失败重试 1 次后 `failed`；审批拒绝、路径越狱、权限拒绝不重试，直接 `failed` 或 `paused(approval)`。
- **取消**：ctx 每步检查；用户/刹车 → `cancelled` 并写原因。
- **产出**：`littly_artifacts`（path 相对 workspace 根）+ `littly_activity_logs(kind='result')`；同时调 05 的 `Stage(ctx, StagingItem{Source:"workspace", ActivityID, ArtifactID, Raw})`，由 05 决定记忆。
- **工作台接口**：`Toolbox.Available(ctx, kind)` 返回工具集（未就绪返回 `ErrWorkspaceNotReady`，活动回 `planned`、10 分钟后重试）；`Invoke(ctx, ToolCall)` 返回 `ToolResult{Output, Usage, Artifacts, Retryable}`。容器按需启动由 07 负责。
## 6. 打断与恢复
```text
消息入站
  └─ NoteInbound(sig)        # attention_events(kind=message)、状态 delta
       └─ 06 决策
            ├─ immediate/short → Engine.Interrupt(activity_id, reason)
            │     pause → 下一步边界暂停 + log(interrupt) + resume_after=now+5m
            │     deny  → 06 降级 later；none → 不暂停
            └─ later/no_reply → 不暂停；attention="看到 X 的消息，等会儿回"
```

- 对 06 提供 `ActivityState{activity_id,kind,progress,interrupt_cost,focus_until,allow_interrupt}` 与 `Interrupt(activity_id,reason) → pause|deny|none`；`focus_until = now+剩余分钟`，审批中/不可中断工具 `allow_interrupt=false`。`interruptCost = kindFocus*(progress/100)`，`kindFocus`：create/write=1.0，research/organize=0.8，learn/maintain=0.6，social/rest=0.3。
- `InboundSignal` 含 `people_id/channel/message_id/urgency/at`；life 只回传快照与成本，不决定回不回。活动 running 时快照带 `activity{kind,progress,attention}`，06 据此倾向 short/later。
- **恢复**：`paused` 且 `resume_after≤now`、phase 允许、无更新的 immediate 打断 → tick 优先恢复，再考虑新活动。续跑以最近 `plan`+`step` 为权威（07 的 `.her/pending` 只作执行层缓存），从下一步继续；plan 缺失才重规划。
- **过期**：paused >24h → Dream 复盘决定 carry（重置 `scheduled_for`）或 `cancelled`（thread 记一笔），不允许无限挂着。
- **attention**：`littly_state.attention` 存 ≤60 字可读文本；每次变化追加 `littly_attention_events`（`message|activity_start|activity_end|interrupt|sleep|wake`），作为“她为什么没回”的解释来源。
## 7. 睡眠时计算（Dream）
**编排**：进入睡眠窗口后 04 的 `MaybeStart` 判定并异步调 05 的 `RunDream(DreamRequest{PersonID,Day,SleepStart,SleepEnd,State,Budget})`；默认 02:00–05:00（随作息），pending≥40 或最老 >36h 低优先级补跑，手动走审批。04 负责何时跑/总预算/重试，**不写** `dream_reports`；05 返回 `DreamResult{ReportID,Status,Stats,ReportPath,LifeSignals{InterestCandidates,TomorrowIntent,NotableEvents}}`。幂等：`pg_try_advisory_lock(hashtext('littly:dream:'||person_id))` 拿不到即 `skipped`；同一睡眠日已 `ok` 不再跑，04 只重试 `failed`。

| 阶段 | 04 职责 | 05 职责 |
|---|---|---|
| 触发/预算 | 睡眠窗口、pending 阈值、总预算、重试；调 `MaybeStart` | 前置检查，不满足返回 skipped |
| D1–D9 | 只传 `DreamRequest` | collect/extract/merge/domains/reflect/people/SELF/diary/report |
| LifeSignals | 落地兴趣候选、目标建议、明日意向、NotableEvents | 生成并随 `DreamResult` 返回 |
| 收尾 | 失败保留 staging、不阻塞白天；健康/审计 | 状态只写 `running/ok/failed`，partial 记 stats |

- 预算 **40k tok / 20 分钟**（05 §6）；04 重试 ≤2 次；醒来仍未完成则停止并保留 staging，不阻塞白天。Dream 在独立 goroutine 运行，tick 只 `MaybeStart`。
- `LifeSignals`：InterestCandidates → §4.1 候选；TomorrowIntent → 校验后写 `littly_intentions(day+1)`，失败早上走 §4.3 回退；NotableEvents 供次日意向/摘要。
- 睡眠期间状态按 §3 积分，成功给 mood +2；`sleep` 不启动活动，`current_activity_id` 必须为空；Dream 异常只写 audit/health，不让 tick 崩溃。
## 8. 主动消息 / 社交编排接口
策略与文案在 06/08；04 只提供触发、闸门、队列与硬上限。

- **触发点**：活动 `done`（优先有 artifact）；thread 到期/有 `next_step`；`social_need≥75` 且 phase 合适；正面事件后 `mood≥75`。生成 `OutreachTrigger{Kind, PeopleID, ReferentType, ReferentID, DedupeKey}`，`DedupeKey` 如 `share:<artifact_id>`。
- **闸门**（`ProactiveGate.Evaluate`）：quiet 拒绝（`DeferUntil=wake+15m`）；`littly_budgets(scope='proactive'|'social', period='day')` 条件自增（默认全局 4/天；细分取 06 §6 与 08 §6 更严者：important≤2 / friend≤1 / stranger 0；同人最小间隔取 06 的 90 分钟与 08 的 2h 中更严者），行不存在时按配置 upsert；连续 2 次 no_reply → 24h 冷却；必须有具体 referent（拒绝“在吗”）。自增用 `UPDATE ... SET used_value=used_value+1 WHERE used_value<limit_value RETURNING ...`，0 行即拒绝。
- **队列**：默认用 03 基线的 `littly_activities(kind='social', status='planned')` 持久队列（`detail={outreach:{...}}`），runner 调社交工具（07/08）；若采纳 06 §5.11 的 `littly_outbox`（扩展建议），则 04 改写 `status=draft`（payload.hint + referent），06 质量门 → `queued`，08 发送。`DedupeKey` 去重，`expires_at` 默认 12h。
- **接口占位**：`OutreachSink.Enqueue` 仅供 06 已起草时直投；04 只产 trigger/draft，不拼文案。社交发帖与主动消息共用闸门、分开计数，发送成功才写 `littly_artifacts(kind='post')` 与 `littly_audit(category='social')`。
## 9. 配置、健康与崩溃恢复
### 9.1 `life` 配置（`configx` typed，默认值）
```yaml
life:
  enabled: true
  tick: 5m
  min_tick_gap: 60s
  wake: "07:30"
  sleep: "23:30"
  quiet: ["23:30", "07:30"]
  sleep_jitter: 20m
  catchup_cap: 24h
  decay: {energy_per_hour: 2.0, mood_target: 55, mood_regress_per_hour: 1.0,
          social_need_per_hour: 3.0, satiety_per_hour: 4.0}
  sleep_recovery: {energy_per_hour: 6.0, mood_target: 60, mood_regress_per_hour: 1.5,
                   social_need_per_hour: 1.0, satiety_per_hour: 1.5,
                   min_hours: 5h, wake_energy_floor: 70}
  activity: {max_concurrent: 1, daily_cap: 8, min_minutes: 15, max_minutes: 90,
             slice: 90s, step_timeout: 2m, heartbeat: 30s, stale_after: 3m,
             max_resumes: 3, max_steps: 40, max_tool_calls: 80}
  selection:
    weights: {interest: 0.32, goal: 0.22, state: 0.15, social: 0.12, thread: 0.10, novelty: 0.09}
    noise_sigma: 8
    top_k: 3
    softmax_temp: 12
  intention: {enabled: true, model_purpose: decision, max_output_tokens: 500, temperature: 0.7, timeout: 30s, retries: 2}
  dream: {enabled: true, window: ["02:00", "05:00"], budget_minutes: 20, budget_tokens: 40000, retries: 2}
  proactive: {enabled: true, daily_limit: 4, min_gap: 2h, cooldown_after_ignored: 24h}
  social: {enabled: false, daily_limit: 2}
```

校验：`tick ∈ [1m,30m]`、`wake≠sleep`、`quiet` 覆盖睡眠、权重和 =1.0±0.01、`max_concurrent=1`（v2 固定）、`wake_energy_floor ∈ [50,90]`。`enabled=false` 时 tick 不推进也不调模型，手动 API 仍可读快照。

### 9.2 健康、观测与审计
- `/health/life`（浏览器 `/api/health/life`）：`{enabled, phase, last_tick_age_s, state, activity:{id,status,heartbeat_age_s}, dream:{last_started_at,status}, budgets:{proactive:{used,limit},social:{...}}, stuck_activities}`。
- 阈值：`last_tick_age_s > 3*tick` → degraded；`heartbeat_age_s > 3*stale_after` → error；昨夜 Dream `failed` → warning；预算耗尽 → info。
- 日志 JSON：`person_id/tick_id/phase/activity_id/kind/duration_ms/result`；模型调用带 `purpose` 与 usage。审计记活动开始/结束/失败原因、Dream 报告、社交发送、预算拒绝、目标放弃、配置变更。
- 今天页读 `littly_state` + `littly_attention_events` + 活动日志即可还原“她在做什么、为什么没回”；不新增 `life_events` 表（LIFE-ENGINE §7 该项由 attention + activity_logs 覆盖）。

### 9.3 启动/崩溃恢复顺序
1. 校验配置与 person 唯一；2. 收割 `running` 僵尸 → `paused`；3. 05 的 `running` Dream 超 90 分钟 → `failed`；4. 按 `catchup_cap` 相位补偿状态；5. 确保今天意向；6. 立即跑一次 tick；7. 启动 5m 循环与事件监听。第 2–6 步全部幂等，重复启动安全。

### 9.4 对 03 的扩展建议（默认不实现）
| 表 | 建议 | 用途 |
|---|---|---|
| `littly_activities` | `thread_id text REFERENCES littly_threads(id)` | 免去 detail 里传 thread |
| `littly_activities` | `resume_state jsonb, attempt smallint` | 显式断点/重试计数 |
| `littly_state` | `carry jsonb` | 保留小数衰减残差 |
| `littly_activity_logs` | `UNIQUE(activity_id, seq)` | 检查点防重复 |
## 10. 测试
| 层 | 用例 | 断言 |
|---|---|---|
| 单测 | fake clock 快进一天/一周，跨午夜、DST、抖动 | phase 正确；energy 40–100；睡眠恢复>0 |
| 单测 | `Advance` 跨 sleep→wake | wake floor 70；负向不越界；hunger 惩罚 |
| 单测 | tick 幂等：同一 `at` 调 2 次；并发 2 个 tick | 状态只推进一次；一个返回 skipped |
| 单测 | 活动状态机全迁移矩阵 | 非法迁移报错；终态不变；`current_activity_id` 同步 |
| 单测 | fitness 硬约束（energy/quiet/budget/日上限/并发） | 不合格候选被排除且原因可查 |
| 单测 | 预算超限：tokens/minutes/steps 分别超 | 按 §5.5 pause 或 fail，不超支 |
| 单测 | 兴趣惰性衰减调用两次、触摸日上限、状态迁移 | 结果一致；不重复衰减/加分 |
| 单测 | 意向：非法 JSON/超时/空 planned | 走静态模板；一天仅一行 |
| 单测 | 打断：immediate 暂停、later 不暂停、attention 落库 | 进度保留；resume_after 正确 |
| 单测 | Dream：请求失败重试、LifeSignals 落地、wake 截止 | 不重复写记忆；status=failed 可解释 |
| 单测 | 闸门：quiet/上限/冷却/无 referent | 拒绝且 reason 正确；预算不虚增 |
| 集成 | fake clock + mock LLM + mock workspace 跑完整一天 | ≥1 个 done 活动、artifact、意向、Dream、日记 |
| 集成 | 活动中途 kill 进程再启动 | 收割为 paused，续跑不重复 artifact，最终 done/failed |
| 集成 | 睡觉窗口到达 | 不启动活动；Dream 仅一次；次日意向存在 |
| 集成 | 消息在活动 running 时到达并 immediate | 活动暂停→回复→恢复，日志完整 |
| 集成 | 时钟停机 26h 后启动 | 衰减封顶 24h；补跑一次 Dream；不补跑所有 tick |

**验收**：① 空跑 24h 无异常，状态在合理区间且每天有恢复；② 至少一个自主活动留下可查看产出与完整日志；③ 断电重启后未完成活动可继续；④ 同一活动不会被两个 runner 执行；⑤ 所有拒绝/失败都有 reason 与审计，不出现“假装做过”。

```text
活动执行时序（打断/恢复）
tick ─▶ Run(act) ─▶ lease ─▶ plan ─▶ step1 ─▶ checkpoint
                       │
        消息 ─▶ NoteInbound ─▶ 06 决策 ─┬─ immediate ─▶ Pause ─▶ paused
                                        └─ later/no_reply ─▶ 不暂停
回复完成 ─▶ resume_after ─▶ tick ResumePausedDue ─▶ step2 ... ─▶ done + artifact
```
## 11. 开放问题
1. 是否要“加速的一天”（现实 1h = 她 1 天）？会改变所有速率常量与测试基线，建议 v2 不做。
2. 活动 token 预算默认值（40k–100k）需按实际模型价格校准；是否再加“每日总预算”二次封顶？
3. 主动聊天默认 2 条/天与“高冷人格”是否冲突？建议由 traits 调低而非改全局默认。
4. 多时区联系人时作息以她为准（已定）；“深夜勿扰对方”的礼貌规则是否放 08 渠道层？
5. 活动是否给 UI 可见进度百分比（会诱导为进度而做）；建议只展示 `status+attention`，进度存内部。
6. paused 超 24h 由 Dream 决定 carry/abandon 的阈值与 owner 审批边界，需结合 05 复盘一起定。
