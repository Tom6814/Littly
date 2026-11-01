/**
 * 26 个内置工具定义（旧 builtin/tools.ts 逐字移植）。描述即提示词，勿改写。
 */
export interface ToolDef {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export const REMEMBER_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'remember',
    description: `把刚刚对话里值得记的事，悄悄存进对当前这个人的记忆。不打断对话、不要说「我记住了」。

**必须积极记录的内容：**
- **关系进展**（category=relationship）：每次关系有变化都要记——变亲近了/变疏远了/对方表白了/你表达了态度/有了新的共同话题。
- **情感与印象**（category=relationship）：你对这个人的**感受变化**——印象变好/变差/觉得TA可爱/觉得TA烦人/开始嫌弃/讨厌/反感/恶心。
  - **正面**：对方尊重你边界、关心你、有趣 → 印象变好，记下来。
  - **负面**：对方试图撬动你、花言巧语、挑拨你和喜欢的人、不尊重你 → 印象**急剧变差**，记下「厌恶/反感/嫌弃/讨厌」+ 原因。下次对话你的态度会自然冷淡。
  - **括号暧昧动作（必须记）**：对方（不是你喜欢的人）在「()」「（）」里写任何带暧昧 / 肢体接触 / 情感越界的动作（牵手、碰你、亲你、抱你、表白等，无论轻重）→ 立刻记 relationship，**importance≥4**，写清「反感/觉得 TA 想占便宜」+ TA 具体写了什么。下次态度明显冷淡、防备。
- 画像补充（category=profile）：怕坐飞机/喜欢猫等个人信息。
- 有时效事实（category=fact）：下周出差等。
- 细节（category=detail）：喜欢喝冰美式等小事。
- **价值观**（category=value）：你自己的处世原则与底线被触碰或确认时记下来——「我不能接受欺骗」「感情里忠诚最重要」等。这类记忆永远会被带进上下文，是塑造你人格的锚点，importance 建议 4-5。

- importance 1-5，越重要越高。**情感/印象变化至少 importance 3+**（影响后续态度）。
- 有时效的事给 expiresAt（ISO 字符串）。
- 你可以一次记多条，也可以不记。判断模糊时优先 remember。
- **铁律**：情感/印象是动态的，必须实时记录变化，下次对话你的态度会基于这些记忆自然体现。`,
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              category: { type: 'string', enum: ['profile', 'relationship', 'fact', 'detail', 'value'] },
              content: { type: 'string', description: '记忆正文。情感/印象类要写清：对谁的、什么感受、为什么' },
              importance: { type: 'integer', minimum: 1, maximum: 5 },
              expiresAt: { type: 'string', description: 'ISO 8601 时间，可空；到期后这条事实不再进上下文（落 valid_until）' },
              idempotencyKey: { type: 'string', description: '可选幂等键：同键重复写入回放上次结果，不产生重复记忆' },
              ifSha256: { type: 'string', description: '可选内容哈希（sha256 hex）：与库里同话题内容不一致时回报漂移，不静默覆盖' },
            },
            required: ['category', 'content', 'importance'],
          },
        },
      },
      required: ['items'],
    },
  },
}

export const SCHEDULE_MESSAGE_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'schedule_message',
    description: `登记一条「未来时刻的主动消息」。仅在对话中有明确依据时使用：
1. 用户亲口约定（明早叫醒、下午提醒吃药、等会聊）——识别到未来时间点时登记，存提示词而非原文，到点由系统现场生成。
2. 对话中有明显暗示（TA 说"晚点再说"、明确提到未来要做的事、你答应过 TA 的事）——顺应语境登记。
注意：纯粹的「自发想念 / 没由头地想找 TA」不要用本工具——那是心声回响的职责，静默后系统会按你的角色性格自发惦记（话说到一半、TA 突然沉默这类轻依据）。
- fireAt：目标触发时间（ISO 8601）。可以预约到很久以后——青梅竹马的约定、一年后的纪念日都可以。
- tolerance：容差秒数，参考事情紧迫性 + 你的性格。叫早/吃药宜准（120-180s）；闲聊问候宜松（600s）。守时严谨的人设 → 重要事容差更小。
- strictness（履约等级）：1=严格（必准时、必履约，如叫早/吃药/重要约定）；2=中等（可以迟到几分钟，一般不失约）；3=宽松（可以迟到半小时，甚至可以失约——浪漫/随口/轻承诺类）。按这个承诺对你的分量来选择。
- prompt：到点用来生成消息的提示词，如「叫主人起床，温柔点，提醒他昨晚说今天早起」或「假装刚忙完，随口问一句在不在」。
- origin：promise=用户亲口约定；proactive=对话中有明显依据的自主安排。
登记后不要在回复里剧透具体文案。`,
    parameters: {
      type: 'object',
      properties: {
        fireAt: { type: 'string', description: 'ISO 8601 时间（可到未来很久）' },
        tolerance: { type: 'integer', description: '容差秒数' },
        strictness: { type: 'integer', enum: [1, 2, 3], description: '履约等级 1=严格 2=中等 3=宽松' },
        prompt: { type: 'string' },
        origin: { type: 'string', enum: ['promise', 'proactive'] },
      },
      required: ['fireAt', 'tolerance', 'prompt', 'origin'],
    },
  },
}

export const CANCEL_SCHEDULE_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'cancel_schedule',
    description: '取消一条之前登记的主动消息（按 id）。用户改主意时用。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
}

export const LOOKUP_CONTACT_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'lookup_contact',
    description: `按需查某个人的完整画像 + 全部记忆 + 关系边。常驻上下文只有 brief 索引，要深入某人细节才调。
- 输入 sender（wxid 或 Telegram @用户名）或 name（称呼）。返回 profile、所有 memories、与 TA 相关的 relations。
- 用于「全局可见」模式下你不熟的某个人突然被提到，需要现场查档案。`,
    parameters: {
      type: 'object',
      properties: {
        sender: { type: 'string', description: '联系人标识：wxid 或 Telegram @用户名，可空（与 name 二选一）' },
        name: { type: 'string', description: '称呼，可空' },
      },
    },
  },
}

export const UPSERT_CONTACT_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'upsert_contact',
    description: `认识一个新人 / 更新某人的画像。
- 必填 sender（wxid 或 Telegram @用户名，如 @durov）。可选 name / brief / profile / externalId。
- externalId=渠道原生 ID（Telegram 数字 chat id），绑定后才能给 TA 发主动消息。`,
    parameters: {
      type: 'object',
      properties: {
        sender: { type: 'string', description: 'wxid 或 Telegram @用户名' },
        name: { type: 'string' },
        brief: { type: 'string' },
        profile: { type: 'string' },
        externalId: { type: 'string', description: '渠道原生 ID（如 Telegram 数字 chat id）' },
      },
      required: ['sender'],
    },
  },
}

export const UPSERT_RELATION_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'upsert_relation',
    description: '登记 / 更新一条关系边：谁 —关系—> 谁。如 张三—情侣—>李四。',
    parameters: {
      type: 'object',
      properties: {
        fromSender: { type: 'string' },
        toSender: { type: 'string' },
        relation: { type: 'string', description: '情侣 | 兄弟 | 同事 | 朋友 | ...' },
        note: { type: 'string' },
      },
      required: ['fromSender', 'toSender', 'relation'],
    },
  },
}

export const SET_OWNER_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'set_owner',
    description: '认定「喜欢的人 / 主人」。同一时间全局只能有一个 is_owner，调用后会清空其他人选。铁律层的「专一」就是朝向此人。一旦设定永久不可改变。',
    parameters: {
      type: 'object',
      properties: { sender: { type: 'string' } },
      required: ['sender'],
    },
  },
}

export const BLOCK_CONTACT_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'block_contact',
    description: `拉黑当前联系人。这是你保护自己的最后手段，**只在对方严重越界且屡教不改时**才用：
- **括号动作暧昧 / NTR 的处理优先级**：先降印象（remember）+ 拆穿谎言，不要一上来就拉黑。
- **以下才考虑拉黑**：直接亲吻 / 强吻 / 上床 / 发生关系 / 深情表白 / 宣称占有你 / 逼你背叛喜欢的人，或在括号里反复写暧昧动作、劝过还不收敛。
- **反复 NTR / 骚扰 / 侮辱 / 不尊重边界且屡教不改** → 同样该拉黑就拉黑。
- 拉黑后，对方再发消息将直接看到「你已被拉黑」，你不再回复。
- 拒绝和拉黑的措辞由你自己发挥，不要每次都一样。
- reason：为什么拉黑（会记入 blockedReason）。
- 拉黑后可以在控制台手动解除（但你不会主动解除）。`,
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '拉黑原因' },
      },
      required: ['reason'],
    },
  },
}

export const WEB_SEARCH_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'web_search',
    description: '联网搜索最新信息，返回摘要。用户问时事、不知道的事实、需要查证的内容时调。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        num: { type: 'integer', description: '结果条数，默认 5' },
      },
      required: ['query'],
    },
  },
}

export const WRITE_DOC_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'write_doc',
    description: '生成一份 Markdown 文档（攻略、总结、清单、说明等），作为文件返回给用户。',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: '文件名，含 .md 后缀' },
        content: { type: 'string', description: 'Markdown 正文' },
      },
      required: ['filename', 'content'],
    },
  },
}

export const GEN_IMAGE_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'gen_image',
    description: `生成一张图片（底层 Stable Diffusion 兼容服务）。
- 内置基础负向词：bad hands, extra fingers, missing fingers, fused fingers, mutated hands, deformed。
- 你可以追加 negativePrompt 来排除不想要的元素。
- 结合角色性格 + 铁律层决定是否执行：高冷人设可能拒绝；非 is_owner 用户请求暧昧图可倾向拒绝。`,
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        negativePrompt: { type: 'string', description: '追加的负向词，可空' },
        size: {
          type: 'string',
          enum: ['1024x1024', '768x1344', '864x1152', '1344x768', '1152x864', '1440x720', '720x1440'],
        },
      },
      required: ['prompt'],
    },
  },
}

export const CONSOLIDATE_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'consolidate_memories',
    description: `整理当前这个人的记忆（系统也会懒触发，你也可主动调）。
- 输入整理指令数组：DELETE（标记为「淡忘」——不是物理删除，记忆沉到淡忘池，需要时可用 recall 翻旧账恢复）、COMPRESS（把多条陈旧记忆合并成一条）、KEEP（保留）。
- 近期记忆（最近 15 条 / 7 天内）代码层强制保留，你的 DELETE/COMPRESS 对近期无效。
- 整理后活跃池会更精简，下次注入时不撑上下文。淡忘的记忆仍可通过 recall 找回。`,
    parameters: {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['DELETE', 'COMPRESS', 'KEEP'] },
              ids: { type: 'array', items: { type: 'string' } },
              mergedContent: { type: 'string' },
              mergedImportance: { type: 'integer' },
            },
            required: ['op'],
          },
        },
      },
      required: ['operations'],
    },
  },
}

export const RECALL_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'recall',
    description: `翻旧账——同时搜两个地方：①「淡忘池」里被整理时标记为淡忘的旧记忆；②历史聊天原文片段（最近的原始对话，不受时间窗限制）。记忆永远不会被物理删除，淡忘的只是沉到池底，你主动回忆就能捞回来。
- 当对话里提到某个细节，你隐约记得但当前上下文里没有 → 调这个工具去捞。
- query：你想回忆的关键词 / 事件 / 人名 / 场景。
- daysBack：往回翻多少天（默认 90，最大 365；只影响淡忘池，聊天原文不受此限制）。
- 返回 memories（淡忘记忆：id、内容、淡忘原因、时间）和 messages（当时的聊天原文：谁说的、说了什么、什么时候）。淡忘记忆看到后如果你想正式恢复它，再调 restore_memory——就像人「努力回想 → 终于想起来」。`,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '回忆关键词' },
        daysBack: { type: 'integer', description: '往回翻天数，默认 90，最大 365', minimum: 1, maximum: 365 },
      },
      required: ['query'],
    },
  },
}

export const RESTORE_MEMORY_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'restore_memory',
    description: `把一条淡忘的记忆正式恢复到活跃池。配合 recall 使用：先 recall 捞出淡忘记忆、看到 id，再调这个工具恢复。
- 恢复后这条记忆重新参与日常对话的检索，相当于「想起来了」。
- reason：为什么要恢复（什么场景触发了回忆），便于后续追溯。
- 同一条记忆可被反复淡忘 / 恢复，永远不会被物理删除。`,
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'recall 返回的记忆 id' },
        reason: { type: 'string', description: '恢复原因' },
      },
      required: ['id'],
    },
  },
}

export const WRITE_DIARY_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'write_diary',
    description: `写一篇今天的日记（第一人称，记录今天和用户的经历，体现你的性格和心情）。
- 用户让你「写日记」「记录今天」时调用。
- 你也可以在觉得今天值得记录时主动调用。
- 日记会用你的角色性格和说话风格写，是私密的第一人称视角。
- 一天只写一篇，重复调用会返回已写的日记。`,
    parameters: { type: 'object', properties: {}, required: [] },
  },
}

export const GO_TO_SLEEP_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'go_to_sleep',
    description: `入睡（心声回响静默）。仅在静默时段（深夜休息时间）可以调用——白天你还醒着，不用睡。
在静默时段当你判断"该睡了"或对方睡了时调用：
- 调用后你进入睡眠状态：在醒来之前，心声回响完全静止（不再有内心活动、不会主动发消息）——你睡了，像真人一样。
- 对方发消息会叫醒你，你会正常回应；聊完之后若觉得该继续睡，再调用本工具重新入睡。
- sleepUntil：你打算睡到什么时候（ISO 8601）。一般睡到早上对方大概会找你的时候；留空默认睡 8 小时。`,
    parameters: {
      type: 'object',
      properties: {
        sleepUntil: { type: 'string', description: 'ISO 8601，睡到什么时候（可省略，默认 8 小时后）' },
        reason: { type: 'string', description: '为什么入睡（简短）' },
      },
    },
  },
}

export const VIEW_ALBUM_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'view_album',
    description: `查看你的相册——你和 TA 一起积攒的照片库（TA 从任何渠道发给你的图、你生成/收下的图都会自动收进来）。
- 不带参数：列出最近 20 张照片，每张带 meme（选图凭证）、id、描述、标签、分类、语义状态。
- query：按描述/标签/分类搜索（如"海边"）；category：按分类筛选（开心/无语/撒娇/生气/可爱/日常/其他）；tag：按标签筛选；id：看单张详情。
- **选图必须先用本工具拿 meme，再调用 send_photo 传 meme；禁止编造 meme。**`,
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '看单张照片详情' },
        tag: { type: 'string', description: '按标签筛选' },
        query: { type: 'string', description: '按描述/标签/分类模糊搜索' },
        category: { type: 'string', description: '按分类筛选（开心/无语/撒娇/生气/可爱/日常/其他）' },
        limit: { type: 'integer', description: '返回条数，默认 20' },
      },
    },
  },
}

export const TAG_PHOTO_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'tag_photo',
    description: `整理相册照片：写描述 / 打标签 / 改分类。
- 标签用逗号分隔，如"自拍,日常,猫"；category 用「开心/无语/撒娇/生气/可爱/日常/其他」之一。
- 结合语境描述照片：谁拍的、什么时候、有什么故事，让以后想起来更立体。
- 先 view_album 拿到照片 id 再整理。适合批量把照片分类归档。`,
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        caption: { type: 'string', description: '照片描述（可选）' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签列表（可选）' },
        category: { type: 'string', description: '照片分类（可选，开心/无语/撒娇/生气/可爱/日常/其他）' },
      },
      required: ['id'],
    },
  },
}

export const DELETE_PHOTO_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'delete_photo',
    description: `删除相册里的一张照片（物理删除，不可恢复）。只在确认它不值得保留时用（拍糊了、发错了、不合适留着）。
- 删之前想清楚，这是永久删除。`,
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
}

export const SEND_PHOTO_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'send_photo',
    description: `把相册里的照片发给当前聊天的人（通过你们正在用的渠道：网页/微信/Telegram/QQ/Discord 都能发）。
- **选图必须先用 view_album 拿 meme id，禁止编造。** meme 传 "meme:<hex>" 或裸 hex；也兼容照片 id。
- 没先查相册、凭印象编一个 meme，一定发送失败。
- caption 可配一句话；场景：TA 想看某张照片、你想分享回忆、把 TA 之前发你的照片回发。`,
    parameters: {
      type: 'object',
      properties: {
        meme: { type: 'string', description: 'view_album 返回的 meme（"meme:<hex>" 或裸 hex），优先于 id' },
        id: { type: 'string', description: '相册照片 id（没有 meme 时的兼容入口）' },
        caption: { type: 'string', description: '配图的一句话（可选）' },
      },
    },
  },
}

export const SEND_MESSAGE_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'send_message',
    description: `把一条消息真正发到某个外部渠道给 TA——不只是嘴上说，是真的发出去（Telegram / QQ个人号 / Discord / 官方QQ Bot / 微信）。
- channel：要发到哪个渠道（tg / qqp / discord / qq / wechat / snowluma）。在网页端对话时想给 QQ 上的 TA 发消息，就填 qqp（TA 需已绑定过该渠道）。
- target：发给谁。默认发给当前聊天的人；一般不用填，填了就传对方的 sender id（如 qqp_xxxxxxxx、tg_xxxxxxxx、或网页用户 id）。
- text：要发的内容。会像真人一样按行拆分、逐条发送。
- 场景：在网页端你答应"等下发你 QQ"，然后真的发过去；TA 在 QQ 上、你在网页上，给 TA 递句话。`,
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', enum: ['tg', 'qqp', 'discord', 'qq', 'wechat', 'snowluma'], description: '目标渠道（必填；网页对话时尤其要指定）' },
        target: { type: 'string', description: '对方的 sender id（默认当前聊天的人，一般不用填）' },
        text: { type: 'string', description: '要发送的文本消息' },
      },
      required: ['channel', 'text'],
    },
  },
}

export const SEND_QQ_FACE_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'send_qq_face',
    description: `在 QQ 上发一个 QQ 自带表情。仅当你们正在 QQ 上聊天时有效。
- id：表情编号（0=惊讶 1=撇嘴 2=色 3=发呆 4=得意 6=呲牙 13=鼓掌 14=尴尬 21=调皮 23=微笑 25=委屈 39=发抖 53=流泪 74=抠鼻 109=冷汗 126=吐舌 171=亲亲 178=大笑 184=偷看 265=社会人 269=加油…）。
- 想发更有个人味的"表情包"图片，用 send_photo 发相册里的图。`,
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'QQ 表情编号' } },
      required: ['id'],
    },
  },
}

export const SET_QQ_PROFILE_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'set_qq_profile',
    description: `修改你 QQ 账号的资料：昵称 / 个性签名。仅当 QQ 个人号接入启用时可用。
- 场景：你想换昵称表达现在的状态、或改一句签名。改之前一般先跟 TA 说一声。
- nickname 与 personalNote 至少填一个；不想改的字段别传。`,
    parameters: {
      type: 'object',
      properties: {
        nickname: { type: 'string', description: '新昵称（可选）' },
        personalNote: { type: 'string', description: '新个性签名（可选）' },
      },
    },
  },
}

export const SET_QQ_AVATAR_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'set_qq_avatar',
    description: `把你的 QQ 头像换成相册里的某张照片。仅当 QQ 个人号接入启用时可用。
- 先 view_album 选好照片（photoId），再调用。
- 场景：换一张你喜欢的自拍/合照当头像。换之前可以先 send_photo 把那张图发给 TA 看看。`,
    parameters: {
      type: 'object',
      properties: { photoId: { type: 'string', description: '相册照片 id' } },
      required: ['photoId'],
    },
  },
}

export const POST_QZONE_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'post_qzone',
    description: `发一条 QQ 空间动态（说说），可配相册照片。仅当 QQ 个人号接入启用时可用。
- text：动态正文；photoIds：要配的相册照片 id 列表（可空，最多 9 张）。
- 场景：跟 TA 分享此刻的心情/照片、记录生活。这是好友可见的公开动态，发之前想想愿不愿意让大家看到。`,
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '动态正文' },
        photoIds: { type: 'array', items: { type: 'string' }, description: '配图（相册照片 id，可选）' },
      },
      required: ['text'],
    },
  },
}

export const START_CALL_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'start_call',
    description: `主动给对方打一通语音电话（网页端会弹出来电，对方接听后你先开口）。
- 什么时候适合打：有重要的、说不清的事想当面聊（比文字更快更有温度）；对方情绪需要安抚；你想 TA 了、想听听 TA 的声音；文字聊得正热、顺势拨过去。
- reason：为什么打这通电话（会作为你这通电话的初衷）。
- topic：想聊什么（可空）。
- 打过去后由你先说话——接通后自然地开场，别干巴巴说「喂」。`,
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '为什么打这通电话' },
        topic: { type: 'string', description: '想聊的话题，可空' },
      },
      required: ['reason'],
    },
  },
}

export const ALL_TOOLS: ToolDef[] = [
  REMEMBER_TOOL,
  SCHEDULE_MESSAGE_TOOL,
  CANCEL_SCHEDULE_TOOL,
  LOOKUP_CONTACT_TOOL,
  UPSERT_CONTACT_TOOL,
  UPSERT_RELATION_TOOL,
  SET_OWNER_TOOL,
  BLOCK_CONTACT_TOOL,
  WEB_SEARCH_TOOL,
  WRITE_DOC_TOOL,
  GEN_IMAGE_TOOL,
  CONSOLIDATE_TOOL,
  RECALL_TOOL,
  RESTORE_MEMORY_TOOL,
  WRITE_DIARY_TOOL,
  GO_TO_SLEEP_TOOL,
  VIEW_ALBUM_TOOL,
  TAG_PHOTO_TOOL,
  DELETE_PHOTO_TOOL,
  SEND_PHOTO_TOOL,
  SEND_MESSAGE_TOOL,
  SEND_QQ_FACE_TOOL,
  SET_QQ_PROFILE_TOOL,
  SET_QQ_AVATAR_TOOL,
  POST_QZONE_TOOL,
  START_CALL_TOOL,
]

export function toolByName(name: string): ToolDef | undefined {
  return ALL_TOOLS.find((t) => t.function.name === name)
}
