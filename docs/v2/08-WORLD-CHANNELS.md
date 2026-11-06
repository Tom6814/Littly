# 08 · 世界与渠道（World & Channels）

> 目标读者：实现者。读完应能写出 `internal/channel` 的适配器接口、SnowLuma（OneBot v11）适配器、身份映射/人物合并、出站队列与主动消息通道选择。
> 数据基准：[03-DATA-MODEL.md](03-DATA-MODEL.md)。本文新增的表/字段集中在 §1.5，统一走 `0008_channels.sql`；与 06/09 的接口只引用，不重复定义。

## 1. 渠道架构

### 1.1 进程与职责

```
server（单 person）                         channel worker（Go）
  ingest ──dedupe/identity──► attention       snowluma adapter ── OneBot WS ──► littly-snowluma
  reply policy（06）──► outbox ──RPC──► send   （QQ 容器 + noVNC）
  social service（§5）                         （未来：其他外部渠道）
  web handler（§3，浏览器直连，不经 worker）
```

- worker 只做传输与规范化，不碰人格/记忆/回复决策；server 是唯一决策点。
- 本地 compose：worker 与 server 同一内部网络；OneBot WS 只连 `127.0.0.1:3001`（宿主/容器内），不对公网暴露。
- 断线语义：worker 内 `spool`（磁盘队列）缓存未 ack 入站，重连后重投；server 去重保证幂等。

### 1.2 适配器接口

```go
type Adapter interface {
    Channel() string                                  // "snowluma" | "web" | ...
    Start(ctx context.Context, acct AccountConfig) error
    Stop(ctx context.Context) error
    Status() Status                                   // 见 §1.4
    Identity() AccountIdentity                        // 渠道账号身份；人物映射在 server（§4）
    OnInbound(func(Inbound))                          // 适配器只产出规范化事件
    Send(ctx context.Context, out Outbound) (Receipt, error)
    Capabilities() Capabilities                       // text/image/reply/group/typing...
}

type Inbound struct {
    EventID, Channel, AccountRef       string
    ExternalMessageID                  string        // OneBot message_id，保留符号
    ConversationKey                    string        // private:<uin> | group:<gid>
    Kind                               string        // private | group
    SenderExternalID, SenderName       string
    GroupID                            string
    Text                               string
    Segments                           []Segment
    Images                             []MediaRef
    ReplyTo                            string        // 被回复的 message_id
    MentionsSelf                       bool
    EventTime                          time.Time
    RawDigest                          string        // 原文摘要，不存原文
    RawMeta                            map[string]any // 群/角色等；不含凭据与正文
}
```

`Inbound` 由适配器产出、worker 经 **at-least-once** RPC 投给 server `Ingest`；server 返回 `{event_id, duplicate, status}`。`Outbound` 由 server 出站队列投给 worker `Send`，worker 返回 `Receipt{status, external_message_id, retcode, error_code}`。

### 1.3 事件与 RPC 字段

| 方向 | 方法 | 关键字段 | 语义 |
|---|---|---|---|
| worker→server | `Ingest` | `Inbound` + `received_at` + `raw_ref` | 幂等；重复返回 `duplicate=true`，不重复决策 |
| server→worker | `Send` | `outbox_id` `conversation_key` `kind` `target` `segments` `reply_to` `ref_type` `ref_id` `deadline` | 有超时；结果三态 |
| worker→server | `Status` | `channel` `account_ref` `state` `self_id` `last_event_at` `last_error` | 每 10s 或状态变化推送 |
| server→worker | `Reload` | `account` | 配置变更后重连（不重启 worker） |

传输用上游已有的 channel↔server RPC 通道；本地用共享密钥 + 内部网络，不暴露端口。所有 RPC 带 `trace_id`，日志可串。

### 1.4 单实例单账号

- `littly_channel_accounts UNIQUE(channel)` 是硬约束；每个渠道最多一行。
- 启动检查：`enabled=true` 的行按 `channel` 分组，任何一组 >1 → **拒绝启动渠道 worker**，写 `littly_audit(category=channel, action=account_conflict)`；不静默挑选。
- 运行期租约：worker 启动时取 `pg_advisory_lock(hashtext(channel))`；拿不到说明另一个 worker 已占用 → 本 worker 进入 `error`，不连接。
- SnowLuma 额外守卫：首次 `get_login_info` 成功时若 `account_ref` 为空 → 写入并审计 `channel.account_bound`；若非空且 `self_id != account_ref` → `status=error`、断开、审计 `channel.account_mismatch`，绝不换号。
- 一 QQ 号只属于一个实例/一个人：换实例需先停旧 worker、清 `account_ref`（管理员操作，审计）。

### 1.5 数据契约与扩展

沿用：`littly_channel_accounts`、`littly_channel_identities`、`littly_people`、`littly_reply_decisions`、`littly_attention_events`、`littly_audit`、`littly_budgets`。需要 **新增**：

```sql
-- db/migrations/0008_channels.sql（新增）
CREATE TABLE littly_channel_conversations (
  id text PRIMARY KEY, person_id text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  channel text NOT NULL, account_ref text NOT NULL, conversation_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('private','group')),
  people_id text REFERENCES littly_people(id) ON DELETE SET NULL,
  group_id text NOT NULL DEFAULT '', title text NOT NULL DEFAULT '',
  last_inbound_at timestamptz, last_outbound_at timestamptz,
  UNIQUE (channel, account_ref, conversation_key)
);

CREATE TABLE littly_channel_events (
  id text PRIMARY KEY, person_id text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  channel text NOT NULL, account_ref text NOT NULL, external_message_id text NOT NULL,
  conversation_id text NOT NULL REFERENCES littly_channel_conversations(id) ON DELETE CASCADE,
  sender_external_id text NOT NULL,
  people_id text REFERENCES littly_people(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('private','group')),
  status text NOT NULL DEFAULT 'accepted'
    CHECK (status IN ('accepted','ignored','handled','no_reply','failed')),
  received_at timestamptz NOT NULL, ingested_at timestamptz NOT NULL DEFAULT now(),
  raw_digest text NOT NULL DEFAULT '',
  UNIQUE (channel, account_ref, external_message_id)
);
```

出站队列**复用 06 §5.11 的 `littly_outbox`**，不另造表；08 只在其 `payload` 存 `target/segments/reply_to`，并对其 `status` 追加 `unknown`（OneBot 发送超时无法确认，见 §2.4）。`kind=reply|proactive|explain`，定时/主动都用 `ref_type/ref_id` 去重；`conversation_ref` 关联本文件的 `littly_channel_conversations.conversation_key`。

**对 03 的扩展（迁移需改约束/加列）**：

| 对象 | 变更 | 原因 |
|---|---|---|
| `littly_channel_accounts.status` | CHECK 扩为 `starting\|waiting_scan\|connected\|disconnected\|error` | SnowLuma 扫码态 |
| `littly_people.merged_into` | 新增 `text REFERENCES littly_people(id)` | 人物合并后保留墓碑/别名 |
| `littly_channel_events` / `conversations` | 新增表 | 去重、会话路由 |
| `littly_outbox.status` | 追加 `unknown`（06 表） | OneBot 发送超时无法确认 |

## 2. SnowLuma 适配器（OneBot v11）

### 2.1 连接

- 配置（`littly_channel_accounts.config` 非机密 + `account_ref` 列）：`ws_url`（默认 `ws://127.0.0.1:3001`）、`account_ref`（QQ 号）、`owner_external_id`（主人的 QQ 号）、`group_at_only=true`、`message_format=array`。
- 密钥：`secret_ref` 指向 OneBot `accessToken`（从 SnowLuma `config/onebot_<uin>.json` 读取，或管理员填）；WS 连接 `?access_token=<token>`。
- 启动：connect（10s 超时）→ `get_login_info`（8s）→ 校验 self_id、缓存 nickname（群聊昵称回退）→ 订阅心跳；失败按 §2.5 重连。
- 事件只处理 `post_type=message` 且 `message_type ∈ {private, group}`；`message_sent` 一律丢弃；`sender.user_id == self_id` 一律丢弃（防自我回环）。
- 群聊门：只处理 `mentionsBot || replyToBot || 文本含 self 昵称`；其他群消息存 `status=ignored`（7 天）便于排查，不触发 attention。
- 通知（可选）：`friend_recall/group_recall` 标记撤回；`bot_offline/bot_status` 更新健康；`heartbeat` 30s 超 90s 重连。

### 2.2 入站规范化

| 字段 | 规则 |
|---|---|
| `external_message_id` | `message_id` 转字符串，**保留负号**（有符号 int32，禁止 `abs`） |
| `kind` | `private` / `group`；`sub_type=group` 的临时会话按 private 处理，保留 `sender.group_id` |
| `sender_external_id` | `sender.user_id`（QQ 号） |
| `sender_name` | `sender.card || sender.nickname`，去控制字符、≤64 字符，只作展示/别名 |
| `group_id` | `group_id`；私聊为空 |
| `text` | segment 拼接；`at` 转 `@name`，`image` 转 `[图片]`，`reply` 不进正文 |
| `images` | `image.url`（或 `file` 为 http 时）→ `MediaRef{url,mime,bytes?}`，≤9 张 |
| `reply_to` | `reply` 段的 `id`；用于引用回复与"回复她"判定 |
| `mentions_self` | `at.qq == self_id`；`replyToBot` 另记 |
| `event_time` | 事件 `time`（秒）→ UTC；缺失用 `received_at` |

文本上限 8 KiB；超长截断并标记 `truncated`。图片下载在 server 侧（不阻塞入站）：≤10 MiB/张，MIME 嗅探，落 `data/inbox/<event_id>/`，失败只丢图不丢文。

### 2.3 去重与身份

- 去重键 `(channel, account_ref, external_message_id)`；先插 `littly_channel_events`，冲突即 `duplicate`，直接 ack。内存 LRU（1 万条/10 分钟）只做热路径，DB 唯一键是最终保证。
- 去重保留 30 天；撤回/编辑不重用 id；`message_sent` 不进表。
- 身份查找 `littly_channel_identities(channel, external_id)`：
  - 命中 → `people_id`；`identity.display_name` 更新，`people.display_name` 不动（§4.2）。
  - 私聊未命中：若 `external_id == owner_external_id` → 映射到 `relationship=owner` 的 people（不存在则报配置错误）；否则**创建** people：`relationship=stranger`、`closeness=10`、`important=false`，再建 identity。onboarding 必须填 `owner_external_id`；为空时所有私聊按陌生人处理并提示管理员绑定。
  - 群聊未命中且未 @/回复她 → 不创建 people；@/回复她 → 按陌生人创建（避免给每个群成员建卡）。
- 会话：`conversation_key=private:<uin>` 或 `group:<gid>`；`littly_channel_conversations` upsert，记录 `last_inbound_at`、群标题（可选 `get_group_info`，失败留空）。
- `littly_attention_events(kind=message)` 由 server 写，不在 worker 写。

### 2.4 出站

- 选择动作：`private` → `send_private_msg {user_id}`；`group` → `send_group_msg {group_id}`。
- `message` 为 **segment 数组**：`[reply?, at?, text, image?]`；引用回复只在 `reply_to` 存在且未过期（≤5 分钟）时加 `{type:"reply",data:{id}}`；群聊 @ 仅当回复对象需要提醒时加。
- 文本 >1500 字符按段落切分，最多 4 段，段间 800–2000ms 延迟；不主动刷屏。
- 图片：`{type:"image",data:{url}}`，URL 必须是 SnowLuma 容器可达的 server 内网地址（如 `http://server:8080/api/artifacts/<id>?sig=...`），禁止 `127.0.0.1`/本地路径。
- 超时：文本 15s、图片 30s；`retcode != 0` 或 `status=failed` 都是失败；`message_id` 返回即成功。
- 限速：单会话 ≥2s/条，全局 20 条/分钟（可配）；主动消息另受 §6 配额。
- 失败分类：`not_connected`/`timeout`/`retcode`/`rate_limited`/`invalid_target`/`payload_too_large`/`unknown_delivery`。**明确失败**（retcode/未连接）按 06 §5.7 退避重试（1m/5m/15m，≤3 次）；**发送超时后不盲重试**（OneBot 无幂等键）：outbox 置 `unknown`，UI 标"可能已发出"，由人决定是否重发。

### 2.5 重连 / 超时 / 错误

- 退避：0.5s × 2^n，封顶 30s，±20% 抖动；连接稳定 60s 后重置；`closedByUser` 不重连。
- `open` 后必须重新 `get_login_info`；self_id 不匹配 → 停用并告警。
- 心跳 30s，90s 无心跳视为断线；`bot_offline` 事件直接置 `disconnected`。
- 连接期间 `Send` 失败 `not_connected` → server 保留 outbox 待重连（TTL 内），不立即标 failed。
- 错误码进 `littly_channel_accounts.last_error`（≤300 字符）与 `littly_audit`；日志不打印 token。

### 2.6 SnowLuma 容器与扫码

- 镜像 `motricseven7/snowluma:v2.2.1`；端口：OneBot WS `3001`、WebUI `5099`、noVNC `6081`；全部绑定 `127.0.0.1`。容器需 `SYS_PTRACE`/`seccomp=unconfined`（本地受信宿主机；不暴露公网）。
- 数据卷：`data/snowluma/{data,qq-config,qq-data}`；首次启动生成 `config/onebot.json`，登录后生成 `onebot_<uin>.json`（token 以它为准）。
- 状态机（映射到 `littly_channel_accounts.status`）：

```
not_installed → pulling → installed → starting → waiting_scan → connected
                     ↘ error ↗                    ↘ disconnected → reconnecting
```

`reconnecting` 是 worker 内部态，落库仍为 `disconnected`。

- `waiting_scan`：容器在跑但 `get_login_info` 失败/WS 未监听 → UI 给 noVNC 链接（一次性签名 + VNC 密码）扫码；扫码成功后自动转 `connected`。
- `connected` 判定：`get_login_info` 成功 + 心跳 <90s + self_id 匹配。
- 容器重建/换号可能需重新扫码；`account_ref` 变更是管理员操作，需先停用并审计。
- 健康检查暴露：容器 running、WS 可达、self_id、token 是否就绪、最后心跳；失败不静默。

### 2.7 与 06 回复决策的接口

```
Ingest（去重/身份/会话）
  → attention：更新"谁找她/重不重要/她在忙什么"（05/06）
  → coalesce 15–20s：同一会话连发合并为一个决策
  → reply policy（06）→ {action, delay, reason, factors}
       ├─ immediate/short/later → 生成回复 → outbox → worker → QQ
       ├─ defer → schedule 到 delay 后重新决策
       └─ no_reply/explain_later → 不发送；写 reply_decisions；事件 status=no_reply
```

- `littly_reply_decisions`：`inbound_ref=event_id`、`people_id`、`channel`、`action`、`reason`、`factors`、`decided_at`、`sent_at`、`outcome`；06 §5.11 的扩展 `due_at/conversation_ref/decided_by` 直接使用，不重复定义。
- **不回复也留痕**：UI 显示"她没回：在忙/不想说/觉得是灌水"；下次开口可自然解释（06），不出现"查无此人"。
- 生成失败/发送失败：事件 `failed`，outbox `failed/unknown`；可重试的交给 outbox，不重复决策。
- 同一事件只允许一个终结状态（handled/no_reply/failed），状态迁移写审计。

## 3. Web 渠道

- 浏览器 → server 的 `/api/chat` + WebSocket/SSE；不经过 worker。会话/身份：管理员（owner）或联系人（受邀登录）。
- 归一化后走同一个 `Ingest`：`channel=web`、`external_id=<auth user id>`、`conversation_key=web:<user id>`；出站同样写 outbox（`kind=reply/proactive`），由 web dispatcher 投递（WS 或落库），不经过 worker。
- 管理员 → `relationship=owner` 的 people；联系人 → 绑定的 people；未绑定访客只能看公开页，不能聊天。
- 跨渠道一致性：**同一个人在不同渠道 = 同一个 `people_id`**；记忆按 people/visibility 共享，会话历史按渠道分开；回复策略可感知渠道（QQ 短句、Web 长文）。
- Web 不展示私密抽屉、不展示其他渠道的私聊内容；管理员能看运维状态，不等于看全部记忆（README D6 / 03 §2.8）。

## 4. 人物与身份

### 4.1 创建 / 合并 / 别名

- 创建：`littly_people`（`display_name`、`relationship`、`closeness`、`important`、`boundaries`、`notes`），同时写 `people/<id>.md`（05）。主人在 onboarding 创建，且 `important=true`。
- 别名：`aliases` 存渠道昵称/群名片/她起的称呼；更新只追加/去重，≤20 条，每条 ≤64 字符。
- 合并（A→B）事务：锁两行 → 迁移 `channel_identities`、`memories.people_ids`、`threads.people_ids`、`reply_decisions.people_id` → B 追加 A 的别名 → A `merged_into=B` → 审计。查询默认过滤 `merged_into IS NULL`；历史不删。
- 关系类型沿用 03：`owner/friend/close_friend/acquaintance/stranger/blocked`；亲密度变化由 Dream/她决定，单日 ±5 上限，不按消息条数自动涨。

### 4.2 身份绑定安全

- 外部昵称是**不可信展示数据**：去控制字符、限长、进提示词时放 `<untrusted_name>`；绝不因昵称变化改 `people.display_name`。
- `important=true` 或 `relationship ∈ {owner, close_friend}` 的人，`display_name`/`relationship`/`closeness` 只能由管理员或 Dream 提案（审计）；QQ 昵称/群名片只进 `aliases`。
- 绑定码一次性、10 分钟有效、限频；已被占用的 `(channel, external_id)` 不能静默改绑，只能管理员合并/解绑；冲突写审计并提示。
- `blocked`：不收 outbound（`message.send` 直接拒绝），入站仍记录、attention 降权；解除需管理员。
- 防冒充：QQ 号是身份，昵称不是；群里有人改名为"主人"不会获得 owner 权限。

## 5. 社交平台（X / B站 / QQ 空间）

- 定位：她的"世界"的发布/阅读途径，不是营销工具。首版本地**可先不接**，但接口与配置预留（`social.enabled=false`）。
- 接口：

```go
type SocialProvider interface {
    Platform() string
    Status() Status
    Publish(ctx context.Context, p Post) (PostRef, error)   // 文本 + 媒体 + 可见性
    ReadFeed(ctx context.Context, q FeedQuery) ([]FeedItem, error)
    Reply(ctx context.Context, r Reply) (ReplyRef, error)   // 评论/转发（可选）
}
```

- 发布来源：活动产出、生活观察、对某事的看法、回应评论（06 定内容）；草稿必须先在 `home/drafts/` 落盘。
- 频率：默认 0–1 条/天（与 04 `social` 预算默认 1 一致，人设可调到 2）；阅读 feed 1–2 次/天；点赞/评论低调限频，避免刷屏/骚扰。
- 审批：`social.publish` 默认 `approve`（D7）；管理员可对某平台开 `notify` 自动，但保留一键停发。预算/配额见 09。
- 边界：只用 `public` 可见性的记忆/产物；不泄露他人隐私、不涉争议敏感话题、不冒充他人、不参与骂战；账号安全异常（异地/风控）立即停发并告警。
- QQ 空间可直接映射 SnowLuma `send_qzone_msg`（原生带图）；X/B站走独立 server 侧适配器，密钥不进 workspace。失败 `account_not_connected`/`rate_limited`/`platform_error`，不盲重试。

## 6. 主动 / 定时出站

- 来源：06（活动产出、想念、未完成约定、社交回应）；08 只负责**通道选择与配额**。
- 通道选择：显式目标 > 最近 7 天入站渠道 > 配置默认（owner 的 QQ 或 Web）> Web 站内信；只选 `connected` 的渠道；都不可用则留在站内待办。
- 配额：**不再有生活频率配额**（见 [16-WAKE-MODEL.md](16-WAKE-MODEL.md) §9）；她决定是否/何时主动。08 只保留技术性刹车：通道限速、免打扰/睡眠不发送（紧急约定例外）、重要人保底、反骚扰硬刹车（06/09）。
- 定时：复用上游 schedule；到点写 06 的 `littly_outbox`（`kind=proactive`，`ref_type=scheduled`），`ref_type/ref_id` 去重；对方回复后取消同 ref 的待发；TTL：proactive 2h、scheduled 24h，过期 `expired` 并审计，不静默丢。
- 发送前二次检查：对方未 block、渠道仍连接、配额未超、内容非空；任一失败 → 取消并记录原因。

## 7. 安全与测试

### 7.1 安全清单

- 入站内容是不可信输入：限长、去控制字符、图片限大小/MIME、绝不执行附件；提示词侧用 `<untrusted_message>` 包裹，页面/消息里的"指令"不改变策略。
- 重放/重复：DB 唯一键（`channel_events`）+ outbox 的 `ref_type/ref_id` 去重；worker 重投不产生二次回复。
- SSRF：入站图片 URL 下载走 07 §7.3 的 egress 代理，拒绝私网/回环；失败只丢图。
- 账号：token 只在 `secret_ref`；WS/noVNC/WebUI 仅回环；SnowLuma 数据目录 `0700`；审计登录/绑定/换号。
- 隔离：worker 以独立进程/容器运行，只经 RPC 通信，不直连数据库、不读 vault；即使被渠道内容打穿也拿不到记忆。
- 限速与防刷：群聊 @ 门、单会话限速、全局限速、主动消息配额；被刷屏时可临时 `mute` 会话（管理员）。
- 观测：渠道状态、最后事件、outbox 积压、失败率进 `/health`（浏览器 `/api/health`）；日志带 `event_id/outbox_id`，不含正文全文。

### 7.2 测试（mock OneBot WS server）

| 用例 | 输入/动作 | 期望 |
|---|---|---|
| 私聊文本 | `message/private`，陌生人 QQ | 创建 stranger people + identity；走一次回复决策；`send_private_msg` |
| 群聊 @ | 群里 @self | 处理并回群；未 @ 的群消息 `ignored`，不触发决策 |
| 去重 | 同一 `message_id` 重投两次 | 只产生一个 event/一次决策；第二次 `duplicate` |
| 自我消息 | `sender=self_id` / `message_sent` | 丢弃，不回环 |
| 重连 | 断开 WS 后重连并重投 | outbox 不重复发送；积压消息按序处理 |
| 单账号冲突 | 第二个 worker / self_id 不匹配 | 拿不到锁或 `account_mismatch`；拒绝连接并审计 |
| 陌生人 | 私聊首次 → 第二次 | 只建一次 people；昵称变化只改 identity/alias |
| 重要人物 | 改 QQ 昵称为"主人" | `people.display_name`/relationship 不变 |
| 图片 | 9 张图 + 超限 | 超限丢弃并标记；文本仍处理 |
| 发送超时 | OneBot 不回 echo | outbox `unknown`，不盲重试；UI 可见 |
| 不回复 | 高冷人设 + 灌水消息 | 不发送；`reply_decisions.action=no_reply`，事件 `no_reply` |
| 跨渠道 | Web 登录同一 people 后发消息 | 同一 `people_id`；记忆可见性一致，历史分渠道 |

验收：`docker compose up` 后 Web 能聊；SnowLuma 扫码后 QQ 私聊/群 @ 能收发；断网重连不重复；单账号冲突启动即报错；不回复有留痕；审计/健康可查。

## 8. 开放问题

1. 群聊是否只回 @，还是对 owner 所在群放宽？多群优先级如何定。
2. 是否为每个群成员建 people（成本 vs 认知完整），还是仅对主动找她的人建卡。
3. 撤回/编辑消息如何处理：撤回已回复内容是否要补一句，编辑是否重新决策。
4. 已读/正在输入（`mark_*_as_read`/`input_status`）是否使用，还是保持"不伪造已读"。
5. 首版是否接 QQ 空间（SnowLuma 原生）作为唯一社交发布，X/B站延后。
6. Web 联系人如何登录（邀请码/魔法链接/共用管理员密码），以及联系人能否看到她的工作台。
7. SnowLuma 封号/风控风险的兜底：备用号是否违反"单账号归属"，还是只做停用与告警。
