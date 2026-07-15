import { defineConfig, devices } from '@playwright/test'

// E2e гоняется против УЖЕ ПОДНЯТОГО prod-local (make prod-local): настоящая
// прод-сборка за Caddy по https на *.localhost. Chromium сам резолвит *.localhost
// в 127.0.0.1; ignoreHTTPSErrors обходит недоверенный локальный CA Caddy (как -k
// в смоуке) — TLS настоящий, просто не доверенный.
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_APP_URL ?? 'https://app.localhost',
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
