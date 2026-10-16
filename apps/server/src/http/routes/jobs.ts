import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Services } from '../../container.js';
import { JOB_STATUSES } from '../../domain/job-state.js';
import { ValidationError } from '../../lib/errors.js';
import { CreateJobInputSchema } from '../../modules/jobs/job-commands.js';
import { authorizeProject } from '../auth.js';
import {
  AttemptSchema,
  errorResponses,
  EventSchema,
  IdParam,
  JobIdParams,
  JobSchema,
  page,
} from '../schemas.js';

export const COMMIT_LSN_HEADER = 'x-scaleflow-commit-lsn';
export const MIN_LSN_HEADER = 'x-scaleflow-min-lsn';

function minLsn(request: FastifyRequest): string | undefined {
  const v = request.headers[MIN_LSN_HEADER];
  return typeof v === 'string' && v.length <= 32 ? v : undefined;
}

function setCommitLsn(reply: FastifyReply, lsn: string | null): void {
  if (lsn) void reply.header(COMMIT_LSN_HEADER, lsn);
}

const IdempotencyHeaders = z.object({
  'idempotency-key': z
    .string()
    .min(1)
    .max(200)
    .regex(/^[\x21-\x7e]+$/)
    .optional()
    .describe('Makes the submission idempotent within the project'),
});

const statusCsv = z
  .string()
  .transform((s) => s.split(',').map((x) => x.trim()))
  .pipe(z.array(z.enum(JOB_STATUSES)));

const ListQuery = z.object({
  status: statusCsv.optional().describe('Comma-separated statuses, e.g. "failed" for the dead-letter view'),
  type: z.string().max(100).optional(),
  queue: z.string().max(50).optional(),
  scheduleId: z.uuid().optional(),
  createdAfter: z.iso.datetime({ offset: true }).optional(),
  createdBefore: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});

export const jobRoutes =
  (services: Services): FastifyPluginCallbackZod =>
  (app, _opts, done) => {
    app.get(
      '/v1/job-types',
      {
        schema: {
          tags: ['jobs'],
          summary: 'Registered job types',
          response: {
            200: z.object({
              items: z.array(
                z.object({ type: z.string(), description: z.string(), defaultTimeoutMs: z.number() }),
              ),
              queues: z.array(z.string()),
            }),
            ...errorResponses,
          },
        },
      },
      () => ({ items: services.handlers.list(), queues: [...services.config.QUEUES] }),
    );

    // ---------------------------------------------------------------- commands
    app.post(
      '/v1/projects/:projectId/jobs',
      {
        schema: {
          tags: ['jobs'],
          summary: 'Submit a job',
          description:
            'Returns 201 for a new job. With an Idempotency-Key that was already used with the same body, returns ' +
            '200 with the original job and `Idempotent-Replayed: true`; with a different body, 422.',
          params: IdParam,
          headers: IdempotencyHeaders,
          body: CreateJobInputSchema,
          response: {
            200: z.object({ job: JobSchema }),
            201: z.object({ job: JobSchema }),
            ...errorResponses,
          },
        },
      },
      async (request, reply) => {
        const { projectId } = request.params;
        const { actor } = await authorizeProject(services, request, projectId, 'jobs:write');
        const headerKey = request.headers['idempotency-key'];
        if (headerKey && request.body.idempotencyKey && headerKey !== request.body.idempotencyKey) {
          throw new ValidationError('Idempotency-Key header and body idempotencyKey differ');
        }
        const input = { ...request.body, idempotencyKey: headerKey ?? request.body.idempotencyKey };
        const { results, commitLsn } = await services.jobCommands.create(projectId, [input], {
          actor,
          correlationId: request.id,
          ip: request.ip,
        });
        const result = results[0];
        if (!result) throw new Error('create returned no result');
        setCommitLsn(reply, commitLsn);
        void reply.header('location', `/v1/projects/${projectId}/jobs/${result.job.id}`);
        if (!result.created) void reply.header('idempotent-replayed', 'true');
        return reply.status(result.created ? 201 : 200).send({ job: result.job });
      },
    );

    app.post(
      '/v1/projects/:projectId/jobs/batch',
      {
        schema: {
          tags: ['jobs'],
          summary: 'Submit up to 100 jobs atomically (all or nothing)',
          params: IdParam,
          body: z.object({ jobs: z.array(CreateJobInputSchema).min(1).max(100) }),
          response: {
            201: z.object({ items: z.array(z.object({ job: JobSchema, created: z.boolean() })) }),
            ...errorResponses,
          },
        },
      },
      async (request, reply) => {
        const { projectId } = request.params;
        const { actor } = await authorizeProject(services, request, projectId, 'jobs:write');
        const { results, commitLsn } = await services.jobCommands.create(projectId, request.body.jobs, {
          actor,
          correlationId: request.id,
          ip: request.ip,
        });
        setCommitLsn(reply, commitLsn);
        return reply.status(201).send({ items: results });
      },
    );

    app.post(
      '/v1/projects/:projectId/jobs/:jobId/cancel',
      {
        schema: {
          tags: ['jobs'],
          summary: 'Cancel a scheduled, queued or retry-waiting job',
          description:
            'Running jobs cannot be cancelled (409 job_not_cancellable): their side effects may be in progress.',
          params: JobIdParams,
          response: { 200: z.object({ job: JobSchema }), ...errorResponses },
        },
      },
      async (request, reply) => {
        const { projectId, jobId } = request.params;
        const { actor } = await authorizeProject(services, request, projectId, 'jobs:write');
        const { job, commitLsn } = await services.jobCommands.cancel(projectId, jobId, {
          actor,
          correlationId: request.id,
          ip: request.ip,
        });
        setCommitLsn(reply, commitLsn);
        return { job };
      },
    );

    app.post(
      '/v1/projects/:projectId/jobs/:jobId/retry',
      {
        schema: {
          tags: ['jobs'],
          summary: 'Manually retry (replay) a failed / dead-lettered job',
          params: JobIdParams,
          response: { 200: z.object({ job: JobSchema }), ...errorResponses },
        },
      },
      async (request, reply) => {
        const { projectId, jobId } = request.params;
        const { actor } = await authorizeProject(services, request, projectId, 'jobs:write');
        const { job, commitLsn } = await services.jobCommands.retry(projectId, jobId, {
          actor,
          correlationId: request.id,
          ip: request.ip,
        });
        setCommitLsn(reply, commitLsn);
        return { job };
      },
    );

    // ----------------------------------------------------------------- queries
    app.get(
      '/v1/projects/:projectId/jobs',
      {
        schema: {
          tags: ['jobs'],
          summary: 'List jobs, newest first, with cursor pagination',
          params: IdParam,
          querystring: ListQuery,
          response: { 200: page(JobSchema), ...errorResponses },
        },
      },
      async (request) => {
        const { projectId } = request.params;
        await authorizeProject(services, request, projectId, 'jobs:read');
        const q = request.query;
        return services.jobQueries.list(
          projectId,
          {
            status: q.status,
            type: q.type,
            queue: q.queue,
            scheduleId: q.scheduleId,
            createdAfter: q.createdAfter ? new Date(q.createdAfter) : undefined,
            createdBefore: q.createdBefore ? new Date(q.createdBefore) : undefined,
          },
          { limit: q.limit, cursor: q.cursor },
          minLsn(request),
        );
      },
    );

    app.get(
      '/v1/projects/:projectId/jobs/:jobId',
      {
        schema: {
          tags: ['jobs'],
          summary: 'Get a job',
          params: JobIdParams,
          response: { 200: z.object({ job: JobSchema }), ...errorResponses },
        },
      },
      async (request) => {
        const { projectId, jobId } = request.params;
        await authorizeProject(services, request, projectId, 'jobs:read');
        return { job: await services.jobQueries.get(projectId, jobId, minLsn(request)) };
      },
    );

    app.get(
      '/v1/projects/:projectId/jobs/:jobId/attempts',
      {
        schema: {
          tags: ['jobs'],
          summary: 'Execution attempts of a job, with errors',
          params: JobIdParams,
          response: { 200: z.object({ items: z.array(AttemptSchema) }), ...errorResponses },
        },
      },
      async (request) => {
        const { projectId, jobId } = request.params;
        await authorizeProject(services, request, projectId, 'jobs:read');
        return { items: await services.jobQueries.attempts(projectId, jobId, minLsn(request)) };
      },
    );

    app.get(
      '/v1/projects/:projectId/jobs/:jobId/events',
      {
        schema: {
          tags: ['jobs'],
          summary: 'State-change timeline of a job',
          params: JobIdParams,
          response: { 200: z.object({ items: z.array(EventSchema) }), ...errorResponses },
        },
      },
      async (request) => {
        const { projectId, jobId } = request.params;
        await authorizeProject(services, request, projectId, 'jobs:read');
        return { items: await services.jobQueries.jobEvents(projectId, jobId, minLsn(request)) };
      },
    );

    app.get(
      '/v1/projects/:projectId/events',
      {
        schema: {
          tags: ['events'],
          summary: 'Project event history, newest first',
          params: IdParam,
          querystring: z.object({
            limit: z.coerce.number().int().min(1).max(200).default(50),
            cursor: z.string().max(100).optional(),
            jobId: z.uuid().optional(),
          }),
          response: { 200: page(EventSchema), ...errorResponses },
        },
      },
      async (request) => {
        const { projectId } = request.params;
        await authorizeProject(services, request, projectId, 'jobs:read');
        return services.jobQueries.projectEvents(projectId, request.query);
      },
    );
    done();
  };
