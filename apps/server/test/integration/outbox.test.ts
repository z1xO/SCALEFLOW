import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchJobId, QueueSet } from '../../src/infra/queue.js';
import { OutboxRelay } from '../../src/modules/outbox/relay.js';
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

function relay(queues = ctx.services.queues, publishTimeoutMs = 5_000): OutboxRelay {
  return new OutboxRelay(ctx.services.pool, queues, ctx.services.logger, ctx.services.metrics, {
    batchSize: 100,
    leaseMs: 30_000,
    publishTimeoutMs,
  });
}

async function submitMany(n: number, queue = 'default'): Promise<string[]> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/v1/projects/${t.projectId}/jobs/batch`,
    headers: asKey(t.apiKey),
    payload: { jobs: Array.from({ length: n }, (_, i) => ({ type: 'demo.echo', queue, payload: { i } })) },
  });
  expect(res.statusCode).toBe(201);
  return res.json().items.map((i: { job: { id: string } }) => i.job.id);
}

async function drain(r: OutboxRelay): Promise<void> {
  while (await r.tick()) {
    /* keep going while batches are full */
  }
}

async function pending(): Promise<number> {
  const { rows } = await ctx.services.pool.query("SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL");
  return rows[0].n as number;
}

describe('outbox relay', () => {
  it('publishes pending dispatches to BullMQ with deterministic ids and marks them published', async () => {
    const ids = await submitMany(5);
    await drain(relay());
    const queue = ctx.services.queues.get('default');
    for (const id of ids) {
      const job = await queue.getJob(dispatchJobId(id, 1));
      expect(job?.data).toMatchObject({ jobId: id, attempt: 1, projectId: t.projectId, type: 'demo.echo' });
    }
    const { rows } = await ctx.services.pool.query(
      'SELECT published_at, attempts, last_error FROM outbox WHERE aggregate_id = ANY($1)',
      [ids],
    );
    expect(rows.every((r) => r.published_at !== null && r.attempts === 1 && r.last_error === null)).toBe(true);
  });

  it('republishing after a crash between publish and mark creates no duplicate queue entries', async () => {
    const ids = await submitMany(10);
    await drain(relay());
    const queue = ctx.services.queues.get('default');
    const before = await queue.count();
    // Simulate: relay published but crashed before recording it.
    await ctx.services.pool.query('UPDATE outbox SET published_at = NULL WHERE aggregate_id = ANY($1)', [ids]);
    await drain(relay());
    expect(await queue.count()).toBe(before);
    expect(await pending()).toBe(0);
  });

  it('a crashed relay leaves claimed rows that another relay picks up after the lease', async () => {
    const ids = await submitMany(3);
    // Claim with a lease, then "crash" (never publish).
    await ctx.services.pool.query(
      "UPDATE outbox SET locked_until = now() + interval '30 seconds', attempts = attempts + 1 WHERE aggregate_id = ANY($1)",
      [ids],
    );
    await drain(relay());
    expect(await pending()).toBe(3); // still leased: nobody else touches them
    await ctx.services.pool.query("UPDATE outbox SET locked_until = now() - interval '1 second' WHERE aggregate_id = ANY($1)", [ids]);
    await drain(relay());
    expect(await pending()).toBe(0);
  });

  it('concurrent relays never claim the same row twice (SKIP LOCKED)', async () => {
    const ids = await submitMany(100);
    await submitMany(100);
    await submitMany(100);
    const relays = [relay(), relay(), relay(), relay()];
    await Promise.all(relays.map((r) => drain(r)));
    expect(await pending()).toBe(0);
    const { rows } = await ctx.services.pool.query('SELECT max(attempts)::int AS max FROM outbox WHERE aggregate_id = ANY($1)', [ids]);
    expect(rows[0].max).toBe(1);
  });

  it('when Redis is unreachable, rows are released with an error and retried later - not lost', async () => {
    await drain(relay());
    const ids = await submitMany(4);
    const dead = new QueueSet('redis://127.0.0.1:6399', `${ctx.services.config.REDIS_KEY_PREFIX}-dead`, ['default']);
    try {
      await relay(dead, 300).tick();
    } finally {
      await Promise.race([dead.close(), new Promise((r) => setTimeout(r, 500))]);
    }
    const { rows } = await ctx.services.pool.query(
      'SELECT published_at, last_error, locked_until, available_at > now() AS deferred FROM outbox WHERE aggregate_id = ANY($1)',
      [ids],
    );
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r.published_at).toBeNull();
      expect(r.locked_until).toBeNull();
      expect(r.last_error).toMatch(/timed out/);
      expect(r.deferred).toBe(true);
    }
    // Once Redis is back (the real one), the rows go out.
    await ctx.services.pool.query('UPDATE outbox SET available_at = now() WHERE aggregate_id = ANY($1)', [ids]);
    await drain(relay());
    expect(await pending()).toBe(0);
  });

  it('reports backlog size and age', async () => {
    await submitMany(2);
    const r = relay();
    const backlog = await r.collectBacklog();
    expect(backlog.pending).toBe(2);
    await drain(r);
    expect((await r.collectBacklog()).pending).toBe(0);
  });
});
