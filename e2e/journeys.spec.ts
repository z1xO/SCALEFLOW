import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const API = process.env.E2E_API_URL ?? 'http://localhost:4000';

function uniqueEmail(): string {
  return `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
}

async function registerAndLogin(page: Page, email = uniqueEmail()): Promise<string> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Create one' }).click();
  await page.getByLabel('Name').fill('E2E User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('e2e-password-123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/projects$/);
  return email;
}

async function createProject(page: Page, name: string): Promise<string> {
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-state', 'live');
  return page.url().split('/').pop() as string;
}

async function createApiKey(page: Page, projectId: string): Promise<string> {
  await page.goto(`/projects/${projectId}/settings`);
  await page.getByLabel('Key name').fill('e2e');
  await page.getByRole('button', { name: 'Create key' }).click();
  const secretEl = page.getByTestId('api-key-secret');
  await expect(secretEl).toHaveText(/^sf_[A-Za-z0-9_-]{43}$/);
  const secret = ((await secretEl.textContent()) ?? '').trim();
  await page.getByRole('button', { name: 'Done' }).click();
  return secret;
}

async function submitViaApi(
  request: APIRequestContext,
  key: string,
  projectId: string,
  body: object,
): Promise<string> {
  const res = await request.post(`${API}/v1/projects/${projectId}/jobs`, {
    headers: { authorization: `Bearer ${key}` },
    data: body,
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { job: { id: string } }).job.id;
}

test('unauthenticated visitors are sent to the login page', async ({ page }) => {
  await page.goto('/projects');
  await expect(page).toHaveURL(/\/login$/);
});

test('sign up, create a project, submit a job from the form and watch it succeed live', async ({ page }) => {
  await registerAndLogin(page);
  const projectId = await createProject(page, 'E2E happy path');

  await page.getByRole('link', { name: 'Submit job' }).first().click();
  await page.getByLabel('Type').selectOption('demo.sleep');
  await page.getByLabel('Payload (JSON)').fill('{"durationMs": 1500}');
  await page.getByRole('button', { name: 'Submit job' }).click();

  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/jobs/[0-9a-f-]{36}$`));
  const status = page.getByTestId('job-status');
  // Goes through running to succeeded without a reload: updates arrive over SSE.
  await expect(status).toContainText('Succeeded', { timeout: 20_000 });
  await expect(page.getByText('Attempt 1 · Succeeded')).toBeVisible();
  await expect(page.getByText('{\n  "sleptMs": 1500\n}')).toBeVisible();
});

test('client-side and server-side validation errors are shown on the form', async ({ page }) => {
  await registerAndLogin(page);
  const projectId = await createProject(page, 'E2E validation');
  await page.goto(`/projects/${projectId}/jobs/new`);
  await page.getByLabel('Payload (JSON)').fill('{not json');
  await page.getByRole('button', { name: 'Submit job' }).click();
  await expect(page.getByText('Payload must be valid JSON.')).toBeVisible();

  await page.getByLabel('Payload (JSON)').fill('{"durationMs": -1}');
  await page.getByRole('button', { name: 'Submit job' }).click();
  await expect(page.getByText("Payload is not valid for job type 'demo.sleep'")).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: /^durationMs: Too small/ })).toBeVisible();
});

test('a dead-lettered job shows its error and can be retried from the dashboard', async ({
  page,
  request,
}) => {
  await registerAndLogin(page);
  const projectId = await createProject(page, 'E2E failures');
  const key = await createApiKey(page, projectId);
  const jobId = await submitViaApi(request, key, projectId, {
    type: 'demo.flaky',
    payload: { failureRate: 1, permanent: true },
    maxAttempts: 2,
  });

  await page.goto(`/projects/${projectId}/jobs?status=failed`);
  const row = page.getByRole('row').filter({ hasText: 'demo_permanent_failure' });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole('link', { name: 'demo.flaky' }).click();
  await expect(page).toHaveURL(new RegExp(jobId));
  await expect(page.getByText('Permanent error (not retried)')).toBeVisible();

  await page.getByRole('button', { name: `Retry job ${jobId}` }).click();
  // The replay runs again (and fails again: failureRate 1) - a second attempt appears live.
  await expect(page.getByText('Attempt 2 · Failed')).toBeVisible({ timeout: 20_000 });
});

test('a delayed job can be cancelled before it runs', async ({ page, request }) => {
  await registerAndLogin(page);
  const projectId = await createProject(page, 'E2E cancel');
  const key = await createApiKey(page, projectId);
  const jobId = await submitViaApi(request, key, projectId, {
    type: 'demo.echo',
    payload: {},
    delayMs: 600_000,
  });
  await page.goto(`/projects/${projectId}/jobs/${jobId}`);
  await expect(page.getByTestId('job-status')).toContainText('Scheduled');
  await page.getByRole('button', { name: `Cancel job ${jobId}` }).click();
  await expect(page.getByTestId('job-status')).toContainText('Cancelled');
});

test('jobs submitted through the API appear in the jobs table in real time', async ({ page, request }) => {
  await registerAndLogin(page);
  const projectId = await createProject(page, 'E2E live table');
  const key = await createApiKey(page, projectId);
  await page.goto(`/projects/${projectId}/jobs`);
  await expect(page.getByText('No jobs yet')).toBeVisible();
  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-state', 'live');

  await submitViaApi(request, key, projectId, { type: 'demo.echo', payload: { message: 'from the API' } });
  await expect(page.getByRole('row').filter({ hasText: 'demo.echo' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Succeeded' })).toBeVisible({ timeout: 20_000 });
});

test("one user cannot open another user's project", async ({ page, browser }) => {
  await registerAndLogin(page);
  const projectId = await createProject(page, 'E2E private');

  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await registerAndLogin(otherPage);
  await otherPage.goto(`/projects/${projectId}/jobs`);
  await expect(otherPage.getByText('Could not load this data')).toBeVisible();
  await expect(otherPage.getByText('Project not found')).toBeVisible();
  await other.close();
});
