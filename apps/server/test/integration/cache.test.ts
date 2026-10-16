import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CachedLoader } from '../../src/infra/cache/cached-loader.js';
import { VersionedCache } from '../../src/infra/cache/versioned-cache.js';
import { asKey, createTenant, createTestContext, type TestContext } from '../helpers/context.js';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

const key = (s: string) => `${ctx.services.config.REDIS_KEY_PREFIX}:test:${s}`;

describe('versioned cache', () => {
  it('closes the cache-aside race: a slow reader cannot overwrite a newer invalidation', async () => {
    const cache = new VersionedCache<{ version: number; v: string }>(ctx.services.redis, 't', ctx.services.logger, ctx.services.metrics);
    const k = key('race');
    // Reader loaded version 1 from the database...
    const staleRead = { version: 1, v: 'old' };
    // ...meanwhile a writer committed version 2 and invalidated.
    await cache.invalidate(k, 2);
    // The reader now tries to populate the cache with what it read.
    expect(await cache.fill(k, staleRead, 60_000)).toBe(false);
    expect(await cache.get(k)).toBeNull(); // tombstone = miss, never stale data
    // The next reader loads version 2 and may fill.
    expect(await cache.fill(k, { version: 2, v: 'new' }, 60_000)).toBe(true);
    expect(await cache.get(k)).toEqual({ version: 2, v: 'new' });
    // A delayed, older invalidation does not clobber newer data.
    await cache.invalidate(k, 1);
    expect(await cache.get(k)).toEqual({ version: 2, v: 'new' });
  });

  it('job detail reflects a cancellation immediately even when cached', async () => {
    const t = await createTenant(ctx.services);
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/v1/projects/${t.projectId}/jobs`,
      headers: asKey(t.apiKey),
      payload: { type: 'demo.echo', payload: {}, delayMs: 60_000 },
    });
    const id = created.json().job.id as string;
    const url = `/v1/projects/${t.projectId}/jobs/${id}`;
    await ctx.app.inject({ method: 'GET', url, headers: asKey(t.apiKey) }); // fills the cache
    expect(await ctx.services.jobCache.get(t.projectId, id)).not.toBeNull();
    await ctx.app.inject({ method: 'POST', url: `${url}/cancel`, headers: asKey(t.apiKey) });
    const after = await ctx.app.inject({ method: 'GET', url, headers: asKey(t.apiKey) });
    expect(after.json().job.status).toBe('cancelled');
  });

  it('worker transitions invalidate the cache too', async () => {
    const t = await createTenant(ctx.services);
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/v1/projects/${t.projectId}/jobs`,
      headers: asKey(t.apiKey),
      payload: { type: 'demo.echo', payload: {} },
    });
    const id = created.json().job.id as string;
    expect((await ctx.services.jobQueries.get(t.projectId, id)).status).toBe('queued');
    await ctx.services.jobExecution.claim(id, 1, 'w', 30_000);
    expect((await ctx.services.jobQueries.get(t.projectId, id)).status).toBe('running');
    await ctx.services.jobExecution.complete(id, 1, 'w', null, 1);
    expect((await ctx.services.jobQueries.get(t.projectId, id)).status).toBe('succeeded');
  });
});

describe('cached loader (stampede protection)', () => {
  it('100 concurrent callers across two "processes" trigger exactly one load', async () => {
    const a = new CachedLoader(ctx.services.redis, 'a', ctx.services.logger, ctx.services.metrics);
    const b = new CachedLoader(ctx.services.redis, 'b', ctx.services.logger, ctx.services.metrics);
    let loads = 0;
    const load = async () => {
      loads++;
      await new Promise((r) => setTimeout(r, 100));
      return { value: 42 };
    };
    const k = key('stampede');
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) => (i % 2 ? a : b).get(k, { freshMs: 5_000, staleMs: 5_000 }, load)),
    );
    expect(results.every((r) => r.value === 42)).toBe(true);
    expect(loads).toBe(1);
  });

  it('serves stale data while one caller refreshes', async () => {
    const loader = new CachedLoader(ctx.services.redis, 'swr', ctx.services.logger, ctx.services.metrics);
    const k = key('swr');
    let version = 1;
    const load = () => Promise.resolve({ version });
    expect((await loader.get(k, { freshMs: 50, staleMs: 10_000 }, load)).version).toBe(1);
    version = 2;
    await new Promise((r) => setTimeout(r, 80)); // now stale
    expect((await loader.get(k, { freshMs: 50, staleMs: 10_000 }, load)).version).toBe(1); // stale served...
    await new Promise((r) => setTimeout(r, 50)); // ...background refresh completes
    expect((await loader.get(k, { freshMs: 5_000, staleMs: 10_000 }, load)).version).toBe(2);
  });
});
