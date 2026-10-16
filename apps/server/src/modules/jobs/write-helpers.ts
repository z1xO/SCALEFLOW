import type { Queryable } from '../../infra/db/pool.js';
import type { Actor, JobRow, NewJobEvent } from './model.js';

/** Appends events to the job event log. Must be called inside the transaction that changed state. */
export async function appendEvents(db: Queryable, events: NewJobEvent[]): Promise<void> {
  if (events.length === 0) return;
  await db.query(
    `INSERT INTO job_events (project_id, job_id, type, data)
     SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::jsonb[])`,
    [
      events.map((e) => e.projectId),
      events.map((e) => e.jobId),
      events.map((e) => e.type),
      events.map((e) => JSON.stringify(e.data)),
    ],
  );
}

export interface DispatchPayload {
  jobId: string;
  projectId: string;
  queue: string;
  type: string;
  /** The attempt number this dispatch is for (attempt_count + 1 at dispatch time). */
  attempt: number;
  correlationId: string | null;
}

/**
 * Writes outbox rows that ask the relay to publish the jobs to the queue. Call in the same
 * transaction that moved the jobs to `queued` - that is the whole point of the outbox.
 */
export async function enqueueDispatches(db: Queryable, jobs: JobRow[]): Promise<void> {
  if (jobs.length === 0) return;
  const payloads: DispatchPayload[] = jobs.map((j) => ({
    jobId: j.id,
    projectId: j.project_id,
    queue: j.queue,
    type: j.type,
    attempt: j.attempt_count + 1,
    correlationId: j.correlation_id,
  }));
  await db.query(
    `INSERT INTO outbox (topic, aggregate_id, payload)
     SELECT 'job.dispatch', * FROM unnest($1::uuid[], $2::jsonb[])`,
    [jobs.map((j) => j.id), payloads.map((p) => JSON.stringify(p))],
  );
}

export async function writeAudit(
  db: Queryable,
  entry: {
    projectId: string | null;
    actor: Actor;
    action: string;
    targetType: string;
    targetId: string;
    metadata?: Record<string, unknown>;
    ip?: string | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (project_id, actor_type, actor_id, action, target_type, target_id, metadata, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.projectId,
      entry.actor.type,
      entry.actor.id,
      entry.action,
      entry.targetType,
      entry.targetId,
      JSON.stringify(entry.metadata ?? {}),
      entry.ip ?? null,
    ],
  );
}
