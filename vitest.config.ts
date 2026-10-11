import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/main/**/*.test.ts', 'src/renderer/src/stores/*.test.ts']
  }
})
