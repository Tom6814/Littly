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

# --- 控制台前端（Vue 3 + Vite + @felinic/ui，独立 workspace）---
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
# python3/pip：容器内跑 `bili`（bilibili-cli，Python CLI）；ca-certificates 供网络请求
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 python3-pip && rm -rf /var/lib/apt/lists/*
# bilibili-cli：她自己的 B 站账号（@littly/bili 直接 spawn `bili`；控制台扫码/浏览器 Cookie 认证）。
# 装不上不阻塞镜像构建：插件 binOk=false，控制台明确显示「未安装」。
# 限时 600s：PyPI 慢的时候不让构建无限挂住。
RUN timeout 600 pip3 install --no-cache-dir --break-system-packages --timeout 60 --retries 3 "bilibili-cli==0.6.2" || \
    echo "[warn] bilibili-cli 安装失败（或超时）：B 站接入不可用（binOk=false）"
# twitter-cli：她自己的 X 账号（@littly/x 插件调用 `twitter` 二进制；写操作默认预演）。
# 装不上也不阻塞镜像构建：插件 binOk=false，控制台明确显示「已安装/未安装」。
RUN timeout 600 pip3 install --no-cache-dir --break-system-packages --timeout 60 --retries 3 "twitter-cli==0.8.5" || \
    echo "[warn] twitter-cli 安装失败（或超时）：X 接入不可用（binOk=false）"

WORKDIR /app/harness
# corepack：运行期若改动了 profile 依赖，播种脚本可以退回 pnpm install
RUN corepack enable
ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    DSH_HOME=/app/data/dsh-home \
    LITTLY_DB_FILE=/app/data/littly.db \
    LITTLY_CONSOLE_DIR=/app/harness/console/dist \
    BILI_CLI_HOME=/app/bili-data \
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
# bilibili-cli 的 HOME：credential.json 随卷持久化（容器重建不丢登录态）
VOLUME ["/app/bili-data"]
EXPOSE 3000
# 健康检查探的是**实际在监听的那个地址**。
# dsh 拒绝 0.0.0.0 通配绑定，entrypoint 让它绑容器自身 IP（hostname -i）——
# 所以探 127.0.0.1 永远 ECONNREFUSED，容器会一直显示 unhealthy。
# 地址由 entrypoint 写到 /tmp/littly-web-host（healthcheck 是另起的 exec，
# 拿不到 entrypoint 的 export）。
HEALTHCHECK --interval=15s --timeout=5s --retries=8 \
  CMD node -e "const fs=require('node:fs');let h='';try{h=fs.readFileSync('/tmp/littly-web-host','utf8').trim()}catch{};if(!h){const os=require('node:os');h=(Object.values(os.networkInterfaces()).flat().find(i=>i&&i.family==='IPv4'&&!i.internal)||{}).address||'127.0.0.1'}fetch('http://'+h+':'+(process.env.PORT||3000)+'/api').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["./deploy-entrypoint.sh"]
