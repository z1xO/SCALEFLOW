import { Queue, type JobsOptions, type KeepJobs } from 'bullmq';
import { bullConnection } from './redis.js';
import type { DispatchPayload } from '../modules/jobs/write-helpers.js';

/** BullMQ job id for a dispatch. Deterministic so re-publishing the same dispatch is a no-op. */
export function dispatchJobId(jobId: string, attempt: number): string {
  return `${jobId}-a${attempt}`;
}

export function bullQueueName(queue: string): string {
  return `jobs-${queue}`;
}

/**
 * BullMQ is the *delivery* mechanism only. It does not own retries, delays or job state - those
 * live in PostgreSQL - so every BullMQ job is a single-attempt, ready-to-run dispatch.
 */
export const KEEP_COMPLETED: KeepJobs = { age: 3600, count: 10_000 };
export const KEEP_FAILED: KeepJobs = { age: 24 * 3600, count: 10_000 };

export const DISPATCH_JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnComplete: KEEP_COMPLETED,
  removeOnFail: KEEP_FAILED,
};

export class QueueSet {
  private readonly queues = new Map<string, Queue<DispatchPayload>>();

  constructor(
    private readonly redisUrl: string,
    readonly prefix: string,
    readonly names: readonly string[],
  ) {}

  get(name: string): Queue<DispatchPayload> {
    let q = this.queues.get(name);
    if (!q) {
      if (!this.names.includes(name)) throw new Error(`Unknown queue ${name}`);
      q = new Queue<DispatchPayload>(bullQueueName(name), {
        connection: bullConnection(this.redisUrl, `scaleflow-queue-${name}`),
        prefix: this.prefix,
        defaultJobOptions: DISPATCH_JOB_OPTIONS,
      });
      this.queues.set(name, q);
    }
    return q;
  }

  all(): Queue<DispatchPayload>[] {
    return this.names.map((n) => this.get(n));
  }

  async counts(): Promise<Record<string, Record<string, number>>> {
    const counts = await Promise.all(
      this.names.map((n) => this.get(n).getJobCounts('waiting', 'active', 'delayed', 'prioritized', 'completed', 'failed')),
    );
    // Built in configured order so consumers render queues in a stable order.
    return Object.fromEntries(this.names.map((n, i) => [n, counts[i] ?? {}]));
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.queues.clear();
  }
}
