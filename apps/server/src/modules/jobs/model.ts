import type { JobStatus } from '../../domain/job-state.js';
import type { Backoff } from '../../domain/retry-policy.js';

export interface JobError {
  code: string;
  message: string;
  retryable: boolean;
}

/** Row shape of the `jobs` table as returned by node-postgres. */
export interface JobRow {
  id: string;
  project_id: string;
  type: string;
  queue: string;
  status: JobStatus;
  payload: unknown;
  result: unknown;
  last_error: JobError | null;
  idempotency_key: string | null;
  request_fingerprint: string | null;
  correlation_id: string | null;
  max_attempts: number;
  attempt_count: number;
  run_attempts: number;
  backoff: Backoff;
  timeout_ms: number;
  run_at: Date;
  scheduled_job_id: string | null;
  locked_by: string | null;
  lease_expires_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  queued_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface JobDto {
  id: string;
  projectId: string;
  type: string;
  queue: string;
  status: JobStatus;
  payload: unknown;
  result: unknown;
  lastError: JobError | null;
  idempotencyKey: string | null;
  correlationId: string | null;
  maxAttempts: number;
  attemptCount: number;
  runAttempts: number;
  backoff: Backoff;
  timeoutMs: number;
  runAt: string;
  scheduledJobId: string | null;
  lockedBy: string | null;
  leaseExpiresAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toJobDto(r: JobRow): JobDto {
  return {
    id: r.id,
    projectId: r.project_id,
    type: r.type,
    queue: r.queue,
    status: r.status,
    payload: r.payload,
    result: r.result ?? null,
    lastError: r.last_error,
    idempotencyKey: r.idempotency_key,
    correlationId: r.correlation_id,
    maxAttempts: r.max_attempts,
    attemptCount: r.attempt_count,
    runAttempts: r.run_attempts,
    backoff: r.backoff,
    timeoutMs: r.timeout_ms,
    runAt: r.run_at.toISOString(),
    scheduledJobId: r.scheduled_job_id,
    lockedBy: r.locked_by,
    leaseExpiresAt: iso(r.lease_expires_at),
    version: r.version,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    queuedAt: iso(r.queued_at),
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
  };
}

export type AttemptStatus = 'running' | 'succeeded' | 'failed' | 'timed_out' | 'lost';

export interface AttemptRow {
  id: string;
  job_id: string;
  project_id: string;
  attempt_number: number;
  worker_id: string;
  status: AttemptStatus;
  started_at: Date;
  finished_at: Date | null;
  duration_ms: number | null;
  queue_wait_ms: number | null;
  error: JobError | null;
}

export interface AttemptDto {
  id: string;
  jobId: string;
  attemptNumber: number;
  workerId: string;
  status: AttemptStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  queueWaitMs: number | null;
  error: JobError | null;
}

export function toAttemptDto(r: AttemptRow): AttemptDto {
  return {
    id: r.id,
    jobId: r.job_id,
    attemptNumber: r.attempt_number,
    workerId: r.worker_id,
    status: r.status,
    startedAt: r.started_at.toISOString(),
    finishedAt: iso(r.finished_at),
    durationMs: r.duration_ms,
    queueWaitMs: r.queue_wait_ms,
    error: r.error,
  };
}

export const JOB_EVENT_TYPES = [
  'job.created',
  'job.queued',
  'job.started',
  'job.succeeded',
  'job.retry_scheduled',
  'job.failed',
  'job.cancelled',
] as const;
export type JobEventType = (typeof JOB_EVENT_TYPES)[number];

export interface JobEventData {
  from: JobStatus | null;
  to: JobStatus;
  type: string;
  queue: string;
  attempt?: number;
  workerId?: string;
  durationMs?: number;
  queueWaitMs?: number;
  delayMs?: number;
  runAt?: string;
  error?: JobError;
  reason?: string;
}

export interface NewJobEvent {
  projectId: string;
  jobId: string;
  type: JobEventType;
  data: JobEventData;
}

export interface JobEventRow {
  id: string; // bigint as string
  tx_id: string; // xid8 as string
  project_id: string;
  job_id: string;
  type: JobEventType;
  data: JobEventData;
  created_at: Date;
}

export interface JobEventDto {
  /** Commit-ordered cursor "<tx_id>.<id>"; also the SSE event id. */
  cursor: string;
  id: string;
  projectId: string;
  jobId: string;
  type: JobEventType;
  data: JobEventData;
  createdAt: string;
}

export function toEventDto(r: JobEventRow): JobEventDto {
  return {
    cursor: `${r.tx_id}.${r.id}`,
    id: r.id,
    projectId: r.project_id,
    jobId: r.job_id,
    type: r.type,
    data: r.data,
    createdAt: r.created_at.toISOString(),
  };
}

export interface Actor {
  type: 'user' | 'api_key' | 'system';
  id: string;
}
