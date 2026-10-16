import type pg from 'pg';
import { withTransaction, type PoolClient } from '../../infra/db/pool.js';
import type { Logger } from '../../lib/logger.js';
import type { Metrics } from '../../lib/metrics.js';
import { cursorOf, ORIGIN, readCommittedEvents, type EventCursor } from '../events/event-log.js';
import type { JobEventRow } from '../jobs/model.js';

/** Upper bounds (ms) of the latency histogram buckets; the last bucket is +Inf. Shared with the SQL schema. */
export const LATENCY_BUCKETS_MS = [
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000,
] as const;
export const HISTOGRAM_SIZE = LATENCY_BUCKETS_MS.length + 1;

export function bucketIndex(ms: number): number {
  const i = LATENCY_BUCKETS_MS.findIndex((b) => ms <= b);
  return i === -1 ? LATENCY_BUCKETS_MS.length : i;
}

const CHECKPOINT = 'job_read_model';
// Arbitrary constant: only one projector folds events at a time; others skip the tick.
const PROJECTOR_LOCK_KEY = 727_301_002;

interface MinuteStats {
  projectId: string;
  bucket: Date;
  submitted: number;
  started: number;
  succeeded: number;
  failed: number;
  retried: number;
  cancelled: number;
  execHist: number[];
  waitHist: number[];
  execSum: number;
  waitSum: number;
}

/**
 * CQRS projector: folds the job event log into the read model (`project_job_counts`,
 * `job_stats_minutely`). The batch's increments and the new checkpoint commit in one transaction,
 * so every event is applied exactly once even if the process crashes mid-batch.
 */
export class Projector {
  constructor(
    private readonly pool: pg.Pool,
    private readonly logger: Logger,
    private readonly metrics: Pick<Metrics, 'projectionLag' | 'projectedEvents'>,
    private readonly batchSize = 1_000,
  ) {}

  /** Returns true when a full batch was processed (more events are probably waiting). */
  async tick(): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const { rows: lock } = await client.query<{ ok: boolean }>(
        'SELECT pg_try_advisory_xact_lock($1) AS ok',
        [PROJECTOR_LOCK_KEY],
      );
      if (!lock[0]?.ok) return false;
      const cursor = await this.checkpoint(client);
      const events = await readCommittedEvents(client, cursor, this.batchSize);
      if (events.length === 0) return false;
      await this.apply(client, events);
      const last = events[events.length - 1] as JobEventRow;
      await this.saveCheckpoint(client, cursorOf(last));
      this.metrics.projectedEvents.inc(events.length);
      this.metrics.projectionLag.set(Math.max(0, (Date.now() - last.created_at.getTime()) / 1000));
      return events.length === this.batchSize;
    });
  }

  async checkpoint(client: pg.PoolClient | pg.Pool): Promise<EventCursor> {
    const { rows } = await client.query<{ tx_id: string; event_id: string }>(
      'SELECT tx_id::text, event_id::text FROM projection_checkpoints WHERE name = $1',
      [CHECKPOINT],
    );
    const r = rows[0];
    return r ? { txId: r.tx_id, id: r.event_id } : ORIGIN;
  }

  /**
   * Repair procedure: recompute status counts from the `jobs` table and move the checkpoint to the
   * current end of the log, atomically.
   *
   * Correctness relies on an invariant of the write side: every transaction that appends job events
   * modifies `jobs` first. `LOCK TABLE jobs IN EXCLUSIVE MODE` waits for all such transactions to
   * commit and blocks new ones (reads continue), so the counts and the checkpoint describe exactly
   * the same set of events. Writers are blocked for the duration of the count.
   */
  async rebuildCounts(): Promise<{ projects: number; checkpoint: EventCursor }> {
    return withTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [PROJECTOR_LOCK_KEY]);
      await client.query('LOCK TABLE jobs IN EXCLUSIVE MODE');
      await client.query('DELETE FROM project_job_counts');
      const { rowCount } = await client.query(
        `INSERT INTO project_job_counts (project_id, status, count)
         SELECT project_id, status, count(*) FROM jobs GROUP BY project_id, status`,
      );
      const { rows } = await client.query<{ tx_id: string; id: string }>(
        'SELECT e.tx_id::text AS tx_id, e.id::text AS id FROM job_events e ORDER BY e.tx_id DESC, e.id DESC LIMIT 1',
      );
      const head = rows[0] ? { txId: rows[0].tx_id, id: rows[0].id } : ORIGIN;
      await this.saveCheckpoint(client, head);
      this.logger.info({ rows: rowCount, checkpoint: head }, 'read-model counts rebuilt');
      return { projects: rowCount ?? 0, checkpoint: head };
    });
  }

  private async saveCheckpoint(client: PoolClient, c: EventCursor): Promise<void> {
    await client.query(
      `INSERT INTO projection_checkpoints (name, tx_id, event_id, updated_at) VALUES ($1, $2::xid8, $3, now())
       ON CONFLICT (name) DO UPDATE SET tx_id = excluded.tx_id, event_id = excluded.event_id, updated_at = now()`,
      [CHECKPOINT, c.txId, c.id],
    );
  }

  private async apply(client: PoolClient, events: JobEventRow[]): Promise<void> {
    const counts = new Map<string, number>();
    const stats = new Map<string, MinuteStats>();
    const bump = (projectId: string, status: string, delta: number): void => {
      const k = `${projectId}|${status}`;
      counts.set(k, (counts.get(k) ?? 0) + delta);
    };

    for (const e of events) {
      if (e.data.from) bump(e.project_id, e.data.from, -1);
      bump(e.project_id, e.data.to, 1);

      const bucket = new Date(Math.floor(e.created_at.getTime() / 60_000) * 60_000);
      const sk = `${e.project_id}|${bucket.toISOString()}`;
      let s = stats.get(sk);
      if (!s) {
        s = {
          projectId: e.project_id,
          bucket,
          submitted: 0,
          started: 0,
          succeeded: 0,
          failed: 0,
          retried: 0,
          cancelled: 0,
          execHist: new Array<number>(HISTOGRAM_SIZE).fill(0),
          waitHist: new Array<number>(HISTOGRAM_SIZE).fill(0),
          execSum: 0,
          waitSum: 0,
        };
        stats.set(sk, s);
      }
      switch (e.type) {
        case 'job.created':
          s.submitted++;
          break;
        case 'job.started':
          s.started++;
          if (e.data.queueWaitMs !== undefined) {
            const i = bucketIndex(e.data.queueWaitMs);
            s.waitHist[i] = (s.waitHist[i] ?? 0) + 1;
            s.waitSum += e.data.queueWaitMs;
          }
          break;
        case 'job.succeeded':
          s.succeeded++;
          break;
        case 'job.failed':
          s.failed++;
          break;
        case 'job.retry_scheduled':
          s.retried++;
          break;
        case 'job.cancelled':
          s.cancelled++;
          break;
        case 'job.queued':
          break;
      }
      if (
        (e.type === 'job.succeeded' || e.type === 'job.failed' || e.type === 'job.retry_scheduled') &&
        e.data.durationMs !== undefined
      ) {
        const i = bucketIndex(e.data.durationMs);
        s.execHist[i] = (s.execHist[i] ?? 0) + 1;
        s.execSum += e.data.durationMs;
      }
    }

    const countEntries = [...counts.entries()]
      .filter(([, d]) => d !== 0)
      .map(([k, d]) => [...k.split('|'), d] as const);
    if (countEntries.length > 0) {
      await client.query(
        `INSERT INTO project_job_counts AS c (project_id, status, count)
         SELECT * FROM unnest($1::uuid[], $2::text[], $3::bigint[])
         ON CONFLICT (project_id, status) DO UPDATE SET count = c.count + excluded.count`,
        [countEntries.map((e) => e[0]), countEntries.map((e) => e[1]), countEntries.map((e) => e[2])],
      );
    }

    const s = [...stats.values()];
    await client.query(
      `INSERT INTO job_stats_minutely AS s (project_id, bucket, submitted, started, succeeded, failed, retried, cancelled,
                                            exec_ms_hist, wait_ms_hist, exec_ms_sum, wait_ms_sum)
       SELECT u.project_id, u.bucket, u.submitted, u.started, u.succeeded, u.failed, u.retried, u.cancelled,
              u.exec_hist::int[], u.wait_hist::int[], u.exec_sum, u.wait_sum
       FROM unnest($1::uuid[], $2::timestamptz[], $3::int[], $4::int[], $5::int[], $6::int[], $7::int[], $8::int[],
                   $9::text[], $10::text[], $11::bigint[], $12::bigint[])
            AS u(project_id, bucket, submitted, started, succeeded, failed, retried, cancelled, exec_hist, wait_hist, exec_sum, wait_sum)
       ON CONFLICT (project_id, bucket) DO UPDATE SET
         submitted = s.submitted + excluded.submitted,
         started = s.started + excluded.started,
         succeeded = s.succeeded + excluded.succeeded,
         failed = s.failed + excluded.failed,
         retried = s.retried + excluded.retried,
         cancelled = s.cancelled + excluded.cancelled,
         exec_ms_hist = (SELECT array_agg(a + b ORDER BY i) FROM unnest(s.exec_ms_hist, excluded.exec_ms_hist) WITH ORDINALITY AS h(a, b, i)),
         wait_ms_hist = (SELECT array_agg(a + b ORDER BY i) FROM unnest(s.wait_ms_hist, excluded.wait_ms_hist) WITH ORDINALITY AS h(a, b, i)),
         exec_ms_sum = s.exec_ms_sum + excluded.exec_ms_sum,
         wait_ms_sum = s.wait_ms_sum + excluded.wait_ms_sum`,
      [
        s.map((x) => x.projectId),
        s.map((x) => x.bucket),
        s.map((x) => x.submitted),
        s.map((x) => x.started),
        s.map((x) => x.succeeded),
        s.map((x) => x.failed),
        s.map((x) => x.retried),
        s.map((x) => x.cancelled),
        s.map((x) => `{${x.execHist.join(',')}}`),
        s.map((x) => `{${x.waitHist.join(',')}}`),
        s.map((x) => x.execSum),
        s.map((x) => x.waitSum),
      ],
    );
  }
}
