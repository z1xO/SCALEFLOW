import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests drive the real stack: dashboard (Next.js) + API + worker + relay + scheduler
 * against PostgreSQL and Redis. Start the infrastructure first (`docker compose up -d postgres redis`
 * and `npm run db:migrate`); the backend processes and dashboard are started here unless already
 * running (reuseExistingServer).
 */
const API = process.env.E2E_API_URL ?? 'http://localhost:4000';
const WEB = process.env.E2E_WEB_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: WEB,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    { command: 'npm run dev:api -w @scaleflow/server', url: `${API}/readyz`, reuseExistingServer: true, timeout: 60_000 },
    { command: 'npm run dev:worker -w @scaleflow/server', url: 'http://localhost:9465/readyz', reuseExistingServer: true, timeout: 60_000 },
    { command: 'npm run dev:relay -w @scaleflow/server', url: 'http://localhost:9466/readyz', reuseExistingServer: true, timeout: 60_000 },
    { command: 'npm run dev:scheduler -w @scaleflow/server', url: 'http://localhost:9467/readyz', reuseExistingServer: true, timeout: 60_000 },
    { command: 'npm run dev -w @scaleflow/dashboard', url: `${WEB}/login`, reuseExistingServer: true, timeout: 120_000 },
  ],
});
