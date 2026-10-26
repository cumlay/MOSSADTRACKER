import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

const root = import.meta.dirname

export default defineConfig({
  root: resolve(root, 'src/web'),
  // Mounted at /tracker/ on the corlay site; nginx strips the prefix before the API sees it.
  base: '/tracker/',
  plugins: [react()],
  css: { postcss: resolve(root, 'postcss.config.js') },
  server: {
    port: 5273,
    proxy: {
      '/tracker/api': { target: 'http://127.0.0.1:3717', changeOrigin: true, rewrite: (p) => p.slice('/tracker'.length), headers: { 'X-Tracker-Access': 'full' } }
    }
  },
  build: {
    outDir: resolve(root, 'dist/web'),
    emptyOutDir: true
  }
})
