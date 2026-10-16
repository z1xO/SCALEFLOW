import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Services } from '../../container.js';
import { CreateApiKeySchema, RotateApiKeySchema } from '../../modules/auth/api-keys.js';
import { actorOf } from '../../modules/auth/principal.js';
import { AddMemberSchema, CreateProjectSchema, UpdateProjectSchema } from '../../modules/projects/projects.js';
import { authorizeProject, requireUser } from '../auth.js';
import { ApiKeySchema, errorResponses, IdParam, MemberSchema, ProjectSchema } from '../schemas.js';

export const projectRoutes =
  (services: Services): FastifyPluginCallbackZod =>
  (app, _opts, done) => {
    app.get(
      '/v1/projects',
      {
        schema: {
          tags: ['projects'],
          summary: 'Projects the current user belongs to',
          response: { 200: z.object({ items: z.array(ProjectSchema) }), ...errorResponses },
        },
      },
      async (request) => ({ items: await services.projects.listForUser(requireUser(request).userId) }),
    );

    app.post(
      '/v1/projects',
      {
        schema: {
          tags: ['projects'],
          summary: 'Create a project (the caller becomes its owner)',
          body: CreateProjectSchema,
          response: { 201: z.object({ project: ProjectSchema }), ...errorResponses },
        },
      },
      async (request, reply) => {
        const user = requireUser(request);
        return reply.status(201).send({ project: await services.projects.create(user.userId, request.body) });
      },
    );

    app.get(
      '/v1/projects/:projectId',
      {
        schema: {
          tags: ['projects'],
          params: IdParam,
          response: { 200: z.object({ project: ProjectSchema }), ...errorResponses },
        },
      },
      async (request) => {
        const access = await authorizeProject(services, request, request.params.projectId, 'project:read');
        return { project: await services.projects.get(request.params.projectId, access.role) };
      },
    );

    app.patch(
      '/v1/projects/:projectId',
      {
        schema: {
          tags: ['projects'],
          params: IdParam,
          body: UpdateProjectSchema,
          response: { 200: z.object({ project: ProjectSchema }), ...errorResponses },
        },
      },
      async (request) => {
        const { actor } = await authorizeProject(services, request, request.params.projectId, 'project:manage');
        return { project: await services.projects.rename(request.params.projectId, request.body, actor) };
      },
    );

    // --- Members ---------------------------------------------------------
    app.get(
      '/v1/projects/:projectId/members',
      {
        schema: {
          tags: ['projects'],
          params: IdParam,
          response: { 200: z.object({ items: z.array(MemberSchema) }), ...errorResponses },
        },
      },
      async (request) => {
        requireUser(request);
        await authorizeProject(services, request, request.params.projectId, 'project:read');
        return { items: await services.projects.members(request.params.projectId) };
      },
    );

    app.post(
      '/v1/projects/:projectId/members',
      {
        schema: {
          tags: ['projects'],
          summary: 'Add an existing user to the project',
          params: IdParam,
          body: AddMemberSchema,
          response: { 201: z.object({ member: MemberSchema }), ...errorResponses },
        },
      },
      async (request, reply) => {
        const { actor } = await authorizeProject(services, request, request.params.projectId, 'members:manage');
        const member = await services.projects.addMember(request.params.projectId, request.body, actor);
        return reply.status(201).send({ member });
      },
    );

    app.delete(
      '/v1/projects/:projectId/members/:userId',
      {
        schema: {
          tags: ['projects'],
          params: z.object({ projectId: z.uuid(), userId: z.uuid() }),
          response: { 204: z.null(), ...errorResponses },
        },
      },
      async (request, reply) => {
        const { actor } = await authorizeProject(services, request, request.params.projectId, 'members:manage');
        await services.projects.removeMember(request.params.projectId, request.params.userId, actor);
        return reply.status(204).send(null);
      },
    );

    // --- API keys --------------------------------------------------------
    app.get(
      '/v1/projects/:projectId/api-keys',
      {
        schema: {
          tags: ['api-keys'],
          params: IdParam,
          response: { 200: z.object({ items: z.array(ApiKeySchema) }), ...errorResponses },
        },
      },
      async (request) => {
        await authorizeProject(services, request, request.params.projectId, 'keys:manage');
        return { items: await services.apiKeys.list(request.params.projectId) };
      },
    );

    app.post(
      '/v1/projects/:projectId/api-keys',
      {
        schema: {
          tags: ['api-keys'],
          summary: 'Create an API key. The secret is returned only in this response.',
          params: IdParam,
          body: CreateApiKeySchema,
          response: { 201: z.object({ apiKey: ApiKeySchema, secret: z.string() }), ...errorResponses },
        },
      },
      async (request, reply) => {
        await authorizeProject(services, request, request.params.projectId, 'keys:manage');
        const user = requireUser(request);
        const created = await services.apiKeys.create(
          request.params.projectId,
          request.body,
          actorOf(user),
          user.userId,
        );
        return reply.status(201).header('cache-control', 'no-store').send(created);
      },
    );

    app.post(
      '/v1/projects/:projectId/api-keys/:keyId/rotate',
      {
        schema: {
          tags: ['api-keys'],
          summary: 'Issue a replacement key; the old one keeps working for the grace period',
          params: z.object({ projectId: z.uuid(), keyId: z.uuid() }),
          body: RotateApiKeySchema,
          response: {
            201: z.object({ apiKey: ApiKeySchema, secret: z.string(), previous: ApiKeySchema }),
            ...errorResponses,
          },
        },
      },
      async (request, reply) => {
        await authorizeProject(services, request, request.params.projectId, 'keys:manage');
        const user = requireUser(request);
        const result = await services.apiKeys.rotate(
          request.params.projectId,
          request.params.keyId,
          request.body,
          actorOf(user),
          user.userId,
        );
        return reply.status(201).header('cache-control', 'no-store').send(result);
      },
    );

    app.delete(
      '/v1/projects/:projectId/api-keys/:keyId',
      {
        schema: {
          tags: ['api-keys'],
          summary: 'Revoke an API key (effective immediately)',
          params: z.object({ projectId: z.uuid(), keyId: z.uuid() }),
          response: { 200: z.object({ apiKey: ApiKeySchema }), ...errorResponses },
        },
      },
      async (request) => {
        const { actor } = await authorizeProject(services, request, request.params.projectId, 'keys:manage');
        return { apiKey: await services.apiKeys.revoke(request.params.projectId, request.params.keyId, actor) };
      },
    );
    done();
  };
