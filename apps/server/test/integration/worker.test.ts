import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { JobExecutor } from '../../src/modules/workers/job-executor.js';
import type { DispatchPayload } from '../../src/modules/jobs/write-helpers.js';
import { asKey, createTenant, createTestContext, type TestContext } from '../helpers/context.js';
import { startPipeline, waitFor, waitForStatus } from '../helpers/pipeline.js';

let ctx: TestContext;
let t: Awaited<ReturnType<typeof createTenant>>;
let stopPipeline: (() => Promise<void>) | null = null;

beforeAll(async () => {
  ctx = await createTestContext();
  t = await createTenant(ctx.services);
});
afterEach(async () => {
  await stopPipeline?.();
  stopPipeline = null;
});
afterAll(async () => {
  await ctx.close();
});

async function submit(body: Record<string, unknown>): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/v1/projects/${t.projectId}/jobs`,
    headers: asKey(t.apiKey),
    payload: body,
  });
  expect(res.statusCode).toBe(201);
  return res.json().job.id as string;
}

async function attempts(jobId: string) {
  return ctx.services.jobQueries.attempts(t.projectId, jobId);
}

async function eventTypes(jobId: string): Promise<string[]> {
  return (await ctx.services.jobQueries.jobEvents(t.projectId, jobId)).map((e) => e.type);
}

function executor(workerId: string, leaseMs = 5_000): JobExecutor {
  return new JobExecutor(ctx.services.jobExecution, ctx.services.handlers, ctx.services.logger, ctx.services.metrics, {
    workerId,
    leaseMs,
  });
}

function dispatchOf(jobId: string, attempt = 1): DispatchPayload {
  return { jobId, attempt, projectId: t.projectId, queue: 'default', type: 'demo.echo', correlationId: null };
}

describe('end to end through BullMQ', () => {
  it('a submitted job is dispatched, executed by a worker and recorded', async () => {
    stopPipeline = (await startPipeline(ctx.services)).stop;
    const id = await submit({ type: 'demo.echo', payload: { message: 'hello' } });
    const job = await waitForStatus(ctx.services, t.projectId, id, ['succeeded']);
    expect(job.result).toEqual({ echo: 'hello', attempt: 1 });
    expect(job.attemptCount).toBe(1);
    expect(await eventTypes(id)).toEqual(['job.created', 'job.started', 'job.succeeded']);
    const [a] = await attempts(id);
    expect(a).toMatchObject({ attemptNumber: 1, status: 'succeeded' });
    expect(a!.queueWaitMs).not.toBeNull();
  });

  it('retries transient failures with backoff until success', async () => {
    stopPipeline = (await startPipeline(ctx.services)).stop;
    const id = await submit({
      type: 'demo.flaky',
      payload: { succeedOnAttempt: 3 },
      maxAttempts: 5,
      backoff: { type: 'fixed', baseDelayMs: 100, maxDelayMs: 100 },
    });
    const job = await waitForStatus(ctx.services, t.projectId, id, ['succeeded', 'failed']);
    expect(job.status).toBe('succeeded');
    expect(job.attemptCount).toBe(3);
    expect((await attempts(id)).map((a) => a.status)).toEqual(['failed', 'failed', 'succeeded']);
    expect(await eventTypes(id)).toEqual([
      'job.created',
      'job.started',
      'job.retry_scheduled',
      'job.queued',
      'job.started',
      'job.retry_scheduled',
      'job.queued',
      'job.started',
      'job.succeeded',
    ]);
  });

  it('dead-letters after the attempt budget is exhausted, then a manual retry replays it', async () => {
    stopPipeline = (await startPipeline(ctx.services)).stop;
    const id = await submit({
      type: 'demo.flaky',
      payload: { failureRate: 1 },
      maxAttempts: 3,
      backoff: { type: 'exponential', baseDelayMs: 100, maxDelayMs: 200 },
    });
    const failed = await waitForStatus(ctx.services, t.projectId, id, ['failed']);
    expect(failed.lastError).toMatchObject({ code: 'demo_transient_failure', retryable: true });
    expect(await attempts(id)).toHaveLength(3);
    const events = await ctx.services.jobQueries.jobEvents(t.projectId, id);
    expect(events.at(-1)?.data).toMatchObject({ to: 'failed', reason: 'attempts_exhausted' });

    // Replay from the dead-letter state with a fresh budget (it will fail again: failureRate 1).
    const retry = await ctx.app.inject({
      method: 'POST',
      url: `/v1/projects/${t.projectId}/jobs/${id}/retry`,
      headers: asKey(t.apiKey),
    });
    expect(retry.statusCode).toBe(200);
    const again = await waitFor(async () => {
      const j = await ctx.services.jobQueries.get(t.projectId, id, '0/0');
      return j.status === 'failed' && j.attemptCount === 6 ? j : null;
    });
    expect(again.runAttempts).toBe(3);
    expect((await attempts(id)).map((a) => a.attemptNumber)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('permanent errors fail immediately without retrying', async () => {
    stopPipeline = (await startPipeline(ctx.services)).stop;
    const id = await submit({ type: 'demo.flaky', payload: { failureRate: 1, permanent: true }, maxAttempts: 5 });
    const job = await waitForStatus(ctx.services, t.projectId, id, ['failed']);
    expect(job.attemptCount).toBe(1);
    expect(job.lastError).toEqual({ code: 'demo_permanent_failure', message: 'Simulated permanent failure', retryable: false });
  });

  it('enforces job timeouts', async () => {
    stopPipeline = (await startPipeline(ctx.services)).stop;
    const id = await submit({ type: 'demo.sleep', payload: { durationMs: 10_000 }, timeoutMs: 200, maxAttempts: 1 });
    const job = await waitForStatus(ctx.services, t.projectId, id, ['failed']);
    expect(job.lastError?.code).toBe('timeout');
    const [a] = await attempts(id);
    expect(a?.status).toBe('timed_out');
    expect(a?.durationMs).toBeLessThan(2_000);
  });

  it('processes many jobs concurrently without losing or duplicating any', async () => {
    stopPipeline = (await startPipeline(ctx.services, { concurrency: 20 })).stop;
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/projects/${t.projectId}/jobs/batch`,
      headers: asKey(t.apiKey),
      payload: { jobs: Array.from({ length: 100 }, (_, i) => ({ type: 'demo.sleep', payload: { durationMs: 20 + (i % 5) } })) },
    });
    const ids: string[] = res.json().items.map((i: { job: { id: string } }) => i.job.id);
    await waitFor(
      async () => {
        const { rows } = await ctx.services.pool.query("SELECT count(*)::int AS n FROM jobs WHERE id = ANY($1) AND status = 'succeeded'", [ids]);
        return rows[0].n === 100;
      },
      { what: '100 jobs to succeed' },
    );
    const { rows } = await ctx.services.pool.query('SELECT count(*)::int AS n FROM job_attempts WHERE job_id = ANY($1)', [ids]);
    expect(rows[0].n).toBe(100); // exactly one attempt each
  });
});

describe('delivery guarantees', () => {
  it('two concurrent deliveries of the same dispatch execute the job once', async () => {
    const id = await submit({ type: 'demo.echo', payload: {} });
    const [a, b] = await Promise.all([executor('w-a').process(dispatchOf(id)), executor('w-b').process(dispatchOf(id))]);
    expect([a, b].sort()).toEqual(['skipped', 'succeeded']);
    expect(await attempts(id)).toHaveLength(1);
  });

  it('a redelivery after completion is skipped', async () => {
    const id = await submit({ type: 'demo.echo', payload: {} });
    expect(await executor('w').process(dispatchOf(id))).toBe('succeeded');
    expect(await executor('w').process(dispatchOf(id))).toBe('skipped');
    expect(await attempts(id)).toHaveLength(1);
  });

  it('a stale dispatch for an older attempt cannot start the job', async () => {
    const id = await submit({ type: 'demo.flaky', payload: { failureRate: 1 }, maxAttempts: 3 });
    expect(await executor('w').process(dispatchOf(id, 1))).toBe('retry');
    await ctx.services.pool.query("UPDATE jobs SET run_at = now() WHERE id = $1", [id]);
    await ctx.services.jobExecution.promoteDue(10);
    // The queue now holds a dispatch for attempt 2; a duplicate of attempt 1 arrives late.
    expect(await executor('w').process(dispatchOf(id, 1))).toBe('skipped');
    expect(await executor('w').process(dispatchOf(id, 2))).toBe('retry');
  });

  it('a cancelled job is skipped when its dispatch arrives', async () => {
    const id = await submit({ type: 'demo.echo', payload: {} });
    await ctx.services.jobCommands.cancel(t.projectId, id, { actor: { type: 'system', id: 't' }, correlationId: null });
    expect(await executor('w').process(dispatchOf(id))).toBe('skipped');
    expect(await attempts(id)).toHaveLength(0);
  });
});

describe('worker crash recovery', () => {
  it('a job claimed by a worker that died is recovered by the lease reaper and retried', async () => {
    const id = await submit({ type: 'demo.echo', payload: {}, maxAttempts: 3 });
    // The worker claims attempt 1 and then "crashes" (never completes, never renews).
    expect(await ctx.services.jobExecution.claim(id, 1, 'crashed-worker', 200)).not.toBeNull();
    await new Promise((r) => setTimeout(r, 300));
    const recovered = await ctx.services.jobExecution.recoverExpiredLeases(100);
    expect(recovered.map((j) => j.id)).toContain(id);
    const job = await ctx.services.jobQueries.get(t.projectId, id, '0/0');
    expect(job.status).toBe('retry_wait');
    expect(job.lastError?.code).toBe('lease_expired');
    expect((await attempts(id))[0]?.status).toBe('lost');

    // The retry runs on a healthy worker.
    stopPipeline = (await startPipeline(ctx.services)).stop;
    await ctx.services.pool.query('UPDATE jobs SET run_at = now() WHERE id = $1', [id]);
    const done = await waitForStatus(ctx.services, t.projectId, id, ['succeeded']);
    expect(done.attemptCount).toBe(2);
  });

  it('a slow "zombie" worker cannot overwrite the result after its lease was recovered', async () => {
    const id = await submit({ type: 'demo.echo', payload: {}, maxAttempts: 3 });
    await ctx.services.jobExecution.claim(id, 1, 'zombie', 100);
    await new Promise((r) => setTimeout(r, 150));
    await ctx.services.jobExecution.recoverExpiredLeases(100);
    await ctx.services.pool.query('UPDATE jobs SET run_at = now() WHERE id = $1', [id]);
    await ctx.services.jobExecution.promoteDue(10);
    expect(await executor('healthy').process(dispatchOf(id, 2))).toBe('succeeded');
    // The zombie wakes up and reports success for attempt 1: discarded.
    const late = await ctx.services.jobExecution.complete(id, 1, 'zombie', { from: 'zombie' }, 5);
    expect(late.applied).toBe(false);
    const job = await ctx.services.jobQueries.get(t.projectId, id, '0/0');
    expect(job.result).toEqual({ echo: null, attempt: 2 });
  });

  it('lease renewal keeps long-running jobs alive while the reaper runs', async () => {
    stopPipeline = (await startPipeline(ctx.services, { worker: false })).stop; // reaper runs every 100ms
    const id = await submit({ type: 'demo.sleep', payload: { durationMs: 1_200 } });
    expect(await executor('long-runner', 300).process(dispatchOf(id))).toBe('succeeded');
    expect((await attempts(id)).map((a) => a.status)).toEqual(['succeeded']);
  });

  it('exhausted attempts after a crash dead-letter the job', async () => {
    const id = await submit({ type: 'demo.echo', payload: {}, maxAttempts: 1 });
    await ctx.services.jobExecution.claim(id, 1, 'crashed', 50);
    await new Promise((r) => setTimeout(r, 100));
    await ctx.services.jobExecution.recoverExpiredLeases(100);
    const job = await ctx.services.jobQueries.get(t.projectId, id, '0/0');
    expect(job.status).toBe('failed');
    expect(job.lastError?.code).toBe('lease_expired');
  });
});

describe('graceful shutdown', () => {
  it('drains running jobs before stopping and marks the worker offline', async () => {
    const pipeline = await startPipeline(ctx.services, { shutdownGraceMs: 5_000 });
    const id = await submit({ type: 'demo.sleep', payload: { durationMs: 600 } });
    await waitForStatus(ctx.services, t.projectId, id, ['running']);
    await pipeline.stop();
    const job = await ctx.services.jobQueries.get(t.projectId, id, '0/0');
    expect(job.status).toBe('succeeded');
    const { rows } = await ctx.services.pool.query('SELECT status FROM workers ORDER BY started_at DESC LIMIT 1');
    expect(rows[0].status).toBe('offline');
  });

  it('aborts jobs that outlive the grace period and schedules them for retry', async () => {
    const pipeline = await startPipeline(ctx.services, { shutdownGraceMs: 300 });
    const id = await submit({ type: 'demo.sleep', payload: { durationMs: 20_000 }, maxAttempts: 3 });
    await waitForStatus(ctx.services, t.projectId, id, ['running']);
    const started = Date.now();
    await pipeline.stop();
    expect(Date.now() - started).toBeLessThan(5_000);
    const job = await ctx.services.jobQueries.get(t.projectId, id, '0/0');
    expect(job.status).toBe('retry_wait');
    expect(job.lastError?.code).toBe('worker_shutdown');
  });
});
