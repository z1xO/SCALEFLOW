import type pg from 'pg';
import type { Config } from '../../config/env.js';
import type { Metrics } from '../../lib/metrics.js';

interface Policy {
  table: string;
  sql: string;
  param: number;
}

/**
 * Batched retention. Each statement deletes at most `batchSize` rows in its own short
 * transaction: long deletes would bloat WAL, hold locks, and (see docs/architecture.md §6) hold
 * back the event-log watermark that real-time delivery and the projector depend on.
 */
export class Retention {
  private readonly policies: Policy[];

  constructor(
    private readonly pool: pg.Pool,
    config: Pick<
      Config,
      | 'RETENTION_JOBS_DAYS'
      | 'RETENTION_EVENTS_DAYS'
      | 'RETENTION_OUTBOX_HOURS'
      | 'RETENTION_STATS_DAYS'
      | 'RETENTION_AUDIT_DAYS'
    >,
    private readonly metrics: Pick<Metrics, 'retentionDeleted'>,
    private readonly batchSize = 5_000,
  ) {
    const days = (n: number) => n * 86_400;
    this.policies = [
      {
        table: 'jobs',
        // Cascades to job_attempts and job_events of those jobs.
        sql: `DELETE FROM jobs WHERE id IN (
                SELECT id FROM jobs WHERE status IN ('succeeded','failed','cancelled')
                AND finished_at < now() - make_interval(secs => $1) LIMIT $2)`,
        param: days(config.RETENTION_JOBS_DAYS),
      },
      {
        table: 'job_events',
        sql: `DELETE FROM job_events WHERE id IN (
                SELECT id FROM job_events WHERE created_at < now() - make_interval(secs => $1) LIMIT $2)`,
        param: days(config.RETENTION_EVENTS_DAYS),
      },
      {
        table: 'outbox',
        sql: `DELETE FROM outbox WHERE id IN (
                SELECT id FROM outbox WHERE published_at < now() - make_interval(secs => $1) LIMIT $2)`,
        param: config.RETENTION_OUTBOX_HOURS * 3600,
      },
      {
        table: 'job_stats_minutely',
        sql: `DELETE FROM job_stats_minutely WHERE ctid IN (
                SELECT ctid FROM job_stats_minutely WHERE bucket < now() - make_interval(secs => $1) LIMIT $2)`,
        param: days(config.RETENTION_STATS_DAYS),
      },
      {
        table: 'audit_log',
        sql: `DELETE FROM audit_log WHERE id IN (
                SELECT id FROM audit_log WHERE created_at < now() - make_interval(secs => $1) LIMIT $2)`,
        param: days(config.RETENTION_AUDIT_DAYS),
      },
      {
        table: 'sessions',
        sql: `DELETE FROM sessions WHERE id IN (
                SELECT id FROM sessions WHERE expires_at < now() - make_interval(secs => $1) LIMIT $2)`,
        param: 0,
      },
      {
        table: 'workers',
        sql: `DELETE FROM workers WHERE id IN (
                SELECT id FROM workers WHERE status = 'offline' AND stopped_at < now() - make_interval(secs => $1) LIMIT $2)`,
        param: days(7),
      },
    ];
  }

  /** One pass over every policy, at most `maxBatches` batches each. Returns rows deleted per table. */
  async run(maxBatches = 10): Promise<Record<string, number>> {
    const deleted: Record<string, number> = {};
    for (const p of this.policies) {
      let total = 0;
      for (let i = 0; i < maxBatches; i++) {
        const { rowCount } = await this.pool.query(p.sql, [p.param, this.batchSize]);
        const n = rowCount ?? 0;
        total += n;
        if (n < this.batchSize) break;
      }
      if (total > 0) this.metrics.retentionDeleted.inc({ table: p.table }, total);
      deleted[p.table] = total;
    }
    return deleted;
  }
}
