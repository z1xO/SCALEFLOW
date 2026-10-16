import type pg from 'pg';
import { decideRetry } from '../../domain/retry-policy.js';
import type { ClassifiedError } from '../../handlers/types.js';
import { withTransaction, type Queryable } from '../../infra/db/pool.js';
import { uuidv7 } from '../../lib/uuid.js';
import type { JobCache } from './job-cache.js';
import type { AttemptStatus, JobRow, NewJobEvent } from './model.js';
import { appendEvents, enqueueDispatches } from './write-helpers.js';

export interface ClaimedJob {
  job: JobRow;
  attemptId: string;
  queueWaitMs: number | null;
}

export type FinishOutcome =
  | { applied: true; outcome: 'succeeded' | 'retry' | 'failed'; job: JobRow; delayMs?: number }
  | { applied: false };

/**
 * State transitions driven by workers and the scheduler. Each is a single transaction whose
 * UPDATE is conditional on the expected current state; zero affected rows means another actor got
 * there first (duplicate delivery, cancel race, lease recovered) and the caller must back off.
 */
export class JobExecution {
  constructor(
    private readonly pool: pg.Pool,
    private readonly cache: JobCache,
    private readonly random: () => number = Math.random,
  ) {}

  /**
   * queued -> running for attempt `attempt`. Matches only if the job is queued *and* waiting for
   * exactly this attempt, so stale or duplicate deliveries of older dispatches cannot start it.
   */
  async claim(jobId: string, attempt: number, workerId: string, leaseMs: number): Promise<ClaimedJob | null> {
    const claimed = await withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<JobRow & { queue_wait_ms: number | null }>(
        `UPDATE jobs SET status = 'running', attempt_count = $2, run_attempts = run_attempts + 1,
                started_at = now(), locked_by = $3, lease_expires_at = now() + make_interval(secs => $4::double precision / 1000),
                updated_at = now(), version = version + 1
         WHERE id = $1 AND status = 'queued' AND attempt_count = $2 - 1
         RETURNING *, (extract(epoch FROM (now() - queued_at)) * 1000)::int AS queue_wait_ms`,
        [jobId, attempt, workerId, leaseMs],
      );
      const job = rows[0];
      if (!job) return null;
      const attemptId = uuidv7();
      await client.query(
        `INSERT INTO job_attempts (id, job_id, project_id, attempt_number, worker_id, status, started_at, queue_wait_ms)
         VALUES ($1, $2, $3, $4, $5, 'running', now(), $6)`,
        [attemptId, job.id, job.project_id, attempt, workerId, job.queue_wait_ms],
      );
      await appendEvents(client, [
        {
          projectId: job.project_id,
          jobId: job.id,
          type: 'job.started',
          data: {
            from: 'queued',
            to: 'running',
            type: job.type,
            queue: job.queue,
            attempt,
            workerId,
            queueWaitMs: job.queue_wait_ms ?? undefined,
          },
        },
      ]);
      return { job, attemptId, queueWaitMs: job.queue_wait_ms };
    });
    if (claimed) await this.cache.invalidate([claimed.job]);
    return claimed;
  }

  /** Extends the lease of a running attempt. False means the lease was lost (job recovered or cancelled). */
  async renewLease(jobId: string, attempt: number, workerId: string, leaseMs: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE jobs SET lease_expires_at = now() + make_interval(secs => $4::double precision / 1000)
       WHERE id = $1 AND status = 'running' AND attempt_count = $2 AND locked_by = $3`,
      [jobId, attempt, workerId, leaseMs],
    );
    return rowCount === 1;
  }

  async complete(
    jobId: string,
    attempt: number,
    workerId: string,
    result: unknown,
    durationMs: number,
  ): Promise<FinishOutcome> {
    const outcome = await withTransaction(this.pool, async (client): Promise<FinishOutcome> => {
      const { rows } = await client.query<JobRow>(
        `UPDATE jobs SET status = 'succeeded', result = $4, last_error = NULL, finished_at = now(),
                locked_by = NULL, lease_expires_at = NULL, updated_at = now(), version = version + 1
         WHERE id = $1 AND status = 'running' AND attempt_count = $2 AND locked_by = $3
         RETURNING *`,
        [jobId, attempt, workerId, JSON.stringify(result ?? null)],
      );
      const job = rows[0];
      if (!job) return { applied: false };
      await finishAttempt(client, jobId, attempt, 'succeeded', durationMs, null);
      await appendEvents(client, [
        {
          projectId: job.project_id,
          jobId,
          type: 'job.succeeded',
          data: { from: 'running', to: 'succeeded', type: job.type, queue: job.queue, attempt, durationMs },
        },
      ]);
      return { applied: true, outcome: 'succeeded', job };
    });
    if (outcome.applied) await this.cache.invalidate([outcome.job]);
    return outcome;
  }

  async fail(
    jobId: string,
    attempt: number,
    workerId: string,
    error: ClassifiedError,
    durationMs: number,
    attemptStatus: Extract<AttemptStatus, 'failed' | 'timed_out'>,
  ): Promise<FinishOutcome> {
    const outcome = await withTransaction(this.pool, async (client): Promise<FinishOutcome> => {
      const { rows } = await client.query<JobRow>(
        `SELECT * FROM jobs WHERE id = $1 AND status = 'running' AND attempt_count = $2 AND locked_by = $3 FOR UPDATE`,
        [jobId, attempt, workerId],
      );
      const job = rows[0];
      if (!job) return { applied: false };
      return applyFailure(client, job, error, attemptStatus, durationMs, this.random);
    });
    if (outcome.applied) await this.cache.invalidate([outcome.job]);
    return outcome;
  }

  /**
   * Lease reaper: running jobs whose worker stopped renewing (crash, partition, OOM kill) are
   * treated as a failed attempt with a retryable 'lease_expired' error. SKIP LOCKED lets several
   * schedulers run this concurrently without blocking each other.
   */
  async recoverExpiredLeases(limit: number): Promise<JobRow[]> {
    const recovered = await withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<JobRow>(
        `SELECT * FROM jobs WHERE status = 'running' AND lease_expires_at < now()
         ORDER BY lease_expires_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [limit],
      );
      const out: JobRow[] = [];
      for (const job of rows) {
        const res = await applyFailure(
          client,
          job,
          {
            code: 'lease_expired',
            message: `Worker ${job.locked_by ?? 'unknown'} stopped renewing its lease`,
            retryable: true,
          },
          'lost',
          null,
          this.random,
        );
        if (res.applied) out.push(res.job);
      }
      return out;
    });
    await this.cache.invalidate(recovered);
    return recovered;
  }

  /**
   * Promoter: scheduled / retry_wait jobs whose run_at has passed become queued, and their
   * dispatch is written to the outbox in the same transaction.
   */
  async promoteDue(limit: number): Promise<(JobRow & { previous_status: string })[]> {
    const promoted = await withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<JobRow & { previous_status: 'scheduled' | 'retry_wait' }>(
        `WITH due AS (
           SELECT id, status FROM jobs
           WHERE status IN ('scheduled', 'retry_wait') AND run_at <= now()
           ORDER BY run_at LIMIT $1 FOR UPDATE SKIP LOCKED
         )
         UPDATE jobs j SET status = 'queued', queued_at = now(), updated_at = now(), version = j.version + 1
         FROM due WHERE j.id = due.id
         RETURNING j.*, due.status AS previous_status`,
        [limit],
      );
      if (rows.length === 0) return rows;
      await appendEvents(
        client,
        rows.map((j): NewJobEvent => ({
          projectId: j.project_id,
          jobId: j.id,
          type: 'job.queued',
          data: {
            from: j.previous_status,
            to: 'queued',
            type: j.type,
            queue: j.queue,
            reason: j.previous_status === 'scheduled' ? 'due' : 'retry_due',
          },
        })),
      );
      await enqueueDispatches(client, rows);
      return rows;
    });
    await this.cache.invalidate(promoted);
    return promoted;
  }
}

async function finishAttempt(
  client: Queryable,
  jobId: string,
  attempt: number,
  status: AttemptStatus,
  durationMs: number | null,
  error: ClassifiedError | null,
): Promise<void> {
  await client.query(
    `UPDATE job_attempts SET status = $3, finished_at = now(),
            duration_ms = COALESCE($4, (extract(epoch FROM (now() - started_at)) * 1000)::int), error = $5
     WHERE job_id = $1 AND attempt_number = $2`,
    [jobId, attempt, status, durationMs, error ? JSON.stringify(error) : null],
  );
}

/** running -> retry_wait | failed, for a row already locked by the caller. */
async function applyFailure(
  client: Queryable,
  job: JobRow,
  error: ClassifiedError,
  attemptStatus: AttemptStatus,
  durationMs: number | null,
  random: () => number,
): Promise<FinishOutcome> {
  const decision = decideRetry({
    retryable: error.retryable,
    runAttempts: job.run_attempts,
    maxAttempts: job.max_attempts,
    backoff: job.backoff,
    random,
  });
  const attempt = job.attempt_count;
  await finishAttempt(client, job.id, attempt, attemptStatus, durationMs, error);
  const base = { type: job.type, queue: job.queue, attempt, error, durationMs: durationMs ?? undefined };

  if (decision.kind === 'retry') {
    const { rows } = await client.query<JobRow>(
      `UPDATE jobs SET status = 'retry_wait', last_error = $2,
              run_at = now() + make_interval(secs => $3::double precision / 1000),
              locked_by = NULL, lease_expires_at = NULL, updated_at = now(), version = version + 1
       WHERE id = $1 RETURNING *`,
      [job.id, JSON.stringify(error), decision.delayMs],
    );
    const updated = rows[0] as JobRow;
    await appendEvents(client, [
      {
        projectId: job.project_id,
        jobId: job.id,
        type: 'job.retry_scheduled',
        data: {
          ...base,
          from: 'running',
          to: 'retry_wait',
          delayMs: decision.delayMs,
          runAt: updated.run_at.toISOString(),
        },
      },
    ]);
    return { applied: true, outcome: 'retry', job: updated, delayMs: decision.delayMs };
  }

  const { rows } = await client.query<JobRow>(
    `UPDATE jobs SET status = 'failed', last_error = $2, finished_at = now(),
            locked_by = NULL, lease_expires_at = NULL, updated_at = now(), version = version + 1
     WHERE id = $1 RETURNING *`,
    [job.id, JSON.stringify(error)],
  );
  const updated = rows[0] as JobRow;
  await appendEvents(client, [
    {
      projectId: job.project_id,
      jobId: job.id,
      type: 'job.failed',
      data: { ...base, from: 'running', to: 'failed', reason: decision.reason },
    },
  ]);
  // 'failed' is the dead-letter state: nothing is dispatched; a manual retry re-enqueues.
  return { applied: true, outcome: 'failed', job: updated };
}
