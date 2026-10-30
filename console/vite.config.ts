import path from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// Dev: front-end runs on 5173, proxies /api to the local console API so the
// httpOnly session cookie and the SSE stream stay same-origin (no CORS dance).
// Override the target with VITE_PROXY_TARGET when validating against a scratch
// backend (e.g. http://127.0.0.1:3103).
const proxyTarget = process.env.VITE_PROXY_TARGET ?? 'http://127.0.0.1:3000'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: [
      // App code.
      { find: '@', replacement: path.resolve(__dirname, 'src') },
      // @felinic/ui ships raw source whose internal imports use the library's
      // own `#/` alias (see packages/ui/vite.config.ts). The host must provide
      // the same mapping because the sources are consumed, not pre-built.
      { find: /^#\//, replacement: path.resolve(__dirname, 'packages/ui/src') + '/' },
    ],
  },
  server: {
    port: 5173,
    strictPort: true,
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
})
