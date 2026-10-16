import { loadConfig } from '../config/env.js';
import { createServices } from '../container.js';
import { closeServer, startOpsServer } from '../http/ops-server.js';
import { loadDotEnv } from '../lib/dotenv.js';
import { Lifecycle, runLoop } from '../lib/lifecycle.js';
import { exportSnapshot, takeSnapshot } from '../modules/maintenance/gauges.js';
import { DispatchReconciler } from '../modules/maintenance/reconciler.js';
import { Retention } from '../modules/maintenance/retention.js';

/**
 * Scheduler process: time-driven state changes and housekeeping. Every loop is safe to run in
 * several replicas (SKIP LOCKED / idempotency keys), so running two schedulers for availability is fine.
 */
loadDotEnv();
const config = loadConfig();
const services = createServices(config, 'scheduler');
const { logger, metrics, jobExecution } = services;
const lifecycle = new Lifecycle(logger);
lifecycle.installSignalHandlers();
lifecycle.onShutdown('services', () => services.close());

const reconciler = new DispatchReconciler(
  services.pool,
  services.queues,
  logger,
  metrics,
  config.RECONCILER_QUEUED_THRESHOLD_MS,
);
const retention = new Retention(services.pool, config, metrics);
const { signal } = lifecycle;
const common = { signal, logger, metrics };

const loops = [
  runLoop({
    ...common,
    name: 'promoter',
    intervalMs: config.SCHEDULER_PROMOTE_MS,
    tick: async () => {
      const promoted = await jobExecution.promoteDue(500);
      for (const j of promoted) metrics.jobsPromoted.inc({ from: j.previous_status });
      return promoted.length === 500;
    },
  }),
  runLoop({
    ...common,
    name: 'cron',
    intervalMs: 1_000,
    tick: async () => {
      const fired = await services.schedules.fireDue(50);
      const created = fired.filter((f) => f.jobId !== null).length;
      if (created > 0) metrics.schedulesFired.inc(created);
      return fired.length === 50;
    },
  }),
  runLoop({
    ...common,
    name: 'lease_reaper',
    intervalMs: 5_000,
    tick: async () => {
      const recovered = await jobExecution.recoverExpiredLeases(100);
      if (recovered.length > 0) {
        metrics.leasesRecovered.inc(recovered.length);
        logger.warn(
          { count: recovered.length, jobIds: recovered.slice(0, 20).map((j) => j.id) },
          'recovered running jobs whose worker lease expired',
        );
      }
      return recovered.length === 100;
    },
  }),
  runLoop({
    ...common,
    name: 'dispatch_reconciler',
    intervalMs: 30_000,
    tick: async () => (await reconciler.tick()) === 500,
  }),
  runLoop({
    ...common,
    name: 'worker_liveness',
    intervalMs: 10_000,
    tick: async () => {
      const stale = await services.workers.markStale(config.WORKER_HEARTBEAT_MS * 6);
      if (stale.length > 0) logger.warn({ workers: stale }, 'workers stopped heartbeating; marked offline');
      return false;
    },
  }),
  runLoop({
    ...common,
    name: 'gauges',
    intervalMs: 5_000,
    tick: async () => {
      exportSnapshot(metrics, await takeSnapshot(services.pool, services.queues));
      return false;
    },
  }),
  runLoop({
    ...common,
    name: 'retention',
    intervalMs: 60_000,
    tick: async () => {
      const deleted = await retention.run();
      const total = Object.values(deleted).reduce((a, b) => a + b, 0);
      if (total > 0) logger.info({ deleted }, 'retention pass');
      return false;
    },
  }),
];

const ops = await startOpsServer(services, config.SCHEDULER_METRICS_PORT, () => lifecycle.isShuttingDown);
lifecycle.onShutdown('ops-server', () => closeServer(ops));
// The lifecycle signal aborts first; this waits for in-flight iterations to finish.
lifecycle.onShutdown('loops', async () => {
  await Promise.all(loops);
});
logger.info('scheduler started');
