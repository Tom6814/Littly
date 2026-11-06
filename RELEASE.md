# Littly v2.0.0 (hackathon build)

她不是助手，她是一个人。

## 交付内容

Memoh 硬分叉 + Littly v2 核心：

- **六面 UI**：`/littly/` 今天 / 她 / 记忆 / 工作台 / 世界 / 设置；`/` 自动跳转，旧 `/settings`、`/bots` 重定向。
- **单实例一个人**：核心 server 拦截第二次 bot 创建；数据按 `owner` 单例。
- **人格**：traits / SELF / 说话方式 / 边界；`system.littly_persona` 注入 Memoh 原生 agent。
- **回复策略**：immediate / short / later / no_reply，决策留痕。
- **记忆**：Markdown vault + Postgres `littly_state` + 规范化 `littly_*` 表；public/relationship/private；日记视图；`system.littly_memory` 注入最近非私密记忆。
- **人物**：分层（陌生/泛泛/朋友/亲密）、重要、手动调层、回收站搜索/恢复。
- **心跳**：保底 + 自心跳（reason 必填）+ 结构化裁决 + no-op 治理；安静时段不打扰；主动消息可发 QQ。
- **生活引擎**：白天闲置自动做小事；每日 Dream 自动整理/写日记。
- **工作台**：文件（路径监狱）、artifact、终端（allow_shell）、headless Chrome（读网页/截图）、tar.gz 快照/恢复。
- **SnowLuma QQ**：OneBot v11 WS 客户端；容器已接，World 内嵌 noVNC 扫码窗口。
- **设置重排**：基本 / 模型 / 心跳 / QQ / 工作台 / 健康 / 关于；模型连通性测试。

## 快速开始

```bash
./scripts/littly-build.sh
# 或
docker compose up -d
open http://127.0.0.1:8082/littly/
```

QQ 首次：World 页展开 noVNC 扫码，登录后把 QQ 号填入设置。

## 验证

```bash
./scripts/littly-test.sh
```

最后验证镜像：`123c6e6c8da0`（v2.0.3）
（`schema_migrations=174|f`，server healthy，浏览器 sidecar ok，snapshot ok，DeepSeek test ok）。

## 已知缺口

1. QQ 真实扫码登录后的私聊/群聊实机联调（等待账号）。
2. Memoh memory provider 为只读桥接 + prompt 注入，尚未合同级完整替换。
3. 桌面（虚拟桌面）尚未实现；浏览器/终端/快照已有。
4. 连接外部网络（GitHub/Docker Hub）偶发超时，已用重试/国内镜像绕过。

## 许可

AGPL-3.0；分叉自 Memoh（见 NOTICE）。
