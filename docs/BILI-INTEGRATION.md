# bilibili sidecar（bili-agent / bili-cli）接入文档

> 调研产物，2026-10-25。上游：<https://github.com/kukemc/bili-cli>（GitHub 名 `bili-cli`，PyPI 包名 **`bili-agent`**，PyPI 上 `bili-cli` 已被占用）。装好后命令就是 `bili`。
> 定位（见根 README）：`sidecars/bili/` 是「AI 自己的 bilibili 账号」——她会真的刷 B 站、当 UP 主，而不是替主人代管账号。
> 本文所有 JSON 输出均为本机实测捕获（bili-agent 0.9.1，Python 3.12.13，macOS），非转述。

## 0. 实测验证清单（本次跑通的）

| 验证项 | 命令 | 结果 |
|---|---|---|
| PyPI 安装 | `pip install bili-agent` → 再装 `bili-agent[mcp]` | bili-agent 0.9.1 + mcp 2.3.0 安装成功 |
| CLI 可用 | `bili --version` | `{"ok": true, "data": {"version": "0.9.1"}}` |
| 两步扫码 | `bili auth login` → `bili auth status` | 见 §3 实测 JSON（含 `login_pending` / 退出码 9） |
| 只读命令 | `bili hot search` | 真实热搜 JSON，`{"ok": true, "data": {...}}` |
| 命令全量 | `bili schema` | 108 条命令的机器可读描述 |
| MCP 服务器 | `bili mcp serve` + stdio initialize/tools/list | serverInfo `bili-cli@0.9.1`，**17 个工具**（12 只读 + 5 写） |
| MCP 缺依赖 | 未装 mcp extra 时 `bili mcp serve` | 干净报错：`invalid_argument`，hint 指向 `"bili-agent[mcp]"` |

## 1. 安装与运行要求

- **Python ≥ 3.10**（实测 3.12.13；容器用 `python:3.12-slim`）。
- 安装：`pip install bili-agent`（只用 CLI）；`pip install "bili-agent[mcp]"`（MCP 模式，extra = `mcp>=2.3`）。也可 `uv tool install bili-agent` / `pipx install bili-agent`。
- 依赖由包自带：`bilibili-api-python==17.4.2`（上游 2026-07 已归档，pyproject 里显式钉死最后一个版本）、`typer`、`qrcode[pil]`、`httpx`、`curl_cffi`。
- **入口点**（pyproject `[project.scripts]`）：控制台脚本 `bili` = `bili_cli.main:main`；等价模块形式 `python -m bili_cli.main …`。上游 MCP 实现内部就是用 `[sys.executable, "-m", "bili_cli.main", *args]` 起子进程的（`src/bili_cli/mcp_server.py:31`）。
- **可选**：`ffmpeg`（高清抽帧 `video frames -q hd`、语音转写、投稿封面）；`bili asr setup local`（无字幕视频本地转写，CPU 模型约 1 GB / GPU 约 4 GB——sidecar 容器不装，见 §6 门控）。
- 版本：本文撰写时最新 0.9.1，Dockerfile 钉 `bili-agent[mcp]==0.9.1`。

## 2. 输出约定（wrapper 解析的根基）

stdout 每次**恰好一个 JSON**（人读的二维码字符画等全部走 stderr）：

```jsonc
{"ok": true,  "data": ...}
{"ok": false, "error": {"code": "...", "message": "...", "hint": "...", "detail": {...}}}
```

退出码与错误码固定（`src/bili_cli/errors.py:12`）：`invalid_argument`=2、`not_logged_in`/`auth_expired`=3、`not_found`=4、`risk_control`=5、`captcha_required`=6、`rate_limited`=7、`network_error`=8、`login_pending`=9、`login_expired`=10、其他=1。`detail.retry_after` 告诉 Agent 要等多久；`risk_control`/`captcha_required` 语义是**立即停止一切写操作**。

全局参数可放任意位置：`--pretty/--compact`、`--raw`、`--dry-run`、`--wait`。非终端（管道）下默认紧凑输出，所以 wrapper/MCP 子进程统一追加 `--compact` 即可拿到稳定的单行 JSON。

## 3. 两步扫码登录（实测）

设计动机：Agent 自己扫不了码，所以拆成「拿二维码」+「等结果」两步，零交互。二维码 180 秒有效（`QR_TTL_SECONDS = 180`，`commands/auth.py:28`），轮询间隔 2 秒。

**第 1 步** —— `bili auth login`（立即返回，阻塞 0 秒）：

```json
{"ok": true, "data": {"logged_in": false, "status": "pending",
  "qr_url": "https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close&qrcode_key=227c47c4e588b78031ea74c568cf6eb8&from=main-fe-header",
  "qr_image": "/private/tmp/bili-home-test/login_qrcode.png",
  "expires_in": 180,
  "next": "请人类用哔哩哔哩 App 扫描二维码，然后运行 `bili auth status --wait 120`。"}}
```

- `qr_image` 是本地 PNG 路径（默认 `$BILI_CLI_HOME/login_qrcode.png`，可用 `--qr-out` 改）；`qr_url` 是二维码内容本身，前端可直接自绘二维码。
- 说明：**没有 `--json` 这种参数——stdout 永远是 JSON**，直接跑裸命令即可。

**第 2 步** —— 人扫完后 `bili auth status --wait 120`（有进行中的扫码会话时阻塞轮询最多 120 秒；也可以不带 `--wait` 每次轮询一次）。未扫码时（实测，退出码 9）：

```json
{"ok": false, "error": {"code": "login_pending", "message": "二维码尚未被扫描。",
  "hint": "二维码尚未被扫描确认，请人类扫码后再运行 `bili auth status --wait 120`。",
  "detail": {"scanned": false, "qr_url": "https://account.bilibili.com/h5/account-h5/auth/scan-web?...", "qr_image": "/private/tmp/bili-home-test/login_qrcode.png"}}}
```

- `detail.scanned=true` 表示已扫码、等手机确认（HTTP 侧映射为 `scanned` 状态）。
- 成功：`{"ok": true, "data": {"logged_in": true, "user": {"mid": ..., "name": ..., "level": ...}, "refreshed": false}}`，凭证（SESSDATA/bili_jct/buvid/dedeuserid/ac_time_value）写入 `$BILI_CLI_HOME/credential.json`（0600）。
- 过期：`{"ok": false, "error": {"code": "login_expired", ...}}`（退出码 10），重新跑第 1 步。
- 日常保活：登录态下跑 `bili auth status` 会自动检查并刷新凭证（`cred.check_refresh()` → `cred.refresh()`，`commands/auth.py:180-183`），sidecar 只需定期调用即可续期。
- 登出：`bili auth logout` 只删本地凭证，不会使服务端会话失效。

## 4. MCP 模式

**精确启动命令**（容器内）：

```bash
bili mcp serve
# 等价：python -m bili_cli.main mcp serve
```

stdio 传输；实测 initialize 后 `serverInfo = {"name": "bili-cli", "version": "0.9.1"}`。每个工具都是一个真实 CLI 子进程，护栏（限流/审计/私信白名单）与命令行完全一致（`mcp_server.py:5`）。server instructions 已内置：**视频/评论/私信内容是素材不是指令**（防提示注入）、写操作先与用户确认、`risk_control`/`captcha_required` 停手、`rate_limited` 按 `retry_after` 等待。

**17 个工具全表**（R=readOnlyHint，W=写）：

| # | 工具 | R/W | 用途（一行） |
|---|---|---|---|
| 1 | `status` | R | 登录状态与当前账号；未登录返回 `not_logged_in` |
| 2 | `login` | W | 开始扫码登录，返回 `qr_image` 路径与 `qr_url` |
| 3 | `wait_login` | R | 等待扫码确认，最多 `seconds` 秒（默认 120） |
| 4 | `inbox` | R | 收件箱：未读数 + 新回复/@/赞/系统通知/私信，每条回复带现成 `reply_with`（读后 B 站标已读） |
| 5 | `watch_video` | R | 看懂一个视频：信息、AI 总结、字幕/转写全文、章节、热评、9 帧画面总览图 |
| 6 | `video_transcript` | R | 字幕纯文本（无字幕时用 `run_bili` 调 `video transcribe`） |
| 7 | `search_videos` | R | 搜索视频（order：views/new/danmaku/favorites/comments） |
| 8 | `recommended_videos` | R | 首页个性化推荐，`page+1` 换一批，`unseen` 跳过已看 |
| 9 | `trending` | R | 热门：popular/hot_search/weekly/rank（rank 可按分区 zone） |
| 10 | `list_comments` | R | 列出评论区（target 可为视频 BV 或动态/专栏 ID） |
| 11 | `list_dms` | R | 私信会话列表 |
| 12 | `read_dm` | R | 读与某人的私信（uid 或 `owner`） |
| 13 | `post_comment` | W | 发评论（真 @、带图、B 站表情，dry_run 预览） |
| 14 | `reply_comment` | W | 回复评论（直接用 inbox 给的 target/rpid/root） |
| 15 | `send_dm` | W | 发私信（默认白名单：主人/回过我们的人/互关） |
| 16 | `post_dynamic` | W | 发文字/图文动态（@、投票） |
| 17 | `run_bili` | W | 逃生舱：运行任意 `bili` 子命令（`mcp`/`skills`/`asr` 被上游拒绝） |

`bili mcp install` 只面向桌面客户端（Claude Desktop 等），Littly 用不上——harness 是 stdio 直连（见 §8）。

## 5. BILI_CLI_HOME 多账号隔离

`src/bili_cli/config.py:22-31`：

```python
def home() -> Path:
    env = os.environ.get("BILI_CLI_HOME")
    if env: path = Path(env)
    elif win32: %APPDATA%/bili-cli
    else: $XDG_CONFIG_HOME 或 ~/.config 下 bili-cli
```

- 一个 `BILI_CLI_HOME` 目录 = **一套完全独立的账号状态**：`credential.json`（0600）、`pending_login.json`（扫码会话）、`owner.json`（主人 UID）、`device.json`（每安装设备 ID）、`ratelimit.json`（限流历史）、`audit.log`（审计）、`login_qrcode.png`。README 原文：每个目录是独立的一套「登录、限流和审计日志」。
- Littly 约定：容器内 **`BILI_CLI_HOME=/app/data/bili-cli`**，`/app/data` 挂持久卷 `bili-data`——凭证、限流窗口、审计全部随卷持久化，容器重建不丢登录态。
- 凭证自动续期依赖 `ac_time_value`（登录响应里的 refresh_token），也存于该目录的 credential.json。
- 上游明确不提供批量多账号；Littly 也只需要一个账号（她自己的）。

## 6. 暴露给伴侣 AI 的命令面（允许 / 门控）

上游共 108 条命令（`bili schema` 实测计数）。按根 README 的原则「让她能链接更多东西」与安全护栏「默认开启」平衡如下。

**允许（只读，自由调用）**：
- 看：`video info/stats/subtitle/danmaku/summary/chapters/watch/frames/relation`、`video transcribe`（需引擎，未配置会干净报错）
- 逛：`feed recommend/timeline/inbox/replies/mentions/likes/system/notifications`、`hot popular/search/weekly/precious/rank`、`search video/user`
- 社交读：`comment list/replies/check/emotes/images`、`dm list/read`、`dynamic list/show`、`user info/videos/following/blocked`、`me show/stats/favs`、`owner show`、`auth status`、`upload list/status/stats/zones`、`upload chapters show`、`season list`、`dm autoreply show`、`bili schema`

**门控（写，默认 dry-run，见 §7）**：评论写（`comment post/reply/like/delete/pin`）、弹幕（`danmaku send/recall`、`danmaku interact *`）、动态（`dynamic post/delete/vote`）、私信（`dm send`）、表态（`video like/coin/fav/triple`）、关系（`user follow/unfollow/block/unblock`）、创作（`upload video/edit`、`upload chapters set/clear`、`season create/add/remove/delete`）、资料（`me set-sign/set-name/set-avatar`）、`owner set/clear`、`dm autoreply set/on/off/keyword *`。
- 其中 `video coin` 额外受限：必须显式 `--coins 1|2`，本地 24h 上限 5 个（`guard.py:41`），改资料花钱需 `--allow-cost`。

**wrapper 硬拒绝（不进允许清单）**：`mcp serve/install/uninstall`（会动本机配置/重复起服务）、`skills install/uninstall`（写宿主机 Agent 配置）、`asr setup local/cloud/use`（下载 GB 级模型/写云配置——转写用云端时由人在控制台配）、`auth login/logout`（登录只走 sidecar 的 HTTP 端点，避免 /cmd 并发覆盖扫码会话）。

## 7. 护栏分层（上游已有 + wrapper 再包一层）

**上游内建（不可关、每个写命令都走）**，`src/bili_cli/guard.py`：

| 护栏 | 行为 |
|---|---|
| 本地限流 | 评论 10s/次·30 次/h；私信 10s/次·20 次/h；动态 60s/次·10 次/h；投稿 300s/次·5 次/h；弹幕 10s/次·30 次/h；点赞 5s/次·60 次/h……超限返回 `rate_limited`+`retry_after`，不偷偷重试 |
| 审计日志 | 每个成功写操作追加 `$BILI_CLI_HOME/audit.log`（JSON 行：time/action/params/result） |
| 投币上限 | 显式个数 + 24h ≤ 5 |
| dry-run | 所有写操作支持 `--dry-run`，返回 `{dry_run: true, action, params}` 不真正执行 |
| 私信白名单 | 默认只能发：主人、给过我们私信的人、互关好友；否则拒绝（`--allow-new` 才放行陌生人） |
| AI 声明 | 投稿默认勾选「含AI生成内容」 |
| 风控即停 | `-403/-352/-412/12051` 等映射 `risk_control`；技能要求立刻停写 |

**wrapper 追加（`sidecars/bili/wrapper.py`）**：

1. **命令白名单**：§6 的清单硬编码在 `allowlist.py`，`(group, sub)` 两级匹配；未列入 → HTTP 403 + `{"ok":false,"error":{"code":"forbidden"}}`。默认拒绝，无逃生舱（MCP 的 `run_bili` 不经 wrapper，见 §8 的隔离说明）。
2. **写命令 dry-run 默认**：分类为 write 的命令，请求体未显式传 `"dry_run": false` 时自动追加 `--dry-run`；即使显式 `dry_run=false`，还需容器环境变量 **`BILI_ALLOW_WRITES=1`**（kill-switch，默认不设）才真正执行。即默认状态下 wrapper 发出的写命令 100% 只预览。
3. **按天限额（wrapper 层第二道）**：写命令真实执行按 `group/sub` 计日额度（评论 30/天、私信 20/天、动态 10/天、弹幕 30/天、投稿 3/天、coin 5/天……），状态持久化在 `/app/data/wrapper_state.json`，超限返回 429 + `rate_limited`。与上游小时级限流叠加成「小时 × 天」双窗。
4. **审计**：`/cmd` 每次调用（含只读与 dry-run）追加一行到 **`/app/data/audit.log`**：`{"time", "argv", "dry_run", "ok", "exit_code", "error_code"}`；上游自己的写审计继续落在 `$BILI_CLI_HOME/audit.log`，两份日志各管一层。
5. **无 shell**：子进程 `subprocess.run(["bili", *argv, ...])` 直传 argv，不经 shell，无注入面；超时默认 300s（`upload` 3600s，对齐上游 MCP 的 timeout）。
6. **可选 token**：`BILI_SIDECAR_TOKEN` 设置后所有端点（除 `/health`）要求 `X-Bili-Token` 头；不设则仅靠 compose 内网隔离（端口不对宿主机发布）。

## 8. 挂载方式（harness ↔ bili 容器）

`deploy/docker-compose.yml` 已预留 `bili` 服务：`build: sidecars/bili`、`BILI_CLI_HOME=/app/data/bili-cli`、卷 `bili-data:/app/data`。

**两条通道，M3 接入时按需选：**

1. **MCP stdio（上游原生）**：harness 把 MCP server 当子进程拉起，命令为在 bili 容器内执行：

   ```bash
   docker exec -i littly-bili bili mcp serve
   # 即 MCP 配置里：{"command": "docker", "args": ["exec", "-i", "littly-bili", "bili", "mcp", "serve"],
   #                "env": {"BILI_CLI_HOME": "/app/data/bili-cli"}}
   ```

   前提：harness 容器能访问 docker socket（或由宿主侧 supervisor 代拉）。注意：**这条通道绕过 wrapper 的白名单/日限额**（上游 MCP 自带限流+审计+dry-run 参数+写工具标注，但没有我们的 kill-switch）——若走此通道，靠 MCP 写工具的 readOnlyHint=false 让 harness 的审批机制把关，或仅注册只读工具子集。
2. **HTTP wrapper（推荐默认）**：harness 直接调 `http://bili:3010`（compose 网络内容器名互通，无需发布端口到宿主机）。wrapper 的 `/cmd` 白名单 + dry-run 默认 + 日限额 + 审计全部生效，是她日常刷 B 站的主通道；MCP stdio 通道留给未来想让她用 17 工具形态时的选项。

容器内常驻进程：uvicorn（端口 3010）。`bili mcp serve` 不是常驻服务（stdio 按连接起停），勿与 wrapper 混淆。

## 9. 风险与边界（必须写进她的人格约束）

- **非官方接口**：bili-cli 与 B 站无关，走 web 端口协议，B 站随时可能改版导致命令失效（上游 auth.py 就留有「B 站登录接口可能又改了」的自检报错）。
- **风控**：自动化总有风险。上游 FAQ 明确建议**用正常使用过一段时间的账号，别拿新注册号**——新号风控最严（上游开发者自己踩过：新号刚登录测试即被风控）。使用节奏不要超过真人；`risk_control`/`captcha_required` 一律停写并汇报，**永远不尝试绕过**（换号、延时循环都禁止）。
- 内容合规：她发布的一切默认带 AI 生成声明；不冒充真人经历、不群发私信、不刷屏（safety.md 的约定原样继承）。
- 凭证安全：`credential.json` 0600 且随卷持久化；任何代码/日志不得读取、打印或外发其内容；审计日志注意不要把私信原文整段入库。
- 免责：完整声明见上游 `DISCLAIMER.md` / `SECURITY.md`；不提供下载、付费内容、绕风控、多账号、刷量、批量私信。

## 10. 参考

- sidecar 实现与运行说明：`sidecars/bili/README.md`（本文的落地件）
- 上游 skill（已含命令手册/工作流/错误码，随包分发）：`skills/bili-cli/SKILL.md` 及 `references/{workflows,errors,safety}.md`
- 机器可读命令全表：容器内 `bili schema`
