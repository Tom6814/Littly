# Littly 部署与验收

> 一句话：**单容器 = harness 内核 + 控制台前端 + 业务库**；QQ 与 B 站是可选 sidecar。

---

## 1. 容器部署（推荐）

```sh
# 构建（仓库根）
docker build -f deploy/Dockerfile -t littly-harness .

# 起容器
docker run -d --name littly \
  -p 3000:3000 \
  -v littly-data:/app/data \
  -v bili-data:/app/bili-data \
  -e TZ=Asia/Shanghai \
  -e OPENAI_API_KEY=sk-xxx \
  littly-harness

# 打开 http://localhost:3000/ ，注册第一个账号（自动成为管理员）
```

镜像里有什么：

| 层 | 内容 |
|---|---|
| `harness/` | dsh 内核 + `@littly/bundle`（业务插件）+ 构建产物 |
| `console/dist` | 控制台前端（MUI + Vite），由 console-api 的 fallback 托管 |
| `python3 + bilibili-cli` | `bili` CLI（v0.6.2）——`@littly/bili` 直接 spawn 它执行 B 站命令；控制台扫码/浏览器 Cookie 认证也由它落凭证 |

持久卷：

| 卷 | 路径 | 内容 |
|---|---|---|
| `littly-data` | `/app/data` | 业务 SQLite（`littly.db`）+ dsh home（`dsh-home/`） |
| `bili-data` | `/app/bili-data` | 她的 bilibili 账号状态：`BILI_CLI_HOME` 是 bili CLI 的 HOME，凭证落 `<HOME>/.bilibili-cli/credential.json`（0600） |

**首启会做两件事**（都由 `deploy/entrypoint.sh` 触发）：

1. **profile 播种** —— dsh 的 profile 是 `$DSH_HOME/profiles/<name>` 的一等公民，
   容器里没有开发时那根软链，所以首启由 `harness/scripts/seed-profile.mjs`
   把镜像里的 `profiles/chat` 播种过去（幂等，不覆盖你改过的内容），
   并按需装一次 profile 的外部依赖。
2. **webserver 绑定** —— dsh 拒绝 `0.0.0.0` 通配绑定，entrypoint 用
   `hostname -i` 取容器自身 IP 再注入。

另外，**业务库是空的，第一次打开控制台时会自动播种**（旧仓 `ensureSeed` 的行为）：
自动建出 bot「小璃」、**完整的**铁律、演示角色卡和三条演示世界书。
所以新装好打开 `http://localhost:3000/` 就能直接聊，不用先去后台点任何东西。
播种是幂等的 —— 已有就不动，你改过的铁律 / 角色卡不会被覆盖。

### 必填环境变量

| 变量 | 说明 |
|---|---|
| `OPENAI_API_KEY` | 模型服务密钥（也可在控制台「全局设置」里配，走 DB KV） |
| `OPENAI_BASE_URL` | 可选，OpenAI 兼容服务地址 |
| `OPENAI_CHAT_MODEL` | 可选，默认模型名 |
| `PORT` | 可选，默认 3000 |
| `LITTLY_DATA_DIR` | 可选，业务数据根目录（**上传/生成文件**落这里的 `downloads/`），默认 `<cwd>/data`；容器 entrypoint 默认 `/app/data`（与 SQLite 同卷）。B11 起不再写 `public/downloads` —— 容器重建不丢相册/文档/语音/头像 |
| `LITTLY_DB_FILE` | 可选，业务 SQLite 路径，默认 `data/littly.db`；容器里是 `/app/data/littly.db` |
| `X_BIN` | 可选，twitter-cli 可执行文件路径，默认 `twitter`（镜像运行层已 `pip3 install twitter-cli==0.8.5`；装不上时控制台 `binOk=false`） |
| `BILI_BIN` | 可选，bilibili-cli 可执行文件路径，默认 `bili`（镜像运行层已 `pip3 install bilibili-cli==0.6.2`；装不上时控制台 `binOk=false`） |
| `BILI_CLI_HOME` | 可选，bili CLI 的 HOME（凭证 `<HOME>/.bilibili-cli/credential.json`），容器里默认 `/app/bili-data`（持久卷） |

---

## 2. 编排（harness + SnowLuma）

```sh
# 全量（QQ 渠道 + harness；B 站能力内置在 harness 里，无需额外服务）
docker compose -f deploy/docker-compose.yml up -d --profile qq

# 只要 harness（B 站能力同样可用，只要镜像里 bilibili-cli 安装成功）
docker compose -f deploy/docker-compose.yml up -d
```

- **SnowLuma**（QQ 账号）：官方镜像，需 `SYS_PTRACE`；首次启用用 noVNC(6081) 扫码登录。
  harness 侧在控制台「角色设置 → SnowLuma」填 OneBot 正向 WS 地址。
- **B 站（bilibili-cli）**：无独立 sidecar。`@littly/bili` 在 harness 进程内 spawn `bili`，
  控制台「Bilibili」页扫码登录（后端直连 passport HTTP，自绘 PNG 二维码）或一键提取本机浏览器
  Cookie；写操作默认预演（控制台「允许写操作」打开 + 显式 dryRun:false 才真执行）。
  AI 侧走 `bili` 元工具（子命令白名单 + 限频 30/5 每小时 + 审计）。

编排文件里的 harness 服务写了显式 image 名（`littly-harness:test`），
所以 `docker compose build` 构建一次，之后 `compose up` 直接复用，
`--no-build` 可以完全跳过构建步骤。

---

## 3. 接入社区 dsh 插件

harness 支持直接装社区插件（计划 v2 §2 的兼容性验收）：

```sh
cd harness
DSH_HOME="$PWD/.dsh-home" node apps/cli/lib/bin.js plugin --profile chat add "github:<owner>/<repo>"
```

- 插件的 peer 版本与当前 dsh 不匹配时，插件管理器会**按设计拦下**并给出精确的豁免命令；
  确认风险后可执行它提示的 `allow-version ... --accept-risk` 再重试。
- 装好后**它注册的工具对她可见可调**：`@littly/agents` 的 dsh-bridge 把
  `ctx.tools` 的工具投影成 Littly 工具形状，模型调用时转回 `ctx.tools.execute`。
- 例：`dsh-case` 提供 `case_convert`（命名风格转换），控制台「插件管理」页能看到。

---

## 3.5 X（Twitter）接入

她用自己的 X 账号（[twitter-cli](https://github.com/jackwener/twitter-cli)，cookie 认证，无官方 API key）。

```sh
# 运行时依赖（镜像已内置；本机手动装）
uv tool install twitter-cli            # 或 pipx / pip3 install --break-system-packages twitter-cli==0.8.5
twitter --version                      # 0.8.5
```

- **登录**：控制台「连接 → X」→ 粘贴浏览器里 x.com 的完整 Cookie（或直接填 `auth_token` + `ct0`）→
  「验证登录」会跑一次 `twitter whoami` 并把用户名存下来。凭据只存业务库，不回显、不进日志。
- **代理**：x.com 在部分网络环境需要代理。X 页面可填 `proxy`（写入 `TWITTER_PROXY`），
  也可用环境变量 `TWITTER_PROXY=http://127.0.0.1:7890`。
- **写操作默认关**：`x.post/x.reply/x.like/...` 一律返回 dry-run 预览；在 X 页面打开「允许写操作」后才会真发，
  且仍受「读 30 次/小时、写 5 次/小时」限频与审计约束。
- **能做什么**：feed / bookmarks / search / tweet / show / user / user-posts / followers / following / list / article
  （读）；post / reply / quote / delete / like / unlike / retweet / unretweet / bookmark / follow / unfollow（写）。
  不支持 DM / 通知 / 投票（上游限制）。
- **验收**：`node harness/scripts/verify-x.mjs`（fake bin，覆盖允许清单/写预演/开关/限频/审计/错误映射）。

## 3.6 QQ（SnowLuma OneBot v11 + 官方 QQBot）

QQ 渠道是一个插件两个通道：**SnowLuma（个人 QQ 号，OneBot v11）** 与 **官方 QQBot（QQ 开放平台）**。
实现派生自 [dsh-lane-bridge](https://github.com/CNranger1124/dsh-lane-bridge)（MIT，致谢见
`harness/packages/littly/channel-qq/NOTICE`），已 TypeScript 化并接入本仓库 hub。

### 3.6.1 SnowLuma（推荐，个人 QQ 号）

SnowLuma 是**第三方** QQ 协议运行时，需**你自行安装并启动**（本仓库不代装、不代启，遵守其 EULA）：

1. 下载 [SnowLuma Releases](https://github.com/SnowLuma/SnowLuma/releases) 完整包解压，`./launcher.sh`（或 `launcher.bat`）。
2. 打开 WebUI `http://127.0.0.1:5099`（初始密码见首启日志），按引导扫码登录 QQ。
3. 在 WebUI 里开启 **OneBot：WebSocket 服务端**（默认端口 3001；注意 HTTP token 与 WS token 是两个不同值）。
4. 控制台「连接 → QQ → SnowLuma」：填 `ws://127.0.0.1:3001` 与 token → 保存 → 点「探测」，
   状态变「已连接（账号 xxx）」即成功；群聊需 @ 她才回（模型侧按渠道策略）。

容器部署时 `deploy/docker-compose.yml` 已带 `snowluma` 服务（`--profile qq`，官方镜像
`ghcr.io/snowluma/snowluma`，需 `SYS_PTRACE`；首次用 noVNC `:6081` 扫码）。

### 3.6.1.1 一键安装（推荐，控制台内完成）

SnowLuma 需要 Docker；控制台提供一键安装/启动/扫码引导，用户只需**扫码登录 QQ**：

1. 「连接 → QQ → SnowLuma」→ 点「一键安装」→ 勾选知情同意（第三方非商业自托管软件，遵守其 EULA）→ 自动 `docker pull` 官方镜像（`motricseven7/snowluma`）。
2. 安装完成后点「启动并扫码」→ 后端自动 `docker run`（SYS_PTRACE / seccomp=unconfined / shm 1g / ulimit / 随机 VNC 密码 / 三块数据卷 bind mount），并读取 `config/onebot.json` 里的 WS accessToken。
3. 点「打开远程桌面（noVNC）」→ 容器内 QQ 自动启动，用手机 QQ 扫码登录；也可用「免密直连」链接（`?autoconnect=1&password=…`）。
4. 登录后控制台自动检测 3001 可达 → `autoconfigure` 把 `ws://127.0.0.1:3001` + token 写入该 bot 并启用 → 显示「已连接 @QQ号」。无需手动填 ws/token。

数据卷位置：`LITTLY_DATA_DIR/snowluma/{data,qq-config,qq-data}`（升级/重装不丢登录态）。
日志与密码：远程桌面密码在控制台可复制（`VNC_PASSWD` 由我们随机生成）；WebUI 临时密码在容器日志里提取（控制台「容器日志」可看）。
卸载默认保留登录数据卷（二次确认）；真实 QQ 扫码必须由你本人在手机上完成。

### 3.6.2 官方 QQBot（QQ 开放平台）

1. 在 [QQ 开放平台](https://q.qq.com/) 创建机器人，拿 `AppID` / `AppSecret`。
2. 控制台「连接 → QQ → 官方 QQBot」：填 AppID/AppSecret（保存后只显示掩码）→ 启用 → 探测。
3. 注意被动回复窗口：QQ 官方要求 `msg_id` 在 **5 分钟**内回复；超时会失败（日志会写清楚）。

### 3.6.3 验收

```sh
cd harness
node scripts/verify-channel-qq.mjs     # 适配器单测（假 OneBot WS 服务 + QQBot mock）
node scripts/verify-e2e.mjs 3000       # 含 /api/qq/status 200、未登录 401
```

API：`GET /api/qq/status`、`PUT /api/qq/snowluma`、`PUT /api/qq/qqbot`、`POST /api/qq/probe`、`GET /api/qq/logs`。

## 4. 旧库迁移

旧项目（Next.js 单体）的 `db/custom.db` 一次性迁进新 schema：

```sh
cd harness
node scripts/migrate-legacy.mjs "/path/to/old/db/custom.db" /path/to/new/littly.db
```

- 旧库只读；新库没有 schema 会就地按 storage 插件同一份 DDL 建表。
- 记忆补 v2 字段初值（`event_time=recorded_at`、`provenance='user-stated'`）。
- 旧审计类别 `call_summary` 映射为 `heartbeat`（新库 CHECK 只认 7 种）。
- 全局配置（模型配置的唯一真相源，含 API Key）一并带走。
- `BindingToken` 是一次性凭证（10 分钟时效），故意不迁。

---

## 5. 验收（全部是能跑的脚本）

```sh
cd harness
pnpm run build:artifacts          # 构建：7 个 gate 全绿才算过

# 行为断言（逐个跑，退出码非 0 即失败；不需要真模型/真服务）
for s in scripts/verify-*.mjs; do
  case "$s" in *verify-e2e.mjs|*verify-onboarding.mjs|*verify-agent-loop.mjs) continue ;; esac
  node "$s"
done

# 主链路（自己起 mock 模型 + 真实 harness，验证缓冲/沉默/安全阀/工具循环）
node scripts/verify-agent-loop.mjs

# 端到端（要真起服务；真模型可选 —— 不配模型时聊天断言容忍失败）
DSH_HOME="$PWD/.dsh-home" node apps/cli/lib/bin.js --profile chat &
node scripts/verify-e2e.mjs 3000

# 首次引导 API（要真起服务 + 模型配置；服务端 env 或 DB 里有可用模型）
node scripts/verify-onboarding.mjs 3000
```

> 本机实测（2026-10-31 夜）：20 个脚本 **699 断言全绿**（含 `verify-agent-loop` 30、`verify-wechat` 116），
> 真服务端到端 **62/0**、引导 API **19/0**。`verify-final.sh` 的容器/compose 段需 docker，本地验收不必跑。
>
> 端到端/引导脚本的 admin 提权：服务启动时 storage 插件会把
> `{pid,port,dbFile,cwd}` 写到 `$TMPDIR/littly-runtime-<PORT>.json`，脚本据此定位真实业务库
> 把测试账号提为 admin（也支持 `node scripts/verify-e2e.mjs <port> <dbPath>` 显式指定）。

| 脚本 | 覆盖 |
|---|---|
| `verify-memory.mjs` | 记忆打分 / 历史窗口 / 拟人化分片 / 出口后处理 / 工具兜底（32 项） |
| `verify-memory-v2.mjs` | explain 台账 / protected 能力位 / 幂等回执 + 漂移检测（41 项） |
| `verify-growth.mjs` | 三铁律硬校验 / 月底窗口 / 提议-审批全链路 / 版本冲突 / 回滚（86 项） |
| `verify-heartbeat.mjs` | 退避序列 / 静默时段 / JSON 稳健提取 / 决策落地 / 扫描守卫（50 项） |
| `verify-bili.mjs` | bilibili-cli 壳：允许清单 / 写默认 dry-run / audio 输出目录 / JSON 信封与错误码 / 扫码三态与凭证 0600 / 限频 / 审计脱敏 / 工具注册与 MCP 收敛门（fake bin + mock passport，140 项） |
| `verify-mcp.mjs` | 服务器清单解析 / 工具命名 / 按角色启停集合（18 项） |
| `verify-events.mjs` | 对话过程事件订阅/退订/异常隔离/按会话路由（9 项） |
| `verify-migrate.mjs` | 旧库迁移的行数守恒 / 字段映射 / 幂等（21 项） |
| `verify-bind.mjs` | 发码 / 消费 / 一次性 / 冲突 / 身份归一 / 解绑（22 项） |
| `verify-seed.mjs` | 首启播种：bot / 完整铁律 / 角色卡 / 世界书 / 幂等 / 不覆盖（43 项） |
| `verify-secret-mask.mjs` | 密钥三态：掩码=保持 / 空串=清空 / 其它=写入（25 项） |
| `verify-channel-qq.mjs` | QQ 渠道（SnowLuma OneBot v11 + 官方 QQBot 适配器；66 项，假 WS/FakeBot 注入） |
| `verify-discord.mjs` | Discord 网关（75 项） |
| `verify-wechat-ilink.mjs` | 微信 iLink + 桥接 Webhook（78 项） |
| `verify-voice-call.mjs` | 通话协议 / 令牌鉴权 / 精简 prompt 层集 / 回响总结（84 项） |
| `verify-backend-mainloop.mjs` | T-A~T-D 主链路契约：缓冲 exactly-once（合并窗口/原子认领/僵死恢复）、沉默不落库、投递失败 failed、工具循环（原生+文本兜底+乱序）、思考不外泄、安全阀、SnowLuma 群@门（43 项） |
| `verify-onboarding.mjs` | 首次引导 API：GET 状态 / test-model（坏配置 + 真模型两条路径）/ complete 幂等（19 项，需真服务） |
| `verify-wechat.mjs` | 微信 iLink 重写套件（116 项，mock HTTP） |
| `verify-x.mjs` | X（Twitter）接入：允许清单 / 写默认预演 / 开关放行 / 限频 / 审计 / JSON 信封（exit 0 也可能失败）/ 401·429·226 映射 / 凭据注入与不回传（75 项，fake bin，不联网） |
| `verify-e2e.mjs` | 真启动：首启播种 / 注册登录 / 插件清单 / 成长 / 来电 / MCP 增删（admin+白名单）/ 工具启停 / 控制台静态托管 / 越界防护（62 项，需真服务） |

CI（`.github/workflows/ci.yml`）跑同样的门禁：构建 + 断言 + 控制台构建 + 端到端 + 容器构建探活。

---

## 6. 本地开发

```sh
# harness（端口 3000）
cd harness && pnpm install && pnpm run build:artifacts
DSH_HOME="$PWD/.dsh-home" node apps/cli/lib/bin.js --profile chat

# 控制台（另开一个，端口 5173，API 代理到 3000）
cd console && pnpm install && pnpm run dev
```
