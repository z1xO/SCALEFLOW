import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/infra/db/pool.js';
import { insertJobs } from '../../src/modules/jobs/job-commands.js';
import { asKey, createTenant, createTestContext, type TestContext } from '../helpers/context.js';

let ctx: TestContext;
let t: Awaited<ReturnType<typeof createTenant>>;

beforeAll(async () => {
  ctx = await createTestContext();
  t = await createTenant(ctx.services);
});
afterAll(async () => {
  await ctx.close();
});

function submit(body: unknown, headers: Record<string, string> = {}) {
  return ctx.app.inject({
    method: 'POST',
    url: `/v1/projects/${t.projectId}/jobs`,
    headers: { ...asKey(t.apiKey), ...headers },
    payload: body as Record<string, unknown>,
  });
}

async function countRows(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await ctx.services.pool.query<Record<string, string>>(sql, params);
  return Number(Object.values(rows[0] ?? {})[0] ?? 0);
}

describe('job submission', () => {
  it('creates a queued job with one event and one outbox row in the same transaction', async () => {
    const res = await submit({ type: 'demo.sleep', payload: { durationMs: 10 }, maxAttempts: 5 });
    expect(res.statusCode).toBe(201);
    const { job } = res.json();
    expect(job).toMatchObject({ status: 'queued', type: 'demo.sleep', queue: 'default', maxAttempts: 5, attemptCount: 0 });
    expect(res.headers.location).toBe(`/v1/projects/${t.projectId}/jobs/${job.id}`);
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(job.correlationId).toBe(res.headers['x-request-id']);
    expect(await countRows('SELECT count(*) FROM job_events WHERE job_id = $1', [job.id])).toBe(1);
    expect(await countRows("SELECT count(*) FROM outbox WHERE aggregate_id = $1 AND published_at IS NULL", [job.id])).toBe(1);
  });

  it('delayed jobs are scheduled and get no outbox row until promoted', async () => {
    const res = await submit({ type: 'demo.echo', payload: {}, delayMs: 60_000 });
    const { job } = res.json();
    expect(job.status).toBe('scheduled');
    expect(new Date(job.runAt).getTime()).toBeGreaterThan(Date.now() + 55_000);
    expect(await countRows('SELECT count(*) FROM outbox WHERE aggregate_id = $1', [job.id])).toBe(0);
  });

  it('applies handler defaults and validates the payload per job type', async () => {
    const ok = await submit({ type: 'demo.flaky', payload: {} });
    expect(ok.json().job.payload).toEqual({ failureRate: 0.5, permanent: false, durationMs: 0 });

    const bad = await submit({ type: 'demo.sleep', payload: { durationMs: -5 } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().code).toBe('invalid_payload');
    expect(bad.json().errors.issues[0].path).toBe('durationMs');

    const unknownQueue = await submit({ type: 'demo.echo', queue: 'nope', payload: {} });
    expect(unknownQueue.statusCode).toBe(422);
    expect(unknownQueue.json().code).toBe('unknown_queue');

    const schema = await submit({ type: 'demo.echo', payload: {}, maxAttempts: 99 });
    expect(schema.statusCode).toBe(400);
    expect(schema.json().code).toBe('validation_failed');

    const both = await submit({ type: 'demo.echo', payload: {}, delayMs: 5, runAt: new Date().toISOString() });
    expect(both.statusCode).toBe(400);
  });

  it('rejects webhook payloads with private URLs only at execution time, but validates shape at submission', async () => {
    const res = await submit({ type: 'webhook.deliver', payload: { url: 'ftp://example.com', body: {} } });
    expect(res.statusCode).toBe(422);
  });

  it('enforces the payload size limit', async () => {
    const big = 'x'.repeat(70 * 1024);
    const res = await submit({ type: 'demo.echo', payload: { message: big } });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('payload_too_large');
  });

  it('enforces the request body limit (413)', async () => {
    const huge = 'y'.repeat(1_100_000);
    const res = await submit({ type: 'demo.echo', payload: { message: huge } });
    expect(res.statusCode).toBe(413);
  });
});

describe('idempotency', () => {
  it('replays the original job for the same key and body', async () => {
    const body = { type: 'demo.echo', payload: { message: 'hi' } };
    const first = await submit(body, { 'idempotency-key': 'order-123' });
    const second = await submit(body, { 'idempotency-key': 'order-123' });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json().job.id).toBe(first.json().job.id);
    expect(await countRows('SELECT count(*) FROM jobs WHERE project_id = $1 AND idempotency_key = $2', [t.projectId, 'order-123'])).toBe(1);
  });

  it('treats semantically equal bodies (different key order) as the same request', async () => {
    const first = await submit({ type: 'demo.echo', payload: { a: 1, b: 2 } }, { 'idempotency-key': 'order-key-order' });
    const second = await submit({ payload: { b: 2, a: 1 }, type: 'demo.echo' }, { 'idempotency-key': 'order-key-order' });
    expect(second.statusCode).toBe(200);
    expect(second.json().job.id).toBe(first.json().job.id);
  });

  it('rejects reuse of a key with a different body', async () => {
    await submit({ type: 'demo.echo', payload: { message: 'one' } }, { 'idempotency-key': 'reuse-1' });
    const res = await submit({ type: 'demo.echo', payload: { message: 'two' } }, { 'idempotency-key': 'reuse-1' });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('idempotency_key_reused');
  });

  it('keys are scoped per project', async () => {
    const other = await createTenant(ctx.services);
    const body = { type: 'demo.echo', payload: {} };
    const mine = await submit(body, { 'idempotency-key': 'shared-key' });
    const theirs = await ctx.app.inject({
      method: 'POST',
      url: `/v1/projects/${other.projectId}/jobs`,
      headers: { ...asKey(other.apiKey), 'idempotency-key': 'shared-key' },
      payload: body,
    });
    expect(theirs.statusCode).toBe(201);
    expect(theirs.json().job.id).not.toBe(mine.json().job.id);
  });

  it('50 concurrent submissions with the same key create exactly one job, one event and one outbox row', async () => {
    const body = { type: 'demo.echo', payload: { n: 1 } };
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => submit(body, { 'idempotency-key': 'race-key' })),
    );
    const statuses = responses.map((r) => r.statusCode);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(49);
    expect(new Set(responses.map((r) => r.json().job.id)).size).toBe(1);
    const jobId = responses[0]!.json().job.id as string;
    expect(await countRows('SELECT count(*) FROM job_events WHERE job_id = $1', [jobId])).toBe(1);
    expect(await countRows('SELECT count(*) FROM outbox WHERE aggregate_id = $1', [jobId])).toBe(1);
  });
});

describe('concurrent submission without keys', () => {
  it('200 concurrent submissions create 200 distinct jobs, each with its event and outbox row', async () => {
    const before = await countRows('SELECT count(*) FROM jobs WHERE project_id = $1', [t.projectId]);
    const responses = await Promise.all(
      Array.from({ length: 200 }, (_, i) => submit({ type: 'demo.echo', payload: { i } })),
    );
    expect(responses.every((r) => r.statusCode === 201)).toBe(true);
    const ids = responses.map((r) => r.json().job.id as string);
    expect(new Set(ids).size).toBe(200);
    expect(await countRows('SELECT count(*) FROM jobs WHERE project_id = $1', [t.projectId])).toBe(before + 200);
    expect(await countRows('SELECT count(*) FROM outbox WHERE aggregate_id = ANY($1)', [ids])).toBe(200);
    expect(await countRows("SELECT count(*) FROM job_events WHERE job_id = ANY($1) AND type = 'job.created'", [ids])).toBe(200);
  });
});

describe('batch submission', () => {
  it('creates all jobs atomically', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/projects/${t.projectId}/jobs/batch`,
      headers: asKey(t.apiKey),
      payload: { jobs: Array.from({ length: 25 }, (_, i) => ({ type: 'demo.echo', payload: { i }, idempotencyKey: `b-${i}` })) },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().items).toHaveLength(25);
  });

  it('inserts nothing if any job in the batch is invalid', async () => {
    const before = await countRows('SELECT count(*) FROM jobs WHERE project_id = $1', [t.projectId]);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/projects/${t.projectId}/jobs/batch`,
      headers: asKey(t.apiKey),
      payload: {
        jobs: [
          { type: 'demo.echo', payload: {} },
          { type: 'demo.sleep', payload: { durationMs: 'soon' } },
        ],
      },
    });
    expect(res.statusCode).toBe(422);
    expect(await countRows('SELECT count(*) FROM jobs WHERE project_id = $1', [t.projectId])).toBe(before);
  });

  it('rejects duplicate idempotency keys within a batch', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/projects/${t.projectId}/jobs/batch`,
      headers: asKey(t.apiKey),
      payload: {
        jobs: [
          { type: 'demo.echo', payload: {}, idempotencyKey: 'dup' },
          { type: 'demo.echo', payload: {}, idempotencyKey: 'dup' },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('database rollback', () => {
  it('a failure after inserting rolls back the job, its event and its outbox row together', async () => {
    const prepared = ctx.services.jobCommands.prepare({
      type: 'demo.echo',
      queue: 'default',
      payload: {},
      maxAttempts: 3,
    });
    await expect(
      withTransaction(ctx.services.pool, async (client) => {
        await insertJobs(client, t.projectId, [prepared], { correlationId: null, scheduledJobId: null });
        // Visible inside the transaction...
        const inside = await client.query('SELECT 1 FROM outbox WHERE aggregate_id = $1', [prepared.id]);
        expect(inside.rowCount).toBe(1);
        throw new Error('simulated crash before commit');
      }),
    ).rejects.toThrow('simulated crash');
    // ...and gone afterwards: no orphan job, event or outbox row.
    expect(await countRows('SELECT count(*) FROM jobs WHERE id = $1', [prepared.id])).toBe(0);
    expect(await countRows('SELECT count(*) FROM job_events WHERE job_id = $1', [prepared.id])).toBe(0);
    expect(await countRows('SELECT count(*) FROM outbox WHERE aggregate_id = $1', [prepared.id])).toBe(0);
  });
});

describe('cancellation', () => {
  it('cancels queued and scheduled jobs; a second cancel is a 409', async () => {
    for (const body of [
      { type: 'demo.echo', payload: {} },
      { type: 'demo.echo', payload: {}, delayMs: 60_000 },
    ]) {
      const { job } = (await submit(body)).json();
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/v1/projects/${t.projectId}/jobs/${job.id}/cancel`,
        headers: asKey(t.apiKey),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().job.status).toBe('cancelled');
      expect(res.json().job.finishedAt).not.toBeNull();
      const again = await ctx.app.inject({
        method: 'POST',
        url: `/v1/projects/${t.projectId}/jobs/${job.id}/cancel`,
        headers: asKey(t.apiKey),
      });
      expect(again.statusCode).toBe(409);
      expect(again.json().code).toBe('job_not_cancellable');
    }
  });

  it('a running job cannot be cancelled', async () => {
    const { job } = (await submit({ type: 'demo.echo', payload: {} })).json();
    const claimed = await ctx.services.jobExecution.claim(job.id, 1, 'test-worker', 30_000);
    expect(claimed).not.toBeNull();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/projects/${t.projectId}/jobs/${job.id}/cancel`,
      headers: asKey(t.apiKey),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().errors).toEqual({ status: 'running' });
  });

  it('cancel vs worker claim race: exactly one wins, every time', async () => {
    const outcomes = { cancelled: 0, claimed: 0 };
    for (let i = 0; i < 40; i++) {
      const { job } = (await submit({ type: 'demo.echo', payload: { i } })).json();
      const [cancel, claim] = await Promise.allSettled([
        ctx.services.jobCommands.cancel(t.projectId, job.id, { actor: { type: 'system', id: 'test' }, correlationId: null }),
        ctx.services.jobExecution.claim(job.id, 1, 'race-worker', 30_000),
      ]);
      const cancelWon = cancel.status === 'fulfilled';
      const claimWon = claim.status === 'fulfilled' && claim.value !== null;
      expect(cancelWon !== claimWon, `iteration ${i}: exactly one must win`).toBe(true);
      if (cancelWon) outcomes.cancelled++;
      else outcomes.claimed++;
      const final = await ctx.services.jobQueries.get(t.projectId, job.id);
      expect(final.status).toBe(cancelWon ? 'cancelled' : 'running');
    }
    expect(outcomes.cancelled + outcomes.claimed).toBe(40);
  });
});

describe('manual retry', () => {
  it('only failed jobs can be retried; retry re-queues with a fresh attempt budget', async () => {
    const { job } = (await submit({ type: 'demo.echo', payload: {}, maxAttempts: 1 })).json();
    const notYet = await ctx.app.inject({
      method: 'POST',
      url: `/v1/projects/${t.projectId}/jobs/${job.id}/retry`,
      headers: asKey(t.apiKey),
    });
    expect(notYet.statusCode).toBe(409);

    await ctx.services.jobExecution.claim(job.id, 1, 'w', 30_000);
    const failed = await ctx.services.jobExecution.fail(
      job.id,
      1,
      'w',
      { code: 'boom', message: 'boom', retryable: true },
      5,
      'failed',
    );
    expect(failed.applied && failed.outcome).toBe('failed');

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/projects/${t.projectId}/jobs/${job.id}/retry`,
      headers: asKey(t.apiKey),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().job).toMatchObject({ status: 'queued', runAttempts: 0, attemptCount: 1 });
    // A dispatch for attempt 2 was written to the outbox in the same transaction.
    const { rows } = await ctx.services.pool.query(
      "SELECT payload FROM outbox WHERE aggregate_id = $1 ORDER BY id DESC LIMIT 1",
      [job.id],
    );
    expect(rows[0].payload.attempt).toBe(2);
    const audit = await countRows("SELECT count(*) FROM audit_log WHERE target_id = $1 AND action = 'job.retried'", [job.id]);
    expect(audit).toBe(1);
  });
});

describe('queries', () => {
  it('lists with filters and stable cursor pagination', async () => {
    const other = await createTenant(ctx.services);
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/v1/projects/${other.projectId}/jobs`,
        headers: asKey(other.apiKey),
        payload: { type: i % 2 ? 'demo.sleep' : 'demo.echo', payload: i % 2 ? { durationMs: 1 } : {} },
      });
      ids.push(res.json().job.id);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const url: string = `/v1/projects/${other.projectId}/jobs?limit=3${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await ctx.app.inject({ method: 'GET', url, headers: asKey(other.apiKey) });
      const body: { items: { id: string }[]; nextCursor: string | null } = res.json();
      expect(body.items.length).toBeLessThanOrEqual(3);
      seen.push(...body.items.map((j: { id: string }) => j.id));
      cursor = body.nextCursor;
    } while (cursor);
    expect(seen).toEqual([...ids].reverse()); // newest first, no gaps, no duplicates

    const sleeps = await ctx.app.inject({
      method: 'GET',
      url: `/v1/projects/${other.projectId}/jobs?type=demo.sleep&status=queued`,
      headers: asKey(other.apiKey),
    });
    expect(sleeps.json().items).toHaveLength(3);
    expect(sleeps.json().items[0].payload).toBeNull(); // list responses omit payloads

    const future = await ctx.app.inject({
      method: 'GET',
      url: `/v1/projects/${other.projectId}/jobs?createdAfter=${encodeURIComponent(new Date(Date.now() + 3_600_000).toISOString())}`,
      headers: asKey(other.apiKey),
    });
    expect(future.json().items).toHaveLength(0);

    const badCursor = await ctx.app.inject({
      method: 'GET',
      url: `/v1/projects/${other.projectId}/jobs?cursor=not-a-cursor`,
      headers: asKey(other.apiKey),
    });
    expect(badCursor.statusCode).toBe(400);
  });

  it('returns attempts and the event timeline', async () => {
    const { job } = (await submit({ type: 'demo.echo', payload: {} })).json();
    await ctx.services.jobExecution.claim(job.id, 1, 'w1', 30_000);
    await ctx.services.jobExecution.complete(job.id, 1, 'w1', { ok: true }, 12);
    const attempts = await ctx.app.inject({
      method: 'GET',
      url: `/v1/projects/${t.projectId}/jobs/${job.id}/attempts`,
      headers: asKey(t.apiKey),
    });
    expect(attempts.json().items).toEqual([
      expect.objectContaining({ attemptNumber: 1, workerId: 'w1', status: 'succeeded', durationMs: 12 }),
    ]);
    const events = await ctx.app.inject({
      method: 'GET',
      url: `/v1/projects/${t.projectId}/jobs/${job.id}/events`,
      headers: asKey(t.apiKey),
    });
    expect(events.json().items.map((e: { type: string }) => e.type)).toEqual(['job.created', 'job.started', 'job.succeeded']);
    expect(events.json().items[0].cursor).toMatch(/^\d+\.\d+$/);
  });

  it('serves the OpenAPI document', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/v1/projects/{projectId}/jobs', '/v1/projects/{projectId}/jobs/{jobId}/retry']),
    );
    expect(doc.components.schemas.Job).toBeDefined();
  });
});
