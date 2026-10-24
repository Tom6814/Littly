"""Littly bili sidecar — HTTP wrapper around the bili-agent CLI (`bili`).

Exposes a narrow, audited surface over bili-cli's JSON CLI:

    POST /auth/qr/start   start QR login           -> {session_id, qr_url, qr_image_base64, ...}
    GET  /auth/qr/status  poll one scan cycle      -> {state: wait|scanned|confirmed|expired, qr_image_base64?}
    GET  /auth/status     current login state      -> upstream envelope passthrough
    POST /cmd             allowlisted `bili ...`   -> {exit_code, dry_run, result: <envelope>}
    GET  /audit/tail      last audit lines
    GET  /health          liveness (no token)

Design notes:
- The CLI's stdout is ALWAYS exactly one JSON document ({"ok": ...}); there is
  no --json flag. We append --compact for deterministic single-line output.
- Writes are allowlisted separately and run with --dry-run unless the request
  sets dry_run=false AND the container sets BILI_ALLOW_WRITES=1.
- Every /cmd call appends one audit line to $BILI_SIDECAR_DATA/audit.log
  (upstream write audit continues to land in $BILI_CLI_HOME/audit.log).
- No shell is ever involved: subprocess argv only.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from pydantic import BaseModel, Field

import allowlist

log = logging.getLogger("bili-sidecar")

# ---------------------------------------------------------------- settings

BILI_BIN = os.environ.get("BILI_BIN", "bili")
DATA_DIR = Path(os.environ.get("BILI_SIDECAR_DATA", "/app/data"))
AUDIT_LOG = DATA_DIR / "audit.log"
STATE_FILE = DATA_DIR / "wrapper_state.json"
SIDECAR_VERSION = "0.1.0"

DEFAULT_TIMEOUT = int(os.environ.get("BILI_CMD_TIMEOUT", "300"))          # matches upstream MCP
UPLOAD_TIMEOUT = int(os.environ.get("BILI_UPLOAD_TIMEOUT", "3600"))
QR_TTL_GRACE = 10  # seconds of slack over the CLI's own 180 s QR lifetime

ALLOW_WRITES = os.environ.get("BILI_ALLOW_WRITES") == "1"
API_TOKEN = os.environ.get("BILI_SIDECAR_TOKEN") or None

_write_lock = threading.Lock()   # serializes write executions + cap/audit bookkeeping
_sessions: dict[str, dict[str, Any]] = {}

app = FastAPI(title="littly-bili-sidecar", version=SIDECAR_VERSION)


# ---------------------------------------------------------------- helpers

def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _audit(entry: dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(AUDIT_LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps({"time": _utcnow_iso(), **entry}, ensure_ascii=False, default=str) + "\n")


def _run_cli(argv: list[str], timeout: int) -> tuple[int, dict[str, Any]]:
    """Run `bili <argv> --compact`; return (exit_code, parsed envelope)."""
    cmd = [BILI_BIN, *argv, "--compact"]
    try:
        proc = subprocess.run(
            cmd, capture_output=True, stdin=subprocess.DEVNULL, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return 124, {"ok": False, "error": {"code": "network_error", "message": f"命令超过 {timeout} 秒未完成。"}}
    except FileNotFoundError:
        return 127, {"ok": False, "error": {"code": "internal_error", "message": f"找不到可执行文件 {BILI_BIN!r}。"}}
    try:
        return proc.returncode, json.loads(proc.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        tail = proc.stderr.decode("utf-8", "replace")[-800:]
        return proc.returncode, {"ok": False, "error": {"code": "internal_error", "message": tail or "stdout 不是合法 JSON。"}}


def _qr_image_base64(path_str: str | None) -> str | None:
    if not path_str:
        return None
    try:
        return base64.b64encode(Path(path_str).read_bytes()).decode("ascii")
    except OSError:
        return None


def _usage_key(argv: list[str]) -> str:
    return argv[0] + (f"/{argv[1]}" if len(argv) > 1 and not argv[1].startswith("-") else "")


def _load_state(today: str) -> dict[str, Any]:
    try:
        state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        state = {}
    if state.get("date") != today:
        state = {"date": today, "counts": {}}
    return state


def _daily_cap_exceeded(argv: list[str]) -> dict[str, Any] | None:
    """Return a rate_limited envelope when the wrapper's daily cap is exhausted."""
    cap = allowlist.daily_cap(argv)
    if cap is None:
        return None
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    state = _load_state(today)
    key = _usage_key(argv)
    used = int(state["counts"].get(key, 0))
    if used >= cap:
        return {
            "ok": False,
            "error": {
                "code": "rate_limited",
                "message": f"sidecar 每日额度：{key} 最多 {cap} 次/天，已用 {used} 次。",
                "hint": "今天的额度用完了，明天再试；不要换参数绕过。",
                "detail": {"action": key, "limit": {"per_day": cap, "used": used}},
            },
        }
    return None


def _record_usage(argv: list[str]) -> None:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    state = _load_state(today)
    key = _usage_key(argv)
    state["counts"][key] = int(state["counts"].get(key, 0)) + 1
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state), encoding="utf-8")
    os.replace(tmp, STATE_FILE)


# ---------------------------------------------------------------- auth dep

async def _check_token(
    x_bili_token: str | None = Header(default=None, alias="X-Bili-Token"),
) -> None:
    """Optional bearer-style gate: enforce only when BILI_SIDECAR_TOKEN is set."""
    if API_TOKEN and x_bili_token != API_TOKEN:
        raise HTTPException(
            status_code=401,
            detail={"ok": False, "error": {"code": "invalid_argument", "message": "缺少或错误的 X-Bili-Token 头。"}},
        )


# ---------------------------------------------------------------- models

class CmdRequest(BaseModel):
    argv: list[str] = Field(
        ..., min_length=1, max_length=24,
        description='命令 token，不含开头的 "bili"，如 ["video","watch","BV1GJ411x7h7"]',
    )
    dry_run: bool | None = Field(
        None,
        description="仅对写命令有意义：None=强制 dry-run；false=真实执行（还需容器 BILI_ALLOW_WRITES=1）；true=预览",
    )


# ---------------------------------------------------------------- endpoints

@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "littly-bili-sidecar",
        "version": SIDECAR_VERSION,
        "allow_writes": ALLOW_WRITES,
        "token_required": bool(API_TOKEN),
    }


@app.post("/auth/qr/start", dependencies=[Depends(_check_token)])
def auth_qr_start() -> dict[str, Any]:
    """Step 1: generate a login QR code. Never blocks; the human scans it."""
    rc, env = _run_cli(["auth", "login"], timeout=60)
    _audit({"source": "auth.qr.start", "argv": ["auth", "login"], "ok": bool(env.get("ok")), "exit_code": rc})
    if not env.get("ok"):
        raise HTTPException(
            status_code=502,
            detail={"ok": False, "error": env.get("error", {"code": "internal_error", "message": "unknown"})},
        )
    data = env["data"]
    if data.get("status") != "pending":
        return {"ok": True, "state": "confirmed", "user": data.get("user")}
    session_id = uuid.uuid4().hex
    _sessions[session_id] = {"started_at": time.time(), "expires_in": int(data.get("expires_in", 180))}
    return {
        "session_id": session_id,
        "qr_url": data.get("qr_url"),
        "qr_image_base64": _qr_image_base64(data.get("qr_image")),
        "expires_in": data.get("expires_in", 180),
        "next": "让人类用哔哩哔哩 App 扫描二维码并确认，然后轮询 GET /auth/qr/status?session_id=...。",
    }


@app.get("/auth/qr/status", dependencies=[Depends(_check_token)])
def auth_qr_status(
    session_id: str = Query(..., min_length=8, max_length=64),
) -> dict[str, Any]:
    """Step 2: single poll of the pending QR login (CLI supports --wait N; we poll per request)."""
    sess = _sessions.get(session_id)
    if sess is None:
        raise HTTPException(
            status_code=404,
            detail={"ok": False, "error": {"code": "not_found", "message": "未知 session_id，请重新 POST /auth/qr/start。"}},
        )

    rc, env = _run_cli(["auth", "status"], timeout=60)
    _audit({"source": "auth.qr.status", "argv": ["auth", "status"], "ok": bool(env.get("ok")), "exit_code": rc})

    age = time.time() - sess["started_at"]
    if env.get("ok"):
        data = env["data"]
        if data.get("logged_in"):
            _sessions.pop(session_id, None)
            return {"state": "confirmed", "user": data.get("user"), "age_seconds": round(age)}
        return {"state": "wait", "age_seconds": round(age)}

    err = env.get("error") or {}
    code = err.get("code")
    detail = err.get("detail") or {}
    qr_b64 = _qr_image_base64(detail.get("qr_image"))
    if code == "login_pending":
        scanned = bool(detail.get("scanned"))
        return {
            "state": "scanned" if scanned else "wait",
            "qr_image_base64": qr_b64,
            "age_seconds": round(age),
            "expires_in": max(0, int(sess["expires_in"]) - round(age)),
        }
    if code == "login_expired" or age > int(sess["expires_in"]) + QR_TTL_GRACE:
        _sessions.pop(session_id, None)
        return {"state": "expired", "age_seconds": round(age),
                "next": "重新 POST /auth/qr/start 获取新二维码。"}
    return {"state": "error", "error": err, "age_seconds": round(age)}


@app.get("/auth/status", dependencies=[Depends(_check_token)])
def auth_status() -> dict[str, Any]:
    """Login state of the persisted credential (also auto-refreshes it)."""
    rc, env = _run_cli(["auth", "status"], timeout=60)
    _audit({"source": "auth.status", "argv": ["auth", "status"], "ok": bool(env.get("ok")), "exit_code": rc})
    return {"exit_code": rc, "result": env}


@app.post("/cmd", dependencies=[Depends(_check_token)])
def cmd(req: CmdRequest) -> dict[str, Any]:
    """Allowlisted `bili <argv>` execution with audit + dry-run default for writes."""
    argv = req.argv
    if any(not isinstance(t, str) or not t.strip() or len(t) > 400 or "\x00" in t for t in argv):
        raise HTTPException(
            status_code=400,
            detail={"ok": False, "error": {"code": "invalid_argument", "message": "argv 必须是 1..400 字符的字符串数组。"}},
        )

    kind, verdict, reason = allowlist.classify(argv)
    if verdict == "reject":
        raise HTTPException(
            status_code=403,
            detail={"ok": False, "error": {
                "code": "forbidden",
                "message": reason,
                "hint": "允许清单见 sidecars/bili/allowlist.py 与 docs/BILI-INTEGRATION.md §6。",
            }},
        )

    is_write = kind == "write"
    effective_dry_run = is_write and not (req.dry_run is False and ALLOW_WRITES)

    run_argv = list(argv)
    if effective_dry_run:
        run_argv.append("--dry-run")

    timeout = UPLOAD_TIMEOUT if argv[:1] == ["upload"] else DEFAULT_TIMEOUT

    with _write_lock:
        cap_err = _daily_cap_exceeded(argv) if (is_write and not effective_dry_run) else None
        if cap_err is not None:
            _audit({"source": "cmd", "argv": argv, "dry_run": False, "ok": False,
                    "exit_code": 429, "error_code": "rate_limited", "scope": "wrapper_daily_cap"})
            raise HTTPException(status_code=429, detail=cap_err)

        rc, envelope = _run_cli(run_argv, timeout=timeout)

        if is_write and not effective_dry_run and envelope.get("ok"):
            _record_usage(argv)

    error_code = (envelope.get("error") or {}).get("code") if not envelope.get("ok") else None
    _audit({"source": "cmd", "argv": argv, "dry_run": effective_dry_run, "ok": bool(envelope.get("ok")),
            "exit_code": rc, "error_code": error_code})
    return {"exit_code": rc, "dry_run": effective_dry_run, "result": envelope}


@app.get("/audit/tail", dependencies=[Depends(_check_token)])
def audit_tail(n: int = Query(20, ge=1, le=200)) -> dict[str, Any]:
    """Last n audit lines (for the console/debugging)."""
    try:
        lines = AUDIT_LOG.read_text(encoding="utf-8").splitlines()[-n:]
    except OSError:
        lines = []
    return {"lines": [json.loads(line) for line in lines if line.strip()]}
