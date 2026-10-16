import type pg from 'pg';
import type { Redis } from 'ioredis';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import type { Actor } from '../jobs/model.js';

export const API_KEY_SCOPES = ['jobs:read', 'jobs:write'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const PROJECT_ROLES = ['owner', 'developer', 'viewer'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

export type Permission =
  'project:read' | 'project:manage' | 'members:manage' | 'keys:manage' | 'jobs:read' | 'jobs:write';

export type Principal =
  | { kind: 'user'; userId: string; email: string; sessionId: string }
  | { kind: 'api_key'; apiKeyId: string; projectId: string; scopes: ApiKeyScope[] };

const ROLE_PERMISSIONS: Record<ProjectRole, readonly Permission[]> = {
  owner: ['project:read', 'project:manage', 'members:manage', 'keys:manage', 'jobs:read', 'jobs:write'],
  developer: ['project:read', 'jobs:read', 'jobs:write'],
  viewer: ['project:read', 'jobs:read'],
};

const SCOPE_PERMISSIONS: Record<ApiKeyScope, readonly Permission[]> = {
  'jobs:read': ['project:read', 'jobs:read'],
  'jobs:write': ['jobs:write'],
};

export function roleAllows(role: ProjectRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function scopesAllow(scopes: readonly ApiKeyScope[], permission: Permission): boolean {
  return scopes.some((s) => SCOPE_PERMISSIONS[s].includes(permission));
}

export function actorOf(principal: Principal): Actor {
  return principal.kind === 'user'
    ? { type: 'user', id: principal.userId }
    : { type: 'api_key', id: principal.apiKeyId };
}

export interface ProjectAccess {
  projectId: string;
  role: ProjectRole | null; // null for API keys
}

const MEMBERSHIP_TTL_S = 30;

/**
 * Project-level authorization. A project the principal cannot see at all yields 404 (identical to
 * a project that does not exist, so ids cannot be probed); a visible project with insufficient
 * rights yields 403.
 */
export class Authorizer {
  constructor(
    private readonly pool: pg.Pool,
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly logger: Logger,
  ) {}

  async authorize(
    principal: Principal | null,
    projectId: string,
    permission: Permission,
  ): Promise<ProjectAccess> {
    if (!principal) throw new UnauthorizedError();
    if (principal.kind === 'api_key') {
      if (principal.projectId !== projectId) throw new NotFoundError('Project');
      if (!scopesAllow(principal.scopes, permission)) {
        throw new ForbiddenError(`API key lacks the scope required for '${permission}'`);
      }
      return { projectId, role: null };
    }
    const role = await this.roleOf(principal.userId, projectId);
    if (!role) throw new NotFoundError('Project');
    if (!roleAllows(role, permission))
      throw new ForbiddenError(`Role '${role}' cannot perform '${permission}'`);
    return { projectId, role };
  }

  async roleOf(userId: string, projectId: string): Promise<ProjectRole | null> {
    const key = this.membershipKey(userId, projectId);
    try {
      const cached = await this.redis.get(key);
      if (cached !== null) return cached === '-' ? null : (cached as ProjectRole);
    } catch (err) {
      this.logger.warn({ err }, 'membership cache read failed');
    }
    const { rows } = await this.pool.query<{ role: ProjectRole }>(
      'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
      [projectId, userId],
    );
    const role = rows[0]?.role ?? null;
    try {
      await this.redis.set(key, role ?? '-', 'EX', MEMBERSHIP_TTL_S);
    } catch (err) {
      this.logger.warn({ err }, 'membership cache write failed');
    }
    return role;
  }

  async invalidateMembership(userId: string, projectId: string): Promise<void> {
    await this.redis.del(this.membershipKey(userId, projectId));
  }

  private membershipKey(userId: string, projectId: string): string {
    return `${this.prefix}:auth:member:${projectId}:${userId}`;
  }
}
