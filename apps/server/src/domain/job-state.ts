import { ConflictError } from '../lib/errors.js';

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

export const TERMINAL_STATUSES: readonly JobStatus[] = ['succeeded', 'failed', 'cancelled'];
export const ACTIVE_STATUSES: readonly JobStatus[] = ['scheduled', 'queued', 'running', 'retry_wait'];

/**
 * The complete set of legal transitions. Anything not listed is illegal.
 * Keep docs/architecture.md §3 in sync with this table.
 */
export const TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  scheduled: ['queued', 'cancelled'],
  queued: ['running', 'cancelled'],
  running: ['succeeded', 'retry_wait', 'failed'],
  retry_wait: ['queued', 'cancelled'],
  failed: ['queued'], // manual retry / replay
  succeeded: [],
  cancelled: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Statuses from which `to` may be reached; used to build conditional UPDATE statements. */
export function sourcesOf(to: JobStatus): JobStatus[] {
  return JOB_STATUSES.filter((from) => TRANSITIONS[from].includes(to));
}

export class InvalidTransitionError extends ConflictError {
  constructor(
    public readonly from: JobStatus,
    public readonly to: JobStatus,
  ) {
    super('invalid_transition', `Job cannot move from '${from}' to '${to}'`, { from, to });
  }
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
