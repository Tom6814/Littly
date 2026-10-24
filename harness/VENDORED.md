# Vendored: DeepSeek Harness (dsh)

- Upstream: https://github.com/deepseek-ai/deepseek-harness
- Pinned commit: `22ddee3792402c3e70ec5f86a63c3e3e895a2f60` (2026-10-23, v0.2.1-rc.3)
- License: MIT（见 `LICENSE` / `THIRD_PARTY_NOTICES.md`，均随源码保留）

## 本 fork 的改造约定

- 目录改动：pruned `website/ benchmarks/ snapshots/ python/ apps/desktop apps/desktop-host apps/plugin-market-generator`；`pnpm-workspace.yaml` 与根 `package.json` 的 workspaces/scripts 已同步修剪。
- 包命名：暂保留 `@deepseek-ai/*` 原名以最小化 diff；M0 完成跑通后统一改名为 `@littly/*`。
- 后续改造（剥离编程-agent 专属部分、LLM provider profile 化、事件外露）在里程碑内以独立 commit 进行，本文件记录 vendor 基线。
- 上游为 developer preview（作者声明会有破坏性变更）：以本基线为准，只选择性吸收上游。
