import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: { alias: { '@': resolve(root, 'src') } },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
})
