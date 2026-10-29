import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

// 手写 manifest(public/manifest.json) + Vite 多入口:
//  - background: 单独的 ES module service worker (固定文件名 background.js)
//  - options / sidepanel / popup / print: HTML 页面入口
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': resolve(root, 'src') } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      input: {
        background: resolve(root, 'src/background/index.ts'),
        options: resolve(root, 'options.html'),
        sidepanel: resolve(root, 'sidepanel.html'),
        popup: resolve(root, 'popup.html'),
        print: resolve(root, 'print.html'),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})
