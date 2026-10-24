# Littly harness 核心 —— Linux Docker 单容器部署
# 形态：dsh-base 内核 + @littly/bundle，无 GUI；webserver 内核自带 HTTP 面。
# 依赖解析：@littly/bundle 由启动器安装本体携带（双锚点），profile 零依赖。
#
# 构建（仓库根执行）：docker build -f deploy/Dockerfile -t littly-harness .
# 运行：见 deploy/docker-compose.yml

FROM node:24-bookworm-slim AS build
WORKDIR /app
# pnpm 版本由根 package.json packageManager 锁定
RUN corepack enable
# 清单先行，命中层缓存
COPY harness/package.json harness/pnpm-lock.yaml harness/pnpm-workspace.yaml ./
COPY harness/patches ./patches
RUN pnpm install --frozen-lockfile
# 源码与产物构建
COPY harness ./harness
RUN pnpm run build:artifacts

FROM node:24-bookworm-slim AS runtime
WORKDIR /app/harness
ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    DSH_HOME=/app/data/dsh-home
# 运行时仅需：依赖树 + 构建产物 + 插件源码（dsh 插件以 .ts 源码直接加载）
COPY --from=build /app/harness/node_modules ./node_modules
COPY --from=build /app/harness/package.json ./package.json
COPY --from=build /app/harness/pnpm-workspace.yaml ./
COPY --from=build /app/harness/apps ./apps
COPY --from=build /app/harness/packages ./packages
COPY --from=build /app/harness/vendor ./vendor
COPY --from=build /app/harness/profiles ./profiles
COPY --from=build /app/harness/native ./native
# SQLite 业务库与 dsh home 落持久卷
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --retries=8 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api').then(r=>process.exit(0)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "apps/cli/lib/bin.js", "--profile", "chat"]
