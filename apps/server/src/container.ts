import type pg from 'pg';
import type { Config } from './config/env.js';
import { createHandlerRegistry, type HandlerRegistry } from './handlers/registry.js';
import { CachedLoader } from './infra/cache/cached-loader.js';
import { createPool } from './infra/db/pool.js';
import { ReadRouter } from './infra/db/read-router.js';
import { QueueSet } from './infra/queue.js';
import { createRedis, type Redis } from './infra/redis.js';
import { createLogger, type Logger } from './lib/logger.js';
import { createMetrics, type Metrics } from './lib/metrics.js';
import { ApiKeyService } from './modules/auth/api-keys.js';
import { AuthService } from './modules/auth/auth-service.js';
import { Authorizer } from './modules/auth/principal.js';
import { Backpressure } from './modules/jobs/backpressure.js';
import { JobCache } from './modules/jobs/job-cache.js';
import { JobCommands } from './modules/jobs/job-commands.js';
import { JobExecution } from './modules/jobs/job-execution.js';
import { JobQueries } from './modules/jobs/job-queries.js';
import { ProjectService } from './modules/projects/projects.js';

/**
 * Composition root: the only place that knows how concrete implementations fit together.
 * Business modules receive their collaborators through constructors, which is what lets the
 * integration tests build the same graph against a test database and Redis.
 */
export interface Services {
  config: Config;
  logger: Logger;
  metrics: Metrics;
  pool: pg.Pool;
  readPool: pg.Pool | null;
  readRouter: ReadRouter;
  redis: Redis;
  queues: QueueSet;
  handlers: HandlerRegistry;
  jobCache: JobCache;
  loader: CachedLoader;
  jobCommands: JobCommands;
  jobQueries: JobQueries;
  jobExecution: JobExecution;
  auth: AuthService;
  authorizer: Authorizer;
  apiKeys: ApiKeyService;
  projects: ProjectService;
  close(): Promise<void>;
}

export function createServices(config: Config, service: string, overrides: { logger?: Logger } = {}): Services {
  const logger = overrides.logger ?? createLogger(config, service);
  const metrics = createMetrics(service);
  const poolOpts = {
    statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
    connectTimeoutMs: config.DATABASE_CONNECT_TIMEOUT_MS,
  };
  const pool = createPool(
    { ...poolOpts, connectionString: config.DATABASE_URL, max: config.DATABASE_POOL_MAX, applicationName: `scaleflow-${service}` },
    logger,
  );
  const readPool = config.DATABASE_READ_URL
    ? createPool(
        {
          ...poolOpts,
          connectionString: config.DATABASE_READ_URL,
          max: config.DATABASE_READ_POOL_MAX,
          applicationName: `scaleflow-${service}-read`,
        },
        logger,
      )
    : null;
  const readRouter = new ReadRouter(pool, readPool, logger, metrics);
  const redis = createRedis(config.REDIS_URL, `scaleflow-${service}`, logger, config.REDIS_COMMAND_TIMEOUT_MS);
  const prefix = config.REDIS_KEY_PREFIX;
  const queues = new QueueSet(config.REDIS_URL, `${prefix}-bull`, config.QUEUES);
  const handlers = createHandlerRegistry(config);
  const jobCache = new JobCache(redis, prefix, logger, metrics);
  const loader = new CachedLoader(redis, 'loader', logger, metrics);
  const backpressure = new Backpressure(
    pool,
    { maxActivePerProject: config.MAX_ACTIVE_JOBS_PER_PROJECT, maxOutboxBacklog: config.MAX_OUTBOX_BACKLOG },
    metrics,
  );
  const jobCommands = new JobCommands({
    pool,
    readRouter,
    handlers,
    cache: jobCache,
    backpressure,
    metrics,
    queues: config.QUEUES,
    maxPayloadBytes: config.MAX_PAYLOAD_BYTES,
  });
  const jobQueries = new JobQueries(readRouter, jobCache);
  const jobExecution = new JobExecution(pool, jobCache);
  const auth = new AuthService(
    pool,
    redis,
    {
      prefix,
      sessionTtlHours: config.SESSION_TTL_HOURS,
      scryptLogN: config.PASSWORD_SCRYPT_LOG_N,
      allowRegistration: config.ALLOW_REGISTRATION,
    },
    logger,
  );
  const authorizer = new Authorizer(pool, redis, prefix, logger);
  const apiKeys = new ApiKeyService(pool, redis, (hash) => auth.apiKeyCacheKey(hash));
  const projects = new ProjectService(pool, authorizer);

  let closed = false;
  return {
    config,
    logger,
    metrics,
    pool,
    readPool,
    readRouter,
    redis,
    queues,
    handlers,
    jobCache,
    loader,
    jobCommands,
    jobQueries,
    jobExecution,
    auth,
    authorizer,
    apiKeys,
    projects,
    async close() {
      if (closed) return;
      closed = true;
      await handlers.close();
      await queues.close();
      await redis.quit().catch((err: unknown) => {
        logger.warn({ err }, 'redis quit failed; disconnecting');
        redis.disconnect();
      });
      await Promise.all([pool.end(), readPool?.end()]);
    },
  };
}
