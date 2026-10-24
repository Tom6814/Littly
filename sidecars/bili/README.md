# littly-bili sidecar

`bili-agent`（GitHub 名 [bili-cli](https://github.com/kukemc/bili-cli)）的 HTTP 包装 sidecar：她自己的 bilibili 账号，带命令白名单、写操作 dry-run 默认、按日限额与审计日志。调研与设计依据见 [`docs/BILI-INTEGRATION.md`](../../docs/BILI-INTEGRATION.md)。

## 运行

```bash
# 仓库根执行
docker build -f sidecars/bili/Dockerfile -t littly-bili sidecars/bili
# 或 compose：docker compose --profile bili up -d bili
```

容器内监听 **3010**，compose 网络内通过 `http://bili:3010` 访问（无需向宿主机发布端口；调试时临时 `-p 3010:3010`）。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `BILI_CLI_HOME` | `/app/data/bili-cli` | CLI 状态目录（凭证/限流/审计/待扫码会话），随 `bili-data` 卷持久化，多账号隔离单位 |
| `BILI_SIDECAR_DATA` | `/app/data` | wrapper 自身落盘目录（`audit.log`、`wrapper_state.json`） |
| `BILI_SIDECAR_TOKEN` | 未设 | 设置后除 `/health` 外所有端点要求请求头 `X-Bili-Token: <值>`；不设则仅靠内网隔离 |
| `BILI_ALLOW_WRITES` | 未设 | **写命令 kill-switch**。未设时所有写命令强制 `--dry-run`；设为 `1` 后，请求体显式 `"dry_run": false` 才真正执行 |
| `BILI_CMD_TIMEOUT` | `300` | /cmd 子进程超时秒数（`upload` 固定 3600，对齐上游 MCP） |
| `BILI_BIN` | `bili` | CLI 可执行文件路径（本地调试用） |

## 端点

| 方法/路径 | 作用 |
|---|---|
| `POST /auth/qr/start` | 生成登录二维码 → `{session_id, qr_url, qr_image_base64, expires_in:180}`（立即返回，不阻塞） |
| `GET /auth/qr/status?session_id=…` | 单次轮询扫码结果 → `{state: wait\|scanned\|confirmed\|expired, qr_image_base64?}` |
| `GET /auth/status` | 当前登录态（顺带自动续期凭证），上游 JSON envelope 原样透传 |
| `POST /cmd` | `{"argv":["video","watch","BV…"], "dry_run":null}` → `{exit_code, dry_run, result:<上游envelope>}`；白名单外的命令 403 |
| `GET /audit/tail?n=20` | 最近 n 条 wrapper 审计行 |
| `GET /health` | 存活探针（不要求 token） |

## 安全说明

- **默认拒绝**：`/cmd` 只执行 `allowlist.py` 白名单内的命令；`mcp`/`skills`/`asr` 与 `auth login/logout` 硬拒绝。
- **写命令三重门**：白名单 → dry-run 默认（`BILI_ALLOW_WRITES` kill-switch）→ 按日限额（`wrapper_state.json`）。上游 CLI 另有小时级限流、私信白名单、投币每日 5 个、AI 生成声明，全部继续生效。
- **审计**：`/cmd` 每次调用追加一行到 `/app/data/audit.log`；上游写审计在 `$BILI_CLI_HOME/audit.log`。
- **无 shell**：子进程直传 argv，无注入面。
- **凭证**：`credential.json`（0600）在 `BILI_CLI_HOME` 内随卷持久化；不要读取/打印/外发其内容。

## 本地开发（不进容器）

```bash
python3.12 -m venv /tmp/bili-venv
/tmp/bili-venv/bin/pip install -r requirements.txt "bili-agent[mcp]==0.9.1"
export BILI_BIN=/tmp/bili-venv/bin/bili BILI_SIDECAR_DATA=/tmp/bili-data BILI_CLI_HOME=/tmp/bili-data/bili-cli
/tmp/bili-venv/bin/uvicorn wrapper:app --port 3010
curl -s localhost:3010/health
```

## 风险提示（必读）

- bili-cli 是**非官方**项目，与哔哩哔哩无关联，走 web 端口协议，B 站改版可能导致命令失效。
- 自动化操作有风控风险：`risk_control` / `captcha_required` 错误码出现时**立即停止一切写操作**并转告人类，永远不要重试或绕过。建议使用正常使用过一段时间的账号（新号风控最严），使用节奏不要超过真人。
- 她发布的内容默认带「AI 生成」声明；不冒充真人经历、不群发私信、不刷屏。
