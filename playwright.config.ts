import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: 'e2e.test.ts',
  timeout: 10000,
  retries: 1,
  use: {
    headless: true,
    baseURL: 'http://localhost:3157',
  },
  webServer: {
    command: 'node --import tsx e2e/server.ts',
    url: 'http://localhost:3157/api/config',
    reuseExistingServer: !process.env.CI,
    timeout: 5000,
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
})