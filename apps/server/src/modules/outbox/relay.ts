import type pg from 'pg';
import { DISPATCH_JOB_OPTIONS, dispatchJobId, type QueueSet } from '../../infra/queue.js';
import { withTimeout } from '../../lib/async.js';
import { errorMessage } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import type { Metrics } from '../../lib/metrics.js';
import type { DispatchPayload } from '../jobs/write-helpers.js';

interface ClaimedRow {
  id: string;
  payload: DispatchPayload;
  attempts: number;
  available_at: Date;
}

export interface RelayOptions {
  batchSize: number;
  leaseMs: number;
  publishTimeoutMs: number;
}

/**
 * Transactional-outbox dispatcher: moves `job.dispatch` rows from PostgreSQL into BullMQ.
 *
 * 1. Claim a batch with a short lease (autocommit UPDATE ... FOR UPDATE SKIP LOCKED), so no
 *    transaction is held open while talking to Redis and several relays can run side by side.
 * 2. Publish with deterministic BullMQ job ids (re-publishing is a no-op).
 * 3. Mark published, or release with backoff and the error on failure.
 *
 * A crash anywhere leaves rows either unpublished (lease expires, another relay retries) or
 * published-but-unmarked (republished, deduplicated by BullMQ id and the worker's claim). Nothing is lost.
 */
export class OutboxRelay {
  constructor(
    private readonly pool: pg.Pool,
    private readonly queues: QueueSet,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
    private readonly opts: RelayOptions,
  ) {}

  /** Returns true when the batch was full (more work is probably waiting). */
  async tick(): Promise<boolean> {
    const { rows } = await this.pool.query<ClaimedRow>(
      `UPDATE outbox SET locked_until = now() + make_interval(secs => $2::double precision / 1000),
              attempts = attempts + 1
       WHERE id IN (
         SELECT id FROM outbox
         WHERE published_at IS NULL AND available_at <= now() AND (locked_until IS NULL OR locked_until < now())
         ORDER BY available_at, id LIMIT $1 FOR UPDATE SKIP LOCKED)
       RETURNING id::text, payload, attempts, available_at`,
      [this.opts.batchSize, this.opts.leaseMs],
    );
    if (rows.length === 0) return false;

    const byQueue = new Map<string, ClaimedRow[]>();
    for (const r of rows) {
      const list = byQueue.get(r.payload.queue) ?? [];
      list.push(r);
      byQueue.set(r.payload.queue, list);
    }

    await Promise.all(
      [...byQueue.entries()].map(async ([queueName, batch]) => {
        try {
          const queue = this.queues.get(queueName);
          await withTimeout(
            queue.addBulk(
              batch.map((r) => ({
                name: r.payload.type,
                data: r.payload,
                opts: { ...DISPATCH_JOB_OPTIONS, jobId: dispatchJobId(r.payload.jobId, r.payload.attempt) },
              })),
            ),
            this.opts.publishTimeoutMs,
            'outbox publish',
          );
          await this.pool.query(
            'UPDATE outbox SET published_at = now(), locked_until = NULL, last_error = NULL WHERE id = ANY($1::bigint[])',
            [batch.map((r) => r.id)],
          );
          const now = Date.now();
          this.metrics.outboxPublished.inc(batch.length);
          for (const r of batch) this.metrics.outboxPublishLatency.observe((now - r.available_at.getTime()) / 1000);
        } catch (err) {
          this.metrics.outboxPublishFailures.inc(batch.length);
          this.logger.warn({ err, queue: queueName, rows: batch.length }, 'outbox publish failed; will retry');
          // Exponential backoff per row, capped at 30s; the lease is released so any relay can retry.
          await this.pool.query(
            `UPDATE outbox SET locked_until = NULL, last_error = $2,
                    available_at = now() + make_interval(secs => least(30, 0.2 * power(2, least(attempts, 8))))
             WHERE id = ANY($1::bigint[])`,
            [batch.map((r) => r.id), errorMessage(err).slice(0, 500)],
          );
        }
      }),
    );
    return rows.length === this.opts.batchSize;
  }

  /** Backlog gauges for dashboards and alerts. */
  async collectBacklog(): Promise<{ pending: number; oldestAgeSeconds: number }> {
    const { rows } = await this.pool.query<{ pending: string; oldest: number | null }>(
      `SELECT count(*)::text AS pending,
              extract(epoch FROM (now() - min(available_at) FILTER (WHERE available_at <= now())))::float8 AS oldest
       FROM outbox WHERE published_at IS NULL`,
    );
    const pending = Number(rows[0]?.pending ?? 0);
    const oldestAgeSeconds = Math.max(0, rows[0]?.oldest ?? 0);
    this.metrics.outboxPending.set(pending);
    this.metrics.outboxOldestPendingAge.set(oldestAgeSeconds);
    return { pending, oldestAgeSeconds };
  }
}
