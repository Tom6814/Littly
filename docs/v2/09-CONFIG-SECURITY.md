# 09 · 配置、模型、健康与安全（实现规格）

> 状态：实现规格 v1.0（2026-11-07）· 配置字段以 [03-DATA-MODEL.md](03-DATA-MODEL.md) 为准；回复/主动参数见 [06-PERSONA-REPLY.md](06-PERSONA-REPLY.md)。
> 原则：**一份 typed config、密钥不进配置、模型不静默失败、渠道单账号、刹车优先于自主**。

## 0. 不变量

- 单实例单 person；单渠道单账号；启动检查不过就拒绝启动（fail fast），不做"先跑起来再说"。
- 密钥只存加密存储/环境变量；配置、日志、工作台、提示词、备份（默认）都不出现明文。
- 每个模型用途都必须可用或显式降级；降级必须审计、健康可见、UI 可见。
- 不可逆/对外动作走刹车或审批；一键停机对她不可绕过；安全/配置/渠道/模型事件写 `littly_audit`，日志脱敏。

## 1. 统一配置

### 1.1 加载顺序与覆盖

```
内置 defaults
  → conf/littly.yaml（基础，人读）
  → 环境变量（仅白名单：DSN、密钥 ref、端口、紧急开关）
  → littly_config.data（DB override，UI 编辑；JSON Merge Patch，null 删除，数组整体替换）
  → schema + 跨字段校验 → 解析 secret_ref → 冻结为运行时 Config
```

- 优先级：DB override > env 白名单 > yaml > defaults。`LITTLY_CONFIG_IGNORE_DB=1` 为 break-glass（只读 yaml，启动时审计）。
- `littly_config.version` 是**配置修订号**（每次 UI 保存 +1），schema 版本在 `data.schema_version`；两者分开。
- UI 保存：先校验 → 写 DB（事务）→ 审计 diff（脱敏）→ 热加载或提示重启；失败不落库、不改运行配置。不可通过 DB override 修改 `schema_version`、`security.trust_mode`、密钥值（只能改 `*_ref`）；`security.brakes` 可改但需 owner 二次确认 + 审计。

| 变更 | 生效方式 |
|---|---|
| `brain.purposes.*`、`life.reply/proactive`、`ui`、`logging` | 预检通过后热加载 |
| `person.*`、`channels.*`、`workspace.*`、`memory.embedding`、`security.*` | 需重启（渠道需重连；embedding 需重建索引） |

### 1.2 校验规则

- 未知键 = 错误（列出 JSON Pointer），不忽略；大小写/拼写错误不得静默。
- 必填：`schema_version`、`person.timezone`、`brain.purposes.chat`、`brain.purposes.decision`、至少一个 `channels.*.enabled=true`、`security.master_key_ref`。
- 范围与枚举：traits 0–100；`buffer_seconds` 5–60；`top_k` 1–50；`dim` 64–8192；`max_batch_messages` 1–20；`important_silence_hours` 1–72；预算/上限 >0；timezone 为 IANA；action/approval/trust/backend/provider kind 限枚举；`quiet_start != quiet_end`（跨夜允许）。
- 跨字段：fallback provider/model 必须存在且不是主模型；`prompt_budget_tokens + max_output_tokens ≤ context_window`；`memory.embedding.dim == brain.purposes.embedding.dim == DB vector 维度`；`per_person_per_day.* ≤ global_per_day`；`via_channel` 必须 enabled；`on_timeout=deny` 时必须配置超时；`backup.encryption=age` 时 `recipient_ref` 必须可解析；失败一次列全，不"修一个报一个"。
- CLI：`littly config validate --file conf/littly.yaml [--with-db]`；启动失败退出码 78（EX_CONFIG），日志写 `config_invalid`（含 pointer，不含值）。
- 密钥扫描：yaml/DB 中**叶子标量键**名匹配 `*api_key*|*token*|*password*|*secret*` 且不以 `_ref` 结尾 → 拒绝；值命中 `sk-…` 等高熵模式 → 警告并要求确认。

### 1.3 完整示例（`conf/littly.yaml`）

```yaml
schema_version: 2
server: { listen: "0.0.0.0:8080", public_url: "http://127.0.0.1:8082" }
database: { dsn_ref: "env:LITTLY_DATABASE_DSN", max_connections: 20 }

person:
  name: "Littly"
  nickname: "她"
  timezone: "Asia/Shanghai"
  birthday: 2001-04-12
  gender: female
  appearance: "黑色短发，宽松卫衣，说话慢半拍。"
  bio: "她住在本地的一台电脑里，有自己的一天；好奇、嘴硬、不太主动服软，但记得你说过的小事。"
  system_prompt_file: "conf/prompts/persona.md"
  rules: ["不聊政治与真实人物隐私", "23:30 后非紧急不主动发消息"]
  style: { language: zh-CN, tone: casual, emoji: low, sentence_length: short, address: { owner: "你", stranger: "您" } }
  traits: { clinginess: 42, social_energy: 55, pride: 60, patience: 50, curiosity: 75, orderliness: 55, possessiveness: 40, expressiveness: 55, independence: 60 }

brain:
  strict_models: true
  providers:
    deepseek: { kind: openai_compatible, base_url: "https://api.deepseek.com/v1", api_key_ref: "env:DEEPSEEK_API_KEY", timeout_ms: 60000, max_retries: 2 }
    siliconflow: { kind: openai_compatible, base_url: "https://api.siliconflow.cn/v1", api_key_ref: "env:SILICONFLOW_API_KEY" }
    openai: { kind: openai_compatible, base_url: "https://api.openai.com/v1", api_key_ref: "env:OPENAI_API_KEY" }
  purposes:
    chat:
      provider: deepseek
      model: deepseek-chat
      context_window: 65536
      max_output_tokens: 2048
      prompt_budget_tokens: 24000
      temperature: 0.85
      supports_tools: true
      fallback: [{ provider: siliconflow, model: "Qwen/Qwen3-32B" }]
    decision: { provider: deepseek, model: deepseek-chat, temperature: 0.2, max_output_tokens: 400, timeout_ms: 8000, json_mode: true, fallback: [{ provider: siliconflow, model: "Qwen/Qwen3-32B" }] }
    growth: { provider: deepseek, model: deepseek-chat, temperature: 0.4, max_output_tokens: 4000 }
    dream: { provider: deepseek, model: deepseek-chat, temperature: 0.5, max_output_tokens: 8000 }
    vision: { enabled: false, provider: siliconflow, model: "Qwen/Qwen3-VL-32B-Instruct" }
    embedding: { provider: openai, model: text-embedding-3-small, dim: 1536 }
    tts: { enabled: false, provider: siliconflow, model: "FunAudioLLM/CosyVoice2-0.5B", voice: "zh_female_01" }

channels:
  web: { enabled: true, account_ref: "local" }
  snowluma:
    enabled: true
    account_ref: "10001"
    connection: { ws_url: "ws://127.0.0.1:3001", access_token_ref: "env:SNOWLUMA_TOKEN", message_format: array, report_self_message: true, reconnect_ms: 5000 }
    send: { min_interval_ms: 800, per_minute: 12, per_hour: 180 }
    private: { allow_stranger_reply: true, stranger_daily_limit: 1 }
    group: { enabled: true, require_at: true, allow_stranger_reply: false, max_replies_per_hour: 10 }

workbench:
  backend: docker
  image: "littly-workspace:2"
  root: "/workspace"
  start_on_demand: true
  idle_timeout_minutes: 20
  limits: { cpu: 2.0, memory_mb: 2048, pids: 512, disk_mb: 10240 }
  network: { mode: proxy, proxy_url: "http://egress-proxy:3128" }
  mounts: []
  command: { mode: allowlist, allow: [bash, sh, python3, node, git, ls, cat, rg, find, curl, pandoc], deny: [sudo, su, docker, mount, nsenter, ssh, scp, nc, socat], timeout_seconds: 60, max_output_bytes: 262144 }
  browser: { enabled: true, headless: true, max_pages: 3, block_private_networks: true, download_max_mb: 100 }

life:
  tick_minutes: 5
  schedule: { wake: "08:30", sleep: "00:30", quiet_start: "23:30", quiet_end: "08:00", weekend_wake: "09:30" }
  state: { energy_decay_per_hour: 2, mood_baseline: 55, mood_regression_per_hour: 1, social_need_gain_per_hour: 3, satiety_decay_per_hour: 4 }
  reply:
    buffer_seconds: [15, 20]
    max_batch_messages: 6
    important_silence_hours: 8
    owner_silence_hours: 3
    max_later_hours: 6
    stranger_policy: one_shot
    group_stranger_policy: ignore
    urgent_score: 80
    urgent_reply_minutes: 10
    max_replies_per_hour: 30
    explanation_ttl_hours: 24
    safety_alert: true
  proactive: { enabled: true, global_per_day: 4, per_person_per_day: { important: 2, friend: 1, stranger: 0 }, min_interval_minutes: 120, quiet: true, max_unanswered: 4, cooldown_after_ignored_hours: 24, ttl_hours: 2, scheduled_ttl_hours: 24, quality_min_chars: 12 }
  activity: { max_concurrent: 1, max_minutes: 90, max_per_day: 8 }
  budgets: { daily_tokens: 800000, daily_activity_minutes: 480, monthly_cost_cny: 200 }

memory:
  retrieval:
    top_k: 12
    rrf_k: 60
    weights: { relevance: 0.55, importance: 0.25, recency: 0.20 }
    half_life_days: { life: 14, feelings: 3, thoughts: 30, plans: 7, knowledge: 90, routines: 45 }
  embedding: { enabled: true, model: text-embedding-3-small, dim: 1536, batch_size: 32, timeout_ms: 10000, on_dim_change: refuse }
  dream: { enabled: true, window: ["02:00", "05:00"], trigger_staging_count: 25, trigger_min_hours: 20, budget_tokens: 40000, budget_minutes: 20, retries: 2 }
  visibility: { default: public, private_web_visible: false }

social:
  platforms:
    qzone: { enabled: true, via_channel: snowluma, max_posts_per_day: 2, min_interval_minutes: 240, approval: required }
    x: { enabled: false }
  feed: { enabled: false, max_items_per_day: 20 }
  comments: { enabled: true, max_replies_per_day: 20, approval: auto }

ui: { locale: zh-CN, theme: auto, show_activity: true, show_reply_reasons: true, panic_button: true }

security:
  trust_mode: local_trusted
  master_key_ref: "env:LITTLY_MASTER_KEY"
  secrets: { backend: encrypted_file, path: "data/secrets.enc" }
  workspace: { path_jail: true, follow_symlinks: false, allow_host_mounts: false, deny_paths: ["/etc", "/proc", "/sys", "/dev", "/root", "/var/run/docker.sock"] }
  network: { default: proxy, egress_allowlist: ["api.deepseek.com", "api.siliconflow.cn", "api.openai.com"], allow_private_networks: false }
  approvals: { external_actions: required, irreversible_actions: required, bulk_outbound_threshold: 10, timeout_minutes: 30, on_timeout: deny }
  brakes: { kill_switch: false, network_enabled: true, outbound_enabled: true, resume_requires_owner: true }
  audit: { retention_days: 365 }
  backup: { enabled: true, dir: "data/backups", schedule: "30 3 * * *", retain: { daily: 7, weekly: 4, monthly: 3 }, encryption: age, recipient_ref: "env:LITTLY_BACKUP_RECIPIENT", include_workspace: false }

logging: { level: info, format: json, file: "data/logs/littly.log", retention_days: 30, redact: [api_key, token, secret, password, authorization, cookie], message_bodies: false, prompts: false }
```

- `memory.embedding.model/dim` 是**索引契约**，必须与 `brain.purposes.embedding` 一致，换模型/维度需显式重建（§3）。`server/database` 若 M0 仍由上游 `config.toml` 管理可暂留，M1 起本文件为唯一入口。04 §9.1 的 `life` 默认值视图按键名映射到本文件：`tick→tick_minutes`、`wake/sleep/quiet→schedule.*`、`decay→state.*`、`activity.daily_cap→activity.max_per_day`、`proactive.daily_limit/min_gap→proactive.global_per_day/min_interval_minutes`、`dream→memory.dream`；`selection/intention/sleep_recovery` 归入 `life.engine` 子段，不另设第二份配置。

### 1.4 schema 版本与迁移

- `schema_version` 为整数；当前 2。低于当前 → 按迁移 registry 顺序内存迁移，写回 DB（先备份 + 审计 `config.migrated`）；高于当前 → 拒绝启动。迁移只做结构变换（改名/搬键/默认值），不做业务决策；每步有 id、from/to、纯函数、测试夹具。
- DB 表结构迁移与 config 迁移分开：先 SQL 后 config，失败不启动；任何迁移前自动备份 `conf/` + `littly_config.data`（不含密钥），保留最近 5 份。

## 2. 密钥

- 引用格式：`env:NAME`、`file:/run/secrets/x`（0600，单行）、`encrypted:data/secrets.enc#key`、`keyring:service/account`（桌面可选）。配置里只出现 `_ref`。
- 存储：`security.secrets.backend=encrypted_file` 时用 AES-256-GCM，主密钥 32 字节（base64）来自 `LITTLY_MASTER_KEY` 或 OS keychain；每条独立 nonce；文件 0600；主密钥不在 DB/备份/仓库。
- UI/API：GET 只返回 `{configured:true, masked:"sk-…9f2c", last4:"9f2c"}`；不提供明文读回；PUT 接受新值或 `rotate:true`；保存后审计 `security.secret_updated`（不含值）。
- 日志：结构化 logger 统一脱敏 `api_key/token/secret/password/authorization/cookie/set-cookie`；`Secret` 类型 `String()` 恒为 `[redacted]`；provider 错误先清洗再落库/展示；默认不记录消息正文与提示词（`logging.message_bodies/prompts=false`）。
- 禁止：yaml/DB 明文、git、工作台环境变量、提示词、错误响应、备份包、README/截图；外发文本/工具结果若出现已知密钥值 → 阻断 + 审计 `security.secret_egress_blocked`。
- 轮换：模型 key 更新 → 预检新 key → 切换 → 审计 → 吊销旧 key；渠道 token 支持 24h 双 token 窗口（旧 token 仍可连、新 token 优先），验证后吊销。轮换失败保留旧值并告警，不中断服务。

## 3. 模型校验

### 3.1 用途与能力

| purpose | 必需 | 能力要求 | 失败策略 |
|---|---|---|---|
| `chat` | 是 | 文本、工具调用、流式（可选） | 启动失败；运行中 fallback，最终失败则 `failed_system` |
| `decision` | 是 | JSON mode、低温度、短输出 | 启动失败；运行中 fallback → 规则降级（06 §5.8） |
| `embedding` | 向量检索开启时是 | 固定维度、批量 | 启动失败；运行中排队重试，检索退化为词法并标记 degraded |
| `growth` | 否 | 长输出、结构化 | 跳过本轮，审计，下月重试 |
| `dream` | 否 | 长输出 | 跳过，保留 staging，下次重试 |
| `vision` | 否 | 图片输入 | 关闭图片理解，标 `[图片]` |
| `tts` | 否 | 音频输出 | 退回文本 |

每个 purpose 可配 `allowed_models` 白名单（为空则只校验 `/models`）；模型必须同时满足能力标志（`supports_tools/json_mode/vision`）。

### 3.2 启动预检（每次启动 + 每次模型配置变更）

1. provider 存在、`kind` 支持、base_url 可达（TLS/超时 10s）；`GET /models` 确认 model 存在，`strict_models=true` 时不在列表 = 失败。
2. 发送 1-token ping（chat/decision/growth/dream）；记录延迟。
3. embedding 发 `"ping"`，校验返回维度 == 配置 == DB vector 维度。
4. 校验 `prompt_budget_tokens + max_output_tokens ≤ context_window`；主模型与 fallback 都必须满足能力标志（`supports_tools/json_mode/vision`）。
5. 写 `littly_model_health(provider,model,purpose,status,latency_ms,last_error)`；必需项失败 → **拒绝启动**（开发可用 `--allow-degraded`，但审计 + UI 红条，不得默认）。

### 3.3 运行失败与 fallback

- 每次调用超时/重试（指数退避，最多 2 次）→ 按 `fallback` 链尝试；每跳都写 `littly_model_health` 与审计 `model.fallback`（from/to/reason，错误脱敏）。
- 熔断：同一 provider/model 5 分钟内 3 次失败 → open 10 分钟，半开探测；期间直接用 fallback。
- 不允许静默换模型：fallback 必须配置；未配置且失败 = 显式错误。
- UI 顶部条：`degraded` 黄条（含用途/模型/最后一次错误/建议），`fail` 红条；设置→健康可看历史。决策模型全挂 → 06 规则降级，`decided_by=fallback`；聊天模型全挂 → 出站失败，不生成假回复；embedding 全挂 → 新记忆先写 `embedding=NULL`，后台重建，检索标 degraded。

## 4. 渠道账号唯一性

- DB：`littly_channel_accounts UNIQUE(channel)`；启动检查 `GROUP BY channel HAVING count(*)>1` 必须为空、每个 enabled 渠道恰一行（web 启动自动建行）、`account_ref` 不得跨渠道复用（web 的 `local` 除外）。配置映射：`connection.access_token_ref → secret_ref`，`account_ref` 原样落库。
- SnowLuma：`account_ref` = QQ uin/self_id；连接后 `get_login_info` 校验 `self_id` 与行一致；每条事件再校验 `self_id`，不匹配 → 断开、`status=error`、审计 `channel.identity_mismatch`、不发消息。
- 防多角色共号复发：一个 QQ 号只能属于一个 person/一个连接；旧的"多 bot 共用 SnowLuma"配置导入时直接拒绝。部署层保证只跑一个 channel worker；若 SnowLuma 侧报连接冲突/心跳争用 → 断开并告警，由 owner 处理（外部实例无法从本进程直接杀死）。
- 改绑：显式 `rebind` 流程（暂停渠道 → 确认短语 → 更新 account_ref/secret_ref → 重连验证 → 审计）；仅改 yaml 不触发静默改绑。渠道健康：`status=connected/disconnected/error`、`last_error`、`last_event_at`；心跳 30s 超时 → 重连；`bot_offline` → error + UI。

## 5. 健康检查

`GET /health`（Go 裸路径；浏览器 `/api/health`）：详细版仅 localhost 或管理员会话；`?probe=1` 只返回 `{status}`（200/503）供 Docker healthcheck；更详细检查 `GET /health/checks`（前端 `/api/health/checks`）。结果缓存 10s，后台每 60s 刷新。

```json
{"status":"degraded","version":"2.0.0","config_version":7,"checked_at":"2026-11-07T12:00:00Z",
 "checks":[
  {"id":"db","status":"ok","latency_ms":3},
  {"id":"migrations","status":"ok","detail":"head=20261107"},
  {"id":"model.chat","status":"ok","detail":"deepseek/deepseek-chat","latency_ms":420},
  {"id":"model.decision","status":"degraded","detail":"fallback=rules"},
  {"id":"channel.snowluma","status":"ok","detail":"uin=10001 connected"},
  {"id":"channel.unique","status":"ok"},
  {"id":"workspace","status":"degraded","detail":"idle; docker ok"},
  {"id":"vault","status":"ok","detail":"writable"},
  {"id":"budget","status":"degraded","detail":"daily tokens 82%"},
  {"id":"disk","status":"ok","detail":"42GB free"},
  {"id":"outbox","status":"ok","detail":"2 queued, 0 failed"}
 ]}
```

- 聚合：任一 critical fail → `fail`（HTTP 503）；任一 degraded → `degraded`（200）；全 ok → `ok`。critical = db/migrations/chat/channel.unique/vault。
- 每项含 `detail`（脱敏）与 `hint`（怎么修）；禁止把密钥/DSN/完整错误堆栈放进响应。
- UI：全局顶栏红/黄条 + 设置→健康页（逐项状态、重新检测、复制诊断）；今天页显示"她没回是因为系统故障还是不想回"。
- 预算/磁盘阈值可配；超 80% degraded、超 95% fail（聊天仍可用但禁止新活动）。

## 6. 安全模型（本地受信宿主机）

- 信任边界：宿主机与 owner 受信；外部内容、网页、转发、模型输出不可信；她"会犯错"但不假设恶意。威胁：提示注入、密钥外泄、误删/越权、刷屏/烧钱、账号共用、Web 暴露。
- **workspace 路径监狱**：所有路径 `Clean` + 拼 root + `EvalSymlinks` 后前缀校验（含分隔符），拒绝 `..`/NUL/绝对路径越界；默认不跟随符号链接；容器非 root、只读 rootfs（`/workspace` 可写）、无 docker socket/宿主敏感挂载、`cap_drop: ALL`、默认 seccomp；文件大小/解压 zip-slip/下载隔离区校验；CPU/内存/pids/磁盘/时长受 `workbench.limits` 与 `life.budgets` 约束。
- **命令**：allowlist 精确二进制 + 参数校验，参数数组执行（尽量不经 shell）；`sudo/su/docker/mount/nsenter/ssh/scp/nc/socat` 永远拒绝；超时杀进程组、输出截断、每条命令审计（hash/exit/耗时，不含密钥）。
- **网络**：默认代理 + 域名 allowlist；浏览器只走该代理，不绕过（要"看世界"由 owner 加域名）；禁止私网/链路本地/云元数据（169.254.169.254）、DNS rebinding 二次校验解析 IP；该策略只约束 workspace/浏览器/工具，server↔SnowLuma 走 loopback 不受限；活动可按需禁网；SnowLuma/OneBot 端口只绑 127.0.0.1。
- **审批与 trust 分级**：

| 档 | 例子 | 默认 |
|---|---|---|
| 内部自由 | 读写 workspace、查资料、跑脚本、整理笔记 | 自动 + 审计，受预算 |
| 外部限速 | 发消息/回帖/评论/点赞、上传、关注 | 限速 + 审计；`external_actions=required` 时逐次审批；首 N 次可自动 |
| 不可逆刹车 | 花钱、改账号/安全设置、批量外发 >10、删数据、装系统包、提权 | 强制审批或直接阻止；超时 = deny；她不能自批 |

> 被动对话回复不逐条审批（owner 已在对话中授权），只受 06 的限速/质量门约束；"外部动作"指主动消息、发帖、上传、批量外发等。审批记录含动作摘要/hash、预览、过期时间、批准人；编辑后旧批准失效、重放拒绝，写上游 approval + `littly_audit(approval)`。

- **一键停机/禁网**：`security.brakes.kill_switch=true`（同时落 `data/BRAKE` 文件，配置/DB 挂了也生效）→ 取消 outbox 排队、停活动、断渠道、禁外部工具、拒绝出站；`network_enabled=false` 只断外网、保留本地 web 聊天；恢复需 owner 二次确认 + 审计。她无权限调用。
- **审计**：`littly_audit(category,action,detail)`，category ∈ config|channel|model|approval|activity|social|memory|security；配置变更、密钥更新、模型 fallback、渠道连接/改绑/冲突、审批、外发、停机、路径越界、命令拒绝、备份/恢复、登录都写；同步写安全事件，异步写活动；只追加，保留 365 天，UI 可筛。
- **日志/提示注入**：结构化 JSON、请求 ID、person/session/activity/decision id；默认不记正文与提示词；外部数据按 06 §4.5 包裹；工作台不注入密钥；外发前扫描已知密钥值并阻断。

## 7. 备份与恢复

| 内容 | 来源 | 必需 | 说明 |
|---|---|---|---|
| 主库 | `pg_dump -Fc` | 是 | 含全部 `littly_*`、会话、审批、config |
| vault | `data/vault/` | 是 | Markdown 真相 + `_history` |
| 配置 | `conf/`（不含密钥） | 是 | 全是 `_ref`，可安全打包 |
| workspace / SnowLuma | `data/workspace/`、`data/snowluma/` | 否 | workspace 体积大，至少备份 artifacts 索引；SnowLuma 含登录凭据必须加密，丢了三方重扫 |
| 密钥 | 不备份 | — | 恢复后重新注入；单独密封备份需另一把密钥，默认不做 |

- 频率：每日 03:30（她睡眠）全量；每周日保留周份；迁移/升级前手动；保留 7 日 + 4 周 + 3 月；同一套脚本在本地与服务器复用。
- 加密：`age`（X25519）或 AES-256-GCM；公钥在配置、私钥离线；上传对象存储前先加密；备份目录 0700；清单 `manifest.json`（sha256、schema/app 版本、git commit、表行数、时间）。
- 恢复：停服务 → 校验 manifest → 新建库 `pg_restore` → 恢复 vault/conf → 跑 SQL 迁移（只向前）→ 启动 → `/api/health` 全绿 → 抽查记忆可见性/渠道登录。RPO 24h、RTO 30min；每季度演练一次。
- 旧项目数据不属于 v2 备份，见 [14-ARCHIVE-MIGRATION.md](14-ARCHIVE-MIGRATION.md)；v2 首版不读旧库。

## 8. 测试与验收

| # | 场景 | 期望 |
|---|---|---|
| C1 | 未知键/拼写错误/缺必填 | 拒绝启动，错误含 JSON Pointer，不落 DB |
| C2 | 越界值（top_k=0、quiet 相等、预算负） | 拒绝启动/保存；一次列全 |
| C3 | chat 模型不在 `/models` | 拒绝启动；`--allow-degraded` 仅开发且审计 |
| C4 | chat 主模型 500、fallback 可用 | fallback 生效；审计 + 健康 degraded + UI 黄条；不静默 |
| C5 | 两次写入同 channel 账号行 / 两个实例同 QQ | 本实例由 DB 唯一约束/启动检查拒绝；外部第二实例由 SnowLuma 冲突检测告警并要求停一个 |
| C6 | SnowLuma `self_id` 与 account_ref 不符 | 断开、status=error、审计、不发消息 |
| C7 | 密钥已配置 | API 只回 masked；日志/配置导出/备份 grep 不到明文 |
| C8 | 密钥轮换失败 | 保留旧值、告警、服务不中断 |
| C9 | DB/模型/渠道/磁盘故障 | `/api/health` fail/degraded；UI 顶栏可见；probe 返回 503 |
| C10 | 路径逃逸 `../../etc/passwd`、危险命令 | 拒绝 + 审计；工作台不越界 |
| C11 | 一键停机 | outbox 取消、渠道断开、外部工具拒绝；她不能恢复；审计 |
| C12 | 备份后清库恢复 | 数据/记忆/config 恢复，健康全绿；重新注入密钥后可启动 |
| C13 | DB override 非法 | 拒绝保存，运行配置不变；审计失败尝试 |

验收：配置非法必须拒启动；无效模型在启动时被阻止；同渠道第二账号被拒；密钥不出现在 API/日志/备份；健康检查失败在 UI 可见且能区分"故障"与"她不想回"。

## 9. 开放问题

1. 是否彻底废弃上游 `config.toml`，还是长期保留"基础设施在 toml、产品在 yaml"的双文件？
2. Docker 容器内无 OS keychain：主密钥只靠环境变量，还是改用 Compose secrets/文件挂载？
3. DB override 的边界：UI 可改 `security.*` 是否过多？是否只允许 brakes/approvals 子集？
4. 外部动作审批在异步渠道（QQ 半夜）如何不阻塞她？是否允许"预授权额度 + 事后审计"？
5. 浏览器全站可达 vs 域名 allowlist：allowlist 更安全但会显著削弱"看世界"，默认值需产品确认；备份上云是否首版就做？
