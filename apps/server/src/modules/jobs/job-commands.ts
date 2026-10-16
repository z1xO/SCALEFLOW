import type pg from 'pg';
import { z } from 'zod';
import { sourcesOf, type JobStatus } from '../../domain/job-state.js';
import { BackoffSchema, DEFAULT_BACKOFF } from '../../domain/retry-policy.js';
import type { HandlerRegistry } from '../../handlers/registry.js';
import { withTransaction, type Queryable } from '../../infra/db/pool.js';
import type { ReadRouter } from '../../infra/db/read-router.js';
import { canonicalJson, sha256Hex } from '../../lib/crypto.js';
import { ConflictError, NotFoundError, UnprocessableError, ValidationError } from '../../lib/errors.js';
import type { Metrics } from '../../lib/metrics.js';
import { uuidv7 } from '../../lib/uuid.js';
import type { Backpressure } from './backpressure.js';
import type { JobCache } from './job-cache.js';
import { toJobDto, type Actor, type JobDto, type JobRow, type NewJobEvent } from './model.js';
import { appendEvents, enqueueDispatches, writeAudit } from './write-helpers.js';

const MAX_DELAY_MS = 30 * 24 * 3600 * 1000;

export const CreateJobInputSchema = z
  .object({
    type: z.string().min(1).max(100).describe('Registered job type, e.g. "webhook.deliver" or "demo.sleep"'),
    queue: z.string().min(1).max(50).default('default'),
    payload: z.record(z.string(), z.unknown()).default({}).describe('Handler-specific JSON object'),
    runAt: z.iso.datetime({ offset: true }).optional().describe('Earliest execution time (ISO 8601)'),
    delayMs: z.number().int().min(0).max(MAX_DELAY_MS).optional().describe('Alternative to runAt'),
    maxAttempts: z.number().int().min(1).max(25).default(3),
    backoff: BackoffSchema.optional(),
    timeoutMs: z.number().int().min(100).max(3_600_000).optional(),
    idempotencyKey: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[\x21-\x7e]+$/, 'printable ASCII without spaces')
      .optional(),
  })
  .refine((v) => !(v.runAt && v.delayMs !== undefined), {
    message: 'Specify either runAt or delayMs, not both',
  });

export type CreateJobInput = z.input<typeof CreateJobInputSchema>;
type ParsedCreateJobInput = z.output<typeof CreateJobInputSchema>;

export interface CommandContext {
  actor: Actor;
  correlationId: string | null;
  ip?: string | null;
}

export interface CreateJobResult {
  job: JobDto;
  created: boolean;
}

interface PreparedJob {
  id: string;
  type: string;
  queue: string;
  status: JobStatus;
  payload: unknown;
  idempotencyKey: string | null;
  fingerprint: string;
  maxAttempts: number;
  backoff: z.infer<typeof BackoffSchema>;
  timeoutMs: number;
  runAt: Date;
}

export interface JobCommandsDeps {
  pool: pg.Pool;
  readRouter: ReadRouter;
  handlers: HandlerRegistry;
  cache: JobCache;
  backpressure: Backpressure;
  metrics: Pick<Metrics, 'jobsSubmitted' | 'idempotentReplays'>;
  queues: readonly string[];
  maxPayloadBytes: number;
}

/**
 * Write side for client-initiated job commands. Every method runs one transaction that changes
 * state, appends events and (if the job became runnable) writes outbox rows.
 */
export class JobCommands {
  constructor(private readonly deps: JobCommandsDeps) {}

  /** Validates and normalises a submission (no I/O). Exposed for the scheduler. */
  prepare(raw: ParsedCreateJobInput, now = new Date()): PreparedJob {
    if (!this.deps.queues.includes(raw.queue)) {
      throw new UnprocessableError('unknown_queue', `Unknown queue '${raw.queue}'`, {
        queues: this.deps.queues,
      });
    }
    const size = Buffer.byteLength(JSON.stringify(raw.payload));
    if (size > this.deps.maxPayloadBytes) {
      throw new UnprocessableError(
        'payload_too_large',
        `Payload is ${size} bytes; the limit is ${this.deps.maxPayloadBytes}`,
      );
    }
    const { handler, payload } = this.deps.handlers.parsePayload(raw.type, raw.payload);
    const runAt = raw.runAt
      ? new Date(raw.runAt)
      : raw.delayMs !== undefined
        ? new Date(now.getTime() + raw.delayMs)
        : now;
    if (runAt.getTime() - now.getTime() > MAX_DELAY_MS) {
      throw new ValidationError('runAt is too far in the future (max 30 days)');
    }
    const { idempotencyKey, ...fingerprinted } = raw;
    return {
      id: uuidv7(now.getTime()),
      type: raw.type,
      queue: raw.queue,
      // A small grace window avoids a scheduler round trip for "now-ish" times.
      status: runAt.getTime() > now.getTime() + 50 ? 'scheduled' : 'queued',
      payload,
      idempotencyKey: idempotencyKey ?? null,
      fingerprint: sha256Hex(canonicalJson(fingerprinted)),
      maxAttempts: raw.maxAttempts,
      backoff: raw.backoff ?? DEFAULT_BACKOFF,
      timeoutMs: raw.timeoutMs ?? handler.defaultTimeoutMs,
      runAt,
    };
  }

  async create(
    projectId: string,
    inputs: ParsedCreateJobInput[],
    ctx: CommandContext,
  ): Promise<{ results: CreateJobResult[]; commitLsn: string | null }> {
    const keys = inputs.map((i) => i.idempotencyKey).filter((k): k is string => k !== undefined);
    if (new Set(keys).size !== keys.length) {
      throw new ValidationError('Duplicate idempotencyKey values within one batch');
    }
    const prepared = inputs.map((i) => this.prepare(i));
    await this.deps.backpressure.check(projectId, prepared.length);

    const results = await withTransaction(this.deps.pool, (client) =>
      insertJobs(client, projectId, prepared, { correlationId: ctx.correlationId, scheduledJobId: null }),
    );

    for (const r of results) {
      if (r.created) this.deps.metrics.jobsSubmitted.inc({ queue: r.job.queue, type: r.job.type });
      else this.deps.metrics.idempotentReplays.inc();
    }
    const commitLsn = await this.deps.readRouter.commitLsn();
    return { results, commitLsn };
  }

  async cancel(
    projectId: string,
    jobId: string,
    ctx: CommandContext,
  ): Promise<{ job: JobDto; commitLsn: string | null }> {
    const row = await withTransaction(this.deps.pool, async (client) => {
      const { rows } = await client.query<JobRow & { previous_status: JobStatus }>(
        `WITH prev AS (SELECT id, status FROM jobs WHERE id = $1 AND project_id = $2 FOR UPDATE)
         UPDATE jobs j SET status = 'cancelled', finished_at = now(), updated_at = now(), version = j.version + 1
         FROM prev
         WHERE j.id = prev.id AND prev.status = ANY($3)
         RETURNING j.*, prev.status AS previous_status`,
        [jobId, projectId, sourcesOf('cancelled')],
      );
      const updated = rows[0];
      if (!updated) {
        const current = await currentStatus(client, projectId, jobId);
        throw new ConflictError('job_not_cancellable', `A job in status '${current}' cannot be cancelled`, {
          status: current,
        });
      }
      await appendEvents(client, [
        {
          projectId,
          jobId,
          type: 'job.cancelled',
          data: { from: updated.previous_status, to: 'cancelled', type: updated.type, queue: updated.queue },
        },
      ]);
      await writeAudit(client, {
        projectId,
        actor: ctx.actor,
        action: 'job.cancelled',
        targetType: 'job',
        targetId: jobId,
        metadata: { previousStatus: updated.previous_status },
        ip: ctx.ip,
      });
      return updated;
    });
    await this.deps.cache.invalidate([row]);
    return { job: toJobDto(row), commitLsn: await this.deps.readRouter.commitLsn() };
  }

  /**
   * Manual retry (replay) of a dead-lettered job. Eligible: status 'failed'. Gives the job a fresh
   * per-run attempt budget; the global attempt counter keeps increasing.
   */
  async retry(
    projectId: string,
    jobId: string,
    ctx: CommandContext,
  ): Promise<{ job: JobDto; commitLsn: string | null }> {
    const row = await withTransaction(this.deps.pool, async (client) => {
      const { rows } = await client.query<JobRow>(
        `UPDATE jobs SET status = 'queued', run_attempts = 0, run_at = now(), queued_at = now(),
                finished_at = NULL, result = NULL, updated_at = now(), version = version + 1
         WHERE id = $1 AND project_id = $2 AND status = 'failed'
         RETURNING *`,
        [jobId, projectId],
      );
      const updated = rows[0];
      if (!updated) {
        const current = await currentStatus(client, projectId, jobId);
        throw new ConflictError(
          'job_not_retryable',
          `Only failed jobs can be retried (status is '${current}')`,
          {
            status: current,
          },
        );
      }
      const event: NewJobEvent = {
        projectId,
        jobId,
        type: 'job.queued',
        data: {
          from: 'failed',
          to: 'queued',
          type: updated.type,
          queue: updated.queue,
          reason: 'manual_retry',
        },
      };
      await appendEvents(client, [event]);
      await enqueueDispatches(client, [updated]);
      await writeAudit(client, {
        projectId,
        actor: ctx.actor,
        action: 'job.retried',
        targetType: 'job',
        targetId: jobId,
        ip: ctx.ip,
      });
      return updated;
    });
    await this.deps.cache.invalidate([row]);
    return { job: toJobDto(row), commitLsn: await this.deps.readRouter.commitLsn() };
  }
}

async function currentStatus(client: Queryable, projectId: string, jobId: string): Promise<JobStatus> {
  const { rows } = await client.query<{ status: JobStatus }>(
    'SELECT status FROM jobs WHERE id = $1 AND project_id = $2',
    [jobId, projectId],
  );
  const status = rows[0]?.status;
  if (!status) throw new NotFoundError('Job');
  return status;
}

/**
 * Inserts prepared jobs inside an existing transaction. Idempotency: `ON CONFLICT DO NOTHING` on
 * the (project_id, idempotency_key) unique index. A concurrent transaction inserting the same key
 * makes this statement wait for it to commit, then skip - so racing duplicates converge on one row.
 */
export async function insertJobs(
  client: Queryable,
  projectId: string,
  prepared: PreparedJob[],
  opts: { correlationId: string | null; scheduledJobId: string | null },
): Promise<CreateJobResult[]> {
  const { rows: inserted } = await client.query<JobRow>(
    `INSERT INTO jobs (id, project_id, type, queue, status, payload, idempotency_key, request_fingerprint,
                       correlation_id, max_attempts, backoff, timeout_ms, run_at, scheduled_job_id, queued_at)
     SELECT u.id, $1, u.type, u.queue, u.status, u.payload, u.idempotency_key, u.fingerprint,
            $2, u.max_attempts, u.backoff, u.timeout_ms, u.run_at, $3,
            CASE WHEN u.status = 'queued' THEN now() END
     FROM unnest($4::uuid[], $5::text[], $6::text[], $7::text[], $8::jsonb[], $9::text[], $10::text[],
                 $11::int[], $12::jsonb[], $13::int[], $14::timestamptz[])
          AS u(id, type, queue, status, payload, idempotency_key, fingerprint, max_attempts, backoff, timeout_ms, run_at)
     ON CONFLICT (project_id, idempotency_key) DO NOTHING
     RETURNING *`,
    [
      projectId,
      opts.correlationId,
      opts.scheduledJobId,
      prepared.map((p) => p.id),
      prepared.map((p) => p.type),
      prepared.map((p) => p.queue),
      prepared.map((p) => p.status),
      prepared.map((p) => JSON.stringify(p.payload)),
      prepared.map((p) => p.idempotencyKey),
      prepared.map((p) => p.fingerprint),
      prepared.map((p) => p.maxAttempts),
      prepared.map((p) => JSON.stringify(p.backoff)),
      prepared.map((p) => p.timeoutMs),
      prepared.map((p) => p.runAt),
    ],
  );

  const byId = new Map(inserted.map((r) => [r.id, r]));
  const conflicted = prepared.filter((p) => !byId.has(p.id));
  const existingByKey = new Map<string, JobRow>();
  if (conflicted.length > 0) {
    const { rows } = await client.query<JobRow>(
      'SELECT * FROM jobs WHERE project_id = $1 AND idempotency_key = ANY($2)',
      [projectId, conflicted.map((p) => p.idempotencyKey)],
    );
    for (const r of rows) if (r.idempotency_key) existingByKey.set(r.idempotency_key, r);
  }

  const results: CreateJobResult[] = prepared.map((p, index) => {
    const row = byId.get(p.id);
    if (row) return { job: toJobDto(row), created: true };
    const existing = p.idempotencyKey ? existingByKey.get(p.idempotencyKey) : undefined;
    if (!existing) {
      // Cannot happen unless the row was deleted between the two statements.
      throw new ConflictError('idempotency_conflict', 'Concurrent modification of an idempotent job; retry');
    }
    if (existing.request_fingerprint !== p.fingerprint) {
      throw new UnprocessableError(
        'idempotency_key_reused',
        'This Idempotency-Key was already used with a different request body',
        { index, idempotencyKey: p.idempotencyKey, existingJobId: existing.id },
      );
    }
    return { job: toJobDto(existing), created: false };
  });

  await appendEvents(
    client,
    inserted.map((r) => ({
      projectId,
      jobId: r.id,
      type: 'job.created' as const,
      data: { from: null, to: r.status, type: r.type, queue: r.queue, runAt: r.run_at.toISOString() },
    })),
  );
  await enqueueDispatches(
    client,
    inserted.filter((r) => r.status === 'queued'),
  );
  return results;
}
