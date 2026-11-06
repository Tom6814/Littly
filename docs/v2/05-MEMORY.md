# 05 · 记忆系统实现规格（Memory Vault）

> 状态：实现规格 v1.0（2026-11-07）· 依据 [03-DATA-MODEL.md](03-DATA-MODEL.md)（**schema 唯一基准**）与 [LIFE-ENGINE.md](LIFE-ENGINE.md) §4、§5.6。
> 目标读者：实现者。读完应能独立实现 `internal/memoryvault/`、检索与 Dream。
> 一句话：**Markdown 是她的自传，Postgres 只是索引；检索是"她想起来"，不是"全库搜索"。**

## 0. 不变量

| # | 不变量 | 落点 |
|---|---|---|
| I1 | 单实例一份 vault；记忆是她的，不是 per-person 库 | 所有 API 带 `person_id` |
| I2 | 文件是真相，索引可全量重建 | 先 Markdown 后 PG；§3.7 |
| I3 | 可见性是硬过滤，不靠模型自觉 | SQL 谓词 + 代码复核，fail-closed |
| I4 | 不覆盖：同 id 内容不同即冲突 | `ErrConflict`；取代走 supersede（§3.5） |
| I5 | `public` 不含他人私密细节；`private` 不进对话检索 | §8 写入 + §5.1 viewer |
| I6 | 不迁移旧数据 | 无 legacy 导入器（14 §4） |

## 1. 服务边界与包结构

`internal/memoryvault/`：`types.go store.go index.go embed.go write.go retrieval.go dream.go people.go privacy.go rebuild.go provider_adapter.go`。

| 文件 | 职责 |
|---|---|
| `types.go` | `Memory/Frontmatter/Candidate/Viewer/Hit/Bundle`、错误、枚举 |
| `store.go` | vault 文件系统：原子写、路径监狱、扫描、墓碑 |
| `index.go` | PG 索引 upsert/软删/supersede/检索 SQL |
| `embed.go` | embedding 包装、批量回填、维度校验 |
| `write.go` | 候选校验 → staging → 去重 → 落盘/索引（状态机） |
| `retrieval.go` | 常驻层 + 相关层 + RRF + 重排 + 上限 |
| `dream.go` | Dream 分步任务（抽取/合并/人物卡/反思/日记/SELF/报告内容），调度归 04 |
| `people.go` | 人物卡渲染/补丁/`notes` 摘要 |
| `privacy.go` | 可见性判定、SQL 谓词、展示授权 |
| `rebuild.go` | 全量扫描 → 索引重建（独立 CLI） |
| `provider_adapter.go` | 适配上游 `internal/memory/adapters.Provider`（薄壳，方法集以上游 v0.13 tag 为准） |

**边界**：`memoryvault` 拥有 vault 文件与 `littly_memories`/`littly_memory_staging`/`littly_diaries` 行（`littly_dream_reports` 行归 04）；traits/状态/兴趣/目标/活动/线程归 `internal/life`（04）；`internal/persona` 只读 SELF 拼提示词；`littly_people` 的关系/亲密度/边界与身份映射归 08，人物卡正文归本包（§7）。

**接口（示例；语义不可改）**

```go
type Store interface { Read(ctx, rel) (Document, error); WriteAtomic(ctx, rel, data, mode) (WriteResult, error); List(ctx, dir) ([]string, error); Scan(ctx, func(EntryView) error) error }
type Index interface { Upsert(ctx, Memory) error; SoftDelete(ctx, id, at) error; Supersede(ctx, oldID, newID) error; Get(ctx, id) (Memory, error); Search(ctx, Query) ([]Hit, error); Count(ctx) (int, error) }
type Writer interface { Stage(ctx, StagingItem) (StageResult, error); Submit(ctx, Candidate) (StageResult, error); Drain(ctx, DrainOpts) (DrainResult, error) }
type Retriever interface { Assemble(ctx, RetrieveRequest) (Bundle, error) }
type DreamTasks interface { // 由 04 的 sleep.Dreamer 按步骤串行调用（04 §7）
    Collect(ctx, DreamKey) (Digest, error)
    Extract(ctx, Digest) (ExtractStats, error)
    Merge(ctx, DreamKey) (MergeStats, error)
    People(ctx, DreamKey) (PeopleStats, error)
    Reflect(ctx, Digest) (ReflectStats, error)
    Diary(ctx, DreamKey) (DiaryStats, error)
    Self(ctx, DreamKey, weekly bool) (SelfStats, error)
    Report(ctx, DreamKey, DreamStats) (ReportFile, error)
}
type Privacy interface { Allow(Memory, Viewer) bool; SQLPredicate(Viewer) (string, []any); Display(ctx, DisplayRequest) (DisplayGrant, error) }
```

`Options` 注入 `Clock`（可快进）、`IDs`（ULID，`mem_`）、`LLM`（可 mock）、`Embedder`、`Tx`、`Audit`、`Logger`、`Cfg`；构造时校验 embedding 维度 == `vector(1536)`，不符拒绝启动。

**接线**：`agent/context` → `Assemble`；`agent/turn` 结束 → `Submit(source=conversation)`；`life/activity` 完成 → `Submit(source=workspace)`；`life/sleep` → `DreamTasks` 分步调用；`handlers` 提供记忆/人物卡/展示 API（编辑走 supersede）。

## 2. 写入路径

### 2.1 来源

| source | 触发 | 默认 domain/kind | 默认 visibility | evidence |
|---|---|---|---|---|
| `conversation` | 一轮对话结束（回不回都写） | life/episodic（情绪→feelings/social） | 涉人私事→`relationship:当前人`，否则 `public` | `session_id`,`message_ids` |
| `workspace` | 活动完成/产出 | life 或 knowledge/episodic | `public`（涉他人→relationship） | `activity_id`,`artifact_id` |
| `diary` | 日记派生 | life/reflection | `private` | `dream_report_id`,`day` |
| `dream` | 反思/抽象认知 | thoughts/reflection | `private`（impersonal 才 public） | `dream_report_id` |
| `post` | 发帖/互动 | life/social | `public` | `post_ref` |

### 2.2 候选（存入 `staging.candidate`，**不新增列**）

键与 03 列同名：`id/domain/kind/title/body/event_time/importance/visibility/visibility_people_id/emotion/people_ids/thread_id/artifact_id/confidence`；运行态：`dedupe_key/evidence/attempts/last_error/stage/merged_from/duplicate_of`。

`Stage(ctx, StagingItem{Source,ActivityID,ArtifactID,Raw})` 是低层入口（04 §5.5 使用），`Submit` 是其带成型候选的便捷封装，两者都只写 staging。

校验失败记 `last_error`、`attempts+1`，3 次后 `dropped`+audit；规则：枚举合法；`event_time ≤ record_time+5m`；`relationship` 必须带存在的 `visibility_people_id`；`private` 不得挂公开 `artifact_id`；body 非空 ≤8000 字符；`confidence<0.4` 直接 drop。

### 2.3 状态机

```
Submit → staging(pending) → 校验 → 去重 → 落 Markdown → 写索引 → ingested
                                  │        │                    │
                                  │        └→ duplicate          └→ pending(stage=index_pending)
                                  └→ dropped（原因入 candidate/audit）
```

`Submit` 只做轻校验 + 插 staging（**不调 LLM、不落盘**，<5ms），保证对话主链路不被拖慢；对话的细抽取在 Dream 或显式 `Extract` 中完成。

### 2.4 幂等与冲突

| 情形 | 行为 |
|---|---|
| 同 id、归一化 body hash 相同 | `AlreadyExists`，不报错、不改 mtime |
| 同 id、内容不同 | `ErrConflict`，走编辑/supersede（§3.5），**禁止覆盖** |
| 异 id、hash 相同 | 标 `duplicate`，不落盘，`duplicate_of=旧id` |
| 异 id、近似 | §2.5 合并/建议 |

### 2.5 去重（按序短路）

1. 精确：`sha256(domain|kind|normalize(body))`；normalize = 去首尾空白、全角转半角、折叠空白、去 Markdown 标记。
2. 近似：同 domain、`|event_time 差| ≤ 7d`、`pg_trgm similarity(title||body) ≥ 0.86` → duplicate；importance 取 max、`people_ids` 并集、记 `merged_from`。
3. 语义：双方有 embedding 且 cosine ≥ 0.92、同 domain → duplicate（仅 Dream 批量做，写入路径不调模型）。
4. 0.75–0.86 → 标 `merge_suggested`，Dream 用 LLM 判断；合并产物为一条新记忆 + supersede 旧条。

### 2.6 失败与补偿

| 失败点 | 现场 | 处理 |
|---|---|---|
| 校验失败 | pending | 退避重试；3 次 drop + audit |
| Markdown 写失败 | 无文件 | 保持 pending；**绝不先写索引** |
| 索引写失败 | 文件已在 | `stage=index_pending`，对账器按 id 补 upsert |
| 崩溃（落盘后/索引前） | 文件在、DB 无或旧 | 同上；扫描 `_staging` 与 pending |
| Dream 中途失败 | 部分已读写 | 04 记 `failed`；staging 不删，重试按 `stats.steps` 跳过已完成 |
| 批量部分失败 | 逐条事务 | 已成功不回滚；报告 `failed_ids` |

**对账器**：每 10 分钟重跑超 2 分钟的 pending；每日 `vault↔index` 差异扫描（id 存在性 + title/body 长度 + event_time）：文件无 DB → upsert；DB 无文件 → 软删 + audit；差异 >5% 告警并停自动修复。

## 3. Vault 读写

### 3.1 目录（严格沿用 03 §4）

`SELF.md`、`people/<people_id>.md`、`domains/<domain>/<mem_id>.md`、`threads/<thread_id>.md`、`diary/YYYY-MM-DD.md`、`_staging/<id>.md`、`_history/<mem_id>.md`；`_staging/` 只在排障模式落 raw 副本（DB 为准），`threads/` 由 04 经本包文档 API 写叙述正文。

**实现期扩展（保留子目录，需回写 03 下一版）**：`_history/SELF/YYYY-MM-DD.md`、`_history/people/<id>/YYYY-MM-DD.md`、`_history/dream/YYYY-MM-DD.md`（`dream_reports.report_path`）。此外根目录不接受任何新路径。

### 3.2 格式

- `visibility` 写三值 + `visibility_people_id`，读取兼容 `relationship:p_…` 并归一化；`people` 为 people_id 数组（>8 截断并 audit）；`thread_id/artifact_id` 为 null 或 id。
- 正文从第 2 个 `---` 后第一行起；`line_no` = 正文首行 1-based 行号。
- UTF-8/LF/结尾单换行；YAML 只允许标量与字符串数组（拒绝嵌套 map/锚点/多文档）。
- 解析失败：不索引、不删除、audit `vault.parse_error`，记忆页标"损坏条目"。

### 3.3 原子写

同目录 `.<name>.tmp-<rand>` → write → fsync → rename → fsync(dir)，0640；绝不原地截断；单文件 ≤1 MiB；内容相同则跳过。

### 3.4 路径监狱

只接受相对路径；`path.Clean` 后拒绝绝对路径/`..`/空段/NUL/盘符/`~`；用 `filepath.Rel(root, abs)` 判定 `..` 前缀（**不用**字符串前缀，防 `/vault-evil`）；父目录 `Lstat` 拒 symlink，读用 `O_NOFOLLOW`；只允许 §3.1 白名单与文件名模式；路径 ≤512 字节。违规统一 `ErrUnsafePath` + audit。

### 3.5 墓碑与取代链

- 删除 = 文件移入 `_history/<id>.md`（追加 `deleted_at/deleted_reason`）+ DB `deleted_at`；检索排除 `deleted_at IS NOT NULL OR superseded_by IS NOT NULL`。
- 编辑/合并 = 新 id 落盘 + 索引 → 旧文件入 `_history` 写 `superseded_by` → DB 置 `superseded_by`；链深 >8 拒绝。
- 物理删除只在 `memoryctl purge`（人工、二次确认、先备份），不进 API。

### 3.6 读取

`Read` 返回 `Document{Kind,Frontmatter,Body,Path,ModTime,Hash}`；SELF 解析为 `SelfDoc{Sections}`（`##` 为 key）。读取软预算 5 MiB/s，超限 `ErrBusy`。

### 3.7 重建

`rebuild.Run`：取 dream 级锁 → 全量 Scan/校验 → 重复 `vault_path` 或解析错误 >1% 则 **fail-closed 中止**并输出清单 → 生成 tsv（`--skip-embed` 时 embedding NULL）→ **单事务** `DELETE … WHERE person_id` + 500/批插入 → 校验行数 → 提交，失败回滚保留旧索引 → audit + `ANALYZE`。重建期间读走旧索引；10k 条 <60s（不含 embedding）。

## 4. PG 索引映射

### 4.1 frontmatter ↔ 列

| frontmatter | 列 | 规则 |
|---|---|---|
| `id/domain/kind/title/emotion/source` | 同名 | 枚举见 03；`domain` 必须等于文件目录 |
| 正文 | `body` | 去 frontmatter，≤8000 |
| `event_time/record_time` | 同名 | `record_time` 缺失取 mtime |
| `importance` | `importance` | 1–5 |
| `visibility`+`visibility_people_id` | 同名 | private 时 people 必须 NULL |
| `people` | `people_ids` | jsonb 数组 |
| `thread_id/artifact_id` | 同名 | 不存在则 NULL（不阻断） |
| 路径 / 正文首行 | `vault_path` / `line_no` | 相对 POSIX 路径 / 1-based |
| 派生 | `tsv` / `embedding` | §4.2 / §4.3 |
| 墓碑 | `deleted_at/superseded_by` | §3.5 |
| 写入 | `created_at` | 首次入库；重建取 `record_time` |

> `display` **不是** DB 可见性枚举（03 CHECK 只有三值），它是展示授权（§8.3）。

### 4.2 tsvector（中文取舍）

- 不用 `zhparser`/`pg_jieba`：要改 PG 镜像与扩展安装，和 Memoh 现成镜像冲突。
- 应用侧分词（`gojieba`/`sego`，纯 Go 优先）：中文按词 + 单字 bigram 兜底，英文/数字留原词；写入 `to_tsvector('simple', seg(title||body))`，权重 `A:title, B:body`。查询用**同一分词器**。
- 检索：分词后取去停用词前 8 个 term，`to_tsquery('simple','a|b|c')`，`ts_rank_cd(tsv,q,32)`。
- 兜底：单字/有效 term ≤1/分词失败 → `ILIKE` 或 `similarity ≥ 0.3`（03 已启用 pg_trgm；**实现期补** `gin ((title||' '||body) gin_trgm_ops)`，不改列，记入 03 下一版）。
- 代价：分词器升级需 `reindex --tsv-only`。

### 4.3 embedding

- `littly_config.memory.embedding={model,dim,batch,timeout_ms}`；**dim 必须 1536**（03 已定 `vector(1536)`），否则启动失败并提示 §9 迁移步骤。
- 输入 `title+"\n\n"+body` 截断 6000 字符，归一化后入库（cosine）。
- 写入不阻塞：落库 `embedding=NULL`，`EmbedPending` 异步补（64/批、4 并发、10s 超时、2 次重试）；失败保持 NULL，检索降级词法，**不算写入失败**。
- 回填：`embedding IS NULL AND deleted_at IS NULL`，按 `record_time` 升序，单次 ≤200 条，每日一次。
- HNSW：`vector_cosine_ops`（m=16, ef_construction=64），查询 `SET LOCAL hnsw.ef_search=80`；全量重建后 `REINDEX`。

## 5. 检索管线

### 5.1 查看者

| Kind | 场景 | 可见 |
|---|---|---|
| `self` | Dream、活动规划、反思 | public + relationship(任意) + private |
| `person:<people_id>` | 与某人对话 | public + 仅指向此人的 relationship |
| `owner_web` | 你在记忆页 | 同 `person:<owner_id>`（**不含 private**） |
| `display` | 她主动展示 | 单条 private/relationship，TTL 内只读 |

> `owner_web ≠ self`：网页看不到 private 是产品规则（D6），服务器文件仍可人工查看。

### 5.2 常驻层（每次对话注入）

SELF 摘要（`我是谁`/`现在的生活`/`我在意什么`，≤400 tok）+ 当前人物卡与 `boundaries`（≤350）+ 近 72h 生活 ≤5 条（≤300）+ 状态旁白（四维/attention/时间地点，≤120）。不注入他人人物卡；SELF 不含他人私密细节（§8.2）。

### 5.3 相关层

查询 = 当前消息 + 近 2 轮 + 当前人 `display_name` + 关系词。词法 top40、向量 top40（embedding 非空时），并集按 id 去重取较优排名。可见性**在 SQL 内**：

```sql
AND deleted_at IS NULL AND superseded_by IS NULL
AND ( :viewer_self OR visibility='public'
   OR (visibility='relationship' AND visibility_people_id=:people_id) )
```

`people_id` 为空（群聊/未知）→ 只 public。群聊不因"群里有 A"解锁关系记忆。

### 5.4 RRF

`rrf(i)=Σ_{list∈{lex,vec}} 1/(60+rank_list(i))`，再除以本批最大值归一为 `rel∈[0,1]`；单路缺失只对存在列表求和。

### 5.5 重排

`score = 0.55·rel + 0.25·(importance/5) + 0.20·recency`；`recency = 0.5^(max(0,age_days)/half_life)`。半衰期：feelings 3d、plans 7d、life 14d、thoughts 30d、routines 45d、knowledge 90d。平手依次比：与当前人相关 → importance 降 → event_time 降 → id 升（确定性）。

### 5.6 上限与输出

≤12 条、≤900 tok；同 domain ≤4、同 people ≤4；正文近重复（>0.9）留一条；至少保留 1 条近期生活；人物卡/边界永不裁。返回 `{id,domain,title,snippet(≤160),event_time,importance,visibility,vault_path,line_no,score,parts:{rel,imp,rec}}`；prompt 渲染为 `- (mem_… · life · 11-05) 标题 — 摘要`，需要时附 `path:line`。

### 5.7 降级

embedding 缺失 → 纯词法；分词器异常 → `ILIKE`/trgm + audit；查询 >800ms → 取消，返回常驻层 + 最近生活；全部失败 → 只返回常驻层，对话继续。

### 5.8 泄漏防线

1. SQL 谓词是唯一权威；2. `ScrubBundle` 逐条复核 `Allow`，不过即丢弃 + `audit(action=visibility_violation)`；3. prompt guard 只作提示，**不算边界**。

## 6. Dream / 睡眠整理

**触发与归属**：04 的 `sleep.Dreamer` 负责触发、幂等（按睡眠日 key）、重试与状态；本包实现 `DreamTasks` 的分步任务，不自己起 goroutine、**不写 `littly_dream_reports` 行**（04 §7 step 12）；手动触发同样走 04 的 `Ensure`。

**锁**：04 持 `life:dream:<person>:<day>` 触发锁；本包分步任务不再加同 key 锁，只对 `Drain`/`rebuild`/`purge` 加 `littly:dream:mem:<person>` 执行锁，防手动与补跑并发；不同 key，不会互锁。

| 04 步骤 | 05 任务 | 输入 → 产出 | 失败 |
|---|---|---|---|
| 1 collect | `Collect`（只读） | 窗口内 messages/logs/artifacts/state_events → `Digest` ≤6000 tok | 返回错误，04 中止 |
| 2 extract | `Extract` | Digest → 候选（13 §7）→ 校验 → staging | 该批 skipped，其余继续 |
| 3 merge | `Merge` | staging + 近 7d 同 domain → duplicate/merged | 留原条，不阻塞 |
| 4 people | `People` | 证据 → 卡片补丁 + `notes` | 单人失败只跳过该人 |
| 5 reflect | `Reflect` | 新记忆 → 3–5 条 `thoughts/reflection`（private） | skipped，不影响 4 |
| 8 diary | `Diary` | Digest → `littly_diaries` + `diary/YYYY-MM-DD.md`（private） | skipped，不阻断 |
| 9 SELF | `Self` | 近 30d reflection → 分节补丁 + 版本文件（04 控制 ≤1 次/周） | 保留旧 SELF |
| 12 report | `Report` | stats → `_history/dream/YYYY-MM-DD.md` 正文 | 仅 audit；04 仍写行 |

6 interests、7 goals、10 tomorrow、11 budgets 归 04；本包只返回 `Signals{InterestTopics,NotableEvents}` 供 04 使用。D2 与 D4 分离是刻意的：抽取失败不产生半条记忆。

**预算**：总预算由 04 传入（默认 20 min / 250k tokens，04 §7）；本包单步上限：抽取 ≤120 条、人物卡 ≤10 人、embedding ≤300 条、单步 180s。`stats.steps` 记 `{name,status,ms,tokens}`；04 重试时按已完成步骤跳过，保证幂等。

**报告**：`Report` 只生成人可读 markdown 与 `ReportFile{Path,Bytes}`；`stats` 至少 `extracted/duplicates/merged/written/reflections/people_updated/self_updated/diary_written/tokens/llm_calls/failed_ids[]`；`status` 由 04 写 `running/ok/failed`，05 只返回每步 `ok|failed|skipped`；04 未就绪的降级路径下，`Report` 可用同一 `report_id` 幂等代写该行。

**接口**：`DreamKey{PersonID, ReportID, Day, SleepStart, SleepEnd, WeeklySelf bool}`；`Digest`/`Stats` 为内部类型；`ReportFile{Path,Bytes}`。

## 7. 人物卡

模板：frontmatter `id/display_name/relationship/closeness/important/aliases/updated_at/sources` + 六节 `## 她是谁`、`## 我们的关系`、`## TA 在意的事`、`## 一起经历过`、`## 边界与雷区`（包在 `<!-- manual -->…<!-- /manual -->`）、`## 最近变化`（留 5 条）。

更新规则：①只在有 `evidence:[mem_id]` 时改；②补丁式 `{section,op,old_text,new_text}`，要求 `old_text` 在该节恰好出现一次，否则 `people_patch_conflict` 下次重试；③manual 区永不改写；④写前文件 hash 校验，Dream 读取后被人工改过则放弃；⑤旧版复制到 `_history/people/<id>/日期.md`。关系枚举/`boundaries`/`important` 不能由卡片决定：Dream 走 `people.ProposeUpdate`（closeness 单次 ±5 自动生效；枚举与边界新增需你确认）；`blocked` 的人不生成主动内容。

`littly_people.notes`：卡片是真相，`notes` 是 ≤400 字符派生摘要（"她是谁"首句 + 关系 + 1 条边界），卡片写成功后同事务更新；只有 `people.go` 写 `notes`，08 其他字段用列级 UPDATE，禁止整行 upsert。有卡无 notes → 重算；有 notes 无卡 → 以 notes + 空模板重建并 audit。

## 8. 隐私

| 点 | 规则 | 失败 |
|---|---|---|
| 写入 | 抽取器判可见性 + `privacy.Validate` 复核；不确定降一级（public→relationship→private） | 拒收，staging 记错 |
| 检索 | SQL 谓词（§5.3）+ `ScrubBundle`，两者同源 | 丢弃 + audit |
| 展示 | Web API 永不返回 private；搜索/时间线/人物卡同一 viewer | 404/空，不提示"存在但不可见" |

**public 抽取要求**：不得含他人健康/财务/家庭/感情细节、住址/单位/行程、凭据、私聊原文、可反推组合（人名+地点+时间）；必要时改写成"一个朋友"并抽象成她的感受；"对方要求保密"一律 relationship 指向该人。Dream 每日对新增 public 做规则扫描（证件/手机号/邮箱/住址/密钥正则 + 敏感词），命中降级 private + audit。

**她主动展示**：①临时展示 `Display` 返回 HMAC token（绑定 viewer 会话 + memory + TTL 默认 12h），凭 token 单条只读，只写 audit；②精选摘录写一条**新 public 记忆**（`provenance.displayed_from=原id`，去标识化），原条不动。只能由她的工具循环在你明确在场的对话里发起；检索层永远不能顺手把 private 变 public。

## 9. 备份 / 导出 / 迁移

`pg_dump`（含上游表）+ vault tar + `conf/`（无密钥）+ SnowLuma 数据，`SHA256SUMS` 校验，7 日备 + 4 周备（与 14 的旧数据备份分开）。vault 即 Markdown，另导 `index.jsonl`（不含 embedding）。重建索引先备份 vault。**换 embedding**：维护模式停写 → 全表 `embedding=NULL`（检索自动词法）→ 改 config → 必要时 `ALTER COLUMN TYPE vector(N)` + 重建 HNSW → 分批回填 → 非空率 100% → 退出维护；禁止新旧维度混存。分词器升级跑 `reindex --tsv-only`。旧项目数据只进 `data/archive/`，无导入器（14 §4）；未来导入条目 `source=legacy`、默认 relationship、导入后强制隐私抽查。灾难恢复：vault 在则索引可重建；每季度演练一次。

## 10. 测试与验收

**单测**：frontmatter 往返与非法 YAML 拒绝；原子写崩溃后旧文件完好；路径监狱（`../`、绝对、`a/../../b`、symlink 父目录、NUL、`/vault-evil` 兄弟目录）；幂等/冲突/阈值边界；可见性矩阵（4 viewer × 3 visibility × people 空/非空）；重排精确值与半衰期；RRF 两路/单路/空集；中文分词（纯中文/混排/单字/标点/emoji）；人物卡补丁（old_text 0/1/2 次、manual 区）；embedder 失败降级。

**集成**（Docker PG + pgvector）：`Submit→Drain→文件→索引→检索` 全链路 + 断点对账；200 条（含中文/关系/私有/墓碑）重建后逐字段一致，重复路径中止且旧索引完好；Dream 正常/预算耗尽按步 `skipped`/kill 后 04 记 `failed` 且 staging 仍在/04 锁竞争 `skipped`；隐私泄漏核心用例（A 的 relationship + private，以 B 检索 20 个 query → 0 命中；owner_web → 0 private；群聊 → 只 public）；中文单字/双字/长句/错字 top-3；展示 token 过期与越权；备份恢复后检索一致。

**验收**：对齐 01 §§5.4/5.5；1k 条词法 p95 <150ms、含向量 <400ms、重建 10k <60s；单次注入 ≤12 条/900 tok；模型故障不影响聊天与写入；连续 3 晚 Dream `ok`、无重复条目、人物卡人工编辑零覆盖。

## 11. 开放问题

1. 分词器选型（`gojieba` 体积/词典 vs `sego` 精度）；是否支持每实例自定义词典（人名/术语）。
2. 1536 维被 03 写死；若选 1024 维本地模型（bge-m3）是否值得一次 schema 迁移？倾向首版用 1536 的 API 模型。
3. `_history/dream` 等保留子目录需回写 03 §4；是否改为独立 `reports/`。
4. 近似去重阈值（0.86/0.92）需真实数据调参；是否加 LLM 判重作第三级。
5. `littly_diaries` 无 visibility 列；"给你看的日记摘录"走展示/精选摘录而非改表。
6. 群聊中多人都认识的关系记忆是否提供"你们都认识"的元信息聚合（不披露内容）。
7. `private` 是否要加密（D6 明确不做；未来做则在 store 层透明加密，索引只存摘要）。
8. 容量上限与折叠策略（低 importance + 高龄条目折叠为摘要，原文留 vault）。
