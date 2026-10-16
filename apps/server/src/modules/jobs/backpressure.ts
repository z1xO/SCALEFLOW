import type pg from 'pg';
import { ACTIVE_STATUSES } from '../../domain/job-state.js';
import { ServiceUnavailableError, TooManyRequestsError } from '../../lib/errors.js';
import type { Metrics } from '../../lib/metrics.js';

interface Cached {
  value: number;
  at: number;
}

/**
 * Admission control for job submission.
 *
 * - Per project: reject (429) when the number of non-terminal jobs reaches a quota, so one tenant
 *   cannot fill the queue for everyone. The count comes from the read model, so it can lag by
 *   about a second - acceptable for a protective limit, and far cheaper than count(*).
 * - System wide: reject (503) when the outbox backlog is large, i.e. the relay or Redis cannot keep
 *   up. Accepting more work at that point only grows latency for everyone.
 *
 * Values are cached in-process for `cacheMs` so admission costs no database round trip on the hot path.
 */
export class Backpressure {
  private readonly projectCounts = new Map<string, Cached>();
  private outbox: Cached | undefined;

  constructor(
    private readonly pool: pg.Pool,
    private readonly limits: { maxActivePerProject: number; maxOutboxBacklog: number },
    private readonly metrics: Pick<Metrics, 'backpressureRejections'>,
    private readonly cacheMs = 1_000,
  ) {}

  async check(projectId: string, incoming: number): Promise<void> {
    const [active, backlog] = await Promise.all([this.activeJobs(projectId), this.outboxBacklog()]);
    if (backlog >= this.limits.maxOutboxBacklog) {
      this.metrics.backpressureRejections.inc({ reason: 'outbox_backlog' });
      throw new ServiceUnavailableError(
        'system_overloaded',
        'The system is temporarily not accepting new jobs; retry later',
        5,
      );
    }
    if (active + incoming > this.limits.maxActivePerProject) {
      this.metrics.backpressureRejections.inc({ reason: 'project_quota' });
      throw new TooManyRequestsError(
        'project_queue_full',
        `Project has reached its limit of ${this.limits.maxActivePerProject} active jobs`,
        10,
      );
    }
  }

  private async activeJobs(projectId: string): Promise<number> {
    const cached = this.projectCounts.get(projectId);
    if (cached && Date.now() - cached.at < this.cacheMs) return cached.value;
    const { rows } = await this.pool.query<{ n: string | null }>(
      'SELECT sum(count)::text AS n FROM project_job_counts WHERE project_id = $1 AND status = ANY($2)',
      [projectId, ACTIVE_STATUSES],
    );
    const value = Number(rows[0]?.n ?? 0);
    this.projectCounts.set(projectId, { value, at: Date.now() });
    if (this.projectCounts.size > 10_000) this.projectCounts.clear();
    return value;
  }

  private async outboxBacklog(): Promise<number> {
    if (this.outbox && Date.now() - this.outbox.at < this.cacheMs) return this.outbox.value;
    // Bounded count: we only need to know whether the backlog crossed the limit.
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM (SELECT 1 FROM outbox WHERE published_at IS NULL LIMIT $1) t`,
      [this.limits.maxOutboxBacklog],
    );
    const value = Number(rows[0]?.n ?? 0);
    this.outbox = { value, at: Date.now() };
    return value;
  }
}
