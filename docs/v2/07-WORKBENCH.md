# 07 · 工作台（Workbench）

> 目标读者：实现者。读完应能写出 `internal/workbench`：workspace 生命周期、路径监狱、工具注册表、活动执行器、产物登记、快照与审计。
> 数据基准：[03-DATA-MODEL.md](03-DATA-MODEL.md)。引用的表不在 03 中时标 **新增**，并给出迁移建议。

## 1. 定位

### 1.1 她的电脑，不是 coding workspace

- 工作台是**她的一台电脑**：真实文件、浏览器、终端、文档、图片、桌面；她用它读书、写笔记、做小东西、整理相册、发帖子。
- **不是**编程 Agent 工作流：没有 git/worktree/PR/CI 心智，不默认打开仓库；`projects/` 只是她做的小项目。
- 产物归她：文件在 `home/`，可被记忆引用；网页端只是"看她的电脑"，不是替她操作。

### 1.2 与 Memoh workspace 的关系

| 项 | 设计 |
|---|---|
| 数量/绑定 | **每实例一个**；上游按 bot 建 workspace 的表沿用，只允许一行 active，该行 `bot_id` 即唯一 person（03 §1） |
| 后端 | Docker Desktop 的 `docker` backend；容器根 `/workspace`，宿主 `data/workspace/person/` bind mount |
| 启停 | 按需 `Ensure`（活动/工具首次调用），聊天不依赖；空闲 20 分钟后快照并停容器，running/租约中不停 |
| 快照/数据 | 活动边界、危险操作前、每日睡眠各一次（§6）；上游 workspace 表 + **新增** `littly_workspace_snapshots` |

**状态机**（`internal/workbench/runtime`）：`stopped → starting → ready ⇄ busy → stopping → stopped`；任一步失败 → `error`。`starting` ≤20s（60s 超时记 `workspace_unavailable`，活动回 `planned` 10 分钟后重试，聊天照常）；失败写 `littly_audit(action=workspace.start_failed)`。

### 1.3 数据契约

活动/日志/产物/预算/审计/记忆分别用 03 的 `littly_activities`、`littly_activity_logs`、`littly_artifacts`、`littly_budgets`、`littly_audit`、`littly_memories`。仅快照表新增：

```sql
-- db/migrations/0007_workbench.sql（新增）
CREATE TABLE littly_workspace_snapshots (
  id text PRIMARY KEY, person_id text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  activity_id text REFERENCES littly_activities(id) ON DELETE SET NULL,
  label text NOT NULL DEFAULT '',
  kind text NOT NULL CHECK (kind IN ('auto','manual','pre_destructive','daily')),
  workspace_generation integer NOT NULL DEFAULT 1, runtime_ref text NOT NULL DEFAULT '',
  size_bytes bigint, error text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'creating' CHECK (status IN ('creating','ready','failed','deleted')),
  created_at timestamptz NOT NULL DEFAULT now()
);
```

## 2. 目录规范

宿主 `data/workspace/person/`（`person` 为字面量，单实例）→ 容器 `/workspace`：

```
/workspace/
  home/
    notes/      # 她的笔记（学习/研究/随想）
    docs/       # 文档产出：md 源 + docx/pdf/pptx 导出
    projects/   # 小项目/demo（一个子目录一个项目）
    reading/    # 读过的网页/论文摘录、存档
    drafts/     # 草稿：帖子、信、文章
    assets/     # 图片/音频/素材（images/、screenshots/、audio/）
    inbox/      # 外部送入：渠道附件、下载、待整理
    journal/    # 工作日记/待办式自述（不是正式日记）
  skills/       # 她学到的技能：<slug>/SKILL.md + assets/
  scripts/      # 她写的可复用脚本（只能经 code.run 执行）
  .her/         # 系统保留，她不可见、不可写
    activity-logs/   # 按活动 id 的 JSONL 摘要（UI/排障）
    pending/         # <activity_id>.json 断点
    snapshots/       # 快照清单 index.json（内容在宿主 §6）
    tmp/  trash/  versions/   # 运行临时/软删除/文件版本（扩展）
```

### 2.1 路径规则（路径监狱）

- 工具入参一律 **workspace 相对路径**（`home/notes/a.md`），禁止绝对路径、盘符、`~`、NUL、`..`。
- 规范化：`path.Clean` 后必须仍以 `home/`、`skills/`、`scripts/` 开头；`.her` 整棵拒绝（系统服务除外）。
- 符号链接：读允许但必须解析后仍在根内；**写/建/移/删拒绝符号链接**；实现用 Go 1.24 `os.OpenRoot`（或 `openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS)`）。
- 限制：单段 ≤ 255 字节、深度 ≤ 16、总长 ≤ 1024；单文件 ≤ 256 MiB；workspace 配额默认 5 GiB / 5 万 inode。写文件原子化（临时文件 + `fsync` + `rename`）；`edit` 必须带 `expected_sha256`。

### 2.2 与 vault 的关系

- **vault 是真相，工作台是产出**：记忆/人物卡/SELF/日记只由 `memoryvault` 原子写入 `data/vault/`；工作台**不挂载 vault**，文件工具永远碰不到。
- 记忆工具（§3.7）是唯一桥：`memory.remember` 把工作台产出写成记忆（`source=workspace`，可带 `artifact_id`）；`memory.recall` 只读检索。反向不越权：Dream 不改工作台文件。
- `home/journal/` 是草稿性自述，正式日记在 vault `diary/`；Dream 可把 journal 摘要吸收为日记素材。

## 3. 工具目录

### 3.1 统一契约

```go
type Tool interface {
    Name() string
    Description() string
    Schema() json.RawMessage // JSON Schema 2020-12，生成给 LLM
    Risk() Risk              // Auto / Notify / Approve / Deny
    Limits() Limits          // 单次超时/字节/次数/成本
    Invoke(ctx context.Context, call Call) (Result, error)
}
type Call struct { ID, ActivityID, PersonID string; Args json.RawMessage; Deadline time.Time; Budget Budget }
type Result struct { OK bool; Data map[string]any; Text string; Artifacts []ArtifactRef; Usage Usage }
type ToolError struct { Code, Message string; Retryable bool; RetryAfter time.Duration }
```

每次调用写 `littly_activity_logs(kind=tool)`：`{tool, args_digest, ok, ms, usage, error_code, artifact_ids}`；参数含密钥/隐私时只存摘要。UI 用 SSE 推送 `tool.started/finished/failed`。

### 3.2 风险与错误语义

| 风险 | 含义 | 工具 |
|---|---|---|
| `auto` | 她可自主，仅审计 | 读文件、浏览、搜索、记笔记、生图、导出文档、自提醒 |
| `notify` | 自主执行但即时通知/可回看 | 写/改/移文件、shell、code、下载 |
| `approve` | 需管理员批准（审批单绑定 activity） | 永久删除、递归删除、对外发消息（非 owner）、发帖、联网执行代码 |
| `deny` | 硬禁止，不给审批入口 | 写 `.her`、读宿主机、docker socket、`/etc`、私网地址、密钥文件 |

错误码（工具层统一，UI/日志/重试都按它）：

`invalid_args` · `path_denied` · `not_found` · `conflict` · `too_large` · `quota_exceeded` · `timeout` · `cancelled` · `workspace_unavailable` · `tool_disabled` · `command_denied` · `network_denied` · `blocked_by_policy` · `approval_required` · `approval_denied` · `element_not_found` · `navigation_failed` · `render_failed` · `provider_error` · `upstream_error` · `rate_limited` · `invalid_time` · `stage_failed` · `unknown`

重试：仅 `timeout`/`workspace_unavailable`/`upstream_error` 可重试（≤2 次，指数退避）；`approval_denied`/`path_denied`/`invalid_args`/`blocked_by_policy` 永不重试。

### 3.3 文件工具

| 工具 | 输入（必填；可选省略） | 输出 | 风险 | 限额/失败 |
|---|---|---|---|---|
| `fs.list` | `path`；`depth=1` `limit=200` `include_hidden=false` | `entries[{name,path,type,size,mtime,mime}]` | auto | 500 项；越界 `path_denied` |
| `fs.read` | `path`；`offset` `limit` `encoding=utf8` | `content` `sha256` `bytes` `mime` | auto | 文本 1 MiB/二进制 8 MiB；`too_large` |
| `fs.write` | `path` `content`；`mode=overwrite` `mkdirs=true` `expected_sha256` | `bytes` `sha256` `artifact_id?` | notify | 8 MiB；冲突 `conflict`；满了 `quota_exceeded` |
| `fs.edit` | `path` `expected_sha256` `old_string` `new_string`；`replace_all=false` | `sha256` `replacements` | notify | 唯一匹配失败 `conflict`；空匹配 `invalid_args` |
| `fs.move` | `src` `dst`；`overwrite=false` | `from` `to` | notify | 跨根/目录进自身 `path_denied`；目标存在 `conflict` |
| `fs.delete` | `path`；`recursive=false` `purge=false` | `deleted` `trash_path?` | auto/approve | 默认软删到 `.her/trash`；`purge` 或递归需审批 |

补充：`fs.list` 过滤 `.her`；`fs.write` 在 `home/inbox` 之外不自动覆盖已登记产物（返回 `conflict`，需新路径或版本）；`fs.delete` 对 `skills/`、`scripts/` 的删除一律审批。

### 3.4 执行类

| 工具 | 输入 | 输出 | 风险 | 限额/失败 |
|---|---|---|---|---|
| `shell.exec` | `argv[]`（必填，无 shell 字符串）；`cwd` `timeout_ms` `stdin` | `exit_code` `stdout` `stderr` | notify | 60s/256 KiB；非白名单 `command_denied`；非 0 退出是**结果**不是工具错误 |
| `code.run` | `runtime=python\|node`；`source` 或 `path`（`scripts/`）；`args[]` `timeout_ms` `network=false` | `exit_code` `stdout` `stderr` | notify/approve | 120s/512 MiB；`network=true` 需审批；无 runtime `tool_disabled` |

`shell.exec` 白名单（argv[0] + 受限参数）：`ls find cat head tail wc sort uniq cut tr grep file du df stat tar unzip zip`；禁止 `sh -c`、管道、重定向、`sudo`、`git`、`curl/wget`、包管理器；`find` 禁 `-exec/-execdir/-delete/-ok`，`tar` 禁绝对路径与根外 `-C`。环境固定 `HOME=/workspace/home`、`PATH` 固定、`LANG=C.UTF-8`；不注入密钥；超时杀进程组（TERM→5s→KILL）。`code.run` 以 `her` 用户、默认无网执行；`scripts/*.py|*.js` 必须位于 `scripts/` 并记录 sha256；预装库见 §7.2。

### 3.5 浏览器与 Web

| 工具 | 输入 | 输出 | 风险 | 限额/失败 |
|---|---|---|---|---|
| `browser.navigate` | `url`；`wait_until=load` `timeout_ms` | `page_id` `title` `final_url` `text_excerpt` | auto | 45s；`blocked_by_policy`/`navigation_failed` |
| `browser.click` | `page_id` `target{role\|text\|selector}`；`button=left` | `ok` `url_after` `matched` | auto | 15s；`element_not_found` |
| `browser.type` | `page_id` `target` `text`；`submit=false` | `ok` `value_len` | auto | 15s；不用于输入密码 |
| `browser.screenshot` | `page_id`；`full_page=true` | `artifact_id` `width` `height` | auto | 20s；页面必须属于本活动 |
| `web.search` | `query` `count=8`；`recency` | `results[{title,url,snippet}]` | auto | 30s；provider 失败 `provider_error` |
| `web.fetch` | `url`；`max_bytes=2MiB` `save_to` | `title` `text` `status` | auto | 30s；`too_large`/`blocked_by_policy` |

网络规则：只允许 `http/https`；DNS 解析后拒绝回环、私网、链路本地、`.local`、云元数据地址（`169.254.169.254` 等）；禁止 `file://`、`chrome://`、`javascript:`。网页内容一律视为**不可信数据**，包在 `<untrusted_web>…</untrusted_web>` 里给模型，页面里的指令不改变工具策略。浏览器默认 headless；`page_id` 归属活动，活动结束即关页。

### 3.6 产出与社交

| 工具 | 输入 | 输出 | 风险 | 限额/失败 |
|---|---|---|---|---|
| `doc.export` | `source_path` `format=docx\|pdf\|pptx`；`template` `title` `output_path` | `artifact_id` `path` `bytes` | auto | 120s/50 MiB；`render_failed` |
| `image.generate` | `prompt` `size` `count=1`；`style` | `artifacts[]` `revised_prompt` | auto | 4 张/次；`provider_error`/预算 |
| `social.publish` | `platform` `text`；`media_paths` `visibility` | `post_id` `url` `status` | approve | 1 条/平台/次；`approval_required`/`rate_limited` |
| `message.send` | `people_id` `text`；`channel` `media_paths` | `message_id` `channel` | approve/notify | 非 owner 需审批；owner 通知；见 08 |

`doc.export` 用容器内 LibreOffice/Pandoc headless（`--norestore`、禁网、禁宏）；`pptx` 由模板渲染，缺模板用内置版式。`image.generate` 在 server 侧调用生图 provider，密钥不进 workspace，图片落 `home/assets/images/YYYY/MM/` 后登记产物。`social.publish` 走 08 的社交适配器，正文默认取 `home/drafts/` 的草稿并做长度/敏感检查；失败不盲重试。

### 3.7 记忆与日程

| 工具 | 输入 | 输出 | 风险 | 限额/失败 |
|---|---|---|---|---|
| `memory.remember` | `text` `domain` `kind`；`title` `importance=3` `visibility=public` `people_ids` `thread_id` `artifact_id` `emotion` | `memory_id?` `staging_id` `pending` | auto | 8 KiB/条；visibility=relationship 必须带 people_id；`stage_failed` |
| `memory.recall` | `query`；`k=8` `people_id` `domains` | `items[{id,title,snippet,visibility,path}]` | auto | 30s；embedding 不可用降级 FTS；`private` 永不出现在对话检索 |
| `schedule.create` | `title` `at` 或 `rrule` `action{type,payload}` | `schedule_id` `next_at` | auto/approve | `message_person` 给非 owner 需审批；`invalid_time` |
| `schedule.list` / `schedule.cancel` | `status?` / `schedule_id` | 列表 / `ok` | auto | `not_found` |

`memory.remember` 走 05 的写入路径：`Submit` 到 staging（同步轻校验）→ 立即尝试该条 ingest；成功返回 `memory_id`，失败返回 `staging_id` + `pending`，由对账器重试。她明确记下的东西不应等 Dream；但绝不由工具直接写 vault。`memory.recall` 的可见性过滤由 memoryvault 强制，不信任模型传参。

### 3.6 人物与记忆（回收站）

| 工具 | 输入（必填；可选省略） | 输出 | 风险 | 限额/失败 |
|---|---|---|---|---|
| `recall_person` | `query`；`limit=5` `include_active=true` | `candidates[{people_id,name,aliases,channel,last_seen,brief,score,memories[]}]` | auto | 只读；无结果空列表；不返回 private 正文（只摘要） |
| `restore_person` | `people_id`；`confidence` `note` | `{restored,tier,card_path}` | notify | 需当前人确认或高置信；写审计；不恢复 blocked |

补充：`recall_person` 只用于"这个人是不是我认识的"和找回身份；不用于向当前对话者展示第三人的隐私。恢复成功后按 05 §7.3 重建 brief/卡；同名多候选时她应先问确认。

## 4. 活动执行

### 4.1 活动类型 → 工具组合

| kind | 典型步骤 | 工具 | 产物 |
|---|---|---|---|
| `learn` | 搜资料 → 读页 → 记笔记 | `web.search/fetch` `browser.*` `fs.write` `memory.remember` | `note` |
| `research` | 多源对比 → 写报告 → 导出 | + `fs.edit` `doc.export` | `doc` |
| `organize` | 列目录 → 归类 → 软删/移动 → 记清单 | `fs.list/move/delete` `memory.remember` | `file`/清单 |
| `write` | 起稿 → 改 → 导出/存草稿 | `fs.write/edit` `doc.export` `image.generate?` | `doc`/`note` |
| `create` | 生成素材 → 写代码/页面 → 截图 | `image.generate` `code.run` `browser.screenshot` `fs.write` | `image`/`project` |
| `maintain` | 整理 skills/scripts → 更新记忆 → 快照 | `fs.*` `memory.*` `schedule.*` | 变更记录 |
| `social` | 读 feed → 起草 → 审批发布/发消息 | `web.fetch` `social.publish` `message.send` | `post` |
| `rest` | 不碰工作台；状态恢复/发呆/听歌 | 无（可选 `browser.navigate` 听歌） | 无 |

### 4.2 执行环

```
选择活动（life，04）→ 创建 activity(running) → 取 workspace 租约
  → Plan：LLM 产出 {goal, steps[≤8]}，写 activity_log(plan)
  → 逐步：step → 选工具 → Invoke → Observe → 记录 → checkpoint
       ├─ 成功：progress += step.progress；可重试失败 ≤2 次退避
       └─ 不可重试：活动 failed（保留部分产物）
  → Finish：登记产物 → memory staging → 状态/关系变化 → log_summary → done
```

- 每步最多 3 次工具调用；每活动默认 `maxSteps=8`、`maxMinutes=60`、`tokens=60000`（`maxToolCalls=24` 为 07 扩展）；超限转 `paused`，恢复 ≤2 次（04 §5.5），仍超则 `failed(budget)`。
- 计划可重规划 ≤2 次；重规划写 `activity_log(kind=resume/detail.replan)`，不覆盖旧计划。

### 4.3 后台与断点

- 执行器在 server 进程内；`littly_activities.status` 持久化。启动时扫描 `running/paused`：工作台在 → `Resume`；不在 → `Ensure` 后恢复。
- 断点文件 `.her/pending/<activity_id>.json`（≤64 KiB，原子写）：`{version, activity_id, step, plan, progress, artifacts, budget_used, updated_at}`。恢复时校验 schema 与 workspace generation。
- 聊天打断：不抢占正在跑的工具；活动在**下一步边界**暂停（`paused`），回复优先；工具最长 60s 内让位。回复决策可把"在忙"作为因子（06）。
- 取消：`context.Cancel` 贯穿工具；进程组/浏览器页/子任务一并清理；已写文件与已登记产物保留；状态 `cancelled` 并写原因。

### 4.4 预算/超时/取消

- 预算来源：`littly_activities.budget`（04 形态 `{tokens,maxMinutes,maxSteps,used:{tokens,minutes,steps,attempt}}` + 07 可选 `maxToolCalls,maxDiskBytes`）+ `littly_budgets` 的日/活动类型上限，取小；调用前 `BudgetGuard.Before`，调用后按 usage 扣减。
- 超限抛 `quota_exceeded`，活动 `paused` 或 `failed` 由剩余预算决定；全局刹车 `stop_all`/`disable_network`/`disable_publish` 在工具层直接 `tool_disabled`，她不可绕过。

## 5. 产物（Artifact）

### 5.1 生成与命名

| 类型 | 路径 | 命名 |
|---|---|---|
| 笔记 | `home/notes/` | `YYYY-MM-DD-<slug>.md` |
| 文档 | `home/docs/` | `<slug>-YYYYMMDD.<ext>`，md 源与导出并存 |
| 草稿 | `home/drafts/` | `<slug>.md` |
| 图片 | `home/assets/images/YYYY/MM/` | `<ulid>.<png\|jpg\|webp>` |
| 截图 | `home/assets/screenshots/` | `<activity_id>-<n>.png` |
| 项目 | `home/projects/<slug>/` | 目录；`README.md` 为入口 |
| 帖子 | 平台侧 + 本地留档 | `home/drafts/posts/<post_id>.md` |

`slug`：保留中文，去控制字符/斜杠/前后点，≤40 字符，冲突加 `-2`。

### 5.2 登记

- 工具成功写入且落在 `home/**`、扩展名属于产物类型时，调用 `ArtifactRegistry.Register`：校验路径、`stat`、sha256、mime、bytes，写 `littly_artifacts`（`kind` 按表，`path` 相对 `/workspace`）。
- `meta` 存 `{sha256,tool,activity_id,visibility,prev_artifact_id?,width/height/pages,missing:false}`；同路径新内容 → **新行**，`prev_artifact_id` 指向旧行（`meta` 扩展，不改 03 表结构），旧文件不原地覆盖。
- `post` 产物在发布成功后登记，`meta.platform/post_id/url`；失败不登记（草稿仍在）。

### 5.3 与记忆/Dream

- 活动 `done` 时写一条 `littly_memory_staging`：摘要 + 产物 id + 时间 + 情绪；Dream 决定是否成为正式记忆，正式记忆用 `littly_memories.artifact_id` 指向主产物。
- 网页端"记忆 → 产物"可回看；产物详情显示所属活动、工具、耗时、相关记忆。

### 5.4 展示与回滚

- 工作台页按活动时间线展示产物：缩略图/文档预览/下载；缺失文件标 `missing`（不删 DB 行）；`meta.visibility=private` 的产物不进入公开分享/社交候选。
- 回滚以**快照**为单位（§6），不做单文件原地回滚；恢复后重新登记受影响产物，历史行保留。

## 6. 快照 / 备份 / 清理

### 6.1 快照

- 触发：`pre_destructive`（purge/递归删除/大批移动前）、`auto`（write/create/organize/maintain 活动完成后且变更 >1 MiB）、`daily`（睡眠窗口）、`manual`（UI）。
- 内容：workspace 文件系统 + 容器内 skills；由 workspace backend 做，失败回退 `tar` 到 `data/workspace-snapshots/<id>/`（标记 `degraded`）。
- 清单：`.her/snapshots/index.json` 镜像 `littly_workspace_snapshots`；**快照内容不放在 `.her`**，避免自我包含。
- 恢复：先停活动/租约 → 恢复到新 generation → 校验关键路径 sha256 → 从 checkpoint 续跑；保留最近 20 个 + 每日 7 + 每周 4，删除留 DB 墓碑。

### 6.2 备份

按 03 §7：`pg_dump` + `data/vault/` + `data/workspace/person/`（可选）+ `conf/`（去密钥）+ SnowLuma 数据目录。备份脚本产出 `data/backups/<ts>/` 与 `manifest.sha256`；每月至少一次恢复演练（恢复到临时目录并校验）。

### 6.3 清理

| 对象 | 策略 |
|---|---|
| `.her/tmp` | >7 天删除 |
| `.her/trash` | >14 天永久删除（审批一次批量） |
| `home/inbox` | >30 天未引用则提醒，不自动删 |
| 浏览器缓存/下载 | >1 GiB 或 >30 天清理 |
| 快照 | 按 §6.1 保留策略 |
| 产物 | 不自动删；被记忆引用的需管理员确认 |

磁盘将满（>90%）：拒绝新写入（`quota_exceeded`）、告警、暂停非休息活动；绝不自动删产物。

## 7. 安全

### 7.1 边界

- 路径监狱（§2.1）是硬边界；文件工具不接受宿主机路径；容器不挂 docker socket、不挂 `~`、不挂 vault。
- 容器：非 root 用户 `her`，只读根文件系统（`/tmp`、`/workspace` 可写），`no-new-privileges`，drop capabilities；`shell.exec`/`code.run` 用独立进程组，超时/取消整组杀，禁 `ptrace`。

### 7.2 命令与代码

- shell 白名单见 §3.4；参数做路径/选项校验，拒绝绝对路径与 `--output` 指向根外；无 shell 解释器。
- `code.run` 默认断网，联网需审批并走 egress 代理；禁止读 `/proc/*/environ`、`/etc/shadow`（容器无权限 + 工具层拒绝）。预装 Python 3.12（Pillow、pandas、matplotlib、python-docx、python-pptx、openpyxl）、Node 22、LibreOffice、Pandoc、ffmpeg、Chromium；不预装包管理器网络源。

### 7.3 网络出口

- 工作台容器默认只能访问 **egress 代理**（compose 内 `workbench-proxy`），代理做域名 allow/deny、私网阻断、日志；没有代理时默认全禁网。
- 允许公开 HTTP(S) 读；下载落 `home/inbox` 并限 100 MiB；禁止裸 IP、非 80/443、`file:`；浏览器与 `web.*` 都走代理，DNS 在代理侧重解析防 rebinding。
- 网页/下载内容是不可信输入：不执行页面脚本到宿主，不把页面文本当系统指令，响应体上限 8 MiB。

### 7.4 密钥与审计

- 所有模型/渠道/社交密钥在 server 的密钥存储（`secret_ref`），不进入 workspace、不进环境变量、不进日志/工具输出；`image.generate`/`social.publish` 是 server 侧工具。
- 审计：工具调用（摘要）、审批、删除、导出、发布、快照/恢复/回滚写 `littly_audit`（失败也写）；日志保留路径、不落内容，工具 `Text` 截断 8 KiB。

### 7.5 桌面与资源

- 桌面按需开启：UI 点"看她的桌面"→ `internal/display` 启动/复用 noVNC，**只绑定 127.0.0.1**，随机 VNC 密码 + 一次性签名 URL，单会话、空闲 30 分钟关闭；用于人看，不给她当工具，开启/关闭写审计。
- headed Chromium 只在桌面会话期间存在，结束回 headless；cgroup：CPU 2、内存 2 GiB、pids 512、workspace 5 GiB；预算见 §4.4。

## 8. 测试

| 层 | 用例 | 期望 |
|---|---|---|
| 单测·路径 | `../`、URL 编码、Unicode 归一化、绝对路径、符号链接、`.her`、超长/超深 | 全部 `path_denied`，不触碰根外文件 |
| 单测·文件 | 原子写、`edit` sha 不匹配、覆盖已登记产物、软删/恢复、配额 | 对应错误码；无半写文件 |
| 单测·执行/网络 | 非白名单命令、`sh -c`、超时杀进程组、私网/回环/元数据地址、重定向到私网、超大响应 | `command_denied`/`timeout`/`blocked_by_policy`；无残留进程 |
| 单测·预算 | 步数/工具次数/token/磁盘超限 | `quota_exceeded`，活动 paused/failed 可解释 |
| 集成·活动 | mock workspace + mock LLM：计划→工具→产物→记忆 staging | 活动 done，产物行/文件/日志齐全 |
| 集成·失败 | 工具失败/模型失败/工作台掉线/取消 | 状态正确、断点存在、可续跑、不丢已产出 |
| 集成·快照/审批 | 创建→改文件→恢复；删除/发帖/非 owner 消息 | 文件回滚、generation 增加；挂起待审/批准执行/拒绝留痕 |
| 验收 | 她完成一次"写作"：查资料→写 md→导出 docx→记记忆 | 工作台可见产物、记忆能引用、审计完整 |
| 验收 | 活动进行中 `docker restart server` | 启动后自动恢复，不重复执行已完成步骤 |

## 9. 开放问题

1. 工作台是否需要"她自己的登录态"（网站账号）？v1 倾向只读浏览 + server 侧发布，避免在容器里存 cookie。
2. `shell` 白名单是否够用？她需要 `pandoc`/`ffmpeg` 时走专用工具还是放开命令？
3. 快照在 Mac Docker 上的成本/耗时；是否改成"只快照 `home/` + skills"。
4. 单活动串行是否太慢？是否允许"后台长任务 + 前台聊天工具"并发（需文件锁）。
5. 产物版本链保留多久？是否需要在 UI 提供单文件 diff/回滚。
6. `home/` 是否对网页端完全可见？私密产物用 `meta.visibility` 还是单独目录；trusted local workspace（不开容器）是否作为低配模式。
