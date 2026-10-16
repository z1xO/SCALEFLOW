import { runLoop } from '../../src/lib/lifecycle.js';
import type { Services } from '../../src/container.js';
import { OutboxRelay } from '../../src/modules/outbox/relay.js';
import { Projector } from '../../src/modules/projections/projector.js';
import { WorkerRuntime } from '../../src/modules/workers/worker-runtime.js';
import type { JobDto } from '../../src/modules/jobs/model.js';

export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  { timeoutMs = 15_000, intervalMs = 50, what = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const reason = last instanceof Error ? `: ${last.message}` : '';
  throw new Error(`Timed out waiting for ${what}${reason}`);
}

export async function waitForStatus(
  services: Services,
  projectId: string,
  jobId: string,
  statuses: string[],
): Promise<JobDto> {
  return waitFor(
    async () => {
      const { rows } = await services.pool.query<{ status: string }>(
        'SELECT status FROM jobs WHERE id = $1',
        [jobId],
      );
      if (!rows[0] || !statuses.includes(rows[0].status)) return null;
      return services.jobQueries.get(projectId, jobId, '0/0');
    },
    { what: `job ${jobId} to reach ${statuses.join('|')}` },
  );
}

/**
 * Runs the whole background pipeline in-process with fast intervals: relay, projector, promoter,
 * lease reaper and a real BullMQ worker. Production runs the same classes in separate processes.
 */
export async function startPipeline(
  services: Services,
  opts: { concurrency?: number; leaseMs?: number; shutdownGraceMs?: number; worker?: boolean } = {},
): Promise<{ runtime: WorkerRuntime | null; stop: () => Promise<void> }> {
  const abort = new AbortController();
  const relay = new OutboxRelay(services.pool, services.queues, services.logger, services.metrics, {
    batchSize: 200,
    leaseMs: 30_000,
    publishTimeoutMs: 5_000,
  });
  const projector = new Projector(services.pool, services.logger, services.metrics);
  const common = { signal: abort.signal, logger: services.logger, metrics: services.metrics };
  const loops = [
    runLoop({ ...common, name: 'outbox', intervalMs: 25, tick: () => relay.tick() }),
    runLoop({ ...common, name: 'projector', intervalMs: 50, tick: () => projector.tick() }),
    runLoop({
      ...common,
      name: 'promoter',
      intervalMs: 25,
      tick: async () => (await services.jobExecution.promoteDue(500)).length === 500,
    }),
    runLoop({
      ...common,
      name: 'reaper',
      intervalMs: 100,
      tick: async () => (await services.jobExecution.recoverExpiredLeases(100)).length === 100,
    }),
  ];
  let runtime: WorkerRuntime | null = null;
  if (opts.worker !== false) {
    runtime = new WorkerRuntime(services, {
      workerId: `test-worker-${Math.random().toString(36).slice(2, 8)}`,
      queues: ['default'],
      concurrency: opts.concurrency ?? 5,
      leaseMs: opts.leaseMs ?? 5_000,
      heartbeatMs: 1_000,
      shutdownGraceMs: opts.shutdownGraceMs ?? 5_000,
    });
    await runtime.start();
  }
  let stopped = false;
  return {
    runtime,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (runtime) await runtime.stop();
      abort.abort();
      await Promise.all(loops);
    },
  };
}
