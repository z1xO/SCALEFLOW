import type pg from 'pg';
import type { QueueSet } from '../../infra/queue.js';
import type { Metrics } from '../../lib/metrics.js';

export interface SystemSnapshot {
  takenAt: string;
  queues: Record<string, Record<string, number>>;
  jobs: { scheduled: number; queued: number; running: number; retry_wait: number };
  oldestQueuedAgeSeconds: number;
  outbox: { pending: number; oldestAgeSeconds: number };
  workers: { online: number; draining: number; activeJobs: number; capacity: number };
}

/**
 * Point-in-time operational state, shared by the scheduler's Prometheus gauges, the
 * /v1/system/queues endpoint and the real-time `system.snapshot` event. Each count is shaped to
 * be served by one of the partial indexes (status-specific), not a full table scan.
 */
export async function takeSnapshot(pool: pg.Pool, queues: QueueSet): Promise<SystemSnapshot> {
  const [counts, db] = await Promise.all([
    queues.counts(),
    pool.query<{
      scheduled: number;
      queued: number;
      running: number;
      retry_wait: number;
      oldest_queued: number | null;
      outbox_pending: number;
      outbox_oldest: number | null;
      online: number;
      draining: number;
      active_jobs: number | null;
      capacity: number | null;
    }>(`SELECT
          (SELECT count(*)::int FROM jobs WHERE status = 'scheduled') AS scheduled,
          (SELECT count(*)::int FROM jobs WHERE status = 'queued') AS queued,
          (SELECT count(*)::int FROM jobs WHERE status = 'running') AS running,
          (SELECT count(*)::int FROM jobs WHERE status = 'retry_wait') AS retry_wait,
          (SELECT extract(epoch FROM now() - min(queued_at))::float8 FROM jobs WHERE status = 'queued') AS oldest_queued,
          (SELECT count(*)::int FROM outbox WHERE published_at IS NULL) AS outbox_pending,
          (SELECT extract(epoch FROM now() - min(available_at))::float8 FROM outbox
             WHERE published_at IS NULL AND available_at <= now()) AS outbox_oldest,
          (SELECT count(*)::int FROM workers WHERE status = 'online') AS online,
          (SELECT count(*)::int FROM workers WHERE status = 'draining') AS draining,
          (SELECT sum(active_jobs)::int FROM workers WHERE status <> 'offline') AS active_jobs,
          (SELECT sum(concurrency)::int FROM workers WHERE status = 'online') AS capacity`),
  ]);
  const r = db.rows[0];
  if (!r) throw new Error('snapshot query returned no row');
  return {
    takenAt: new Date().toISOString(),
    queues: counts,
    jobs: { scheduled: r.scheduled, queued: r.queued, running: r.running, retry_wait: r.retry_wait },
    oldestQueuedAgeSeconds: Math.max(0, r.oldest_queued ?? 0),
    outbox: { pending: r.outbox_pending, oldestAgeSeconds: Math.max(0, r.outbox_oldest ?? 0) },
    workers: { online: r.online, draining: r.draining, activeJobs: r.active_jobs ?? 0, capacity: r.capacity ?? 0 },
  };
}

export function exportSnapshot(metrics: Metrics, s: SystemSnapshot): void {
  for (const [queue, states] of Object.entries(s.queues)) {
    for (const [state, n] of Object.entries(states)) {
      if (state === 'completed' || state === 'failed') continue; // retained history, not depth
      metrics.queueDepth.set({ queue, state }, n);
    }
  }
  for (const [status, n] of Object.entries(s.jobs)) metrics.jobsByStatus.set({ status }, n);
  metrics.oldestQueuedAge.set(s.oldestQueuedAgeSeconds);
  metrics.outboxPending.set(s.outbox.pending);
  metrics.outboxOldestPendingAge.set(s.outbox.oldestAgeSeconds);
  metrics.workersOnline.set(s.workers.online);
}
