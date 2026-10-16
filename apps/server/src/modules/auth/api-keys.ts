import type pg from 'pg';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { withTransaction } from '../../infra/db/pool.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { uuidv7 } from '../../lib/uuid.js';
import type { Actor } from '../jobs/model.js';
import { writeAudit } from '../jobs/write-helpers.js';
import { API_KEY_SCOPES, type ApiKeyScope } from './principal.js';

export const CreateApiKeySchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).default(['jobs:read', 'jobs:write']),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});

export const RotateApiKeySchema = z.object({
  /** How long the old key keeps working after rotation. 0 revokes it immediately. */
  gracePeriodSeconds: z
    .number()
    .int()
    .min(0)
    .max(7 * 24 * 3600)
    .default(3600),
});

export interface ApiKeyDto {
  id: string;
  projectId: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  rotatedFrom: string | null;
}

interface ApiKeyRow {
  id: string;
  project_id: string;
  name: string;
  key_prefix: string;
  key_hash: Buffer;
  scopes: ApiKeyScope[];
  created_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  last_used_at: Date | null;
  rotated_from: string | null;
}

function toDto(r: ApiKeyRow): ApiKeyDto {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    prefix: r.key_prefix,
    scopes: r.scopes,
    createdAt: r.created_at.toISOString(),
    expiresAt: r.expires_at?.toISOString() ?? null,
    revokedAt: r.revoked_at?.toISOString() ?? null,
    lastUsedAt: r.last_used_at?.toISOString() ?? null,
    rotatedFrom: r.rotated_from,
  };
}

/** Generates `sf_<43 chars base64url>` = 256 bits of entropy. Only its SHA-256 is stored. */
export function generateApiKey(): { secret: string; prefix: string; hash: Buffer } {
  const secret = `sf_${randomToken(32)}`;
  return { secret, prefix: secret.slice(0, 11), hash: sha256(secret) };
}

export class ApiKeyService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly redis: Redis,
    private readonly cacheKey: (hash: Buffer) => string,
  ) {}

  async list(projectId: string): Promise<ApiKeyDto[]> {
    const { rows } = await this.pool.query<ApiKeyRow>(
      'SELECT * FROM api_keys WHERE project_id = $1 ORDER BY created_at DESC',
      [projectId],
    );
    return rows.map(toDto);
  }

  /** The plaintext `secret` is returned exactly once, here. */
  async create(
    projectId: string,
    input: z.infer<typeof CreateApiKeySchema>,
    actor: Actor,
    createdBy: string | null,
  ): Promise<{ apiKey: ApiKeyDto; secret: string }> {
    const key = generateApiKey();
    const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null;
    const row = await withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<ApiKeyRow>(
        `INSERT INTO api_keys (id, project_id, name, key_prefix, key_hash, scopes, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [uuidv7(), projectId, input.name, key.prefix, key.hash, input.scopes, createdBy, expiresAt],
      );
      const r = rows[0] as ApiKeyRow;
      await writeAudit(client, {
        projectId,
        actor,
        action: 'api_key.created',
        targetType: 'api_key',
        targetId: r.id,
        metadata: { name: r.name, scopes: r.scopes },
      });
      return r;
    });
    return { apiKey: toDto(row), secret: key.secret };
  }

  async revoke(projectId: string, keyId: string, actor: Actor): Promise<ApiKeyDto> {
    const row = await withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<ApiKeyRow>(
        `UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now())
         WHERE id = $1 AND project_id = $2 RETURNING *`,
        [keyId, projectId],
      );
      const r = rows[0];
      if (!r) throw new NotFoundError('API key');
      await writeAudit(client, {
        projectId,
        actor,
        action: 'api_key.revoked',
        targetType: 'api_key',
        targetId: keyId,
      });
      return r;
    });
    // Effective immediately: the auth cache entry is removed after commit.
    await this.redis.del(this.cacheKey(row.key_hash));
    return toDto(row);
  }

  /**
   * Issues a replacement key with the same name and scopes. The old key keeps working until
   * `now + gracePeriodSeconds` so clients can be redeployed without downtime.
   */
  async rotate(
    projectId: string,
    keyId: string,
    input: z.infer<typeof RotateApiKeySchema>,
    actor: Actor,
    createdBy: string | null,
  ): Promise<{ apiKey: ApiKeyDto; secret: string; previous: ApiKeyDto }> {
    const key = generateApiKey();
    const result = await withTransaction(this.pool, async (client) => {
      const { rows: oldRows } = await client.query<ApiKeyRow>(
        'SELECT * FROM api_keys WHERE id = $1 AND project_id = $2 FOR UPDATE',
        [keyId, projectId],
      );
      const old = oldRows[0];
      if (!old) throw new NotFoundError('API key');
      if (old.revoked_at) throw new ConflictError('api_key_revoked', 'A revoked key cannot be rotated');
      const graceEnd = new Date(Date.now() + input.gracePeriodSeconds * 1000);
      const newExpiry = old.expires_at && old.expires_at < graceEnd ? old.expires_at : graceEnd;
      const { rows: prevRows } = await client.query<ApiKeyRow>(
        input.gracePeriodSeconds === 0
          ? 'UPDATE api_keys SET revoked_at = now() WHERE id = $1 RETURNING *'
          : 'UPDATE api_keys SET expires_at = $2 WHERE id = $1 RETURNING *',
        input.gracePeriodSeconds === 0 ? [keyId] : [keyId, newExpiry],
      );
      const { rows } = await client.query<ApiKeyRow>(
        `INSERT INTO api_keys (id, project_id, name, key_prefix, key_hash, scopes, created_by, rotated_from)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [uuidv7(), projectId, old.name, key.prefix, key.hash, old.scopes, createdBy, old.id],
      );
      const created = rows[0] as ApiKeyRow;
      await writeAudit(client, {
        projectId,
        actor,
        action: 'api_key.rotated',
        targetType: 'api_key',
        targetId: keyId,
        metadata: { newKeyId: created.id, gracePeriodSeconds: input.gracePeriodSeconds },
      });
      return { created, previous: prevRows[0] as ApiKeyRow };
    });
    await this.redis.del(this.cacheKey(result.previous.key_hash));
    return { apiKey: toDto(result.created), secret: key.secret, previous: toDto(result.previous) };
  }
}
