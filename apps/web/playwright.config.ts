import { defineConfig, devices } from '@playwright/test';

// Browser tests run against a disposable seeded server (apps/server/test/e2e-server.ts).
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173', trace: 'off',
    // Optional: point at a system Chromium when the pinned Playwright browser is not downloaded.
    ...(process.env.PW_CHROMIUM ? { launchOptions: { executablePath: process.env.PW_CHROMIUM } } : {}),
  },
  webServer: {
    command: 'pnpm --filter @noir/server exec tsx test/e2e-server.ts',
    url: 'http://127.0.0.1:4173/healthz',
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'tablet', use: { ...devices['iPad (gen 7)'], browserName: 'chromium' } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
});
