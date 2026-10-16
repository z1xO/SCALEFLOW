import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { sha256Hex } from '../../lib/crypto.js';
import type { Logger } from '../../lib/logger.js';

/** apps/server/migrations, both from src/ (tsx) and dist/ (compiled). */
export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../migrations');

// Arbitrary constant: serialises concurrent migration runs (e.g. several containers starting at once).
const MIGRATION_LOCK_KEY = 727_301_001;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Minimal forward-only migration runner: plain SQL files applied in lexical order, each in its
 * own transaction, recorded with a checksum. Editing an applied migration is an error - write a
 * new one instead.
 */
export async function migrate(pool: pg.Pool, logger: Logger, dir = MIGRATIONS_DIR): Promise<MigrationResult> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations',
    );
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));

    for (const file of files) {
      const sql = await readFile(path.join(dir, file), 'utf8');
      const checksum = sha256Hex(sql.replace(/\r\n/g, '\n'));
      const existing = applied.get(file);
      if (existing !== undefined) {
        if (existing !== checksum) {
          throw new Error(`Migration ${file} was modified after being applied (checksum mismatch)`);
        }
        result.skipped.push(file);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`, {
          cause: err,
        });
      }
      logger.info({ migration: file }, 'migration applied');
      result.applied.push(file);
    }
    return result;
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    } finally {
      client.release();
    }
  }
}
