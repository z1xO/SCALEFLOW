import { CronExpressionParser } from 'cron-parser';
import type pg from 'pg';
import { z } from 'zod';
import { BackoffSchema } from '../../domain/retry-policy.js';
import { withTransaction } from '../../infra/db/pool.js';
import { pgErrorCode, PgErrorCode } from '../../infra/db/pool.js';
import { ConflictError, NotFoundError, UnprocessableError } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import { uuidv7 } from '../../lib/uuid.js';
import type { JobCommands } from '../jobs/job-commands.js';
import { insertJobs } from '../jobs/job-commands.js';
import type { Actor, JobDto } from '../jobs/model.js';
import { writeAudit } from '../jobs/write-helpers.js';

const JobOptionsSchema = z.object({
  maxAttempts: z.number().int().min(1).max(25).default(3),
  backoff: BackoffSchema.optional(),
  timeoutMs: z.number().int().min(100).max(3_600_000).optional(),
});

export const CreateScheduleSchema = z.object({
  name: z.string().trim().min(1).max(100),
  cron: z.string().min(9).max(100).describe('5- or 6-field cron expression, e.g. "*/5 * * * *"'),
  timezone: z.string().max(64).default('UTC'),
  jobType: z.string().min(1).max(100),
  queue: z.string().min(1).max(50).default('default'),
  payload: z.record(z.string(), z.unknown()).default({}),
  jobOptions: JobOptionsSchema.default({ maxAttempts: 3 }),
  enabled: z.boolean().default(true),
});

export const UpdateScheduleSchema = z
  .object({
    cron: CreateScheduleSchema.shape.cron,
    timezone: z.string().max(64),
    payload: z.record(z.string(), z.unknown()),
    jobOptions: JobOptionsSchema,
    enabled: z.boolean(),
  })
  .partial();

export interface ScheduleRow {
  id: string;
  project_id: string;
  name: string;
  cron: string;
  timezone: string;
  job_type: string;
  queue: string;
  payload: Record<string, unknown>;
  job_options: z.infer<typeof JobOptionsSchema>;
  enabled: boolean;
  next_run_at: Date;
  last_run_at: Date | null;
  last_job_id: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface ScheduleDto {
  id: string;
  projectId: string;
  name: string;
  cron: string;
  timezone: string;
  jobType: string;
  queue: string;
  payload: Record<string, unknown>;
  jobOptions: z.infer<typeof JobOptionsSchema>;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastJobId: string | null;
  createdAt: string;
  updatedAt: string;
}

const toDto = (r: ScheduleRow): ScheduleDto => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  cron: r.cron,
  timezone: r.timezone,
  jobType: r.job_type,
  queue: r.queue,
  payload: r.payload,
  jobOptions: r.job_options,
  enabled: r.enabled,
  nextRunAt: r.next_run_at.toISOString(),
  lastRunAt: r.last_run_at?.toISOString() ?? null,
  lastJobId: r.last_job_id,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

/** Next occurrence strictly after `after`. Throws a 422 for invalid expressions or time zones. */
export function nextOccurrence(cron: string, timezone: string, after: Date): Date {
  try {
    return CronExpressionParser.parse(cron, { currentDate: after, tz: timezone }).next().toDate();
  } catch (err) {
    throw new UnprocessableError('invalid_cron', `Invalid cron expression or time zone: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Rejects schedules that would fire more often than once a minute (protects the queue). */
function assertMinimumInterval(cron: string, timezone: string): void {
  const first = nextOccurrence(cron, timezone, new Date());
  const second = nextOccurrence(cron, timezone, first);
  if (second.getTime() - first.getTime() < 60_000) {
    throw new UnprocessableError('schedule_too_frequent', 'Schedules may fire at most once per minute');
  }
}

export interface FiredSchedule {
  scheduleId: string;
  projectId: string;
  jobId: string | null;
  tick: Date;
  nextRunAt: Date;
  error?: string;
}

export class ScheduleService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly commands: JobCommands,
    private readonly logger: Logger,
  ) {}

  async list(projectId: string): Promise<ScheduleDto[]> {
    const { rows } = await this.pool.query<ScheduleRow>(
      'SELECT * FROM scheduled_jobs WHERE project_id = $1 ORDER BY created_at',
      [projectId],
    );
    return rows.map(toDto);
  }

  async get(projectId: string, id: string): Promise<ScheduleDto> {
    return toDto(await this.getRow(projectId, id));
  }

  async create(projectId: string, input: z.infer<typeof CreateScheduleSchema>, actor: Actor): Promise<ScheduleDto> {
    assertMinimumInterval(input.cron, input.timezone);
    // Validate the job template exactly like a real submission would be validated.
    this.commands.prepare({ type: input.jobType, queue: input.queue, payload: input.payload, ...input.jobOptions });
    const next = nextOccurrence(input.cron, input.timezone, new Date());
    try {
      return await withTransaction(this.pool, async (client) => {
        const { rows } = await client.query<ScheduleRow>(
          `INSERT INTO scheduled_jobs (id, project_id, name, cron, timezone, job_type, queue, payload, job_options, enabled, next_run_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
          [
            uuidv7(),
            projectId,
            input.name,
            input.cron,
            input.timezone,
            input.jobType,
            input.queue,
            JSON.stringify(input.payload),
            JSON.stringify(input.jobOptions),
            input.enabled,
            next,
          ],
        );
        const row = rows[0] as ScheduleRow;
        await writeAudit(client, {
          projectId,
          actor,
          action: 'schedule.created',
          targetType: 'schedule',
          targetId: row.id,
          metadata: { cron: input.cron, jobType: input.jobType },
        });
        return toDto(row);
      });
    } catch (err) {
      if (pgErrorCode(err) === PgErrorCode.UniqueViolation) {
        throw new ConflictError('schedule_name_taken', 'A schedule with this name already exists in the project');
      }
      throw err;
    }
  }

  async update(
    projectId: string,
    id: string,
    input: z.infer<typeof UpdateScheduleSchema>,
    actor: Actor,
  ): Promise<ScheduleDto> {
    return withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<ScheduleRow>(
        'SELECT * FROM scheduled_jobs WHERE id = $1 AND project_id = $2 FOR UPDATE',
        [id, projectId],
      );
      const current = rows[0];
      if (!current) throw new NotFoundError('Schedule');
      const cron = input.cron ?? current.cron;
      const timezone = input.timezone ?? current.timezone;
      const payload = input.payload ?? current.payload;
      const jobOptions = input.jobOptions ?? current.job_options;
      assertMinimumInterval(cron, timezone);
      this.commands.prepare({ type: current.job_type, queue: current.queue, payload, ...jobOptions });
      const enabled = input.enabled ?? current.enabled;
      const timingChanged = cron !== current.cron || timezone !== current.timezone || (enabled && !current.enabled);
      const nextRunAt = timingChanged ? nextOccurrence(cron, timezone, new Date()) : current.next_run_at;
      const { rows: updated } = await client.query<ScheduleRow>(
        `UPDATE scheduled_jobs SET cron = $3, timezone = $4, payload = $5, job_options = $6, enabled = $7,
                next_run_at = $8, version = version + 1, updated_at = now()
         WHERE id = $1 AND project_id = $2 RETURNING *`,
        [id, projectId, cron, timezone, JSON.stringify(payload), JSON.stringify(jobOptions), enabled, nextRunAt],
      );
      await writeAudit(client, {
        projectId,
        actor,
        action: 'schedule.updated',
        targetType: 'schedule',
        targetId: id,
        metadata: { fields: Object.keys(input) },
      });
      return toDto(updated[0] as ScheduleRow);
    });
  }

  async remove(projectId: string, id: string, actor: Actor): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const { rowCount } = await client.query('DELETE FROM scheduled_jobs WHERE id = $1 AND project_id = $2', [id, projectId]);
      if (rowCount === 0) throw new NotFoundError('Schedule');
      await writeAudit(client, { projectId, actor, action: 'schedule.deleted', targetType: 'schedule', targetId: id });
    });
  }

  /** "Run now": creates one job from the template immediately, without moving the schedule. */
  async trigger(projectId: string, id: string, correlationId: string | null): Promise<JobDto> {
    const s = await this.getRow(projectId, id);
    const prepared = this.commands.prepare({ type: s.job_type, queue: s.queue, payload: s.payload, ...s.job_options });
    const [result] = await withTransaction(this.pool, (client) =>
      insertJobs(client, projectId, [prepared], { correlationId, scheduledJobId: s.id }),
    );
    if (!result) throw new Error('trigger produced no job');
    return result.job;
  }

  /**
   * Fires due schedules. Safe with several schedulers running: rows are claimed with SKIP LOCKED,
   * and each tick creates its job with the idempotency key `schedule:<id>:<tick>`, so a tick can
   * never produce two jobs even across crashes and restarts.
   *
   * Misfire policy: if the scheduler was down and several ticks were missed, one job is created
   * for the oldest missed tick and the schedule resumes at the next occurrence after now
   * (no thundering herd of catch-up jobs).
   */
  async fireDue(limit = 50, now = new Date()): Promise<FiredSchedule[]> {
    return withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<ScheduleRow>(
        `SELECT * FROM scheduled_jobs WHERE enabled AND next_run_at <= $2
         ORDER BY next_run_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [limit, now],
      );
      const fired: FiredSchedule[] = [];
      for (const s of rows) {
        const tick = s.next_run_at;
        let nextRunAt: Date;
        try {
          nextRunAt = nextOccurrence(s.cron, s.timezone, now > tick ? now : tick);
        } catch (err) {
          // An expression that became invalid (e.g. unknown time zone after an OS update): disable it.
          this.logger.error({ err, scheduleId: s.id }, 'schedule has an invalid cron expression; disabling');
          await client.query('UPDATE scheduled_jobs SET enabled = false, updated_at = now() WHERE id = $1', [s.id]);
          continue;
        }
        let jobId: string | null = null;
        let error: string | undefined;
        let prepared: ReturnType<JobCommands['prepare']> | null = null;
        try {
          // Pure validation (no I/O), so a failure here cannot abort the surrounding transaction.
          prepared = this.commands.prepare(
            {
              type: s.job_type,
              queue: s.queue,
              payload: s.payload,
              ...s.job_options,
              idempotencyKey: `schedule:${s.id}:${tick.toISOString()}`,
            },
            now,
          );
        } catch (err) {
          // The template no longer validates (job type removed, queue renamed). Skip this tick, keep the schedule.
          error = err instanceof Error ? err.message : String(err);
          this.logger.warn({ err, scheduleId: s.id }, 'schedule tick skipped: job template is invalid');
        }
        if (prepared) {
          const [result] = await insertJobs(client, s.project_id, [prepared], {
            correlationId: `schedule:${s.id}`,
            scheduledJobId: s.id,
          });
          jobId = result?.job.id ?? null;
        }
        await client.query(
          `UPDATE scheduled_jobs SET next_run_at = $2, last_run_at = $3, last_job_id = COALESCE($4, last_job_id),
                  updated_at = now() WHERE id = $1`,
          [s.id, nextRunAt, now, jobId],
        );
        fired.push({ scheduleId: s.id, projectId: s.project_id, jobId, tick, nextRunAt, ...(error ? { error } : {}) });
      }
      return fired;
    });
  }

  private async getRow(projectId: string, id: string): Promise<ScheduleRow> {
    const { rows } = await this.pool.query<ScheduleRow>('SELECT * FROM scheduled_jobs WHERE id = $1 AND project_id = $2', [
      id,
      projectId,
    ]);
    const row = rows[0];
    if (!row) throw new NotFoundError('Schedule');
    return row;
  }
}
