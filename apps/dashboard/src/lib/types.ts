/** Mirrors the API response schemas (see /openapi.json). */

export const JOB_STATUSES = [
  'scheduled',
  'queued',
  'running',
  'retry_wait',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export type Role = 'owner' | 'developer' | 'viewer';

export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface Membership {
  projectId: string;
  projectName: string;
  role: Role;
}

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  role: Role | null;
}

export interface JobError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface Backoff {
  type: 'exponential' | 'fixed';
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface Job {
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

export interface Attempt {
  id: string;
  jobId: string;
  attemptNumber: number;
  workerId: string;
  status: 'running' | 'succeeded' | 'failed' | 'timed_out' | 'lost';
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  queueWaitMs: number | null;
  error: JobError | null;
}

export type JobEventType =
  | 'job.created'
  | 'job.queued'
  | 'job.started'
  | 'job.succeeded'
  | 'job.retry_scheduled'
  | 'job.failed'
  | 'job.cancelled';

export interface JobEvent {
  cursor: string;
  id: string;
  projectId: string;
  jobId: string;
  type: JobEventType;
  data: {
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
  };
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface JobType {
  type: string;
  description: string;
  defaultTimeoutMs: number;
}

export interface ApiKey {
  id: string;
  projectId: string;
  name: string;
  prefix: string;
  scopes: ('jobs:read' | 'jobs:write')[];
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  rotatedFrom: string | null;
}

export interface Member {
  userId: string;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
}

export interface Schedule {
  id: string;
  projectId: string;
  name: string;
  cron: string;
  timezone: string;
  jobType: string;
  queue: string;
  payload: Record<string, unknown>;
  jobOptions: { maxAttempts: number; backoff?: Backoff; timeoutMs?: number };
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastJobId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LatencySummary {
  count: number;
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

export type MetricWindow = '15m' | '1h' | '6h' | '24h';

export interface ProjectMetrics {
  window: MetricWindow;
  generatedAt: string;
  readModelAsOf: string | null;
  counts: Record<JobStatus, number>;
  totals: {
    submitted: number;
    started: number;
    succeeded: number;
    failed: number;
    retried: number;
    cancelled: number;
    successRate: number | null;
  };
  latency: { execution: LatencySummary; queueWait: LatencySummary };
  series: { t: string; submitted: number; succeeded: number; failed: number; retried: number }[];
}

export interface SystemSnapshot {
  takenAt: string;
  queues: Record<string, Record<string, number>>;
  jobs: { scheduled: number; queued: number; running: number; retry_wait: number };
  oldestQueuedAgeSeconds: number;
  outbox: { pending: number; oldestAgeSeconds: number };
  workers: { online: number; draining: number; activeJobs: number; capacity: number };
}

export interface Worker {
  id: string;
  hostname: string;
  pid: number;
  queues: string[];
  concurrency: number;
  status: 'online' | 'draining' | 'offline';
  activeJobs: number;
  processedTotal: number;
  failedTotal: number;
  version: string;
  startedAt: string;
  lastHeartbeatAt: string;
  stoppedAt: string | null;
}
