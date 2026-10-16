import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCursor, readCommittedEvents } from '../../src/modules/events/event-log.js';
import { JobExecutor } from '../../src/modules/workers/job-executor.js';
import { waitFor } from '../helpers/pipeline.js';
import { asKey, asUser, createTenant, createTestContext, type TestContext } from '../helpers/context.js';
import { SseClient } from '../helpers/sse.js';

let ctx: TestContext;
let base: string;
let a: Awaited<ReturnType<typeof createTenant>>;
let b: Awaited<ReturnType<typeof createTenant>>;
const clients: SseClient[] = [];

beforeAll(async () => {
  ctx = await createTestContext({
    env: { SSE_POLL_MS: '25', SSE_HEARTBEAT_MS: '1000', SSE_REPLAY_MAX_EVENTS: '50' },
  });
  await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = ctx.app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${addr.port}`;
  a = await createTenant(ctx.services);
  b = await createTenant(ctx.services);
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await ctx.close();
});

async function connect(projectId: string, headers: Record<string, string>): Promise<SseClient> {
  const c = await SseClient.connect(`${base}/v1/projects/${projectId}/stream`, headers);
  clients.push(c);
  return c;
}

async function submit(
  t: typeof a,
  body: Record<string, unknown> = { type: 'demo.echo', payload: {} },
): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/v1/projects/${t.projectId}/jobs`,
    headers: asKey(t.apiKey),
    payload: body,
  });
  expect(res.statusCode).toBe(201);
  return res.json().job.id as string;
}

function run(jobId: string, projectId: string): Promise<string> {
  const ex = new JobExecutor(
    ctx.services.jobExecution,
    ctx.services.handlers,
    ctx.services.logger,
    ctx.services.metrics,
    {
      workerId: 'rt-worker',
      leaseMs: 5_000,
    },
  );
  return ex.process({
    jobId,
    attempt: 1,
    projectId,
    queue: 'default',
    type: 'demo.echo',
    correlationId: null,
  });
}

describe('server-sent events', () => {
  it('requires authentication and project access', async () => {
    const anon = await connect(a.projectId, {});
    expect(anon.status).toBe(401);
    const otherTenant = await connect(a.projectId, asKey(b.apiKey));
    expect(otherTenant.status).toBe(404);
  });

  it('delivers job lifecycle events live, in order, with commit-ordered ids', async () => {
    const stream = await connect(a.projectId, asKey(a.apiKey));
    expect(stream.status).toBe(200);
    await stream.waitFor((c) => c.messages.some((m) => m.event === 'ready'));
    const id = await submit(a);
    expect(await run(id, a.projectId)).toBe('succeeded');
    await stream.waitFor((c) => c.jobEvents.filter((e) => e.jobId === id).length === 3);
    const mine = stream.messages.filter(
      (m) => m.event === 'job' && (m.data as { jobId: string }).jobId === id,
    );
    expect(mine.map((m) => (m.data as { type: string }).type)).toEqual([
      'job.created',
      'job.started',
      'job.succeeded',
    ]);
    for (const m of mine) expect(m.id).toMatch(/^\d+\.\d+$/);
    await stream.close();
  });

  it("never leaks another project's events", async () => {
    const streamB = await connect(b.projectId, asKey(b.apiKey));
    const streamA = await connect(a.projectId, asKey(a.apiKey));
    await Promise.all(
      [streamA, streamB].map((s) => s.waitFor((c) => c.messages.some((m) => m.event === 'ready'))),
    );
    const idA = await submit(a);
    const idB = await submit(b);
    await streamA.waitFor((c) => c.jobEvents.some((e) => e.jobId === idA));
    await streamB.waitFor((c) => c.jobEvents.some((e) => e.jobId === idB));
    await new Promise((r) => setTimeout(r, 200));
    expect(streamB.jobEvents.every((e) => e.jobId !== idA)).toBe(true);
    expect(streamA.jobEvents.every((e) => e.jobId !== idB)).toBe(true);
    await Promise.all([streamA.close(), streamB.close()]);
  });

  it('resumes after a disconnect with Last-Event-ID: missed events exactly once, no gaps', async () => {
    const first = await connect(a.projectId, asUser(a.user));
    await first.waitFor((c) => c.messages.some((m) => m.event === 'ready'));
    const before = await submit(a);
    await first.waitFor((c) => c.jobEvents.some((e) => e.jobId === before));
    const resumeFrom = first.lastEventId;
    expect(resumeFrom).toBeDefined();
    await first.close(); // browser tab sleeps / network drops

    // While disconnected, things happen.
    const missed = [await submit(a), await submit(a), await submit(a)];
    for (const id of missed) await run(id, a.projectId);

    const second = await connect(a.projectId, { ...asUser(a.user), 'last-event-id': resumeFrom! });
    // Replay covers everything below the commit watermark; anything committed above it (the
    // watermark is cluster-wide, so busy neighbours delay it) follows as live traffic. Either way
    // every missed event must arrive exactly once.
    await second.waitFor((c) => missed.every((id) => c.jobEvents.filter((e) => e.jobId === id).length >= 3));
    const replayed = second.jobEvents;
    expect(replayed.filter((e) => e.jobId === before)).toHaveLength(0); // already seen: not repeated
    for (const id of missed) {
      expect(replayed.filter((e) => e.jobId === id).map((e) => e.type)).toEqual([
        'job.created',
        'job.started',
        'job.succeeded',
      ]);
    }
    // Live delivery continues on the resumed stream.
    const after = await submit(a);
    await second.waitFor((c) => c.jobEvents.some((e) => e.jobId === after));
    const ids = second.messages.filter((m) => m.event === 'job').map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    await second.close();
  });

  it('accepts ?since= as an alternative to the Last-Event-ID header', async () => {
    const first = await connect(a.projectId, asKey(a.apiKey));
    await first.waitFor((c) => c.messages.some((m) => m.event === 'ready'));
    const cursor = first.lastEventId!;
    await first.close();
    const id = await submit(a);
    const second = await SseClient.connect(
      `${base}/v1/projects/${a.projectId}/stream?since=${cursor}`,
      asKey(a.apiKey),
    );
    clients.push(second);
    await second.waitFor((c) => c.jobEvents.some((e) => e.jobId === id));
    await second.close();
  });

  it('sends reset when the client is too far behind, or the cursor is invalid', async () => {
    const first = await connect(a.projectId, asKey(a.apiKey));
    await first.waitFor((c) => c.messages.some((m) => m.event === 'ready'));
    const cursor = first.lastEventId!;
    await first.close();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/projects/${a.projectId}/jobs/batch`,
      headers: asKey(a.apiKey),
      payload: { jobs: Array.from({ length: 60 }, () => ({ type: 'demo.echo', payload: {} })) }, // > SSE_REPLAY_MAX_EVENTS
    });
    expect(res.statusCode).toBe(201);
    // Wait until the batch is below the (cluster-wide) commit watermark, i.e. replayable.
    const from = parseCursor(cursor)!;
    await waitFor(
      async () => (await readCommittedEvents(ctx.services.pool, from, 100, [a.projectId])).length > 50,
    );
    const behind = await connect(a.projectId, { ...asKey(a.apiKey), 'last-event-id': cursor });
    await behind.waitFor((c) => c.messages.some((m) => m.event === 'ready'));
    expect(behind.messages.find((m) => m.event === 'reset')?.data).toEqual({ reason: 'too_far_behind' });
    // Nothing is replayed before `ready`: the client is told to re-fetch instead. (Events committed
    // after the live position may still follow as normal live traffic.)
    const readyAt = behind.messages.findIndex((m) => m.event === 'ready');
    expect(behind.messages.slice(0, readyAt).filter((m) => m.event === 'job')).toHaveLength(0);

    const garbage = await connect(a.projectId, { ...asKey(a.apiKey), 'last-event-id': 'not-a-cursor' });
    await garbage.waitFor((c) => c.messages.some((m) => m.event === 'ready'));
    expect(garbage.messages.find((m) => m.event === 'reset')?.data).toEqual({ reason: 'invalid_cursor' });
    await Promise.all([behind.close(), garbage.close()]);
  });

  it('sends heartbeats and periodic system snapshots', async () => {
    const stream = await connect(a.projectId, asKey(a.apiKey));
    await stream.waitFor(
      (c) => c.comments.includes('ping') && c.messages.some((m) => m.event === 'system'),
      12_000,
    );
    const sys = stream.messages.find((m) => m.event === 'system')?.data as {
      queues: object;
      workers: object;
    };
    expect(sys).toHaveProperty('queues');
    expect(sys).toHaveProperty('workers');
    await stream.close();
  });

  it('shutting the API down ends open streams instead of hanging (clients reconnect elsewhere)', async () => {
    const other = await createTestContext();
    try {
      await other.app.listen({ port: 0, host: '127.0.0.1' });
      const addr = other.app.server.address();
      if (!addr || typeof addr === 'string') throw new Error('no address');
      const t = await createTenant(other.services);
      const stream = await SseClient.connect(
        `http://127.0.0.1:${addr.port}/v1/projects/${t.projectId}/stream`,
        asKey(t.apiKey),
      );
      await stream.waitFor((c) => c.messages.some((m) => m.event === 'ready'));
      const started = Date.now();
      await other.app.close();
      expect(Date.now() - started).toBeLessThan(3_000);
      await stream.waitFor((c) => c.closed, 3_000);
    } finally {
      await other.close();
    }
  });

  it('limits concurrent streams per principal', async () => {
    const opened: SseClient[] = [];
    for (let i = 0; i < 20; i++) opened.push(await connect(b.projectId, asKey(b.apiKey)));
    expect(opened.every((c) => c.status === 200)).toBe(true);
    const extra = await connect(b.projectId, asKey(b.apiKey));
    expect(extra.status).toBe(429);
    await Promise.all(opened.map((c) => c.close()));
    // Slots are released when clients disconnect.
    await new Promise((r) => setTimeout(r, 200));
    const again = await connect(b.projectId, asKey(b.apiKey));
    expect(again.status).toBe(200);
    await again.close();
  });
});
