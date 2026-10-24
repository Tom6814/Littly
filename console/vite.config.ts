import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发模式下前端跑在 5173，通过代理转发 /api 到后端（默认 3000），
// 这样 Cookie 与 SSE 都是同源的，不需要后端配置跨域。
// 若后端不在 3000，可设环境变量 VITE_PROXY_TARGET。
const proxyTarget = process.env.VITE_PROXY_TARGET ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: proxyTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
});
