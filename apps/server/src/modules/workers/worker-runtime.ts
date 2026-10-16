import { Worker } from 'bullmq';
import type { Services } from '../../container.js';
import { bullQueueName, KEEP_COMPLETED, KEEP_FAILED } from '../../infra/queue.js';
import { bullConnection } from '../../infra/redis.js';
import { sleep } from '../../lib/async.js';
import { runLoop } from '../../lib/lifecycle.js';
import type { DispatchPayload } from '../jobs/write-helpers.js';
import { JobExecutor } from './job-executor.js';
import { WorkerRegistry } from './worker-registry.js';

export interface WorkerRuntimeOptions {
  workerId: string;
  queues: string[];
  concurrency: number;
  leaseMs: number;
  heartbeatMs: number;
  shutdownGraceMs: number;
}

/**
 * One worker process: a BullMQ consumer per queue, all sharing one executor, plus a heartbeat.
 *
 * Shutdown (SIGTERM): mark 'draining', stop taking new deliveries, let running jobs finish for up to
 * `shutdownGraceMs`, then abort the stragglers (recorded as a retryable 'worker_shutdown' failure),
 * and finally mark the worker 'offline'. A crash skips all of this - the lease reaper covers it.
 */
export class WorkerRuntime {
  readonly executor: JobExecutor;
  private readonly registry: WorkerRegistry;
  private bullWorkers: Worker<DispatchPayload>[] = [];
  private readonly heartbeatAbort = new AbortController();
  private heartbeatLoop: Promise<void> | undefined;

  constructor(
    private readonly services: Services,
    private readonly opts: WorkerRuntimeOptions,
  ) {
    this.executor = new JobExecutor(services.jobExecution, services.handlers, services.logger, services.metrics, {
      workerId: opts.workerId,
      leaseMs: opts.leaseMs,
    });
    this.registry = new WorkerRegistry(services.pool);
  }

  async start(): Promise<void> {
    const { config, logger, metrics } = this.services;
    await this.registry.register({
      id: this.opts.workerId,
      queues: this.opts.queues,
      concurrency: this.opts.concurrency * this.opts.queues.length,
      version: config.SERVICE_VERSION,
    });
    metrics.workerConcurrency.set(this.opts.concurrency * this.opts.queues.length);

    for (const queue of this.opts.queues) {
      const worker = new Worker<DispatchPayload>(
        bullQueueName(queue),
        async (job, _token, signal) => {
          await this.executor.process(job.data, signal);
        },
        {
          connection: bullConnection(config.REDIS_URL, `scaleflow-worker-${queue}`),
          prefix: this.services.queues.prefix,
          concurrency: this.opts.concurrency,
          // BullMQ's lock only guards the *delivery*; job ownership is the Postgres lease.
          lockDuration: 30_000,
          maxStalledCount: 1,
          removeOnComplete: KEEP_COMPLETED,
          removeOnFail: KEEP_FAILED,
        },
      );
      worker.on('error', (err) => {
        logger.error({ err, queue }, 'bullmq worker error');
      });
      worker.on('failed', (job, err) => {
        // Reaching here means recording the outcome failed (e.g. Postgres down). The job stays
        // 'running' in Postgres and is recovered by the lease reaper.
        logger.error({ err, jobId: job?.data.jobId, queue }, 'dispatch processing failed; lease reaper will recover the job');
      });
      this.bullWorkers.push(worker);
    }

    this.heartbeatLoop = runLoop({
      name: 'worker_heartbeat',
      intervalMs: this.opts.heartbeatMs,
      signal: this.heartbeatAbort.signal,
      logger,
      metrics,
      tick: async () => {
        await this.registry.heartbeat(this.opts.workerId, {
          activeJobs: this.executor.activeCount,
          processed: this.executor.processed,
          failed: this.executor.failed,
        });
        return false;
      },
    });
    logger.info({ workerId: this.opts.workerId, queues: this.opts.queues, concurrency: this.opts.concurrency }, 'worker started');
  }

  async stop(): Promise<void> {
    const { logger } = this.services;
    logger.info({ active: this.executor.activeCount }, 'worker draining');
    await this.registry.setStatus(this.opts.workerId, 'draining').catch((err: unknown) => {
      logger.warn({ err }, 'could not mark worker draining');
    });
    const closing = Promise.all(this.bullWorkers.map((w) => w.close()));
    const drained = await Promise.race([closing.then(() => true), sleep(this.opts.shutdownGraceMs).then(() => false)]);
    if (!drained) {
      logger.warn({ active: this.executor.activeCount }, 'grace period over; aborting running jobs');
      this.executor.abortAll();
      await Promise.race([closing, sleep(5_000)]);
      await Promise.all(this.bullWorkers.map((w) => w.close(true)));
    }
    this.heartbeatAbort.abort();
    await this.heartbeatLoop;
    await this.registry.setStatus(this.opts.workerId, 'offline');
    logger.info('worker stopped');
  }
}
