import { defineConfig, build as viteBuild } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

/** One Vite build also emits the x.com content script as a classic IIFE (MV3 content scripts). */
function strikeContentScript() {
  return {
    name: 'strike-content-script',
    apply: 'build' as const,
    async closeBundle() {
      await viteBuild({
        configFile: false,
        publicDir: false,
        plugins: [],
        build: {
          emptyOutDir: false,
          outDir: resolve(root, 'dist'),
          sourcemap: false,
          cssCodeSplit: false,
          lib: {
            entry: resolve(root, 'src/strike/content/entry.ts'),
            name: 'XToolkitStrike',
            formats: ['iife'],
            fileName: () => 'strike.js',
          },
          rollupOptions: {
            output: {
              extend: true,
              inlineDynamicImports: true,
              assetFileNames: (info) => {
                const name = info.names?.[0] ?? info.name ?? ''
                return name.endsWith('.css') ? 'strike.css' : 'assets/[name][extname]'
              },
            },
          },
        },
      })
    },
  }
}

// 手写 manifest(public/manifest.json) + Vite 多入口:
//  - background: 单独的 ES module service worker (固定文件名 background.js)
//  - options / sidepanel / popup / print: HTML 页面入口
export default defineConfig({
  plugins: [react(), strikeContentScript()],
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
