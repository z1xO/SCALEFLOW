import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Services } from '../../container.js';
import { CreateScheduleSchema, UpdateScheduleSchema } from '../../modules/schedules/schedules.js';
import { authorizeProject } from '../auth.js';
import { BackoffOut, errorResponses, IdParam, JobSchema } from '../schemas.js';

export const ScheduleSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    name: z.string(),
    cron: z.string(),
    timezone: z.string(),
    jobType: z.string(),
    queue: z.string(),
    payload: z.record(z.string(), z.unknown()),
    jobOptions: z.object({
      maxAttempts: z.number().int(),
      backoff: BackoffOut.optional(),
      timeoutMs: z.number().int().optional(),
    }),
    enabled: z.boolean(),
    nextRunAt: z.string(),
    lastRunAt: z.string().nullable(),
    lastJobId: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'Schedule' });

const ScheduleParams = z.object({ projectId: z.uuid(), scheduleId: z.uuid() });

export const scheduleRoutes =
  (services: Services): FastifyPluginCallbackZod =>
  (app, _opts, done) => {
    app.get(
      '/v1/projects/:projectId/schedules',
      {
        schema: {
          tags: ['schedules'],
          summary: 'Recurring schedules',
          params: IdParam,
          response: { 200: z.object({ items: z.array(ScheduleSchema) }), ...errorResponses },
        },
      },
      async (request) => {
        await authorizeProject(services, request, request.params.projectId, 'jobs:read');
        return { items: await services.schedules.list(request.params.projectId) };
      },
    );

    app.post(
      '/v1/projects/:projectId/schedules',
      {
        schema: {
          tags: ['schedules'],
          summary: 'Create a recurring schedule (cron). Fires at most once per minute.',
          params: IdParam,
          body: CreateScheduleSchema,
          response: { 201: z.object({ schedule: ScheduleSchema }), ...errorResponses },
        },
      },
      async (request, reply) => {
        const { actor } = await authorizeProject(services, request, request.params.projectId, 'jobs:write');
        const schedule = await services.schedules.create(request.params.projectId, request.body, actor);
        return reply.status(201).send({ schedule });
      },
    );

    app.get(
      '/v1/projects/:projectId/schedules/:scheduleId',
      {
        schema: {
          tags: ['schedules'],
          params: ScheduleParams,
          response: { 200: z.object({ schedule: ScheduleSchema }), ...errorResponses },
        },
      },
      async (request) => {
        await authorizeProject(services, request, request.params.projectId, 'jobs:read');
        return { schedule: await services.schedules.get(request.params.projectId, request.params.scheduleId) };
      },
    );

    app.patch(
      '/v1/projects/:projectId/schedules/:scheduleId',
      {
        schema: {
          tags: ['schedules'],
          summary: 'Update cron, payload, options or enabled flag',
          params: ScheduleParams,
          body: UpdateScheduleSchema,
          response: { 200: z.object({ schedule: ScheduleSchema }), ...errorResponses },
        },
      },
      async (request) => {
        const { actor } = await authorizeProject(services, request, request.params.projectId, 'jobs:write');
        return {
          schedule: await services.schedules.update(
            request.params.projectId,
            request.params.scheduleId,
            request.body,
            actor,
          ),
        };
      },
    );

    app.delete(
      '/v1/projects/:projectId/schedules/:scheduleId',
      {
        schema: { tags: ['schedules'], params: ScheduleParams, response: { 204: z.null(), ...errorResponses } },
      },
      async (request, reply) => {
        const { actor } = await authorizeProject(services, request, request.params.projectId, 'jobs:write');
        await services.schedules.remove(request.params.projectId, request.params.scheduleId, actor);
        return reply.status(204).send(null);
      },
    );

    app.post(
      '/v1/projects/:projectId/schedules/:scheduleId/trigger',
      {
        schema: {
          tags: ['schedules'],
          summary: 'Run the schedule now (one extra job; the regular cadence is unchanged)',
          params: ScheduleParams,
          response: { 201: z.object({ job: JobSchema }), ...errorResponses },
        },
      },
      async (request, reply) => {
        await authorizeProject(services, request, request.params.projectId, 'jobs:write');
        const job = await services.schedules.trigger(request.params.projectId, request.params.scheduleId, request.id);
        return reply.status(201).send({ job });
      },
    );
    done();
  };
