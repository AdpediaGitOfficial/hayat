import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // One throwaway database per test run: created, migrated and dropped here.
    globalSetup: ['tests/db/global-setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
})
