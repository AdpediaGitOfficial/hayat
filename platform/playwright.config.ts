import { defineConfig } from '@playwright/test'

/**
 * Browser smoke tests. `npm run build` first; global setup creates a throwaway database, seeds demo users and
 * starts the production server on E2E_PORT (default 3120) as the app login role, then drops everything.
 * Set E2E_CHROMIUM to use a browser installed elsewhere.
 */
const port = Number(process.env.E2E_PORT ?? 3120)
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /.*\.spec\.ts/,
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    launchOptions: process.env.E2E_CHROMIUM ? { executablePath: process.env.E2E_CHROMIUM } : {},
    trace: 'retain-on-failure',
  },
})
