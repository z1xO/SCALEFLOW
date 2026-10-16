import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asKey, createApiKey, createTenant, createTestContext, type TestContext } from '../helpers/context.js';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext({
    env: { RATE_LIMIT_MAX: '5', RATE_LIMIT_WINDOW_MS: '60000', MAX_ACTIVE_JOBS_PER_PROJECT: '3', MAX_OUTBOX_BACKLOG: '1000' },
  });
});
afterAll(async () => {
  await ctx.close();
});

describe('rate limiting', () => {
  it('limits per API key and answers 429 with Retry-After as problem details', async () => {
    const t = await createTenant(ctx.services);
    const url = `/v1/projects/${t.projectId}/jobs`;
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) {
      codes.push((await ctx.app.inject({ method: 'GET', url, headers: asKey(t.apiKey) })).statusCode);
    }
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes.slice(5)).toEqual([429, 429]);
    const limited = await ctx.app.inject({ method: 'GET', url, headers: asKey(t.apiKey) });
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.json().code).toBe('rate_limited');

    // A different key in the same project has its own budget.
    const other = await createApiKey(ctx.services, t.projectId, t.user);
    expect((await ctx.app.inject({ method: 'GET', url, headers: asKey(other) })).statusCode).toBe(200);
  });

  it('health endpoints are never rate limited', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await ctx.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    }
  });
});

describe('backpressure', () => {
  it('rejects submissions once a project reaches its active-job quota (429)', async () => {
    const t = await createTenant(ctx.services);
    // The read model drives the quota; seed it as the projector would.
    await ctx.services.pool.query(
      "INSERT INTO project_job_counts (project_id, status, count) VALUES ($1, 'queued', 3)",
      [t.projectId],
    );
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/projects/${t.projectId}/jobs`,
      headers: asKey(t.apiKey),
      payload: { type: 'demo.echo', payload: {} },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().code).toBe('project_queue_full');
    expect(res.headers['retry-after']).toBe('10');
  });
});

describe('outbox backlog backpressure', () => {
  let small: TestContext;
  beforeAll(async () => {
    small = await createTestContext({ env: { MAX_OUTBOX_BACKLOG: '5' } });
  });
  afterAll(async () => {
    await small.close();
  });

  it('answers 503 + Retry-After when the outbox backlog is too large', async () => {
    const t = await createTenant(small.services);
    const res = await small.app.inject({
      method: 'POST',
      url: `/v1/projects/${t.projectId}/jobs/batch`,
      headers: asKey(t.apiKey),
      payload: { jobs: Array.from({ length: 5 }, () => ({ type: 'demo.echo', payload: {} })) },
    });
    expect(res.statusCode).toBe(201);
    await new Promise((r) => setTimeout(r, 1_100)); // admission caches the backlog for 1s
    const rejected = await small.app.inject({
      method: 'POST',
      url: `/v1/projects/${t.projectId}/jobs`,
      headers: asKey(t.apiKey),
      payload: { type: 'demo.echo', payload: {} },
    });
    expect(rejected.statusCode).toBe(503);
    expect(rejected.json().code).toBe('system_overloaded');
    expect(rejected.headers['retry-after']).toBe('5');
  });
});
