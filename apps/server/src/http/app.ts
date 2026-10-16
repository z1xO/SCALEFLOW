import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Services } from '../container.js';
import { TooManyRequestsError, UnauthorizedError } from '../lib/errors.js';
import { uuidv7 } from '../lib/uuid.js';
import { registerAuth } from './auth.js';
import { registerErrorHandling } from './errors.js';
import { checkDependencies } from './health.js';
import { authRoutes } from './routes/auth.js';
import { jobRoutes } from './routes/jobs.js';
import { projectRoutes } from './routes/projects.js';
import { scheduleRoutes } from './routes/schedules.js';
import { streamRoutes } from './routes/stream.js';
import { systemRoutes } from './routes/system.js';
import { takeSnapshot } from '../modules/maintenance/gauges.js';
import { RealtimeHub } from '../modules/realtime/hub.js';

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

export interface AppOptions {
  isShuttingDown?: () => boolean;
}

export async function buildApp(services: Services, opts: AppOptions = {}): Promise<FastifyInstance> {
  const { config, metrics } = services;
  // Typed as Fastify's base logger so plugins see the default logger type.
  const loggerInstance: FastifyBaseLogger = services.logger;
  const app = Fastify({
    loggerInstance,
    bodyLimit: config.API_BODY_LIMIT_BYTES,
    trustProxy: config.TRUST_PROXY,
    // Accept a caller-supplied correlation id if it is well-formed; otherwise mint one.
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID_RE.test(incoming) ? incoming : uuidv7();
    },
    // Request logging is done once per request in the onResponse hook below.
    logController: new LogController({ requestIdLogLabel: 'requestId', disableRequestLogging: true }),
    routerOptions: { maxParamLength: 200 },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);

  app.addHook('onRequest', async (request, reply) => {
    void reply.header('x-request-id', request.id);
  });
  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unmatched';
    // Long-lived SSE streams would dominate the latency histogram; they are tracked by
    // scaleflow_realtime_connections instead.
    if (route === '/v1/projects/:projectId/stream' && reply.statusCode === 200) return;
    const seconds = reply.elapsedTime / 1000;
    metrics.httpRequestDuration.observe({ method: request.method, route, status_code: String(reply.statusCode) }, seconds);
    const level = reply.statusCode >= 500 ? 'error' : reply.statusCode >= 400 ? 'info' : 'debug';
    request.log[level](
      { method: request.method, route, statusCode: reply.statusCode, durationMs: Math.round(reply.elapsedTime) },
      'request completed',
    );
  });

  await app.register(cors, {
    origin: config.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-request-id', 'x-scaleflow-min-lsn', 'last-event-id'],
    exposedHeaders: ['x-request-id', 'x-scaleflow-commit-lsn', 'idempotent-replayed', 'retry-after', 'location'],
    maxAge: 600,
  });
  await app.register(cookie);
  registerAuth(app, services);

  await app.register(rateLimit, {
    global: true,
    hook: 'preHandler', // after authentication, so limits apply per API key / user
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    redis: services.redis,
    nameSpace: `${config.REDIS_KEY_PREFIX}:rl:`,
    skipOnError: true, // a Redis outage must not take the API down
    keyGenerator: (request) => {
      const p = request.principal;
      if (p?.kind === 'api_key') return `key:${p.apiKeyId}`;
      if (p?.kind === 'user') return `user:${p.userId}`;
      return `ip:${request.ip}`;
    },
    onExceeded: () => {
      metrics.rateLimited.inc();
    },
    errorResponseBuilder: (_request, context) =>
      new TooManyRequestsError(
        'rate_limited',
        `Rate limit of ${context.max} requests per ${context.after} exceeded`,
        Math.max(1, Math.ceil(context.ttl / 1000)),
      ),
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'ScaleFlow API',
        version: config.SERVICE_VERSION,
        description:
          'Distributed job processing and event delivery. Authenticate with `Authorization: Bearer <api key>` ' +
          '(project-scoped) or a dashboard session cookie. Errors are RFC 9457 problem details.',
      },
      servers: [{ url: config.PUBLIC_API_URL }],
      components: {
        securitySchemes: {
          apiKey: { type: 'http', scheme: 'bearer', description: 'Project API key (sf_...)' },
          session: { type: 'apiKey', in: 'cookie', name: 'sf_session' },
        },
      },
      security: [{ apiKey: [] }, { session: [] }],
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });
  app.get('/openapi.json', { schema: { hide: true }, config: { rateLimit: false } }, () => app.swagger());

  // --- Operational endpoints (not rate limited) -----------------------------
  app.get('/healthz', { schema: { hide: true }, config: { rateLimit: false } }, () => ({ status: 'ok' }));
  app.get('/readyz', { schema: { hide: true }, config: { rateLimit: false } }, async (_request, reply) => {
    if (opts.isShuttingDown?.()) return reply.status(503).send({ status: 'shutting_down' });
    const result = await checkDependencies(services.pool, services.redis);
    return reply.status(result.ok ? 200 : 503).send({ status: result.ok ? 'ready' : 'not_ready', checks: result.checks });
  });
  app.get('/metrics', { schema: { hide: true }, config: { rateLimit: false } }, async (request, reply) => {
    if (config.METRICS_TOKEN && request.headers.authorization !== `Bearer ${config.METRICS_TOKEN}`) {
      throw new UnauthorizedError('Metrics token required');
    }
    return reply.type(metrics.registry.contentType).send(await metrics.registry.metrics());
  });

  await app.register(authRoutes(services));
  await app.register(projectRoutes(services));
  await app.register(jobRoutes(services));
  await app.register(scheduleRoutes(services));
  await app.register(systemRoutes(services));

  // Real-time delivery. The hub's tailer starts lazily with the first subscriber.
  const hub = new RealtimeHub(
    services.pool,
    () =>
      services.loader.get(`${config.REDIS_KEY_PREFIX}:system:queues`, { freshMs: 2_000, staleMs: 10_000 }, () =>
        takeSnapshot(services.pool, services.queues),
      ),
    services.logger,
    metrics,
    { pollMs: config.SSE_POLL_MS, batchSize: 500, systemSnapshotMs: 5_000, maxConnectionsPerPrincipal: 20 },
  );
  // preClose runs before Fastify waits for open connections: end SSE streams first.
  app.addHook('preClose', () => hub.stop());
  await app.register(streamRoutes(services, hub));

  return app;
}
