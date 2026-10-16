import type { JobStatus } from '../../domain/job-state.js';
import type { ReadRouter } from '../../infra/db/read-router.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { isUuid, uuidv7Bound } from '../../lib/uuid.js';
import type { JobCache } from './job-cache.js';
import {
  toAttemptDto,
  toEventDto,
  toJobDto,
  type AttemptDto,
  type AttemptRow,
  type JobDto,
  type JobEventDto,
  type JobEventRow,
  type JobRow,
} from './model.js';

export interface JobListFilters {
  status?: JobStatus[];
  type?: string;
  queue?: string;
  scheduleId?: string;
  createdAfter?: Date;
  createdBefore?: Date;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export function encodeCursor(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string, validate: (v: string) => boolean): string {
  const value = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!validate(value)) throw new ValidationError('Invalid cursor');
  return value;
}

/** Columns needed for list views - excludes payload/result, which can be large. */
const LIST_COLUMNS = `id, project_id, type, queue, status, NULL::jsonb AS payload, NULL::jsonb AS result, last_error,
  idempotency_key, NULL::text AS request_fingerprint, correlation_id, max_attempts, attempt_count, run_attempts, backoff,
  timeout_ms, run_at, scheduled_job_id, locked_by, lease_expires_at, version, created_at, updated_at, queued_at,
  started_at, finished_at`;

/**
 * Read side for jobs. Never writes, never locks, may be served from a replica (see ReadRouter) and
 * from the cache. Every query is scoped by project_id - an id from another project behaves exactly
 * like an id that does not exist.
 */
export class JobQueries {
  constructor(
    private readonly router: ReadRouter,
    private readonly cache: JobCache,
  ) {}

  async list(
    projectId: string,
    filters: JobListFilters,
    page: { limit: number; cursor?: string },
    minLsn?: string,
  ): Promise<Page<JobDto>> {
    const where: string[] = ['project_id = $1'];
    const params: unknown[] = [projectId];
    const add = (sql: string, value: unknown): void => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (filters.status?.length) add('status = ANY(?)', filters.status);
    if (filters.type) add('type = ?', filters.type);
    if (filters.queue) add('queue = ?', filters.queue);
    if (filters.scheduleId) add('scheduled_job_id = ?', filters.scheduleId);
    // UUIDv7 ids embed creation time, so time filters become index range conditions on id.
    if (filters.createdAfter) add('id >= ?', uuidv7Bound(filters.createdAfter, 'min'));
    if (filters.createdBefore) add('id <= ?', uuidv7Bound(filters.createdBefore, 'max'));
    if (page.cursor) add('id < ?', decodeCursor(page.cursor, isUuid));
    params.push(page.limit + 1);
    const sql = `SELECT ${LIST_COLUMNS} FROM jobs WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT $${params.length}`;

    const pool = await this.router.pool(minLsn);
    const { rows } = await pool.query<JobRow>(sql, params);
    const hasMore = rows.length > page.limit;
    const items = rows.slice(0, page.limit).map(toJobDto);
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? encodeCursor(last.id) : null };
  }

  async get(projectId: string, jobId: string, minLsn?: string): Promise<JobDto> {
    // A read-your-writes request bypasses the cache: the cache may be filled from a lagging replica.
    if (!minLsn) {
      const cached = await this.cache.get(projectId, jobId);
      if (cached) return cached;
    }
    const pool = await this.router.pool(minLsn);
    const { rows } = await pool.query<JobRow>('SELECT * FROM jobs WHERE id = $1 AND project_id = $2', [
      jobId,
      projectId,
    ]);
    const row = rows[0];
    if (!row) throw new NotFoundError('Job');
    const dto = toJobDto(row);
    await this.cache.fill(dto);
    return dto;
  }

  async attempts(projectId: string, jobId: string, minLsn?: string): Promise<AttemptDto[]> {
    const pool = await this.router.pool(minLsn);
    await this.assertJobExists(pool, projectId, jobId);
    const { rows } = await pool.query<AttemptRow>(
      'SELECT * FROM job_attempts WHERE job_id = $1 AND project_id = $2 ORDER BY attempt_number',
      [jobId, projectId],
    );
    return rows.map(toAttemptDto);
  }

  async jobEvents(projectId: string, jobId: string, minLsn?: string): Promise<JobEventDto[]> {
    const pool = await this.router.pool(minLsn);
    await this.assertJobExists(pool, projectId, jobId);
    const { rows } = await pool.query<JobEventRow>(
      `SELECT id::text, tx_id::text, project_id, job_id, type, data, created_at
       FROM job_events WHERE job_id = $1 AND project_id = $2 ORDER BY id LIMIT 1000`,
      [jobId, projectId],
    );
    return rows.map(toEventDto);
  }

  /** Project event history, newest first. */
  async projectEvents(
    projectId: string,
    page: { limit: number; cursor?: string; jobId?: string },
  ): Promise<Page<JobEventDto>> {
    const params: unknown[] = [projectId];
    let where = 'project_id = $1';
    if (page.jobId) {
      params.push(page.jobId);
      where += ` AND job_id = $${params.length}`;
    }
    if (page.cursor) {
      params.push(decodeCursor(page.cursor, (v) => /^\d{1,19}$/.test(v)));
      where += ` AND id < $${params.length}`;
    }
    params.push(page.limit + 1);
    const pool = await this.router.pool();
    const { rows } = await pool.query<JobEventRow>(
      `SELECT id::text, tx_id::text, project_id, job_id, type, data, created_at
       FROM job_events WHERE ${where} ORDER BY id DESC LIMIT $${params.length}`,
      params,
    );
    const hasMore = rows.length > page.limit;
    const items = rows.slice(0, page.limit).map(toEventDto);
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? encodeCursor(last.id) : null };
  }

  private async assertJobExists(
    pool: { query: ReadRouter['primary']['query'] },
    projectId: string,
    jobId: string,
  ): Promise<void> {
    const { rowCount } = await pool.query('SELECT 1 FROM jobs WHERE id = $1 AND project_id = $2', [
      jobId,
      projectId,
    ]);
    if (rowCount === 0) throw new NotFoundError('Job');
  }
}
