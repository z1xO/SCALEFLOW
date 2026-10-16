import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Services } from '../../container.js';
import { JOB_STATUSES } from '../../domain/job-state.js';
import { UnauthorizedError } from '../../lib/errors.js';
import { takeSnapshot } from '../../modules/maintenance/gauges.js';
import { METRIC_WINDOWS, type MetricWindow } from '../../modules/projections/metrics-queries.js';
import { authorizeProject } from '../auth.js';
import { errorResponses, IdParam } from '../schemas.js';

const Latency = z.object({
  count: z.number(),
  avgMs: z.number().nullable(),
  p50Ms: z.number().nullable(),
  p95Ms: z.number().nullable(),
  p99Ms: z.number().nullable(),
});

export const ProjectMetricsSchema = z
  .object({
    window: z.enum(Object.keys(METRIC_WINDOWS) as [MetricWindow, ...MetricWindow[]]),
    generatedAt: z.string(),
    readModelAsOf: z.string().nullable(),
    counts: z.record(z.enum(JOB_STATUSES), z.number()),
    totals: z.object({
      submitted: z.number(),
      started: z.number(),
      succeeded: z.number(),
      failed: z.number(),
      retried: z.number(),
      cancelled: z.number(),
      successRate: z.number().nullable(),
    }),
    latency: z.object({ execution: Latency, queueWait: Latency }),
    series: z.array(
      z.object({ t: z.string(), submitted: z.number(), succeeded: z.number(), failed: z.number(), retried: z.number() }),
    ),
  })
  .meta({ id: 'ProjectMetrics' });

export const SystemSnapshotSchema = z
  .object({
    takenAt: z.string(),
    queues: z.record(z.string(), z.record(z.string(), z.number())),
    jobs: z.object({ scheduled: z.number(), queued: z.number(), running: z.number(), retry_wait: z.number() }),
    oldestQueuedAgeSeconds: z.number(),
    outbox: z.object({ pending: z.number(), oldestAgeSeconds: z.number() }),
    workers: z.object({ online: z.number(), draining: z.number(), activeJobs: z.number(), capacity: z.number() }),
  })
  .meta({ id: 'SystemSnapshot' });

export const WorkerSchema = z
  .object({
    id: z.string(),
    hostname: z.string(),
    pid: z.number(),
    queues: z.array(z.string()),
    concurrency: z.number(),
    status: z.enum(['online', 'draining', 'offline']),
    activeJobs: z.number(),
    processedTotal: z.number(),
    failedTotal: z.number(),
    version: z.string(),
    startedAt: z.string(),
    lastHeartbeatAt: z.string(),
    stoppedAt: z.string().nullable(),
  })
  .meta({ id: 'Worker' });

export const systemRoutes =
  (services: Services): FastifyPluginCallbackZod =>
  (app, _opts, done) => {
    app.get(
      '/v1/projects/:projectId/metrics',
      {
        schema: {
          tags: ['metrics'],
          summary: 'Throughput, success rate, latency percentiles and status counts (read model, ~1s behind)',
          params: IdParam,
          querystring: z.object({ window: z.enum(['15m', '1h', '6h', '24h']).default('1h') }),
          response: { 200: ProjectMetricsSchema, ...errorResponses },
        },
      },
      async (request) => {
        await authorizeProject(services, request, request.params.projectId, 'jobs:read');
        return services.metricsQueries.get(request.params.projectId, request.query.window);
      },
    );

    // Queue and worker health are shared infrastructure (one worker pool serves all projects), so
    // they are visible to any authenticated caller and contain no tenant data.
    app.get(
      '/v1/system/queues',
      {
        schema: {
          tags: ['system'],
          summary: 'Queue depth, outbox backlog, oldest queued job and worker capacity',
          response: { 200: SystemSnapshotSchema, ...errorResponses },
        },
      },
      async (request) => {
        if (!request.principal) throw new UnauthorizedError();
        return services.loader.get(`${services.config.REDIS_KEY_PREFIX}:system:queues`, { freshMs: 2_000, staleMs: 10_000 }, () =>
          takeSnapshot(services.pool, services.queues),
        );
      },
    );

    app.get(
      '/v1/system/workers',
      {
        schema: {
          tags: ['system'],
          summary: 'Workers seen in the last hour with heartbeat and utilization',
          response: { 200: z.object({ items: z.array(WorkerSchema) }), ...errorResponses },
        },
      },
      async (request) => {
        if (!request.principal) throw new UnauthorizedError();
        return { items: await services.workers.list() };
      },
    );
    done();
  };
