# Littly UI（老版控制台）

这是 Littly v1 控制台的 UI，被复用到 v2：保留它的设计系统、布局与页面，通过
`public/shim.js` 把老版 `/api/*` 映射到 v2 核心的 `/littly/api/*`。

- 构建产物已随仓库放在 `docker/littly-console/`，由 `docker/Dockerfile.web.local`
  复制到 nginx 的 `/littly/`。
- 路由使用 hash（`/littly/#/chat`），所以 nginx 不需要 SPA fallback 之外的改写。
- `vite.config.ts` 的 `base` 已设为 `/littly/`。

重新构建（需要 Docker）：

```bash
rm -rf .build/console && cp -a littly-ui .build/console
docker run --rm -v "$PWD/.build/console:/app" -w /app node:24-bookworm-slim \
  sh -c 'npm i -g pnpm@11 && pnpm install --no-frozen-lockfile && pnpm build'
rm -rf docker/littly-console && cp -a .build/console/dist docker/littly-console
docker build -f docker/Dockerfile.web.local -t memohai/web:latest .
```

导航只保留 v2 已实现的部分：对话、角色卡、日记、工作台、记忆、联系人、QQ、概览、设置；
老版的插件/MCP/多渠道/成长/相册等未接 v2 的页面不在导航中。
