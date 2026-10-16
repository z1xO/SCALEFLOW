// Captures README screenshots from a running stack (dashboard :3000, API :4000) with the seed data.
//   npm run db:seed && npm run dev   (in another terminal)
//   npx tsx scripts/screenshots.mts
import { chromium, type Page } from '@playwright/test';

const WEB = process.env.E2E_WEB_URL ?? 'http://localhost:3000';
const API = process.env.E2E_API_URL ?? 'http://localhost:4000';
const EMAIL = process.env.SEED_EMAIL ?? 'demo@scaleflow.dev';
const PASSWORD = process.env.SEED_PASSWORD ?? 'scaleflow-demo-password';
const OUT = 'docs/images';

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
}

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  colorScheme: 'dark',
  deviceScaleFactor: 2,
});
const page = await context.newPage();

await page.goto(`${WEB}/login`);
await page.getByLabel('Email').fill(EMAIL);
await page.getByLabel('Password').fill(PASSWORD);
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForURL(/\/projects$/);
await page.getByRole('link', { name: 'Demo project' }).click();
await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
const projectId = page.url().split('/').pop() as string;

// Generate some fresh activity through the API (using the session cookie) so charts and feeds have data.
const submit = (body: object) =>
  page.request.post(`${API}/v1/projects/${projectId}/jobs/batch`, {
    headers: { origin: WEB },
    data: { jobs: [body] },
  });
for (let i = 0; i < 30; i++)
  await submit({ type: 'demo.sleep', payload: { durationMs: 200 + (i % 7) * 150 } });
for (let i = 0; i < 6; i++)
  await submit({
    type: 'demo.flaky',
    payload: { succeedOnAttempt: 2 },
    maxAttempts: 3,
    backoff: { type: 'fixed', baseDelayMs: 1000, maxDelayMs: 1000 },
  });
for (let i = 0; i < 2; i++)
  await submit({ type: 'demo.flaky', payload: { failureRate: 1, permanent: true } });
const flaky = await page.request.post(`${API}/v1/projects/${projectId}/jobs`, {
  headers: { origin: WEB },
  data: {
    type: 'demo.flaky',
    payload: { succeedOnAttempt: 3 },
    maxAttempts: 5,
    backoff: { type: 'fixed', baseDelayMs: 1500, maxDelayMs: 1500 },
  },
});
const flakyId = ((await flaky.json()) as { job: { id: string } }).job.id;
await page.waitForTimeout(9000);

await page.goto(`${WEB}/projects/${projectId}`);
await page.getByRole('combobox').filter({ hasText: 'Last hour' }).selectOption('15m');
await settle(page);
await page.screenshot({ path: `${OUT}/overview.png` });

await page.goto(`${WEB}/projects/${projectId}/jobs`);
await settle(page);
await page.screenshot({ path: `${OUT}/jobs.png` });

await page.goto(`${WEB}/projects/${projectId}/jobs/${flakyId}`);
await page.getByTestId('job-status').getByText('Succeeded').waitFor({ timeout: 30_000 });
await settle(page);
await page.screenshot({ path: `${OUT}/job-detail.png`, fullPage: true });

await page.goto(`${WEB}/projects/${projectId}/system`);
await settle(page);
await page.screenshot({ path: `${OUT}/workers.png` });

await browser.close();
console.log(`screenshots written to ${OUT}/`);
