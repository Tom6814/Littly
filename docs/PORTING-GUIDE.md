# dsh 移植指南（子代理调研产物，2026-10-25）

> 适用：把 `harness/`（dsh fork @22ddee3）改造为 Littly 业务 agent 底座。所有结论带 `文件:行号`（以 vendor 基线为准）。

## 0. 总览

- monorepo(pnpm)：`apps/cli`（dsh 启动器）、`apps/web`（浏览器前端）、`packages/*`（约 100 个插件包）、`vendor/*`（Cordis 4.0.0-rc.7 等，改名发布为 `@deepseek-ai/*`）。
- **每个产品部件都是插件**，包括模型适配器、工具注册表、会话日志与 agent 循环本身（`docs/architecture.md:9`）。
- 词汇：`docs/glossary.md`（seam / scope / turn / step / human command）。Host(Node) 与 Client(浏览器) 两套 TS 编译面（`docs/development.md:59-75`）。

## 1. 启动与容器（Cordis）

- `Context` 是运行时代理：`ctx.provide(name, value)` 写服务（`vendor/cordis/src/reflect.ts:246-258`），`inject` 声明依赖后才能读 `ctx.<key>`（`reflect.ts:144-159`）；`ctx.plugin()` 挂子插件。
- 事件五种派发：`emit / waterfall / parallel / serial / bail`（`docs/cordis-primer.md:17-25`）；waterfall 是 around 中间件（监听器拿 `(...args, next)`）。
- 可逆副作用：`ctx.effect(execute, label)`（`vendor/cordis/src/fiber.ts:415-417`），disposer 逆序执行。
- `Service` 基类：构造即 `ctx.reflect.provide(name, this)`（`vendor/cordis/src/service.ts:46-60`），异步初始化放 `[Service.init]`。
- **启动链**：`apps/cli/src/bin.ts:26-74` → `profile-boot.ts:271-353` `runProfile()`：bundle 层（profile `package.json` 的 `dsh.profile.bundles` 顺序）→ profile 自身 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch` 覆盖层。profile 根配置为空条目列表（`profile-boot.ts:81-85`），插件树全由补丁组成。SIGTERM/SIGINT → fiber.dispose。
- 失败策略：required 插件失败整体退出（`packages/boot/app-boot/README.md:96-113`，required 清单含 `agent-loop`、`tool-executor-native`、`tool-executor-ptc`、`webserver`、`web-runtime`、`modules`、`connection`、`headless-runner`、`acp`、`sdk-jsonrpc-server`）。
- `dsh --profile <name> --dump-config` 打印组合树。

## 2. 插件系统

三种定义（`docs/cordis-tutorial/01-first-plugin.md:53-77`）：函数插件导出 `apply(ctx, config)` + 可选 `name` / `inject` / `Config`（schemastery）；对象插件 `{name, apply}`；类插件 `extends Service`。config 支持 `!!js` 表达式。

包清单：profile 包声明 `dsh.profile.bundles`；bundle 包声明 `dsh.bundle.patch`（`docs/architecture.md:21`）。加载源：npm/git/tarball/`file:`/`link:`/profile 相对路径。

**`dsh plugin add`**（`apps/cli/src/plugin.ts:81-106`）：向 `$DSH_HOME/profiles/<name>` 执行 `pnpm add`，先做兼容性预检（`engines.dsh` 或对 `@deepseek-ai/dsh*` 的 peer 范围）；安装的 bundle 默认自动启用（`packages/boot/plugin-manager/README.md`）。

**事件钩子**（`docs/event-producer-consumer.md`）：
- `tools/*`（`packages/core/tools/src/events.ts:17-56`）：`pre-execute`(waterfall allow/deny/cancel/ask)、`execute`、`post-execute`、`result`(emit 只读)、`change`。
- `agent/*`（`packages/core/agent/src/runtime-types.ts:290-429`）：`created/disposed/error/status/inbox/*`、`pre-step`(可改写本步输入)、`request-error`、`turn-stopping`。
- 其他：`session/created|event|flush`、`system-prompt/assemble|change`、`llm/stream`、`schedule/resolve-agent`、`approval/request`、`user-questions/request`。

**最小真实插件范本** = `packages/preset/persona/src/index.ts`（scope-only persona section 注册，可直接当 persona 业务插件底子）。

## 3. 工具

`defineTool`（`packages/core/tools/src/schema.ts:484-633`）：

```ts
defineTool({
  name, description,
  parameters: ParameterSchemaSpec,
  output: { schema: ValueSchemaSpec, render(args, value): ContentBlock[], presentationMeta? },
  async execute(args, exec: ToolRunContext),
  // timeoutMs / isConcurrencySafe / presentCall / presentResult / deferLoading 可选
})
```

- 入参先校验（`ToolArgsError`）、lossless-JSON 快照深冻结；返回值校验冻结后交 `render`；失败一律 `isError`。
- `exec`（`contracts.ts:244-261`）：`token/callId/agent/signal` + `deferContext()` + `concludeTurn()`；`exec.agent.inject({content, source})` 注入持久上下文。
- 呈现：`ToolsService` 向 systemPrompt 注册 tool provider（`core/tools/src/index.ts:113-117`）；每步 `ctx.tools.resolve()`（`agent-loop/src/agent.ts:285`）→ `systemPrompt.assemble()`。
- 权限三件套：`pre-execute` 决策（`contracts.ts:356-361`）→ `ctx.approval` seam 作答（缺失 fail-closed）→ `ctx.tools.guard()` 单调 deny + 沙箱预设（`bundle/base/cordis.patch.yml:240-276`）。

## 4. Skills

`ctx.skills`（`packages/skill/skill/src/index.ts`）：`SkillProvider{name,list,get}`，rank 合并（bundled=600）；发现根（`skill-filesystem/src/index.ts:247-257`）：项目 `.dsh/skills`、`.agents/skills`、`customSkillDirs`、`$DSH_HOME/skills`、bundled。frontmatter：`name`(kebab) + `description` 必填，`whenToUse/disable-model-invocation/user-invocable` 可选。模型经 `skill` 工具取正文（`tool-skill`），目录摘要在每 turn 前缀注入。

## 5. MCP（仅客户端）

`packages/mcp/mcp-client`：stdio + streamable-http（index.ts:52-104）；工具名 `mcp__<serverName>__<rawName>`；Config：`transport/serverName/toolCallTimeoutMs(60s)/failOnStartupError(false)/maxInstructionBytes(32k)/reconnect`；服务器 instructions 以署名 section 进系统提示。接入 = 补丁里插一行 `@deepseek-ai/dsh-mcp-client`。

## 6. 定时任务

`ScheduleService`（`packages/schedule/schedule/src/index.ts:110-239`）+ `ScheduleRuntime`（`runtime.ts:21-169`）单 timer：到期任务 → `schedule/resolve-agent` waterfall → `createUserMessage({source:{kind:'schedule'}})` → **`agent.followup()`** → `sessions.flush()`。周期类型 `after/at/every/daily/weekly/cron`；持久化走 storage domain `schedule`（`storage.ts:49-60`）；模型工具 `schedule_create/list/update/delete`。**直接复用为 Littly 调度器底座。**

## 7. LLM 适配层

pi-ai 体系：`dsh-llm-pi-ai` 依赖 `@earendil-works/pi-ai@^1.3.0`。seam `ctx.llm = LlmRuntime`（`packages/llm/llm/src/index.ts:354`）；抽象基类唯一必实现 `stream(options): AsyncIterable<StreamChunk>`（208-303）；`ctx.llm.registerAdapter(providers[], adapter)`（401-430）。**零代码自定义 provider**：pi-ai 手写路由 YAML（`api: openai-completions`、`baseURL`、`compat.thinkingFormat`、models 列表；`llm-pi-ai/src/index.ts:29-55`）+ `llm-pi-ai:` settings 提供密钥；base bundle 已挂 `llm-pi-ai` 休眠行（`bundle/base/cordis.patch.yml:135-136`）。`llm/stream` waterfall 可拦截；重试由 `dsh-llm-retry`。

## 8. 会话与循环

- `ctx.sessions` 事件溯源 append-only JSONL（`core/session`）；事件词表 `KNOWN_SESSION_EVENT_TYPES`（`known-event-types.ts:32+`）：`turn/start|end`、`step/start|end`、`system/message`、`user/message`、`assistant/message|attempt`、`tool/call|result` 等。**模型可见即已入日志**。
- `ctx.agents`：`create/resume`（`core/agent/src/index.ts:416/435`）；句柄：`send/followup/steer/inject/model.select/agent.ctx`（`runtime-types.ts:230-273`）。
- `AgentLoop`（`agent-loop/src/index.ts:291-371`）`inject=['agents','sessions','llm','tools','systemPrompt','sessionProjections']`；每步 `tools.resolve → systemPrompt.assemble → pre-step → llm.stream → tools.execute → step/end → turn-stopping → turn/end`。
- SystemPrompt：section/context/variable/tools 全 scoped（`core/system-prompt/src/index.ts`）；槽位表 `SECTION_ORDERS`（136-184）；**部署人设 = personaPrefix/personaSuffix 配置（263-284，覆盖点名 `deployment:persona-prefix`）**；`system-prompt/assemble` waterfall 可整体改写。
- 子代理 provider：`spawn-in-process / fork-in-process / acp / codex / claude-code / dsh-sdk`。

## 9. HTTP/API

- `ctx.webServer`（`host/webserver/src/index.ts`）：named route（exact|prefix）+ **`registerUpgrade`（WS 升级）+ `registerFallback`（SPA）**；SSE 支持（hmr 就是这么做的）。
- `ctx.connection`：浏览器会话认证 + `POST /api/<ns>/<method>` RPC + **WS 多路复用 `/api/remote.mux`**（`api/gateway/src/stream-protocol.ts:7`）。
- 业务 API 声明：**Typert `@Remote`**（`docs/api-gateway.md`）：继承 `TypertRemoteService`，Host 描述符 + Client 挂载；`mode:'stream'` 走 mux WS。现成 Remote 面：`session-controller/job-controller/settings-controller` 等。
- 四种 shipped profile：`web`（HTTP+GUI）/`headless`/`sdk`（stdio JSON-RPC）/`acp`。**Littly 控制台 = 自定义 profile（裁剪 base + webserver + connection + 自有 @Remote / SSE 路由）**，MUI 前端独立仓库目录；官方 web UI 可选挂 `dsh-web-app`。

## 10. 剥离清单（coding 专属）

剥离（不删包，改 profile/bundle patch 层不选）：`fs` 全家、`shell/subprocess/terminal`、`sandbox/ssh`、`plan/todo/workspace/deliverables/lsp`、`browser-use/computer-use/experimental`、DeepSeek 专属（`session-log-deepseek`、`credentials/deepseek-account`、`llm-deepseek*`、`web-search-deepseek`、`account-controller`）、遥测 otel、`acp` 与外部 agent 桥、编码技能（`skill-office` 等）。

保留内核：`vendor/*`；core `session/agent/agent-loop/tools/system-prompt/scope/agent-default-model/tool-executor-native`；`llm` 栈；session 持久化/投影/query；storage 三件套；interaction 四件套；skill 三件套；`schedule/jobs`；boot 全组；`api gateway/remotes/remote-access/session-controller/job-controller/settings-controller`；`client/connection/modules/hmr`；`attachment/spill/compaction/settings/preset`；`host/webserver/frontend-static`。`tool-web` 可留作通用联网。

## 11. 渠道插件落点

每个渠道 = 函数插件，`inject: ['agents']`（+按需 `sessionController`）：
- 入站：`ctx.agents.create/resume` → `agent.followup(createUserMessage({content, source:{kind:'telegram'|'snowluma'|...}}))`；自定义来源参照 `packages/schedule/schedule/src/runtime.ts:4-8` 做声明合并。
- 出站：监听 `session/event` 的 `assistant/message`（+`agent/status`），按 sessionId→渠道映射发送；经持久化投影防重放。
- **Littly 缓冲窗口（15~20s 合并 + exactly-once）作为独立业务服务**，渠道插件把原始入站交给缓冲服务，到期后由缓冲服务一次性 followup。

## 12. 落地顺序

1. 建自家 profile（空 bundle 起步）→ `dsh --profile <name> --dump-config` 逐层加回「保留清单」行；coding 工具全不选。
2. 业务插件用 `dsh plugin --profile <name> add ./path`（`file:`/`link:` 均可）安装；第三方 dsh 插件同法。
3. persona/memory/scheduler 对照 `dsh-persona`、`dsh-schedule` 改写；console-api 用 Typert @Remote + `/api/remote.mux` 流（或直接 webServer 注册 SSE 路由）。
4. 自定义 provider 优先 pi-ai 路由配置（零代码），确需协议定制再写 LlmAdapter。
5. 注意：`docs/subsystems/*.md` 有 `type-equiv` 锁定（`pnpm run doc-sync`）——接口语义以这些文档为准，移植期可暂关该 gate。

## 13. 我们的包布局（落地决策）

pnpm workspace 根保持 `harness/`（其脚本/tsconfig 假设根在此）。**业务包放进 `harness/packages/littly/*`**（`packages/*/*` glob 天然覆盖）：`littly/storage`、`littly/persona`、`littly/memory`、`littly/agents`、`littly/scheduler`、`littly/identity`、`littly/growth`、`littly/voice`、`littly/console-api`、`littly/channel-snowluma`、`littly/channel-telegram`、`littly/channel-wechat`、`littly/channel-qq`、`littly/channel-discord`。`littly/` 仓库根只放 console/（独立 Vite 应用）、sidecars/、deploy/、docs/。

## 14. storage 插件骨架（会编译通过）

见调研原文（关键点：`defineDomain({name:'mystorage', version:1, tables:{...}})` + `inject:['storageDomain']` + `ctx.storageDomain.open(spec)` + `ctx.provide('myStorage', service)`；自定义后端实现 `StorageBackend` 后 `ctx.storage.backend.register()`。范本：`packages/storage/storage-json/src/index.ts:104-119`；domain 消费范本：`packages/schedule/schedule/src/index.ts:149-193`）。
