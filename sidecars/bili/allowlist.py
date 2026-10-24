"""Curated command allowlist for the Littly bili sidecar.

Matching is done on the leading non-flag tokens of `argv` (after the group),
longest first — e.g. ["dm", "autoreply", "keyword", "add"] matches the key
"autoreply keyword add". Derived from the upstream command table (README
「全部命令」, verified against `bili schema` — 108 commands) and the guardrail
surface in bili_cli/guard.py.

Kinds:
    read   — never mutates anything; free to call.
    write  — mutates Bilibili state as the account; the wrapper forces
             --dry-run unless the request explicitly opts out AND
             BILI_ALLOW_WRITES=1 is set in the container.

Groups absent from this file (mcp / skills / asr / auth login / auth logout)
are hard-rejected by the wrapper. `auth login/logout` are excluded on purpose:
login is managed exclusively by the sidecar's /auth/qr/* endpoints so
concurrent /cmd calls cannot clobber a pending scan.
"""

from __future__ import annotations

from typing import Literal

Kind = Literal["read", "write"]

ALLOWLIST: dict[str, dict[str, Kind]] = {
    # ---- account (login managed via /auth/* endpoints)
    "auth": {"status": "read"},
    "schema": {},  # whole-group read (self-description); handled in classify()
    "owner": {"show": "read", "set": "write", "clear": "write"},
    "me": {
        "show": "read", "stats": "read", "favs": "read",
        "set-sign": "write", "set-name": "write", "set-avatar": "write",
    },
    # ---- watching / browsing
    "video": {
        "info": "read", "stats": "read", "subtitle": "read", "danmaku": "read",
        "summary": "read", "chapters": "read", "watch": "read", "frames": "read",
        "transcribe": "read",  # needs an ASR engine; errors cleanly if unset
        "relation": "read",
        "like": "write", "coin": "write", "fav": "write", "triple": "write",
    },
    "search": {"video": "read", "user": "read"},
    "hot": {"popular": "read", "search": "read", "weekly": "read", "precious": "read", "rank": "read"},
    "feed": {
        "inbox": "read", "replies": "read", "mentions": "read", "likes": "read",
        "system": "read", "notifications": "read", "recommend": "read", "timeline": "read",
    },
    "user": {
        "info": "read", "videos": "read", "following": "read", "blocked": "read",
        "follow": "write", "unfollow": "write", "block": "write", "unblock": "write",
    },
    # ---- social
    "comment": {
        "list": "read", "replies": "read", "check": "read", "emotes": "read", "images": "read",
        "post": "write", "reply": "write", "like": "write", "delete": "write", "pin": "write",
    },
    "dm": {
        "list": "read", "read": "read", "send": "write",
        # B 站自带私信自动回复（>=1000 粉）
        "autoreply show": "read", "autoreply set": "write", "autoreply on": "write",
        "autoreply off": "write", "autoreply keyword add": "write",
        "autoreply keyword delete": "write",
    },
    # ---- publishing
    "dynamic": {"list": "read", "show": "read", "post": "write", "delete": "write", "vote": "write"},
    "danmaku": {
        "send": "write", "recall": "write",
        # interactive components attach only to her own videos
        "interact vote": "write", "interact rating": "write", "interact reserve": "write",
        "interact link": "write", "interact follow": "write", "interact list": "read",
        "interact remove": "write",
    },
    "upload": {
        "list": "read", "status": "read", "stats": "read", "zones": "read",
        "chapters show": "read", "chapters set": "write", "chapters clear": "write",
        "video": "write", "edit": "write",
    },
    "season": {"list": "read", "create": "write", "add": "write", "remove": "write", "delete": "write"},
}

# Groups the wrapper never executes, with the reason surfaced to the caller.
REJECTED_GROUPS: dict[str, str] = {
    "mcp": "MCP 服务器/客户端配置由容器与 harness 管理，不允许经 /cmd 操作。",
    "skills": "skills install 会写入宿主机 Agent 配置，仅限人在终端执行。",
    "asr": "语音转写引擎部署/切换（下载 GB 级模型、写云配置）仅限人在控制台操作；转写本身走 `video transcribe`。",
}

# Subcommands of auth that bypass the /auth/* flow are rejected by name.
REJECTED_AUTH_SUBS = {"login", "logout"}

# Wrapper-level daily caps for real (non-dry-run) executions, keyed by
# "group/sub" falling back to the group default. Defense in depth on top of
# the CLI's own hourly rate limits (bili_cli/guard.py LIMITS).
DEFAULT_DAILY_CAPS: dict[str, int] = {
    "comment": 30,
    "dm": 20,
    "dm/autoreply": 20,
    "dynamic": 10,
    "danmaku": 30,
    "danmaku/interact": 20,
    "video/like": 60,
    "video/coin": 5,      # mirrors the CLI's hard daily coin limit
    "video/fav": 60,
    "video/triple": 20,
    "user": 20,
    "upload": 3,
    "upload/chapters": 10,
    "season": 20,
    "me": 10,
    "owner": 4,
}


def classify(argv: list[str]) -> tuple[Kind, Literal["read", "write", "reject"], str]:
    """Return (kind, verdict, reason) for a token vector (without leading `bili`)."""
    if not argv:
        return "read", "reject", "空命令。"
    group = argv[0]

    if group in REJECTED_GROUPS:
        return "write", "reject", REJECTED_GROUPS[group]
    if group == "auth" and len(argv) > 1 and argv[1] in REJECTED_AUTH_SUBS:
        return "write", "reject", "登录/登出由 sidecar 的 /auth/* 端点统一管理。"
    if group == "schema":
        return "read", "read", ""

    subs = ALLOWLIST.get(group)
    if subs is None:
        return "read", "reject", f"命令组 `{group}` 不在白名单内。"

    kind = _match(subs, argv)
    if kind is not None:
        return kind, kind, ""
    if group == "dm" and len(argv) > 1 and argv[1] == "autoreply":
        return "read", "reject", "`dm autoreply` 需要子命令（show/set/on/off/keyword …）。"
    return "read", "reject", (
        f"`{' '.join(argv[:2])}` 不在白名单内。运行 `bili {group} --help` 查看可用子命令。"
    )


def _match(subs: dict[str, Kind], argv: list[str]) -> Kind | None:
    """Longest-prefix match over the leading non-flag tokens after the group."""
    limit = len(argv)
    for i, tok in enumerate(argv[1:], start=1):
        if tok.startswith("-"):
            limit = i
            break
    for n in range(min(limit, 4), 0, -1):
        key = " ".join(argv[1:1 + n])
        if key in subs:
            return subs[key]
    return None


def daily_cap(argv: list[str]) -> int | None:
    """Wrapper-level per-day execution cap for a write command (None = read/uncapped)."""
    group = argv[0]
    tokens = [t for t in argv[1:] if not t.startswith("-")]
    # most specific first: "video/coin" beats "upload" group default
    for key in ([f"{group}/{tokens[0]}"] if tokens else []) + [group]:
        if key in DEFAULT_DAILY_CAPS:
            return DEFAULT_DAILY_CAPS[key]
    return None
