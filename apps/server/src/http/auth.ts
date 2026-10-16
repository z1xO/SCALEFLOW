import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Services } from '../container.js';
import { ForbiddenError, UnauthorizedError } from '../lib/errors.js';
import { actorOf, type Permission, type Principal, type ProjectAccess } from '../modules/auth/principal.js';
import type { Actor } from '../modules/jobs/model.js';

export const SESSION_COOKIE = 'sf_session';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
    authVia: 'api_key' | 'session' | null;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Resolves the caller on every request (before rate limiting, so limits are per principal):
 *   - `Authorization: Bearer sf_...` -> API key (project-scoped)
 *   - `sf_session` cookie -> dashboard user session
 * Cookie-authenticated unsafe requests must come from an allowed Origin (CSRF defence; the cookie
 * is also SameSite=Lax). API-key requests carry no ambient credentials, so they are exempt.
 */
export function registerAuth(app: FastifyInstance, services: Services): void {
  app.decorateRequest('principal', null);
  app.decorateRequest('authVia', null);
  const allowedOrigins = new Set(services.config.CORS_ORIGINS);

  app.addHook('onRequest', async (request) => {
    const header = request.headers.authorization;
    if (header !== undefined) {
      const m = /^Bearer\s+(\S+)$/i.exec(header);
      if (!m?.[1]) throw new UnauthorizedError('Malformed Authorization header');
      const principal = await services.auth.resolveApiKey(m[1]);
      if (!principal) throw new UnauthorizedError('Invalid, expired or revoked API key');
      request.principal = principal;
      request.authVia = 'api_key';
      return;
    }
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;
    const principal = await services.auth.resolveSession(token);
    if (!principal) return; // expired cookie: treated as anonymous; protected routes answer 401
    if (!SAFE_METHODS.has(request.method)) {
      const origin = request.headers.origin;
      if (!origin || !allowedOrigins.has(origin)) {
        throw new ForbiddenError('Cross-site request rejected (Origin not allowed)');
      }
    }
    request.principal = principal;
    request.authVia = 'session';
  });
}

export function requireUser(request: FastifyRequest): Extract<Principal, { kind: 'user' }> {
  const p = request.principal;
  if (!p) throw new UnauthorizedError();
  if (p.kind !== 'user') throw new ForbiddenError('This endpoint requires a user session, not an API key');
  return p;
}

export interface AuthorizedRequest extends ProjectAccess {
  principal: Principal;
  actor: Actor;
}

export async function authorizeProject(
  services: Services,
  request: FastifyRequest,
  projectId: string,
  permission: Permission,
): Promise<AuthorizedRequest> {
  const access = await services.authorizer.authorize(request.principal, projectId, permission);
  const principal = request.principal;
  if (!principal) throw new UnauthorizedError();
  return { ...access, principal, actor: actorOf(principal) };
}
