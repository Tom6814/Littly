# Littly harness 核心 —— Linux Docker 单容器部署
# 形态：dsh-base 内核 + @littly/bundle，无 GUI；webserver 内核自带 HTTP 面。
# 依赖解析：@littly/bundle 由启动器安装本体携带（双锚点），profile 零依赖。
#
# 构建（仓库根执行）：docker build -f deploy/Dockerfile -t littly-harness .
# 运行：见 deploy/docker-compose.yml

FROM node:24-bookworm-slim AS build
# 构建管线需要：
#   git/ca-certificates —— typert/build 步骤要读 git 版本戳、还要联网取包
#   build-essential    —— native/system 的 Node-API 插件（flock）要现场编译（cc + libc 头）；
#                         Node 自带的 /usr/local/include/node/node_api.h 已在镜像里
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates build-essential && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app/harness

# 清单先行，命中层缓存（scripts/ 也是 install 前置：根 postinstall 引用）
COPY harness/package.json harness/pnpm-lock.yaml harness/pnpm-workspace.yaml ./
COPY harness/patches ./patches
COPY harness/scripts ./scripts
RUN pnpm install --frozen-lockfile

# 源码与产物构建（管线要读 git 版本戳：初始化哑仓库）
COPY harness/ ./
RUN git init -q && git config user.email build@littly.local && git config user.name build && git add -A && git commit -qm "container build"
RUN pnpm run build:artifacts

# profile 的外部依赖（社区 dsh 插件）在构建期就装好 —— 运行期不联网、不需要 pnpm。
# 播种脚本会把这份 node_modules 复制到 $DSH_HOME/profiles/chat。
RUN cd profiles/chat && pnpm install --frozen-lockfile

# --- 控制台前端（MUI + Vite，独立 workspace）---
FROM node:24-bookworm-slim AS console
RUN corepack enable
WORKDIR /app/console
COPY console/package.json console/pnpm-lock.yaml console/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY console/ ./
# 同源部署：控制台与 API 同一个端口，API 基址留空（走相对路径）
ENV VITE_API_BASE=
RUN pnpm run build

FROM node:24-bookworm-slim AS runtime
# python3/pip：给 MCP 面提供 `bili mcp serve`（stdio）；ca-certificates 供网络请求
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 python3-pip && rm -rf /var/lib/apt/lists/*
# bili-agent：她自己的 B 站账号（与 sidecar 共用 BILI_CLI_HOME → 同一个账号）
# 给 MCP 面提供 `bili mcp serve`（stdio）。装不上也不阻塞镜像构建：
# MCP 行是 failOnStartupError=false，bili 元工具走 HTTP sidecar。
# 限时 900s：PyPI 慢的时候（实测能到 30~40kB/s）不让构建无限挂住。
RUN timeout 900 pip3 install --no-cache-dir --break-system-packages --timeout 60 --retries 3 "bili-agent[mcp]==0.9.1" || \
    echo "[warn] bili-agent 安装失败（或超时）：MCP 面不可用，bili 元工具仍走 HTTP sidecar"
WORKDIR /app/harness
# corepack：运行期若改动了 profile 依赖，播种脚本可以退回 pnpm install
RUN corepack enable
ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    DSH_HOME=/app/data/dsh-home \
    LITTLY_DB_FILE=/app/data/littly.db \
    LITTLY_CONSOLE_DIR=/app/harness/console/dist \
    BILI_CLI_HOME=/app/bili-data/bili-cli \
    BILI_BIN=bili
# 运行时仅需：依赖树 + 构建产物 + 插件源码（dsh 插件以 .ts 源码直接加载）
COPY --from=build /app/harness/node_modules ./node_modules
COPY --from=build /app/harness/package.json ./package.json
COPY --from=build /app/harness/pnpm-workspace.yaml ./
COPY --from=build /app/harness/apps ./apps
COPY --from=build /app/harness/packages ./packages
COPY --from=build /app/harness/vendor ./vendor
COPY --from=build /app/harness/profiles ./profiles
COPY --from=build /app/harness/native ./native
# profile 播种脚本（把镜像里的 profiles/chat 落到 $DSH_HOME/profiles/chat）
COPY --from=build /app/harness/scripts/seed-profile.mjs ./scripts/seed-profile.mjs
# 控制台静态资源（由 console-api 的 fallback 托管，SPA 路由回 index.html）
COPY --from=console /app/console/dist ./console/dist
COPY deploy/entrypoint.sh ./deploy-entrypoint.sh
RUN chmod +x ./deploy-entrypoint.sh
# SQLite 业务库与 dsh home 落持久卷
VOLUME ["/app/data"]
# bilibili 账号状态（与 bili sidecar 共用同一卷的同一路径 → 同一个账号）
VOLUME ["/app/bili-data"]
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --retries=8 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api').then(r=>process.exit(0)).catch(()=>process.exit(1))"
ENTRYPOINT ["./deploy-entrypoint.sh"]
