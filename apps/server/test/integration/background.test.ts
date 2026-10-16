import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchJobId } from '../../src/infra/queue.js';
import { ORIGIN, readCommittedEvents } from '../../src/modules/events/event-log.js';
import { DispatchReconciler } from '../../src/modules/maintenance/reconciler.js';
import { Retention } from '../../src/modules/maintenance/retention.js';
import { OutboxRelay } from '../../src/modules/outbox/relay.js';
import { histogramQuantile } from '../../src/modules/projections/metrics-queries.js';
import { Projector } from '../../src/modules/projections/projector.js';
import { asKey, asUser, createTenant, createTestContext, type TestContext } from '../helpers/context.js';
import { startPipeline, waitFor, waitForStatus } from '../helpers/pipeline.js';

let ctx: TestContext;
let t: Awaited<ReturnType<typeof createTenant>>;

beforeAll(async () => {
  ctx = await createTestContext();
  t = await createTenant(ctx.services);
});
afterAll(async () => {
  await ctx.close();
});

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await ctx.services.pool.query<Record<string, unknown>>(sql, params);
  return Number(Object.values(rows[0] ?? {})[0] ?? 0);
}

describe('recurring schedules', () => {
  const actor = { type: 'system' as const, id: 'test' };

  it('validates cron expressions, time zones and frequency', async () => {
    const base = { jobType: 'demo.echo', payload: {} };
    for (const [cron, timezone, code] of [
      ['not a cron', 'UTC', 'invalid_cron'],
      ['*/5 * * * *', 'Mars/Olympus', 'invalid_cron'],
      ['* * * * * *', 'UTC', 'schedule_too_frequent'],
    ] as const) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/v1/projects/${t.projectId}/schedules`,
        headers: asUser(t.user),
        payload: { ...base, name: `bad-${code}-${cron}`, cron, timezone },
      });
      expect(res.statusCode, cron).toBe(422);
      expect(res.json().code).toBe(code);
    }
    const badPayload = await ctx.app.inject({
      method: 'POST',
      url: `/v1/projects/${t.projectId}/schedules`,
      headers: asUser(t.user),
      payload: { name: 'bad-payload', cron: '*/5 * * * *', jobType: 'demo.sleep', payload: { durationMs: 'x' } },
    });
    expect(badPayload.statusCode).toBe(422);
  });

  it('fires a due schedule exactly once per tick, even with two schedulers racing', async () => {
    const s = await ctx.services.schedules.create(
      t.projectId,
      { name: 'race', cron: '* * * * *', timezone: 'UTC', jobType: 'demo.echo', queue: 'default', payload: {}, jobOptions: { maxAttempts: 3 }, enabled: true },
      actor,
    );
    await ctx.services.pool.query("UPDATE scheduled_jobs SET next_run_at = date_trunc('minute', now()) WHERE id = $1", [s.id]);
    const [a, b] = await Promise.all([ctx.services.schedules.fireDue(), ctx.services.schedules.fireDue()]);
    expect([...a, ...b].filter((f) => f.scheduleId === s.id)).toHaveLength(1);
    expect(await count('SELECT count(*) FROM jobs WHERE scheduled_job_id = $1', [s.id])).toBe(1);
    const after = await ctx.services.schedules.get(t.projectId, s.id);
    expect(new Date(after.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    expect(after.lastJobId).not.toBeNull();
  });

  it('a tick that is replayed (crash after insert) does not create a second job', async () => {
    const s = await ctx.services.schedules.create(
      t.projectId,
      { name: 'replay', cron: '*/10 * * * *', timezone: 'UTC', jobType: 'demo.echo', queue: 'default', payload: {}, jobOptions: { maxAttempts: 3 }, enabled: true },
      actor,
    );
    const tick = new Date(Math.floor(Date.now() / 600_000) * 600_000);
    await ctx.services.pool.query('UPDATE scheduled_jobs SET next_run_at = $2 WHERE id = $1', [s.id, tick]);
    await ctx.services.schedules.fireDue();
    // Simulate a scheduler that inserted the job but crashed before moving next_run_at.
    await ctx.services.pool.query('UPDATE scheduled_jobs SET next_run_at = $2 WHERE id = $1', [s.id, tick]);
    await ctx.services.schedules.fireDue();
    expect(await count('SELECT count(*) FROM jobs WHERE scheduled_job_id = $1', [s.id])).toBe(1);
  });

  it('recovers after downtime: one job for the missed ticks, then resumes in the future', async () => {
    const s = await ctx.services.schedules.create(
      t.projectId,
      { name: 'downtime', cron: '* * * * *', timezone: 'UTC', jobType: 'demo.echo', queue: 'default', payload: {}, jobOptions: { maxAttempts: 3 }, enabled: true },
      actor,
    );
    await ctx.services.pool.query("UPDATE scheduled_jobs SET next_run_at = now() - interval '45 minutes' WHERE id = $1", [s.id]);
    const fired = await ctx.services.schedules.fireDue();
    expect(fired.filter((f) => f.scheduleId === s.id)).toHaveLength(1);
    expect(await ctx.services.schedules.fireDue()).toHaveLength(0);
    expect(await count('SELECT count(*) FROM jobs WHERE scheduled_job_id = $1', [s.id])).toBe(1);
    const after = await ctx.services.schedules.get(t.projectId, s.id);
    expect(new Date(after.nextRunAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('supports CRUD, disable and run-now through the API', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/v1/projects/${t.projectId}/schedules`,
      headers: asKey(t.apiKey),
      payload: { name: 'nightly', cron: '0 3 * * *', timezone: 'Europe/Berlin', jobType: 'demo.echo', payload: { m: 1 } },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().schedule.id as string;
    const dup = await ctx.app.inject({
      method: 'POST',
      url: `/v1/projects/${t.projectId}/schedules`,
      headers: asKey(t.apiKey),
      payload: { name: 'nightly', cron: '0 3 * * *', jobType: 'demo.echo' },
    });
    expect(dup.statusCode).toBe(409);
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/projects/${t.projectId}/schedules/${id}`,
      headers: asKey(t.apiKey),
      payload: { enabled: false },
    });
    expect(patched.json().schedule.enabled).toBe(false);
    const run = await ctx.app.inject({
      method: 'POST',
      url: `/v1/projects/${t.projectId}/schedules/${id}/trigger`,
      headers: asKey(t.apiKey),
    });
    expect(run.statusCode).toBe(201);
    expect(run.json().job.scheduledJobId).toBe(id);
    const del = await ctx.app.inject({ method: 'DELETE', url: `/v1/projects/${t.projectId}/schedules/${id}`, headers: asKey(t.apiKey) });
    expect(del.statusCode).toBe(204);
  });
});

describe('dispatch reconciler', () => {
  it('re-dispatches a queued job whose queue entry was lost (e.g. Redis data loss)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/projects/${t.projectId}/jobs`,
      headers: asKey(t.apiKey),
      payload: { type: 'demo.echo', payload: { lost: true } },
    });
    const id = res.json().job.id as string;
    const relay = new OutboxRelay(ctx.services.pool, ctx.services.queues, ctx.services.logger, ctx.services.metrics, {
      batchSize: 100,
      leaseMs: 30_000,
      publishTimeoutMs: 5_000,
    });
    while (await relay.tick()) { /* drain */ }
    const queue = ctx.services.queues.get('default');
    // Redis "loses" the dispatch.
    await queue.remove(dispatchJobId(id, 1));
    expect(await queue.getJobState(dispatchJobId(id, 1))).toBe('unknown');
    await ctx.services.pool.query("UPDATE jobs SET queued_at = now() - interval '10 minutes' WHERE id = $1", [id]);

    const reconciler = new DispatchReconciler(ctx.services.pool, ctx.services.queues, ctx.services.logger, ctx.services.metrics, 60_000);
    expect(await reconciler.tick()).toBeGreaterThanOrEqual(1);
    expect(await reconciler.tick()).toBe(0); // the new outbox row is pending: not re-dispatched twice

    const pipeline = await startPipeline(ctx.services);
    try {
      const job = await waitForStatus(ctx.services, t.projectId, id, ['succeeded']);
      expect(job.attemptCount).toBe(1);
    } finally {
      await pipeline.stop();
    }
  });

  it('leaves jobs alone whose dispatch is still waiting in the queue (a backlog is not a loss)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/projects/${t.projectId}/jobs`,
      headers: asKey(t.apiKey),
      payload: { type: 'demo.echo', payload: {} },
    });
    const id = res.json().job.id as string;
    const relay = new OutboxRelay(ctx.services.pool, ctx.services.queues, ctx.services.logger, ctx.services.metrics, {
      batchSize: 100,
      leaseMs: 30_000,
      publishTimeoutMs: 5_000,
    });
    while (await relay.tick()) { /* drain */ }
    await ctx.services.pool.query("UPDATE jobs SET queued_at = now() - interval '10 minutes' WHERE id = $1", [id]);
    const before = await count('SELECT count(*) FROM outbox WHERE aggregate_id = $1', [id]);
    await new DispatchReconciler(ctx.services.pool, ctx.services.queues, ctx.services.logger, ctx.services.metrics, 60_000).tick();
    expect(await count('SELECT count(*) FROM outbox WHERE aggregate_id = $1', [id])).toBe(before);
  });
});

describe('event log watermark', () => {
  it('does not expose an event until every older transaction has finished (no gaps for tailers)', async () => {
    const jobRes = await ctx.app.inject({
      method: 'POST',
      url: `/v1/projects/${t.projectId}/jobs`,
      headers: asKey(t.apiKey),
      payload: { type: 'demo.echo', payload: {}, delayMs: 3_600_000 },
    });
    const jobId = jobRes.json().job.id as string;
    const pool = ctx.services.pool;
    // NB: the watermark (oldest running transaction) is cluster-wide - transactions in *other*
    // databases on the same server hold it back too - so this test looks only at its own job's events.
    const eventsOfJob = async () =>
      (await readCommittedEvents(pool, ORIGIN, 100_000, [t.projectId])).filter((e) => e.job_id === jobId).map((e) => e.type);
    await waitFor(async () => (await eventsOfJob()).length === 1, { what: 'job.created to become visible' });

    const slow = new pg.Client({ connectionString: ctx.databaseUrl });
    await slow.connect();
    try {
      // Transaction A starts first (older xid) and writes an event, but does not commit yet.
      await slow.query('BEGIN');
      await slow.query(
        "INSERT INTO job_events (project_id, job_id, type, data) VALUES ($1, $2, 'job.queued', '{\"from\":\"scheduled\",\"to\":\"queued\",\"type\":\"demo.echo\",\"queue\":\"default\"}')",
        [t.projectId, jobId],
      );
      // Transaction B (newer) writes and commits.
      await pool.query(
        "INSERT INTO job_events (project_id, job_id, type, data) VALUES ($1, $2, 'job.cancelled', '{\"from\":\"queued\",\"to\":\"cancelled\",\"type\":\"demo.echo\",\"queue\":\"default\"}')",
        [t.projectId, jobId],
      );
      // B is committed, but it is newer than A, which is still running: a tailer must not see B yet,
      // otherwise its cursor would move past A's event and lose it.
      await new Promise((r) => setTimeout(r, 200));
      expect(await eventsOfJob()).toEqual(['job.created']);
      await slow.query('COMMIT');
      const after = await waitFor(async () => {
        const types = await eventsOfJob();
        return types.length === 3 ? types : null;
      });
      expect(after).toEqual(['job.created', 'job.queued', 'job.cancelled']); // commit-safe order: A, then B
    } finally {
      await slow.end();
    }
  });

  it('orders cursors numerically, not lexically', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/projects/${t.projectId}/jobs/batch`,
      headers: asKey(t.apiKey),
      payload: { jobs: Array.from({ length: 30 }, () => ({ type: 'demo.echo', payload: {} })) },
    });
    expect(res.statusCode).toBe(201);
    const events = await readCommittedEvents(ctx.services.pool, ORIGIN, 10_000);
    const keys = events.map((e) => [BigInt(e.tx_id), BigInt(e.id)] as const);
    for (let i = 1; i < keys.length; i++) {
      const [ptx, pid] = keys[i - 1]!;
      const [tx, id] = keys[i]!;
      expect(tx > ptx || (tx === ptx && id > pid)).toBe(true);
    }
  });
});

describe('read model projection (CQRS)', () => {
  it('folds events into counts and per-minute stats exactly once, and serves them as metrics', async () => {
    const other = await createTenant(ctx.services);
    const projector = new Projector(ctx.services.pool, ctx.services.logger, ctx.services.metrics);
    while (await projector.tick()) { /* catch up on earlier tests */ }

    const pipeline = await startPipeline(ctx.services, { concurrency: 10 });
    try {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/v1/projects/${other.projectId}/jobs/batch`,
        headers: asKey(other.apiKey),
        payload: {
          jobs: [
            ...Array.from({ length: 8 }, () => ({ type: 'demo.sleep', payload: { durationMs: 30 } })),
            ...Array.from({ length: 2 }, () => ({ type: 'demo.flaky', payload: { failureRate: 1, permanent: true } })),
          ],
        },
      });
      const ids: string[] = res.json().items.map((i: { job: { id: string } }) => i.job.id);
      await waitFor(async () => (await count("SELECT count(*) FROM jobs WHERE id = ANY($1) AND status IN ('succeeded','failed')", [ids])) === 10);
      // The pipeline's projector runs every 50ms; the read model converges shortly after.
      await waitFor(async () => {
        const m = await ctx.services.metricsQueries.compute(other.projectId, '15m');
        return m.counts.succeeded === 8 && m.counts.failed === 2 ? m : null;
      }, { what: 'read model to converge' });
    } finally {
      await pipeline.stop();
    }
    const m = await ctx.services.metricsQueries.compute(other.projectId, '15m');
    expect(m.counts).toMatchObject({ queued: 0, running: 0, succeeded: 8, failed: 2 });
    expect(m.totals).toMatchObject({ submitted: 10, started: 10, succeeded: 8, failed: 2 });
    expect(m.totals.successRate).toBeCloseTo(0.8);
    expect(m.latency.execution.count).toBe(10);
    expect(m.latency.execution.p50Ms).toBeGreaterThan(0);
    expect(m.series.reduce((a, s) => a + s.submitted, 0)).toBe(10);

    // Re-running the projector changes nothing (checkpointed).
    while (await projector.tick()) { /* nothing */ }
    expect((await ctx.services.metricsQueries.compute(other.projectId, '15m')).counts.succeeded).toBe(8);

    // The repair procedure recomputes the same counts from the jobs table.
    await ctx.services.pool.query("UPDATE project_job_counts SET count = 999 WHERE project_id = $1 AND status = 'succeeded'", [other.projectId]);
    await projector.rebuildCounts();
    expect((await ctx.services.metricsQueries.compute(other.projectId, '15m')).counts.succeeded).toBe(8);

    // The HTTP endpoint serves the same numbers.
    const http = await ctx.app.inject({ method: 'GET', url: `/v1/projects/${other.projectId}/metrics?window=15m`, headers: asKey(other.apiKey) });
    expect(http.statusCode).toBe(200);
    expect(http.json().counts.succeeded).toBe(8);
  });

  it('computes histogram quantiles by interpolation', () => {
    const hist = new Array<number>(14).fill(0);
    hist[4] = 100; // all samples in (50, 100]
    expect(histogramQuantile(hist, 0.5)).toBe(75);
    expect(histogramQuantile(hist, 0.99)).toBe(100);
    expect(histogramQuantile(new Array<number>(14).fill(0), 0.5)).toBeNull();
  });
});

describe('system endpoints', () => {
  it('report queue depth, outbox backlog and workers to authenticated callers only', async () => {
    const anon = await ctx.app.inject({ method: 'GET', url: '/v1/system/queues' });
    expect(anon.statusCode).toBe(401);
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/system/queues', headers: asKey(t.apiKey) });
    expect(res.statusCode).toBe(200);
    expect(res.json().queues.default).toHaveProperty('waiting');
    expect(res.json().outbox).toHaveProperty('pending');
    const workers = await ctx.app.inject({ method: 'GET', url: '/v1/system/workers', headers: asUser(t.user) });
    expect(workers.statusCode).toBe(200);
    expect(Array.isArray(workers.json().items)).toBe(true);
  });
});

describe('retention', () => {
  it('deletes expired terminal jobs (with attempts and events) in batches, and keeps active ones', async () => {
    const r = await ctx.app.inject({
      method: 'POST',
      url: `/v1/projects/${t.projectId}/jobs/batch`,
      headers: asKey(t.apiKey),
      payload: { jobs: Array.from({ length: 3 }, () => ({ type: 'demo.echo', payload: {} })) },
    });
    const [oldDone, recentDone, active] = r.json().items.map((i: { job: { id: string } }) => i.job.id) as string[];
    await ctx.services.pool.query(
      "UPDATE jobs SET status = 'succeeded', finished_at = now() - interval '40 days' WHERE id = $1",
      [oldDone],
    );
    await ctx.services.pool.query("UPDATE jobs SET status = 'succeeded', finished_at = now() WHERE id = $1", [recentDone]);
    const retention = new Retention(ctx.services.pool, ctx.services.config, ctx.services.metrics, 2);
    const deleted = await retention.run();
    expect(deleted.jobs).toBeGreaterThanOrEqual(1);
    expect(await count('SELECT count(*) FROM jobs WHERE id = $1', [oldDone])).toBe(0);
    expect(await count('SELECT count(*) FROM job_events WHERE job_id = $1', [oldDone])).toBe(0);
    expect(await count('SELECT count(*) FROM jobs WHERE id = ANY($1)', [[recentDone, active]])).toBe(2);
  });
});
