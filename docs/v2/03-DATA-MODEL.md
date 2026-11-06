# 03 · 数据模型（实现基准）

> 这份 schema 是 v2 实现的**唯一数据基准**；其他文档引用这里，不另造字段。
> 约定：Postgres 18；表名/列名 snake_case；id 用文本 ULID；时间 `timestamptz`（UTC 存储，展示按 person 时区）。
> **person_id = 单实例唯一**：沿用上游 `bots` 表的一行作为 person 载体（只允许一行 active，启动检查），新表用 `person_id` 外键引用它。产品/UI 不暴露 "bot" 概念。

## 1. 单实例约束

- 启动时检查 `bots` 中 active 行数 = 1；否则报错/进入初始化。
- 迁移后禁止通过 API 创建第二个 "person"。
- 所有新表 `person_id` 指向该行；无跨 person 查询。

## 2. 新表（`littly_` 前缀）

### 2.1 person 扩展

```sql
-- 她的人设/初始化（bots 主行已有 name/avatar/character_id 等；这里放 v2 语义）
CREATE TABLE littly_persona (
  person_id      text PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  nickname       text NOT NULL DEFAULT '',
  timezone       text NOT NULL DEFAULT 'Asia/Shanghai',
  birthday       date,
  gender         text NOT NULL DEFAULT '',
  appearance     text NOT NULL DEFAULT '',
  bio            text NOT NULL DEFAULT '',          -- 种子人设
  system_prompt  text NOT NULL DEFAULT '',          -- 角色底稿（可覆盖 bots 字段）
  personality    text NOT NULL DEFAULT '',
  scenario       text NOT NULL DEFAULT '',
  style          jsonb NOT NULL DEFAULT '{}',       -- 风格校准/模型族
  voice          jsonb NOT NULL DEFAULT '{}',       -- TTS/音色引用
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- 性格维度（0-100；影响活动选择、回复策略、主动消息、语气）
CREATE TABLE littly_traits (
  person_id  text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  key        text NOT NULL,   -- clinginess/social_energy/pride/patience/curiosity/orderliness/possessiveness/expressiveness/independence
  value      smallint NOT NULL DEFAULT 50 CHECK (value BETWEEN 0 AND 100),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, key)
);
```

### 2.2 状态

```sql
CREATE TABLE littly_state (
  person_id           text PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  energy              smallint NOT NULL DEFAULT 60 CHECK (energy BETWEEN 0 AND 100),
  mood                smallint NOT NULL DEFAULT 60 CHECK (mood BETWEEN 0 AND 100),
  social_need         smallint NOT NULL DEFAULT 40 CHECK (social_need BETWEEN 0 AND 100),
  satiety             smallint NOT NULL DEFAULT 60 CHECK (satiety BETWEEN 0 AND 100),
  attention           text NOT NULL DEFAULT '',   -- 当前注意力描述（"在写笔记"/"刚被消息打断"）
  current_activity_id text,
  last_tick_at        timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE littly_state_events (        -- 可选：状态变化审计
  id         text PRIMARY KEY,
  person_id  text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  at         timestamptz NOT NULL,
  kind       text NOT NULL,              -- decay/message/activity/rest/sleep...
  delta      jsonb NOT NULL DEFAULT '{}',
  reason     text NOT NULL DEFAULT ''
);
```

### 2.3 兴趣 / 目标 / 意向

```sql
CREATE TABLE littly_interests (
  id              text PRIMARY KEY,
  person_id       text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  topic           text NOT NULL,
  summary         text NOT NULL DEFAULT '',
  strength        smallint NOT NULL DEFAULT 50 CHECK (strength BETWEEN 0 AND 100),
  source          text NOT NULL DEFAULT 'seed',  -- seed|evolved|conversation|social
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','dormant','archived')),
  decay_per_day   numeric(4,2) NOT NULL DEFAULT 1.0,
  last_touched_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE littly_goals (
  id          text PRIMARY KEY,
  person_id   text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  title       text NOT NULL,
  detail      text NOT NULL DEFAULT '',
  kind        text NOT NULL DEFAULT 'project' CHECK (kind IN ('long_term','project','wish','habit')),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','done','abandoned')),
  priority    smallint NOT NULL DEFAULT 2,      -- 1..5
  due_at      timestamptz,
  progress    smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE littly_intentions (
  id            text PRIMARY KEY,
  person_id     text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  day           date NOT NULL,
  main_intent   text NOT NULL DEFAULT '',
  mood_note     text NOT NULL DEFAULT '',
  planned       jsonb NOT NULL DEFAULT '[]',     -- [{activityKind,title,why}]
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','carried')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (person_id, day)
);
```

### 2.4 活动 / 产出 / 日志

```sql
CREATE TABLE littly_activities (
  id            text PRIMARY KEY,
  person_id     text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  intention_id  text REFERENCES littly_intentions(id) ON DELETE SET NULL,
  kind          text NOT NULL,        -- learn|research|organize|write|create|maintain|social|rest
  title         text NOT NULL,
  detail        text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'planned'
                CHECK (status IN ('planned','running','paused','done','failed','cancelled')),
  progress      smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  budget        jsonb NOT NULL DEFAULT '{}',   -- {tokens,maxMinutes,maxSteps}
  scheduled_for timestamptz,
  started_at    timestamptz,
  ended_at      timestamptz,
  log_summary   text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_activities_status ON littly_activities(person_id, status, scheduled_for);

CREATE TABLE littly_activity_logs (
  id          text PRIMARY KEY,
  activity_id text NOT NULL REFERENCES littly_activities(id) ON DELETE CASCADE,
  seq         integer NOT NULL,
  at          timestamptz NOT NULL,
  kind        text NOT NULL,          -- plan|tool|step|result|error|interrupt|resume
  detail      jsonb NOT NULL DEFAULT '{}',
  ok          boolean
);

CREATE TABLE littly_artifacts (
  id          text PRIMARY KEY,
  activity_id text REFERENCES littly_activities(id) ON DELETE SET NULL,
  person_id   text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  kind        text NOT NULL,          -- file|doc|note|image|post|project
  title       text NOT NULL DEFAULT '',
  path        text NOT NULL,          -- 相对 workspace 根
  mime        text NOT NULL DEFAULT '',
  bytes       bigint,
  meta        jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

### 2.5 未完结的线

```sql
CREATE TABLE littly_threads (
  id          text PRIMARY KEY,
  person_id   text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  title       text NOT NULL,
  kind        text NOT NULL DEFAULT 'idea' CHECK (kind IN ('commitment','conflict','project','idea','story')),
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','waiting','resolved','abandoned')),
  people_ids  jsonb NOT NULL DEFAULT '[]',   -- littly_people.id
  summary     text NOT NULL DEFAULT '',
  next_step   text NOT NULL DEFAULT '',
  due_at      timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
```

### 2.6 人物（她对人的认知）

```sql
CREATE TABLE littly_people (
  id           text PRIMARY KEY,                 -- 稳定人物 id（内部）
  person_id    text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  aliases      jsonb NOT NULL DEFAULT '[]',
  relationship text NOT NULL DEFAULT 'acquaintance'
               CHECK (relationship IN ('owner','friend','close_friend','acquaintance','stranger','blocked')),
  tier         text NOT NULL DEFAULT 'stranger'
               CHECK (tier IN ('stranger','acquaintance','friend','intimate','blocked')),
  closeness    smallint NOT NULL DEFAULT 30 CHECK (closeness BETWEEN 0 AND 100),
  important    boolean NOT NULL DEFAULT false,   -- 手动 pin/重要
  brief        text NOT NULL DEFAULT '',         -- 一句话印象（泛泛之交；不进独立卡）
  card_path    text NOT NULL DEFAULT '',         -- people/<id>.md；空 = 无独立人物卡
  interaction_count integer NOT NULL DEFAULT 0,
  last_interaction_at timestamptz,
  boundaries   text NOT NULL DEFAULT '',         -- 她与 TA 的边界（friend/intimate）
  notes        text NOT NULL DEFAULT '',         -- 完整理解（仅 friend/intimate/important）
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_people_person ON littly_people(person_id, important, closeness);
CREATE INDEX ix_people_tier ON littly_people(person_id, tier, last_interaction_at DESC);

-- 渠道身份映射：外部账号 ↔ 她认识的人
CREATE TABLE littly_channel_identities (
  id          text PRIMARY KEY,
  person_id   text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  people_id   text NOT NULL REFERENCES littly_people(id) ON DELETE CASCADE,
  channel     text NOT NULL,            -- web|snowluma|telegram|...
  external_id text NOT NULL,            -- QQ 号/OpenID 等
  display_name text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, external_id)
);
```

### 2.7 渠道账号（单实例单账号）

```sql
CREATE TABLE littly_channel_accounts (
  id            text PRIMARY KEY,
  person_id     text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  channel       text NOT NULL,           -- snowluma|web|telegram|...
  account_ref   text NOT NULL DEFAULT '',-- QQ号/自建标识
  enabled       boolean NOT NULL DEFAULT false,
  config        jsonb NOT NULL DEFAULT '{}',  -- 非机密配置（wsUrl 等）
  secret_ref    text NOT NULL DEFAULT '',     -- 指向密钥存储（不存明文）
  status        text NOT NULL DEFAULT 'disconnected', -- starting|waiting_scan|connected|disconnected|error
  last_error    text NOT NULL DEFAULT '',
  last_event_at timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel)                       -- 每渠道只能有一个账号（单账号归属）
);
```

### 2.8 记忆（Postgres 索引；Markdown 是真相）

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE littly_memories (
  id               text PRIMARY KEY,
  person_id        text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  domain           text NOT NULL,       -- life|feelings|thoughts|plans|knowledge|routines
  kind             text NOT NULL,       -- episodic|semantic|social|reflection
  title            text NOT NULL DEFAULT '',
  body             text NOT NULL,       -- 索引用正文（真相在 vault）
  event_time       timestamptz NOT NULL,
  record_time      timestamptz NOT NULL DEFAULT now(),
  importance       smallint NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  visibility       text NOT NULL DEFAULT 'public'
                   CHECK (visibility IN ('public','relationship','private')),
  visibility_people_id text REFERENCES littly_people(id) ON DELETE SET NULL, -- relationship 时指向某人
  emotion          text NOT NULL DEFAULT '',
  people_ids       jsonb NOT NULL DEFAULT '[]',
  thread_id        text REFERENCES littly_threads(id) ON DELETE SET NULL,
  artifact_id      text REFERENCES littly_artifacts(id) ON DELETE SET NULL,
  source           text NOT NULL DEFAULT 'conversation', -- conversation|workspace|diary|dream|post
  vault_path       text NOT NULL,
  line_no          integer,
  embedding        vector(1536),        -- 维度按 embedding 模型；可空
  tsv              tsvector,
  deleted_at       timestamptz,         -- 墓碑
  superseded_by    text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_mem_person_time ON littly_memories(person_id, event_time DESC);
CREATE INDEX ix_mem_person_domain ON littly_memories(person_id, domain);
CREATE INDEX ix_mem_visibility ON littly_memories(person_id, visibility, visibility_people_id);
CREATE INDEX ix_mem_tsv ON littly_memories USING gin(tsv);
CREATE INDEX ix_mem_embedding ON littly_memories USING hnsw (embedding vector_cosine_ops);

CREATE TABLE littly_memory_staging (
  id         text PRIMARY KEY,
  person_id  text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  raw        text NOT NULL,
  source     text NOT NULL DEFAULT 'conversation',
  candidate  jsonb NOT NULL DEFAULT '{}',
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ingested','duplicate','dropped')),
  created_at timestamptz NOT NULL DEFAULT now()
);
```

### 2.9 日记 / 睡眠整理

```sql
CREATE TABLE littly_diaries (
  id         text PRIMARY KEY,
  person_id  text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  day        date NOT NULL,
  content    text NOT NULL DEFAULT '',
  mood       text NOT NULL DEFAULT '',
  summary    text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (person_id, day)
);

CREATE TABLE littly_dream_reports (
  id          text PRIMARY KEY,
  person_id   text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  started_at  timestamptz NOT NULL,
  ended_at    timestamptz,
  status      text NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','failed')),
  stats       jsonb NOT NULL DEFAULT '{}',   -- extracted/updated/merged/tokens
  report_path text NOT NULL DEFAULT ''
);
```

### 2.10 回复决策 / 注意力 / 预算 / 健康

```sql
CREATE TABLE littly_reply_decisions (
  id            text PRIMARY KEY,
  person_id     text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  people_id     text REFERENCES littly_people(id) ON DELETE SET NULL,
  inbound_ref   text NOT NULL DEFAULT '',   -- 入站消息/事件 id
  channel       text NOT NULL DEFAULT '',
  received_at   timestamptz NOT NULL,
  factors       jsonb NOT NULL DEFAULT '{}',-- traits/relationship/state/content/scores
  action        text NOT NULL CHECK (action IN ('immediate','short','later','no_reply','explain_later','defer')),
  reason        text NOT NULL DEFAULT '',
  decided_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,
  outcome       text NOT NULL DEFAULT ''
);

CREATE TABLE littly_attention_events (
  id          text PRIMARY KEY,
  person_id   text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  at          timestamptz NOT NULL,
  kind        text NOT NULL,      -- message|activity_start|activity_end|interrupt|sleep|wake
  people_id   text REFERENCES littly_people(id) ON DELETE SET NULL,
  activity_id text REFERENCES littly_activities(id) ON DELETE SET NULL,
  detail      jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE littly_budgets (
  id          text PRIMARY KEY,
  person_id   text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  scope       text NOT NULL,       -- activity_kind|proactive|social|daily
  period      text NOT NULL DEFAULT 'day',
  limit_value bigint NOT NULL DEFAULT 0,
  used_value  bigint NOT NULL DEFAULT 0,
  reset_at    timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (person_id, scope, period)
);

CREATE TABLE littly_model_health (
  provider    text NOT NULL,
  model       text NOT NULL,
  purpose     text NOT NULL,       -- chat|growth|vision|embedding|tts|decision|dream
  status      text NOT NULL DEFAULT 'unknown' CHECK (status IN ('ok','error','unknown')),
  last_error  text NOT NULL DEFAULT '',
  latency_ms  integer,
  checked_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, model, purpose)
);
```

### 2.11 统一配置

```sql
CREATE TABLE littly_config (
  id         integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  version    integer NOT NULL DEFAULT 1,
  data       jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- 启动时：文件 conf/littly.yaml（基础） + DB 覆盖；schema 校验；失败拒绝启动。
```

### 2.12 审计

```sql
CREATE TABLE littly_audit (
  id         text PRIMARY KEY,
  person_id  text,
  at         timestamptz NOT NULL DEFAULT now(),
  category   text NOT NULL,      -- config|channel|model|approval|activity|social|memory|security
  action     text NOT NULL,
  detail     jsonb NOT NULL DEFAULT '{}'
);
```

## 3. 与上游 Memoh 表的关系

| 用途 | 上游 | 我们 |
|---|---|---|
| 她本人 | `bots` | 单行沿用；扩展 `littly_persona` |
| 会话/消息 | `sessions`/`messages`（上游 agent/chat） | 沿用；给 person/session 加 `people_id` 映射（若缺） |
| 工作区 | workspace/bridge 表 | 沿用；**每实例一个 workspace** 绑定 person |
| 渠道 | 上游 channel 配置/账号 | 用 `littly_channel_accounts` 做唯一归属；适配器读它 |
| 审批 | 上游 approval 表 | 沿用，绑定 person/activity |
| 定时 | 上游 schedule | 生活引擎写 schedule 或自有 tick；二选一（见 04） |
| 记忆 | 上游 memory provider | **不用**；`littly_memories` + vault 接管 |
| 技能 | 上游 skills | 沿用（作为她的可学习技能） |

## 3.5 API 路由约定（与 02/10 一致）

- 浏览器统一 `/api/*`；nginx 去掉 `/api` 前缀后转给 Go，因此 **Go 路由注册不带 `/api`**（如 `e.Group("/today")`、`/her/persona`、`/memories`、`/world/channels`、`/config`）。
- 上游 Memoh 端点保持原路径（`/bots/:id/container/fs|terminal|display|snapshots`、`/bots/:id/sessions|messages`、`/auth/login`），前端不暴露 `bot_id/person_id` 概念。
- 健康：Go `/health`（公开精简）、`/health/checks`（JWT 详细）；前端分别 `/api/health`、`/api/health/checks`。
- "她主动展示"= 消息引用 artifact，不是新表/新枚举；`private` 记忆按 id 查询返回 404（不泄露存在性）。

## 4. Vault 文件格式（Markdown 真相）

```
data/vault/
  SELF.md
  people/<people_id>.md
  domains/
    life/<mem_id>.md
    feelings/<mem_id>.md
    thoughts/<mem_id>.md
    plans/<mem_id>.md
    knowledge/<mem_id>.md
    routines/<mem_id>.md
  threads/<thread_id>.md
  diary/YYYY-MM-DD.md
  _staging/<id>.md
  _history/<mem_id>.md      # 墓碑
```

条目文件：

```markdown
---
id: mem_01J...
domain: life
kind: episodic
title: 今天整理完相册
event_time: 2026-11-07T15:20:00+08:00
record_time: 2026-11-07T15:22:10+08:00
importance: 3
visibility: public
emotion: 平静
people: [p_...]
thread_id: null
artifact_id: a_...
source: workspace
---
正文（第一人称或她自己的观察；不要写别人的私密细节到 public）
```

规则：
- 同一 id 重复写：内容相同幂等；内容不同拒绝（需走编辑流程）。
- 原子写（临时文件 + rename）；路径穿越拒绝。
- 删除 = 写 `_history` 墓碑 + DB `deleted_at`。
- PG 索引可由 vault 全量重建（`littly_memories` 清空后重建；embedding 可重新生成）。

## 5. 索引与检索

- 词法：`tsv`（simple + pg_trgm 支持中文子串）；向量：`embedding`（pgvector HNSW，余弦）。
- 检索时按 `visibility` 过滤：`public` 恒可用；`relationship` 仅当 `visibility_people_id = 当前对话人`；`private` 永不进入对话检索。
- 重排：`0.55*相关度 + 0.25*(importance/5) + 0.20*recency(event_time, domain 半衰期)`。

## 6. 初始化/种子

- 首次启动：从 `conf/littly.yaml` 的 `person` 段创建唯一的她；写入初始 traits、SELF.md（模板）、`littly_config`。
- 示例数据（dev）：`scripts/seed-dev.sh` 生成 2 个 people、3 条 interests、若干 memories，便于本地验收。

## 7. 备份与旧数据

- 备份脚本导出：`pg_dump` + `data/vault/` + `conf/`（密钥除外）+ `data/workspace`（可选）+ SnowLuma 数据目录（QQ 登录态）。
- 旧项目 DB/memory 仅归档到 `data/archive/`，v2 不读；见 [14-ARCHIVE-MIGRATION.md](14-ARCHIVE-MIGRATION.md)。

## 8. 未来扩展预留

- `littly_people` 可增加 `traits`（她对某人的印象维度）与 `relationship_history`。
- `littly_memories.embedding` 维度随 provider 变化时，用 `littly_config.memory.embedding.model/dim` 记录并支持重建。

## 9. 实现期扩展（已并入基准；实现按此建表）

> 来源：04/06/07/08 的实现规格在写作中发现 03 初版缺少运行时必需的结构。以下**已采纳为 v1.1 基准**；其它“扩展建议”未采纳的仍留在各文档中标注。

```sql
-- 06 §5.11：later / explain_later / 主动消息的统一持久队列
CREATE TABLE littly_outbox (
  id              text PRIMARY KEY,
  person_id       text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('reply','proactive','explain')),
  channel         text NOT NULL,
  people_id       text REFERENCES littly_people(id) ON DELETE SET NULL,
  conversation_ref text NOT NULL DEFAULT '',
  decision_id     text REFERENCES littly_reply_decisions(id) ON DELETE SET NULL,
  due_at          timestamptz NOT NULL,
  expires_at      timestamptz,
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','queued','sending','sent','failed','unknown','cancelled','expired')),
  payload         jsonb NOT NULL DEFAULT '{}',
  ref_type        text NOT NULL DEFAULT '',   -- artifact|thread|memory|event|message
  ref_id          text NOT NULL DEFAULT '',
  attempts        smallint NOT NULL DEFAULT 0,
  last_error      text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_outbox_due ON littly_outbox(person_id, status, due_at);

-- 08 §1.5：渠道会话与入站事件（去重/路由/状态）
CREATE TABLE littly_channel_conversations (
  id               text PRIMARY KEY,
  person_id        text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  channel          text NOT NULL,
  account_ref      text NOT NULL,
  conversation_key text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('private','group')),
  people_id        text REFERENCES littly_people(id) ON DELETE SET NULL,
  group_id         text NOT NULL DEFAULT '',
  title            text NOT NULL DEFAULT '',
  last_inbound_at  timestamptz,
  last_outbound_at timestamptz,
  UNIQUE (channel, account_ref, conversation_key)
);

CREATE TABLE littly_channel_events (
  id                  text PRIMARY KEY,
  person_id           text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  channel             text NOT NULL,
  account_ref         text NOT NULL,
  external_message_id text NOT NULL,
  conversation_id     text NOT NULL REFERENCES littly_channel_conversations(id) ON DELETE CASCADE,
  sender_external_id  text NOT NULL,
  people_id           text REFERENCES littly_people(id) ON DELETE SET NULL,
  kind                text NOT NULL CHECK (kind IN ('private','group')),
  status              text NOT NULL DEFAULT 'accepted'
                      CHECK (status IN ('accepted','ignored','handled','no_reply','failed')),
  received_at         timestamptz NOT NULL,
  ingested_at         timestamptz NOT NULL DEFAULT now(),
  raw_digest          text NOT NULL DEFAULT '',
  UNIQUE (channel, account_ref, external_message_id)
);
CREATE INDEX ix_chevents_conversation ON littly_channel_events(conversation_id, received_at DESC);

-- 04 §9.4：活动断点/线程关联；日志防重
ALTER TABLE littly_activities
  ADD COLUMN thread_id text REFERENCES littly_threads(id) ON DELETE SET NULL,
  ADD COLUMN resume_state jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN attempt smallint NOT NULL DEFAULT 0;
ALTER TABLE littly_activity_logs ADD CONSTRAINT uq_activity_seq UNIQUE (activity_id, seq);
ALTER TABLE littly_state ADD COLUMN carry jsonb NOT NULL DEFAULT '{}';   -- 64 §9.4 小数残差

-- 06 §5.11：回复决策调度字段
ALTER TABLE littly_reply_decisions
  ADD COLUMN due_at timestamptz,
  ADD COLUMN conversation_ref text NOT NULL DEFAULT '',
  ADD COLUMN decided_by text NOT NULL DEFAULT 'rules';  -- rules|llm|guardrail|fallback

-- 08 §1.5：人物合并墓碑
ALTER TABLE littly_people ADD COLUMN merged_into text REFERENCES littly_people(id);
```

```sql
-- 07/12：工作区快照（她的电脑回滚点）
CREATE TABLE littly_workspace_snapshots (
  id          text PRIMARY KEY,
  person_id   text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  name        text NOT NULL DEFAULT '',
  backend     text NOT NULL DEFAULT '',       -- docker|containerd|apple|local
  external_ref text NOT NULL DEFAULT '',      -- 上游快照 id / 目录
  size_bytes  bigint,
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

```sql
-- 16 §4：心跳（自心跳 reason 必填；保底心跳由进程定时器管理，不落此表）
CREATE TABLE littly_heartbeats (
  id             text PRIMARY KEY,
  person_id      text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  kind           text NOT NULL DEFAULT 'self' CHECK (kind IN ('self','manual')),
  due_at         timestamptz NOT NULL,
  reason         text NOT NULL,
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','fired','cancelled','superseded','missed','expired')),
  noop_count     smallint NOT NULL DEFAULT 0,
  lifetime_until timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  fired_at       timestamptz,
  meta           jsonb NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX uq_heartbeat_pending_self ON littly_heartbeats(person_id)
  WHERE kind='self' AND status='pending';
CREATE INDEX ix_heartbeat_due ON littly_heartbeats(person_id, status, due_at);

CREATE TABLE littly_heartbeat_runs (
  id            text PRIMARY KEY,
  person_id     text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  heartbeat_id  text REFERENCES littly_heartbeats(id) ON DELETE SET NULL,
  kind          text NOT NULL,
  started_at    timestamptz NOT NULL,
  ended_at      timestamptz,
  outcome       text NOT NULL DEFAULT '',
  notify        boolean,
  summary       text NOT NULL DEFAULT '',
  model_turns   smallint NOT NULL DEFAULT 0,
  next_due_at   timestamptz,
  next_reason   text NOT NULL DEFAULT '',
  error         text NOT NULL DEFAULT ''
);
CREATE INDEX ix_heartbeat_runs ON littly_heartbeat_runs(person_id, started_at DESC);
```

未采纳（仍为各文档“扩展建议”）：`littly_hashtags` 等；实现时如需要，先回写本节再写迁移。
