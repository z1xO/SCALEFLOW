import type pg from 'pg';
import { withTransaction } from '../../infra/db/pool.js';
import { dispatchJobId, type QueueSet } from '../../infra/queue.js';
import type { Logger } from '../../lib/logger.js';
import type { Metrics } from '../../lib/metrics.js';
import type { JobRow } from '../jobs/model.js';
import { enqueueDispatches } from '../jobs/write-helpers.js';

const PENDING_STATES = new Set(['waiting', 'active', 'delayed', 'prioritized', 'waiting-children']);

/**
 * Dispatch reconciler: the last line of defence for "accepted jobs never silently disappear".
 *
 * A job can be `queued` in PostgreSQL while BullMQ has no live entry for it if Redis lost data
 * (restart without persistence, failover, manual flush) or a delivery failed before the claim. For
 * jobs queued longer than `thresholdMs` that have no unpublished outbox row, ask BullMQ for the
 * dispatch's state and re-dispatch through the outbox if it is missing or already finished.
 */
export class DispatchReconciler {
  constructor(
    private readonly pool: pg.Pool,
    private readonly queues: QueueSet,
    private readonly logger: Logger,
    private readonly metrics: Pick<Metrics, 'dispatchesReconciled'>,
    private readonly thresholdMs: number,
  ) {}

  async tick(limit = 500): Promise<number> {
    const { rows } = await this.pool.query<Pick<JobRow, 'id' | 'queue' | 'attempt_count'>>(
      `SELECT j.id, j.queue, j.attempt_count FROM jobs j
       WHERE j.status = 'queued' AND j.queued_at < now() - make_interval(secs => $1::double precision / 1000)
         AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.aggregate_id = j.id AND o.published_at IS NULL)
       ORDER BY j.queued_at LIMIT $2`,
      [this.thresholdMs, limit],
    );
    const missing: typeof rows = [];
    for (const r of rows) {
      if (!this.queues.names.includes(r.queue)) continue;
      const queue = this.queues.get(r.queue);
      const bullId = dispatchJobId(r.id, r.attempt_count + 1);
      const state = await queue.getJobState(bullId);
      if (PENDING_STATES.has(state)) continue;
      if (state === 'completed' || state === 'failed') {
        // A finished delivery for a job that is still queued: that delivery never claimed it.
        // Remove it so the deterministic id can be reused.
        await queue.remove(bullId);
      }
      missing.push(r);
    }
    if (missing.length === 0) return 0;

    const redispatched = await withTransaction(this.pool, async (client) => {
      // Re-check under lock: only jobs still queued for the same attempt.
      const { rows: locked } = await client.query<JobRow>(
        `SELECT * FROM jobs WHERE id = ANY($1) AND status = 'queued' FOR UPDATE SKIP LOCKED`,
        [missing.map((m) => m.id)],
      );
      const stillMissing = locked.filter((j) =>
        missing.some((m) => m.id === j.id && m.attempt_count === j.attempt_count),
      );
      await enqueueDispatches(client, stillMissing);
      return stillMissing;
    });
    if (redispatched.length > 0) {
      this.metrics.dispatchesReconciled.inc(redispatched.length);
      this.logger.warn(
        { count: redispatched.length, jobIds: redispatched.slice(0, 20).map((j) => j.id) },
        're-dispatched queued jobs missing from the queue',
      );
    }
    return redispatched.length;
  }
}
