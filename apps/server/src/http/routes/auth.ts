import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Services } from '../../container.js';
import { LoginSchema, RegisterSchema } from '../../modules/auth/auth-service.js';
import { requireUser, SESSION_COOKIE } from '../auth.js';
import { errorResponses, MembershipSchema, UserSchema } from '../schemas.js';

export const authRoutes =
  (services: Services): FastifyPluginCallbackZod =>
  (app, _opts, done) => {
    const strictLimit = {
      rateLimit: { max: services.config.AUTH_RATE_LIMIT_MAX, timeWindow: 60_000 },
    };

    app.post(
      '/v1/auth/register',
      {
        config: strictLimit,
        schema: {
          tags: ['auth'],
          summary: 'Create a user account (development / self-hosted registration)',
          body: RegisterSchema,
          response: { 201: z.object({ user: UserSchema }), ...errorResponses },
        },
      },
      async (request, reply) => {
        const user = await services.auth.register(request.body);
        return reply.status(201).send({ user });
      },
    );

    app.post(
      '/v1/auth/login',
      {
        config: strictLimit,
        schema: {
          tags: ['auth'],
          summary: 'Log in; sets an HttpOnly session cookie',
          body: LoginSchema,
          response: { 200: z.object({ user: UserSchema, expiresAt: z.string() }), ...errorResponses },
        },
      },
      async (request, reply) => {
        const { user, token, expiresAt } = await services.auth.login(request.body, {
          userAgent: request.headers['user-agent'],
          ip: request.ip,
        });
        void reply.setCookie(SESSION_COOKIE, token, {
          httpOnly: true,
          secure: services.config.COOKIE_SECURE,
          sameSite: 'lax',
          path: '/',
          expires: expiresAt,
        });
        return { user, expiresAt: expiresAt.toISOString() };
      },
    );

    app.post(
      '/v1/auth/logout',
      {
        schema: { tags: ['auth'], summary: 'Revoke the current session', response: { 204: z.null(), ...errorResponses } },
      },
      async (request, reply) => {
        const token = request.cookies[SESSION_COOKIE];
        if (token) await services.auth.logout(token);
        void reply.clearCookie(SESSION_COOKIE, { path: '/' });
        return reply.status(204).send(null);
      },
    );

    app.get(
      '/v1/auth/me',
      {
        schema: {
          tags: ['auth'],
          summary: 'Current user and project memberships',
          response: { 200: z.object({ user: UserSchema, memberships: z.array(MembershipSchema) }), ...errorResponses },
        },
      },
      async (request) => {
        const user = requireUser(request);
        return services.auth.me(user.userId);
      },
    );
    done();
  };
