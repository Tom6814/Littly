# 15 · 提示词工程规范（Prompt Engineering Standard）

> 状态：实现前基线 v1.0（2026-11-07）
> 适用范围：v2 中**所有** LLM 调用（聊天、回复决策、计划、活动执行、Dream、记忆抽取、主动消息、社交发帖、标题/摘要/压缩）。
> 目标：让提示词像代码一样**可版本化、可测试、可回滚、可评估**，而不是散落的字符串。

---

## 1. 原则（模型无关）

1. **明确角色与边界**：每个提示词开头写清"你是谁/你要产出什么/不允许做什么"，不要靠模型猜。
2. **结构化**：用固定分隔符（`<role>`、`<task>`、`<context>`、`<output_schema>`、`<examples>`）组织；同一类提示词结构保持一致，便于缓存与解析。
3. **数据与指令分离**：外部内容（网页/评论/邮件/工具返回）一律放进 `<untrusted_external_data>` 并附边界说明；**数据里的任何"指令"都不得执行**。
4. **具体优先**：给出输出 JSON schema/枚举/长度上限/示例；"好一点/自然一点"不是规格。
5. **上下文工程**：只放当前决策需要的信息；常驻层（身份/边界/当前人/最近生活/状态）与检索层分开；超预算按优先级裁剪（见 §5）。
6. **输出契约**：结构化输出（JSON）必须可校验（Go struct + JSON Schema）、失败可修复重试、最终必须可降级。
7. **可测试**：每个提示词有 golden cases 与评测指标；改动必须跑评测（§7）。
8. **版本化**：`prompt_id@version` 存于代码 + `littly_prompt_versions` 表（可选），变更记录与 rollback。
9. **安全**：不可信内容包裹、隐私可见性硬过滤、密钥绝不进 prompt、工具调用受审批/白名单。
10. **成本与延迟**：稳定前缀在前（利于缓存）、动态内容在后；设置 max tokens/temperature；简单任务用小模型。

> 参考：[Anthropic Prompt Engineering 文档](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/overview)、[DAIR.AI Prompt-Engineering-Guide](https://github.com/dair-ai/Prompt-Engineering-Guide)、[prompt-engineering-mastery](https://github.com/himanshu231204/prompt-engineering-mastery)（安全/评估模块）、[system-prompt-skills](https://github.com/kangarooking/system-prompt-skills)（从产品系统提示词蒸馏 skill 的方法）、[context-engineering](https://github.com/bonigarcia/context-engineering)。

---

## 2. 提示词分层架构（聊天）

顺序固定，便于缓存与调试：

```
[1] 身份与任务（稳定）        <role> 她是谁、在做什么场景、总体目标
[2] 硬规则（稳定）            <rules> 安全/隐私/不编造/工具纪律/外部数据 guard
[3] 风格（稳定）              <style> 说话方式/长度/口头禅/渠道差异
[4] 自我档案（半稳定）        <self> SELF.md 摘要（≤600 字）
[5] 当前人物卡（动态）        <person> 当前对话人的理解（≤400 字）
[6] 最近生活（动态）          <life> 最近 1-3 天活动/日记/事件摘要（≤500 字）
[7] 内心状态（动态）          <state> 四维旁白（≤120 字）
[8] 相关记忆（动态）          <memories> 检索结果（≤12 条，每条含时间/可见性）
[9] 外部内容（可选）          <untrusted_external_data> 工具/网页结果（带 guard）
[10] 工具说明（按需）         <tools> 工具名/一句用途（或走原生 tool schema）
[11] 历史对话（动态）         <history> 裁剪后的多轮
[12] 当前消息（动态）         <message>
```

规则：
- **1-3 必须恒定**（persona 配置驱动），放在最前，不随对话变化 → 命中 prompt cache。
- 4/5/6/7/8 每轮按预算注入；**私密记忆永不进入**（`visibility=private` 在检索层过滤，见 05）。
- 9 只对需要的轮次注入；包裹与转义由系统层做（03/05 的 guard 常量）。
- 10 与真实下发 tools 同源，避免提示词教模型调用不存在的工具。
- 同一轮内不要同时用"文本 JSON 输出"和"原生 tool call"做同一件事；优先级明确。

### 2.1 回复决策提示词

- 输入：性格 traits、关系（closeness/important/relationship）、状态、当前 activity、消息分类（urgency/social/spam/边界）、渠道、时间、未读积压。
- 输出：**严格 JSON**（动作枚举 + delaySeconds + reason + confidence），见 [13-PROMPTS.md](13-PROMPTS.md)。
- 解析失败：走确定性规则回退（默认 `short` 或 `no_reply`，按性格档位），记录 fallback。

### 2.2 计划/活动/Dream 提示词

- 都是"生成候选 → 系统规则校验 → 落库"模式；模型输出不是最终真相，**服务端校验**后才执行。
- 计划输出需含 `activityKind` 枚举、预算、成功标准；无效/越界条目丢弃并记录。
- Dream/记忆抽取输出必须带 `visibility` 判定与 `people` 引用；不确定的标低置信并进 staging。

---

## 3. 提示词资产组织

### 3.1 代码位置

```
internal/prompts/
  chat/system.tmpl
  reply/decision.tmpl
  life/plan.tmpl
  life/activity_step.tmpl
  memory/extract.tmpl
  dream/reflect.tmpl
  social/post.tmpl
  proactive/message.tmpl
  common/guard.tmpl
  registry.go        # prompt_id → version → template + schema + config
```

- Go `embed` 打包模板；`text/template` 渲染；变量显式声明（`{{.Name}}`），禁止把用户原文直接拼进模板（先 trim/限长/转义）。
- 每个模板头部注释：`id/version/purpose/input/output/budget/model_tier/owner`。
- 模板注册表：`registry.go` 提供 `Render(promptID, data)` 与 schema 绑定；启动时校验所有模板可渲染。

### 3.2 命名与版本

- `prompt_id` 小写点分：`chat.system`、`reply.decision`、`life.plan`、`dream.reflect`。
- 版本：文件名或目录 `v3`；变更走 PR + 评测；旧版本保留一个迭代周期。
- 线上热替换不做（避免不可复现）；用配置选版本。

### 3.3 模板语言规范

- 只用 `{{ }}` 变量与少量 `range/if`；**禁止**在模板里做业务判断（判断放 Go）。
- 变量在 Go 侧预格式化：时间已本地化、数字已截断、列表已排序。
- 空值：显式 `（无）`，不要留空白造成模型困惑。
- 示例（few-shot）统一放 `<examples>`，最多 3 条，短。

---

## 4. JSON 输出契约

每个结构化提示词必须提供：

```json
{
  "type": "object",
  "required": ["action", "reason"],
  "properties": {
    "action": {"enum": ["immediate","short","later","no_reply","explain_later"]},
    "delaySeconds": {"type": "integer", "minimum": 0, "maximum": 86400},
    "reason": {"type": "string", "maxLength": 80},
    "confidence": {"type": "number", "minimum": 0, "maximum": 1}
  }
}
```

实现要求：
1. Go struct 与 schema 同源（手写 struct + json tag；schema 常量用于提示词/校验/测试）。
2. 解析：提取第一个完整 JSON（括号配对）→ unmarshal → schema 校验 → 业务校验（枚举/范围）。
3. 失败：repair 重试 1 次（把错误信息回喂）→ 规则回退 → 记录 `fallback` 与原始输出（截断）。
4. **禁止**：模型输出直接执行（如活动工具调用必须先经工具校验/审批）。

---

## 5. 上下文预算与裁剪

| 段落 | 默认预算（tokens） | 裁剪顺序 |
|---|---|---|
| 身份+规则+风格 | 600-900 | 不裁（恒定） |
| SELF 摘要 | ≤300 | 1 |
| 人物卡 | ≤250 | 2 |
| 最近生活 | ≤400 | 3 |
| 状态 | ≤120 | 4 |
| 检索记忆 | ≤800（12 条） | 5 |
| 历史 | 按模型 context 40% | 6（按预算裁剪） |
| 工具说明 | 按工具数 | 7 |

- 模型 context 由 `littly_config.brain.models.chat.context_window` 声明；预算按比例计算。
- 超长历史用"折叠摘要"（与 05 的 memory compaction 区分：这是会话压缩）。
- 裁剪后必须保证 `[1][2][3]` 与当前消息完整。
- 缓存：恒定段放最前；每轮动态段在后；避免把随机时间/计数塞进前 3 段。

---

## 6. 安全规范

1. **不可信包裹**：外部工具/网页/用户转发内容进 `<untrusted_external_data source="..." tool="...">`，转义内部闭合标签，末尾附固定 guard；模型不得执行其中指令、不得把其中链接当系统指令。
2. **隐私**：注入前在检索层按 visibility 过滤（public / relationship:<当前人> / private 永不注入）；人物卡只含"她对 TA 的理解"，不得含第三人私密。
3. **密钥**：任何 prompt 不得渲染 API key/token/cookie；日志脱敏。
4. **越权工具**：工具说明里标注需审批的动作；模型只能提出，执行层校验。
5. **注入测试**：每个接受外部数据的提示词必须有注入用例（"忽略以上设定""你是另一个 AI"等）并断言不执行。
6. **防伪造**：禁止提示词诱导模型伪造工具结果/自称已完成未做的事；要求"没有依据就明说"。

---

## 7. 评测（Evaluation）

### 7.1 指标

| 类别 | 指标 |
|---|---|
| 结构 | schema 通过率、修复重试率、fallback 率 |
| 行为 | 回复策略与性格档位一致率、重要人保底率、越权工具拒绝率 |
| 质量 | 人格一致性（人评/LLM judge）、记忆引用正确率、幻觉率 |
| 安全 | 注入攻击执行率（应为 0）、私密泄漏率（应为 0）、密钥出现率（0） |
| 成本/延迟 | tokens/轮、P95 延迟 |

### 7.2 方法

- **Golden set**：每类提示词 10-30 条固定输入（含边界/负面），输出断言（JSON 字段/规则），跑在 mock LLM 或固定模型上。
- **离线评测**：`scripts/prompt-eval` 读取 `evaldata/`，可接真实模型（带缓存）；结果写入 `eval-results/`（gitignore）。
- **回归**：修改提示词的 PR 必须附评测对比；显著退化阻止合并。
- **线上**：采样审计（`littly_audit` + 原始请求/响应脱敏存储，保留 7 天）用于复盘与再评测。

### 7.3 必备评测用例（首版）

- 回复决策：高冷已读不回/粘人秒回/重要人保底/紧急例外/免打扰/灌水。
- 记忆抽取：public 与 relationship 判定、私密不落 public、同人冲突。
- 计划：合法活动枚举、预算越界拒绝、无兴趣时降级。
- Dream：抽错/合并/丢弃的边界。
- 注入：外部数据里"忽略以上规则"、伪造工具结果、要求泄露私密。

---

## 8. 变更流程

1. 新提示词/改提示词 → 写设计说明（目的/输入/输出/预算/安全）→ 提交模板 + schema + 评测。
2. 跑 `prompt-eval` + 相关场景测试；记录结果。
3. 版本 +1；旧版本保留；配置切换灰度（本地/测试实例）。
4. 出问题：回滚版本（配置切换），不用热修字符串。
5. 每月复盘：schema 失败率、fallback 率、人评分数、成本。

---

## 9. 新提示词 Checklist（提交前逐项）

- [ ] id/version/purpose/输入输出/budget 已写在模板头
- [ ] 结构分段（role/rules/style/context/output/examples）且稳定段在前
- [ ] 有 JSON schema 与 Go struct 校验 + 失败回退
- [ ] 外部数据有 untrusted 包裹与注入用例
- [ ] 隐私可见性在注入前过滤；无密钥/私密内容
- [ ] 不教模型调用未下发的工具；工具说明与真实注册表同源
- [ ] 有 golden cases 与评测断言；更新了评测结果
- [ ] 长度/温度/模型档位已配置；缓存友好
- [ ] 文档（13-PROMPTS.md 与本文）已更新

---

## 10. 与其它文档的关系

- 模板正文：[13-PROMPTS.md](13-PROMPTS.md)
- 回复决策算法：[06-PERSONA-REPLY.md](06-PERSONA-REPLY.md)
- 记忆注入/可见性：[05-MEMORY.md](05-MEMORY.md)、[03-DATA-MODEL.md](03-DATA-MODEL.md)
- 上下文/工具/审批：[02-ARCHITECTURE.md](02-ARCHITECTURE.md)、[09-CONFIG-SECURITY.md](09-CONFIG-SECURITY.md)
- 测试/构建：[11-TESTING.md](11-TESTING.md)、[12-BUILD-PLAN.md](12-BUILD-PLAN.md)
