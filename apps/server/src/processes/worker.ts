import { loadConfig } from '../config/env.js';
import { createServices } from '../container.js';
import { closeServer, startOpsServer } from '../http/ops-server.js';
import { loadDotEnv } from '../lib/dotenv.js';
import { Lifecycle } from '../lib/lifecycle.js';
import { newWorkerId } from '../modules/workers/worker-registry.js';
import { WorkerRuntime } from '../modules/workers/worker-runtime.js';

loadDotEnv();
const config = loadConfig();
const services = createServices(config, 'worker');
const lifecycle = new Lifecycle(services.logger, config.WORKER_SHUTDOWN_GRACE_MS + 15_000);
lifecycle.installSignalHandlers();
lifecycle.onShutdown('services', () => services.close());

const runtime = new WorkerRuntime(services, {
  workerId: newWorkerId(config.WORKER_NAME),
  queues: config.WORKER_QUEUES,
  concurrency: config.WORKER_CONCURRENCY,
  leaseMs: config.WORKER_LEASE_MS,
  heartbeatMs: config.WORKER_HEARTBEAT_MS,
  shutdownGraceMs: config.WORKER_SHUTDOWN_GRACE_MS,
});

const ops = await startOpsServer(services, config.WORKER_METRICS_PORT, () => lifecycle.isShuttingDown);
lifecycle.onShutdown('ops-server', () => closeServer(ops));
await runtime.start();
lifecycle.onShutdown('worker', () => runtime.stop());
