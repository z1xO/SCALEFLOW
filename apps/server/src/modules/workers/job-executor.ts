import type { HandlerRegistry } from '../../handlers/registry.js';
import { classifyError, PermanentJobError } from '../../handlers/types.js';
import type { Logger } from '../../lib/logger.js';
import type { Metrics } from '../../lib/metrics.js';
import type { JobExecution } from '../jobs/job-execution.js';
import type { DispatchPayload } from '../jobs/write-helpers.js';

export type ExecutionOutcome = 'skipped' | 'succeeded' | 'retry' | 'failed' | 'stale';

type AbortReason = 'timeout' | 'lease_lost' | 'shutdown';

class ExecutionAborted extends Error {
  constructor(readonly reason: AbortReason) {
    super(`execution aborted: ${reason}`);
    this.name = 'ExecutionAborted';
  }
}

export interface ExecutorOptions {
  workerId: string;
  leaseMs: number;
}

/**
 * Runs one delivered dispatch: claim -> execute -> record. Independent of BullMQ so it can be
 * exercised directly in tests (duplicate deliveries, crashes, stale workers).
 */
export class JobExecutor {
  private readonly active = new Map<string, AbortController>();
  processed = 0;
  failed = 0;

  constructor(
    private readonly execution: JobExecution,
    private readonly handlers: HandlerRegistry,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
    private readonly opts: ExecutorOptions,
  ) {}

  get activeCount(): number {
    return this.active.size;
  }

  /** Aborts every running handler (used when a graceful drain runs out of time). */
  abortAll(): void {
    for (const c of this.active.values()) c.abort(new ExecutionAborted('shutdown'));
  }

  async process(dispatch: DispatchPayload, deliverySignal?: AbortSignal): Promise<ExecutionOutcome> {
    const { jobId, attempt, queue } = dispatch;
    const log = this.logger.child({ jobId, attempt, queue, correlationId: dispatch.correlationId });

    const claimed = await this.execution.claim(jobId, attempt, this.opts.workerId, this.opts.leaseMs);
    if (!claimed) {
      // Duplicate delivery, stale dispatch for an older attempt, or the job was cancelled first.
      this.metrics.duplicateDeliveries.inc({ queue });
      log.debug('delivery skipped: job is not claimable for this attempt');
      return 'skipped';
    }
    const job = claimed.job;
    if (claimed.queueWaitMs !== null)
      this.metrics.jobQueueWait.observe({ queue }, claimed.queueWaitMs / 1000);

    const controller = new AbortController();
    this.active.set(jobId, controller);
    this.metrics.workerActiveJobs.set(this.active.size);
    const onDeliveryAbort = (): void => {
      controller.abort(new ExecutionAborted('shutdown'));
    };
    deliverySignal?.addEventListener('abort', onDeliveryAbort, { once: true });

    const timeout = setTimeout(() => {
      controller.abort(new ExecutionAborted('timeout'));
    }, job.timeout_ms);
    // Renew the lease well before it expires; losing it means someone else may run this job now.
    const renew = setInterval(
      () => {
        this.execution
          .renewLease(jobId, attempt, this.opts.workerId, this.opts.leaseMs)
          .then((ok) => {
            if (!ok) {
              log.warn('lease lost while running; aborting handler');
              controller.abort(new ExecutionAborted('lease_lost'));
            }
          })
          .catch((err: unknown) => {
            log.warn({ err }, 'lease renewal failed; will retry');
          });
      },
      Math.max(50, Math.floor(this.opts.leaseMs / 3)),
    );

    const started = performance.now();
    let outcome: ExecutionOutcome;
    try {
      // 1. Run the handler. Only errors thrown *here* count as job failures.
      let result: unknown;
      let handlerError: unknown;
      let failed = false;
      try {
        const handler = this.handlers.get(job.type);
        if (!handler)
          throw new PermanentJobError('unknown_job_type', `No handler registered for '${job.type}'`);
        const aborted = new Promise<never>((_, reject) => {
          controller.signal.addEventListener(
            'abort',
            () => {
              reject(controller.signal.reason as Error);
            },
            { once: true },
          );
        });
        // Promise.race: a handler that ignores the abort signal cannot hold the attempt past its timeout.
        result = await Promise.race([
          handler.execute(job.payload, {
            jobId,
            projectId: job.project_id,
            attempt,
            signal: controller.signal,
            logger: log,
          }),
          aborted,
        ]);
      } catch (err) {
        failed = true;
        handlerError = err;
      }
      const durationMs = Math.round(performance.now() - started);

      // 2. Record the outcome. If *recording* fails (database unavailable), the error propagates:
      //    the attempt stays 'running', its lease expires, and the reaper retries it. The handler's
      //    side effects may then repeat - the documented at-least-once behaviour.
      if (!failed) {
        const res = await this.execution.complete(jobId, attempt, this.opts.workerId, result, durationMs);
        outcome = res.applied ? 'succeeded' : 'stale';
        if (!res.applied) {
          this.metrics.staleCompletions.inc();
          log.warn('result discarded: lease no longer held (job was recovered by another worker)');
        }
      } else {
        const reason = handlerError instanceof ExecutionAborted ? handlerError.reason : null;
        if (reason === 'lease_lost') {
          this.metrics.staleCompletions.inc();
          outcome = 'stale';
        } else {
          const classified =
            reason === 'shutdown'
              ? {
                  code: 'worker_shutdown',
                  message: 'Worker shut down before the job finished',
                  retryable: true,
                }
              : classifyError(handlerError, reason === 'timeout');
          const res = await this.execution.fail(
            jobId,
            attempt,
            this.opts.workerId,
            classified,
            durationMs,
            reason === 'timeout' ? 'timed_out' : 'failed',
          );
          outcome = res.applied ? res.outcome : 'stale';
          if (res.applied) {
            log.info(
              { code: classified.code, outcome, retryable: classified.retryable },
              'job attempt failed',
            );
          }
        }
      }
      this.observe(job.queue, job.type, outcome, durationMs);
    } finally {
      clearTimeout(timeout);
      clearInterval(renew);
      deliverySignal?.removeEventListener('abort', onDeliveryAbort);
      this.active.delete(jobId);
      this.metrics.workerActiveJobs.set(this.active.size);
    }
    this.processed++;
    if (outcome === 'failed') this.failed++;
    return outcome;
  }

  private observe(queue: string, type: string, outcome: ExecutionOutcome, durationMs: number): void {
    const label = outcome === 'stale' ? 'stale' : outcome;
    this.metrics.jobsCompleted.inc({ queue, type, outcome: label });
    this.metrics.jobExecutionDuration.observe({ queue, type, outcome: label }, durationMs / 1000);
  }
}
