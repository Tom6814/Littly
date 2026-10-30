# Littly 控制台（Vue 3 重写版）

`console/` 是旧 React 版（由 Lead 在集成时替换）；本目录是新的 Vue 3.5 前端。

## 技术栈

- Vue 3.5 + Vite 8 + Tailwind 4（`@tailwindcss/vite`）+ vue-router 4
- 设计系统：本地 vendored `@felinic/ui`（`packages/ui`，pnpm workspace `workspace:*`）。
  视觉规则以 `packages/ui/AGENTS.md`、`packages/ui/skills/web/SKILL.md`、
  `packages/ui/skills/ui-owners/SKILL.md` 为准：**只用 token 与 owner 组件，不手写控件/颜色/阴影**。
- 无 pinia/vue-query：`src/stores/*` 是模块级 reactive 单例（auth / bots / onboarding / ui）。

## 开发

```bash
pnpm install
pnpm dev          # http://localhost:5173，/api 代理到 127.0.0.1:3000
# 或指向其它后端：
VITE_PROXY_TARGET=http://127.0.0.1:3101 pnpm dev
```

## 构建与校验

```bash
pnpm build        # vite build → dist/（后端 registerConsoleStatic 直接 serve）
pnpm typecheck    # vue-tsc --noEmit
node scripts/check-icons.mjs   # lucide 图标名校验（防版本改名导致构建期 MISSING_EXPORT）
```

## 目录

```
src/
  api/{client.ts,types.ts,endpoints.ts}   # 唯一数据入口：信封/401/类型化端点（盘点自 console-api）
  stores/{auth,bots,onboarding,ui}.ts     # 模块级单例状态
  components/
    AppShell.vue        # 桌面侧栏 + 移动端 Sheet 抽屉（同一份导航/账户/当前她）
    AppNav.vue BotSwitcher.vue AccountFooter.vue
    ChannelConfigPage.vue   # telegram/qq/discord 共用渠道配置+绑定
    CharacterFormFields.vue StubPage.vue
  pages/
    LoginPage RegisterPage OnboardingPage ChatPage
    her/ memory/ proactive/ contacts/ bind/ channels/ system/
  router.ts           # 22 条路由（已冻结）
  style.css           # 只 import @felinic/ui 样式 + app 级 token/字体规则
```

## 约定

- 页面只用 `src/api/endpoints.ts` 调接口；不直接 `fetch`。
- 成功信封 `{data}`、失败 `{error:{code,message}}`；鉴权走 httpOnly Cookie。
- 页面骨架统一 `PageShell`（`@felinic/ui`）→ `SettingsSection/SettingsRow/FieldStack`；
  破坏性操作 `ConfirmPopover`，弹窗表单 `FormDialogShell`。
- 所有按 bot 查询的页面用 `useBots().currentBotId`（与外壳切换器同一状态）。
- `/chat?sender=<id>` 可打开指定联系人会话（联系人页跳转用）。
