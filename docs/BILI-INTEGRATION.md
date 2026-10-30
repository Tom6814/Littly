# Bilibili 接入（bilibili-cli）— 实现与运维文档

> 状态：2026-10-31 重写。上游：[`public-clis/bilibili-cli`](https://github.com/public-clis/bilibili-cli)
> （Apache-2.0，Python CLI，PyPI 包名 `bilibili-cli`，命令 `bili`，本文按 v0.6.2 实测）。
> 旧方案（`bili-agent` + `sidecars/bili` HTTP wrapper + MCP stdio）已整体下线，本文是唯一现行文档。

---

## 0. 为什么换成 bilibili-cli

| 维度 | 旧 bili-agent 方案 | 现 bilibili-cli 方案 |
|---|---|---|
| 形态 | 独立 sidecar 容器 + HTTP wrapper + MCP stdio | **无 sidecar**：harness 进程内 spawn `bili` |
| 认证 | 只靠控制台扫码（wrapper 两步 QR） | **智能三选一**：CLI 自动读浏览器 Cookie / 控制台扫码（直连 passport）/ 手动凭证 |
| 命令面 | 上游 MCP 17 工具 + wrapper 白名单 108 命令 | CLI 20 个子命令（视频/用户/搜索/热门/排行/动态/收藏/历史/音频/互动） |
| 依赖面 | 多一个容器 + `bili-agent[mcp]` + token 头 | 一个 `pip install bilibili-cli`，无需额外端口 |
| 护栏位置 | sidecar（Python wrapper）+ harness 收敛门 | **@littly/bili service**（TS，模型/控制台同一入口） |

驱动：用户要求「抄 bilibili-cli」，让 AI 能真正刷 B 站 + 扫码/浏览器 Cookie 双认证。

---

## 1. 安装与运行前提

- Python ≥ 3.10。安装二选一：
  - 容器：`pip3 install --break-system-packages bilibili-cli==0.6.2`（`deploy/Dockerfile` 已内置，失败不阻塞构建）
  - 本机：`uv tool install bilibili-cli`（或 `pipx install bilibili-cli`），命令即 `bili`
- 自检：`bili --version` → `bili, version 0.6.2`；`bili status --json`（未登录时退出码 1 但 JSON 合法）。
- **认证/凭证位置**：`$HOME/.bilibili-cli/credential.json`（0600）。CLI **不支持**自定义凭证路径的 env，
  所以「换账号/持久化」通过给子进程换 `HOME` 实现：本仓库把 **`BILI_CLI_HOME` 解释为 bili CLI 的 HOME**，
  凭证实际落在 `<BILI_CLI_HOME>/.bilibili-cli/credential.json`。
- 凭证 schema（与 CLI `auth.py save_credential` 逐字一致）：

```json
{
  "sessdata": "...", "bili_jct": "...", "ac_time_value": "...",
  "buvid3": "...", "buvid4": "...", "dedeuserid": "...",
  "saved_at": 1761...
}
```

- 容器内：卷 `bili-data:/app/bili-data`，`BILI_CLI_HOME=/app/bili-data` → 登录态随卷持久化，容器重建不丢。

---

## 2. 智能认证（三条路）

CLI 自身的认证顺序（`bili_cli/auth.py`）：**已保存凭证 → 本机浏览器 Cookie 提取（browser-cookie3）→ TTY 扫码**。
`bili login` 是纯 TTY 交互（rich 终端二维码），非 TTY 下没有任何输出 —— 因此控制台扫码**不能 spawn `bili login`**，
改为后端直连 passport HTTP，自己把 Cookie 写进 credential.json。

### 2.1 扫码登录（控制台，推荐）

1. `GET https://passport.bilibili.com/x/passport-login/web/qrcode/generate`
   → `{code:0, data:{url, qrcode_key}}`
2. 后端用**零依赖 QR 编码器**把 `url` 渲染成 PNG data URL 返回前端（`<img src>` 直接显示）。
3. 前端每 2s 轮询 `GET .../x/passport-login/web/qrcode/poll?qrcode_key=...`：
   `data.code` = `86101` 未扫码 / `86090` 已扫码待确认 / `86038` 过期 / `0` 成功。
4. 成功响应同时带 **Set-Cookie**（`SESSDATA` / `bili_jct` / `DedeUserID` / `buvid3` / `buvid4`），
   body 的 `data.url`（crossDomain 跳转链接）也能兜底解析同样的值，`data.refresh_token` → `ac_time_value`。
5. 后端写 credential.json（合并旧 buvid3/4，0600），再跑 `bili status --json` **复核**；复核通过返回账号信息。

会话只在内存（3 分钟 TTL，`QrSessionStore`）；进程重启后重新扫码即可。

### 2.2 一键提取浏览器 Cookie（admin，仅对「运行本服务的机器」有效）

控制台按钮 → 后端**先删除 credential.json**，再跑 `bili status --json`：
CLI 会自动用 browser-cookie3 从本机 Chrome/Edge/Safari 提取并保存凭证。成功即登录；
浏览器不可用（容器/服务器/未登录过 B 站）返回可读错误并提示改用扫码。

### 2.3 已保存凭证

`bili status --json` 发现有效 credential.json 时直接复用（CLI 会在 7 天后尝试浏览器刷新，
失败则回退校验旧凭证）。控制台「登出」删文件 + 跑 `bili logout` 双保险。

---

## 3. 命令面（允许清单）

`bili --help` 的 20 个命令中，允许 AI/控制台调用：

| 类 | 命令 | 说明 |
|---|---|---|
| 读 | `status` `whoami` `video` `user` `user-videos` `search` `hot` `rank` `feed` `my-dynamics` `favorites` `following` `watch-later` `history` | 自由调用（限频 30 次/小时） |
| 读（下载类） | `audio` | 下载视频音频（ASR-ready WAV）；**按写操作门控**，固定输出到 `${LITTLY_DATA_DIR}/downloads/bili` |
| 写 | `like` `coin` `triple` `unfollow` `dynamic-post` `dynamic-delete` | 默认 dry-run；限频 5 次/小时 |

**硬拦截**：
- 允许清单外的第一个 token → 400 `command_not_allowed`（不拼 shell，argv 数组直传 spawn）。
- `-o` / `--output` / `--from-file` / `--input` / `-i` / `--yaml` 一律 400 `flag_not_allowed`（禁文件读写/自定义输出目录/破坏 JSON 信封）。
- 空 argv / 空字符串项 / 超长参数 → 400 `bad_request`。
- `unfollow` / `dynamic-delete` 真执行时自动补 `--yes`（否则非 TTY 下 CLI 的 `click.confirm` 会 EOF 失败）。

**写操作开关**：`global_settings['bili.allow_writes']`（控制台「允许写操作」）。
`allowWrites='1'` **且**显式 `dryRun:false` 才真正执行；否则只返回预演结果（带可读 note）。audio 同规则。

---

## 4. 模型工具 `bili`

```jsonc
{ "argv": ["video", "BV1xx411c7mD", "--subtitle"], "dryRun": true }
```

- 工具定义在 `harness/packages/littly/bili/src/tool.ts`；执行结果 JSON 字符串：
  `{ok, dryRun, exitCode, command, argv, data?, error?}`。
- 系统提示建议：**总结视频先 `video BV… --subtitle` 看字幕，再视需要加 `--ai` / `--comments`；列表类用 `-n/--max` 控制体积**。
- 错误码：`not_authenticated`（未登录/凭证失效）、`rate_limited`（本地限频/接口 429）、
  `risk_control`（B 站 -352/-412，**立即停手，不要换参数绕过**）、`not_found`、`network_error`、`bili_api_error`。

---

## 5. 控制台 API（console-api/src/routes-bili.ts）

| 方法/路径 | 权限 | 行为 |
|---|---|---|
| `GET /api/bili/status` | required | `{authenticated, user, allowWrites, binOk, loggedInAt, lastError, hint?}`；未登录不报错 |
| `POST /api/bili/qr/start` | required | `{sessionId, qrDataUrl(PNG), link, expiresInMs:180000}` |
| `GET /api/bili/qr/status?sessionId=` | required | `{status:'wait'|'scaned'|'confirmed'|'expired', user?}` |
| `POST /api/bili/extract-cookie` | admin | 删凭证 → CLI 浏览器提取 → 返回状态（失败带 hint） |
| `POST /api/bili/logout` | admin | `{ok:true, cleared}` |
| `PUT /api/bili/settings` | admin | `{allowWrites:boolean}` → `{ok:true, allowWrites}` |
| `POST /api/bili/cmd` | required | `{argv, dryRun?}` → 与模型工具同一 service（同白名单/开关/限频/审计） |

凭证（SESSDATA 等）**永不回传**；status 只给账号展示字段 + 凭证摘要（存在性、saved_at、是否有 buvid）。
错误信息里若出现凭证值一律替换为 `***`（错误/审计/lastProbe 都过一层脱敏）。

---

## 6. 装配与实现边界

- 插件：`harness/packages/littly/bili`（`@littly/bili`，服务键 `littlyBili`），
  `bundle/cordis.patch.yml` 已有 `littly-bili` 一行；工具在 `littlyHub` 就绪后注册。
- 文件：
  - `src/service.ts` — CLI 执行/允许清单/写护栏/限频/审计/status/browserExtract/qrPoll/logout
  - `src/qr.ts` — passport generate/poll + 二维码会话
  - `src/credential.ts` — credential.json 读写（0600）/Set-Cookie 解析/脱敏
  - `src/qr-encoder.ts` — 零依赖 QR 编码器；**复制自 `channel-wechat-ilink/src/ilink-qr.ts`**（仓库无 qrcode 依赖，两处需同步改）
  - `src/tool.ts` — `bili` 工具定义 + 注册
- **旧 MCP 面已无对应实现**：bilibili-cli 没有 `mcp` 命令。`@littly/bili` 仍保留收敛门（`mcp__bili__*` → deny），
  但 `bundle/cordis.patch.yml` 里旧的 `mcp-bili`（spawn `bili mcp serve`）应删除，否则每次启动会打
  `Error: No such command 'mcp'` 噪声（不影响功能）。
- 头像：CLI 的 `status/whoami` 归一化 payload 不含 face/avatar，控制台头像位为空（需要时可用 mid 拼
  `https://api.bilibili.com/x/web-interface/card` 另查，本版未做）。
- `bili status` 未登录时**退出码 1 但 JSON 合法** → 成功判定一律看信封 `ok`，不看 exit code。

---

## 7. 护栏分层（全部在 @littly/bili service，模型绕不过去）

| 护栏 | 实现 |
|---|---|
| 命令白名单 | 20 命令硬编码；未列入 400；无逃生舱（不存在 run_bili） |
| 写默认预演 | `bili.allow_writes` + 显式 `dryRun:false` 双条件 |
| 限频 | 读 30/h、写（含 audio）5/h；按 bot 统计 `audit_logs` |
| 审计 | 每次调用写 `audit_logs`（`category=tool_call`，`action=bili_<cmd>`，argv 脱敏 + 超长截断 + 记录 dryRun/exitCode/errorCode） |
| 无 shell | `spawn(bin, argv, {shell:false})` 直传数组 |
| 超时 | 默认 60s（可配 `timeoutMs`），超时 SIGKILL |
| 凭证安全 | 不回传、不写日志、错误/审计/lastProbe 脱敏；credential 0600 |
| 输出目录 | audio 固定 `${LITTLY_DATA_DIR}/downloads/bili`，禁用户 `-o` |

---

## 8. 部署

- `deploy/Dockerfile`：运行层 `pip3 install --break-system-packages bilibili-cli==0.6.2`（失败不阻塞）；
  `ENV BILI_CLI_HOME=/app/bili-data BILI_BIN=bili`；`VOLUME ["/app/bili-data"]`。
- `deploy/docker-compose.yml`：**没有 bili 服务**；harness 服务挂 `bili-data:/app/bili-data` 并设
  `BILI_CLI_HOME=/app/bili-data`。`BILI_SIDECAR_URL` / `BILI_SIDECAR_TOKEN` / `BILI_ALLOW_WRITES` 已废弃。
- `sidecars/bili/` 已删除；`verify-bili-sidecar.mjs` 已删除。

---

## 9. 测试

- `harness/scripts/verify-bili.mjs`（**140 断言**，fake `bili` + 本地 mock passport，不联网）：
  允许清单 / 空 argv / 危险参数 / 写默认预演 / 开关放行 / audio 输出目录与 --yes /
  信封解析（exit 1 = 未登录）/ 错误码映射 / 超时 / 二进制缺失 / status / 浏览器提取（成功+失败删凭证）/
  扫码 generate+poll 三态+确认 / credential schema+0600+buvid 合并 / 限频 30-5 / 审计 /
  凭证不打印（错误/审计/lastProbe 三处脱敏）/ 工具注册 / 旧 MCP 收敛门 / 插件装配。
- `harness/scripts/verify-e2e.mjs`：新增 `/api/bili/*` 的 12 条断言（status / cmd 参数校验 /
  settings 写开关往返 / qr 未知会话），不依赖外网，真实 harness 进程内跑。
- `harness/scripts/verify-final.sh`：本地断言段加入 `verify-bili.mjs`；compose 编排不再有 bili profile。

---

## 10. 风险与边界（必须写进她的人格约束）

- **非官方接口**：passport / web 接口随时可能改版；CLI 与 B 站无关，失效时按上游报错停手。
- **风控**：自动化总有风险；`risk_control`/`captcha` 语义 = **立即停止一切写操作**，永远不尝试绕过
  （不换号、不延时循环、不刷量）。建议用正常使用过一段时间的账号，不要新号。
- **内容合规**：她发布的一切默认是 AI 生成内容；不冒充真人经历、不群发私信、不刷屏。
- **凭证安全**：credential.json 0600；任何代码/日志/接口不得打印或外发；审计日志不落 Cookie 原文。
- **浏览器提取只在运行本服务的机器上有效**：容器部署默认没有浏览器 → 请用扫码。
- **audio 落盘**：下载/切分会产生文件（默认每段 25s WAV），注意卷空间；固定目录便于清理。
- **写操作范围有限**：`coin` 单次 1-2 枚、无本地每日投币上限（只有 5 次/小时写限频）；
  需要更严格预算时在 `service.ts` 加日限。
