import type pg from 'pg';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { withTransaction, pgErrorCode, PgErrorCode } from '../../infra/db/pool.js';
import { hashPassword, passwordNeedsRehash, randomToken, sha256, verifyPassword } from '../../lib/crypto.js';
import { ConflictError, ForbiddenError, UnauthorizedError } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import { uuidv7 } from '../../lib/uuid.js';
import type { ApiKeyScope, Principal, ProjectRole } from './principal.js';

export const RegisterSchema = z.object({
  email: z.email().max(320),
  password: z.string().min(10, 'at least 10 characters').max(200),
  name: z.string().trim().min(1).max(100),
});
export const LoginSchema = z.object({ email: z.email().max(320), password: z.string().min(1).max(200) });

export interface UserDto {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface MembershipDto {
  projectId: string;
  projectName: string;
  role: ProjectRole;
}

interface SessionCacheEntry {
  userId: string;
  email: string;
  sessionId: string;
  expiresAt: number;
}

interface ApiKeyCacheEntry {
  apiKeyId: string;
  projectId: string;
  scopes: ApiKeyScope[];
  expiresAt: number | null;
}

const AUTH_CACHE_TTL_S = 60;
const NEGATIVE_TTL_S = 30;

export class AuthService {
  private readonly lastTouched = new Map<string, number>();
  private dummyHash: Promise<string> | undefined;

  constructor(
    private readonly pool: pg.Pool,
    private readonly redis: Redis,
    private readonly opts: { prefix: string; sessionTtlHours: number; scryptLogN: number; allowRegistration: boolean },
    private readonly logger: Logger,
  ) {}

  async register(input: z.infer<typeof RegisterSchema>): Promise<UserDto> {
    if (!this.opts.allowRegistration) throw new ForbiddenError('Registration is disabled on this server');
    const passwordHash = await hashPassword(input.password, this.opts.scryptLogN);
    const id = uuidv7();
    try {
      const { rows } = await this.pool.query<{ id: string; email: string; name: string; created_at: Date }>(
        `INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)
         RETURNING id, email, name, created_at`,
        [id, input.email.trim(), input.name, passwordHash],
      );
      const u = rows[0];
      if (!u) throw new Error('insert returned no row');
      return { id: u.id, email: u.email, name: u.name, createdAt: u.created_at.toISOString() };
    } catch (err) {
      if (pgErrorCode(err) === PgErrorCode.UniqueViolation) {
        throw new ConflictError('email_taken', 'An account with this email already exists');
      }
      throw err;
    }
  }

  async login(
    input: z.infer<typeof LoginSchema>,
    meta: { userAgent?: string | undefined; ip?: string | undefined },
  ): Promise<{ user: UserDto; token: string; expiresAt: Date }> {
    const { rows } = await this.pool.query<{
      id: string;
      email: string;
      name: string;
      password_hash: string;
      created_at: Date;
    }>('SELECT id, email, name, password_hash, created_at FROM users WHERE lower(email) = lower($1)', [
      input.email.trim(),
    ]);
    const user = rows[0];
    // Verify against a dummy hash when the user does not exist so response time does not reveal
    // which emails are registered.
    const ok = await verifyPassword(input.password, user?.password_hash ?? (await this.getDummyHash()));
    if (!user || !ok) throw new UnauthorizedError('Invalid email or password');

    if (passwordNeedsRehash(user.password_hash, this.opts.scryptLogN)) {
      const upgraded = await hashPassword(input.password, this.opts.scryptLogN);
      await this.pool.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [
        user.id,
        upgraded,
      ]);
    }

    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + this.opts.sessionTtlHours * 3600_000);
    await this.pool.query(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at, user_agent, ip)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [uuidv7(), user.id, sha256(token), expiresAt, meta.userAgent?.slice(0, 300) ?? null, meta.ip ?? null],
    );
    return {
      user: { id: user.id, email: user.email, name: user.name, createdAt: user.created_at.toISOString() },
      token,
      expiresAt,
    };
  }

  async logout(token: string): Promise<void> {
    const hash = sha256(token);
    await this.pool.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [
      hash,
    ]);
    await this.redis.del(this.sessionKey(hash));
  }

  async resolveSession(token: string): Promise<Principal | null> {
    const hash = sha256(token);
    const key = this.sessionKey(hash);
    const cached = await this.cacheGet<SessionCacheEntry>(key);
    if (cached === 'negative') return null;
    if (cached) {
      if (cached.expiresAt <= Date.now()) return null;
      return { kind: 'user', userId: cached.userId, email: cached.email, sessionId: cached.sessionId };
    }
    const { rows } = await this.pool.query<{ id: string; user_id: string; email: string; expires_at: Date }>(
      `SELECT s.id, s.user_id, u.email, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [hash],
    );
    const s = rows[0];
    if (!s) {
      await this.cacheSet(key, 'negative', NEGATIVE_TTL_S);
      return null;
    }
    const entry: SessionCacheEntry = {
      userId: s.user_id,
      email: s.email,
      sessionId: s.id,
      expiresAt: s.expires_at.getTime(),
    };
    await this.cacheSet(key, entry, AUTH_CACHE_TTL_S);
    return { kind: 'user', userId: s.user_id, email: s.email, sessionId: s.id };
  }

  async resolveApiKey(token: string): Promise<Principal | null> {
    const hash = sha256(token);
    const key = this.apiKeyCacheKey(hash);
    let entry: ApiKeyCacheEntry;
    const cached = await this.cacheGet<ApiKeyCacheEntry>(key);
    if (cached === 'negative') return null;
    if (cached) {
      entry = cached;
    } else {
      const { rows } = await this.pool.query<{
        id: string;
        project_id: string;
        scopes: ApiKeyScope[];
        expires_at: Date | null;
      }>(
        `SELECT id, project_id, scopes, expires_at FROM api_keys
         WHERE key_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
        [hash],
      );
      const k = rows[0];
      if (!k) {
        await this.cacheSet(key, 'negative', NEGATIVE_TTL_S);
        return null;
      }
      entry = { apiKeyId: k.id, projectId: k.project_id, scopes: k.scopes, expiresAt: k.expires_at?.getTime() ?? null };
      // Never cache past the key's own expiry.
      const ttl = entry.expiresAt
        ? Math.max(1, Math.min(AUTH_CACHE_TTL_S, Math.floor((entry.expiresAt - Date.now()) / 1000)))
        : AUTH_CACHE_TTL_S;
      await this.cacheSet(key, entry, ttl);
    }
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) return null;
    this.touchApiKey(entry.apiKeyId);
    return { kind: 'api_key', apiKeyId: entry.apiKeyId, projectId: entry.projectId, scopes: entry.scopes };
  }

  async me(userId: string): Promise<{ user: UserDto; memberships: MembershipDto[] }> {
    const [u, m] = await Promise.all([
      this.pool.query<{ id: string; email: string; name: string; created_at: Date }>(
        'SELECT id, email, name, created_at FROM users WHERE id = $1',
        [userId],
      ),
      this.pool.query<{ project_id: string; name: string; role: ProjectRole }>(
        `SELECT pm.project_id, p.name, pm.role FROM project_members pm JOIN projects p ON p.id = pm.project_id
         WHERE pm.user_id = $1 ORDER BY p.created_at`,
        [userId],
      ),
    ]);
    const user = u.rows[0];
    if (!user) throw new UnauthorizedError();
    return {
      user: { id: user.id, email: user.email, name: user.name, createdAt: user.created_at.toISOString() },
      memberships: m.rows.map((r) => ({ projectId: r.project_id, projectName: r.name, role: r.role })),
    };
  }

  /** Revoking every session of a user (e.g. after a password change). */
  async revokeAllSessions(userId: string): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<{ token_hash: Buffer }>(
        'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL RETURNING token_hash',
        [userId],
      );
      if (rows.length > 0) await this.redis.del(...rows.map((r) => this.sessionKey(r.token_hash)));
    });
  }

  apiKeyCacheKey(hash: Buffer): string {
    return `${this.opts.prefix}:auth:key:${hash.toString('hex')}`;
  }

  private sessionKey(hash: Buffer): string {
    return `${this.opts.prefix}:auth:sess:${hash.toString('hex')}`;
  }

  /** Records last use at most once a minute per key, off the request path. */
  private touchApiKey(id: string): void {
    const now = Date.now();
    const last = this.lastTouched.get(id) ?? 0;
    if (now - last < 60_000) return;
    this.lastTouched.set(id, now);
    if (this.lastTouched.size > 50_000) this.lastTouched.clear();
    this.pool.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [id]).catch((err: unknown) => {
      this.logger.warn({ err, apiKeyId: id }, 'failed to record API key last use');
    });
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= hashPassword(randomToken(16), this.opts.scryptLogN);
    return this.dummyHash;
  }

  private async cacheGet<T>(key: string): Promise<T | 'negative' | null> {
    try {
      const raw = await this.redis.get(key);
      if (raw === null) return null;
      if (raw === '-') return 'negative';
      return JSON.parse(raw) as T;
    } catch (err) {
      this.logger.warn({ err }, 'auth cache read failed; falling back to database');
      return null;
    }
  }

  private async cacheSet(key: string, value: object | 'negative', ttlS: number): Promise<void> {
    try {
      await this.redis.set(key, value === 'negative' ? '-' : JSON.stringify(value), 'EX', ttlS);
    } catch (err) {
      this.logger.warn({ err }, 'auth cache write failed');
    }
  }
}
