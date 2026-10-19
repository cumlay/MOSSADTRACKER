import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

const root = import.meta.dirname

export default defineConfig({
  root: resolve(root, 'src/web'),
  plugins: [react()],
  css: { postcss: resolve(root, 'postcss.config.js') },
  server: {
    port: 5273,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3717', changeOrigin: true }
    }
  },
  build: {
    outDir: resolve(root, 'dist/web'),
    emptyOutDir: true
  }
})
