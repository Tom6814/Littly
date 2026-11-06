# 14 · 旧数据备份、角色归档与未来导入

> 原则（D12）：**v2 首版不迁移历史数据**。旧库/记忆/配置只做备份与归档；迁移作为独立项目后置。

## 1. 备份（动手前必须做）

### 1.1 备份清单

| 对象 | 来源 | 说明 |
|---|---|---|
| SQLite 数据库 | 旧项目 `harness/data/littly.db`（及服务器 `/opt/littly-data/littly.db`） | 消息/记忆/联系人/角色/配置/审计 |
| Memory vault | 旧项目 `data/memory/`（服务器 `/opt/littly-data/memory/`） | 每角色每人的 Markdown 真相 |
| 配置/密钥 | 旧 `global_settings`（在 DB 内）、`.env`、部署脚本中的配置 | 只入备份，不进 v2 |
| SnowLuma 数据 | `data/snowluma/`（QQ 登录态/配置） | 保留 QQ 登录，避免重新扫码 |
| 媒体文件 | `data/downloads/`、`data/photos/`、语音/图片 | 可选；体积大，单独打包 |
| 旧控制台构建 | `console/dist`（可选） | 回滚演示用 |

### 1.2 打包

```bash
ts=$(date +%Y%m%d-%H%M%S)
mkdir -p backups/$ts
sqlite3 harness/data/littly.db ".backup backups/$ts/littly.db"
tar czf backups/$ts/memory.tar.gz -C harness/data memory
tar czf backups/$ts/snowluma.tar.gz -C harness/data snowluma        # 含 QQ 登录态
tar czf backups/$ts/downloads.tar.gz -C harness/data downloads 2>/dev/null || true
cp harness/data/littly.db.backup-* backups/$ts/ 2>/dev/null || true
# 校验
sha256sum backups/$ts/* > backups/$ts/SHA256SUMS
```

- 备份保留至少两份（本机 + 外部盘/对象存储）。
- 备份目录**不提交进 git**（`backups/` 加入 .gitignore）。
- 服务器旧数据同理备份到 `/opt/littly-data/backups/`，并下载一份到本地。

## 2. 角色归档（其余三个角色）

旧实例有 4 个角色（小璃/优香/鲸鱼娘/11）。v2 只保留一个 person；其余角色不删除，做**只读归档**：

1. 导出为 JSON：bot 行、角色卡、消息、日记、成长、记忆、联系人、照片元数据；
2. 存入 `backups/archive/roles/<name>.json`（及原始 vault 目录）；
3. v2 不加载这些数据；UI 不显示；
4. 未来如需"她过去认识的人"，可从归档生成人物卡（手动/脚本，后置）。

```bash
# 伪命令（实现阶段用脚本 tools/export-legacy-roles.mjs）
node tools/export-legacy-roles.mjs --db harness/data/littly.db \
  --memory harness/data/memory --out backups/archive/roles
```

## 3. 旧数据与 v2 的边界

- v2 **不读**旧 SQLite、不读旧 vault、不跑旧 TS 服务。
- 旧仓库保留在 git 历史/单独分支，作为参考与回滚点。
- 旧配置（API key、渠道 token）**不自动带进 v2**：v2 重新配置（避免技术债与泄漏）。

## 4. 未来导入（后置项目，仅预案）

当 v2 稳定后，如需历史导入：

1. **只读导入器**：旧 DB → 中间 JSON（消息/人物/日记/成长/记忆条目）；
2. 映射：
   - 旧 `contacts` → `littly_people`（合并同名/同身份）；
   - 旧 `memories`（per sender）→ `littly_memories`，按"她认识的人"归属，`visibility=relationship:<people>`，`source=legacy`；
   - 旧 vault 条目 → 同 domain 映射；PROFILE → 人物卡补充；RULES → 边界；
   - 旧 `messages` → 会话历史（可只保留摘要/最近 N 条，避免 v2 上下文被旧对话主导）；
3. 导入必须**幂等**（id 映射表、sha 去重）、可回滚（导入前备份 v2）；
4. 导入后跑一遍记忆重建 + 人工抽查隐私可见性；
5. 旧角色若保留为人物：生成人物卡（"她过去的熟人"），不迁移其人格/记忆库。

## 5. 验收（本轮）

- [ ] 备份文件存在且 sha256 校验通过；
- [ ] 三个旧角色导出 JSON 可解析、数量与旧库一致；
- [ ] v2 启动不依赖任何旧数据；
- [ ] 文档/脚本说明了"如何回滚到旧实例"；
- [ ] SnowLuma 登录态备份可恢复（QQ 不重扫）。

## 6. 风险

- **备份遗漏**：旧项目数据可能在多处（本地/服务器/备份盘）——以服务器为准做一份全量，再与本地比对。
- **密钥泄漏**：备份内含 API key/QQ token，存放注意权限（chmod 600），不提交 git。
- **误删**：本轮只归档不删除；删除动作必须单独确认。
