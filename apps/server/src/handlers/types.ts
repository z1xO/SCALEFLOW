import type { z } from 'zod';
import type { Logger } from '../lib/logger.js';

export interface JobContext {
  jobId: string;
  projectId: string;
  /** Global attempt number (1-based, unique per job). */
  attempt: number;
  /** Aborted when the job times out, the worker loses its lease, or the worker is force-stopped. */
  signal: AbortSignal;
  logger: Logger;
}

/**
 * A job type. Handlers must be safe to run more than once for the same job (delivery is
 * at-least-once); use `ctx.jobId` as an idempotency key towards downstream systems.
 */
export interface JobHandler<P = unknown> {
  type: string;
  description: string;
  payloadSchema: z.ZodType<P>;
  defaultTimeoutMs: number;
  execute(payload: P, ctx: JobContext): Promise<unknown>;
}

/** Throw to fail the job immediately without retrying (bad input, 4xx from a target, ...). */
export class PermanentJobError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

/** Throw to signal a transient failure with a specific code. Any other error is also retried. */
export class RetryableJobError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RetryableJobError';
  }
}

export interface ClassifiedError {
  code: string;
  message: string;
  retryable: boolean;
}

const MAX_ERROR_MESSAGE = 1_000;

/** Turns anything thrown by a handler into a storable error. Stack traces are never persisted. */
export function classifyError(err: unknown, timedOut: boolean): ClassifiedError {
  if (timedOut) return { code: 'timeout', message: 'Job exceeded its timeout', retryable: true };
  if (err instanceof PermanentJobError) {
    return { code: err.code, message: truncate(err.message), retryable: false };
  }
  if (err instanceof RetryableJobError) {
    return { code: err.code, message: truncate(err.message), retryable: true };
  }
  if (err instanceof Error) return { code: 'handler_error', message: truncate(err.message), retryable: true };
  return { code: 'handler_error', message: truncate(String(err)), retryable: true };
}

function truncate(s: string): string {
  return s.length > MAX_ERROR_MESSAGE ? `${s.slice(0, MAX_ERROR_MESSAGE)}…` : s;
}
