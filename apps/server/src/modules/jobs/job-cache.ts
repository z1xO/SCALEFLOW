import type { Redis } from 'ioredis';
import { isTerminal } from '../../domain/job-state.js';
import { VersionedCache } from '../../infra/cache/versioned-cache.js';
import type { Logger } from '../../lib/logger.js';
import type { Metrics } from '../../lib/metrics.js';
import type { JobDto, JobRow } from './model.js';

const ACTIVE_TTL_MS = 2_000;
const TERMINAL_TTL_MS = 300_000;

/**
 * Job-detail cache (the endpoint clients poll). Active jobs change every few seconds, so they get
 * a short TTL; terminal jobs are effectively immutable (only a manual retry changes them, and that
 * writes a tombstone) so they are kept longer.
 */
export class JobCache {
  private readonly cache: VersionedCache<JobDto>;

  constructor(
    redis: Redis,
    private readonly prefix: string,
    logger: Logger,
    metrics: Pick<Metrics, 'cacheRequests'>,
  ) {
    this.cache = new VersionedCache<JobDto>(redis, 'job', logger, metrics);
  }

  key(projectId: string, jobId: string): string {
    return `${this.prefix}:job:${projectId}:${jobId}`;
  }

  get(projectId: string, jobId: string): Promise<JobDto | null> {
    return this.cache.get(this.key(projectId, jobId));
  }

  fill(job: JobDto): Promise<boolean> {
    return this.cache.fill(this.key(job.projectId, job.id), job, isTerminal(job.status) ? TERMINAL_TTL_MS : ACTIVE_TTL_MS);
  }

  /** Call after the transaction that produced `rows` has committed. */
  async invalidate(rows: Pick<JobRow, 'id' | 'project_id' | 'version'>[]): Promise<void> {
    await Promise.all(rows.map((r) => this.cache.invalidate(this.key(r.project_id, r.id), r.version)));
  }
}
