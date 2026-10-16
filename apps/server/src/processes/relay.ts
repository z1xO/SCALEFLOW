import { loadConfig } from '../config/env.js';
import { createServices } from '../container.js';
import { closeServer, startOpsServer } from '../http/ops-server.js';
import { loadDotEnv } from '../lib/dotenv.js';
import { Lifecycle, runLoop } from '../lib/lifecycle.js';
import { OutboxRelay } from '../modules/outbox/relay.js';
import { Projector } from '../modules/projections/projector.js';

/**
 * Relay process: consumers of PostgreSQL logs.
 *   - outbox dispatcher: outbox -> BullMQ (transport)
 *   - projector: job_events -> read model (CQRS)
 * Both are safe with multiple replicas (SKIP LOCKED leases / advisory lock).
 */
loadDotEnv();
const config = loadConfig();
const services = createServices(config, 'relay');
const { logger, metrics } = services;
const lifecycle = new Lifecycle(logger);
lifecycle.installSignalHandlers();
lifecycle.onShutdown('services', () => services.close());

const relay = new OutboxRelay(services.pool, services.queues, logger, metrics, {
  batchSize: config.RELAY_BATCH_SIZE,
  leaseMs: 30_000,
  publishTimeoutMs: 5_000,
});
const projector = new Projector(services.pool, logger, metrics);
const common = { signal: lifecycle.signal, logger, metrics };

const loops = [
  runLoop({ ...common, name: 'outbox', intervalMs: config.RELAY_POLL_MS, tick: () => relay.tick() }),
  runLoop({
    ...common,
    name: 'projector',
    intervalMs: config.PROJECTOR_POLL_MS,
    tick: () => projector.tick(),
  }),
  runLoop({
    ...common,
    name: 'outbox_backlog',
    intervalMs: 5_000,
    tick: async () => {
      await relay.collectBacklog();
      return false;
    },
  }),
];

const ops = await startOpsServer(services, config.RELAY_METRICS_PORT, () => lifecycle.isShuttingDown);
lifecycle.onShutdown('ops-server', () => closeServer(ops));
lifecycle.onShutdown('loops', async () => {
  await Promise.all(loops);
});
logger.info('relay started');
