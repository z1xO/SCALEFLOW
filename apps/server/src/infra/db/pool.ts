import pg from 'pg';
import type { Logger } from '../../lib/logger.js';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
/** Anything that can run a query: a pool (autocommit) or a client inside a transaction. */
export type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

export interface PoolOptions {
  connectionString: string;
  max: number;
  statementTimeoutMs: number;
  connectTimeoutMs: number;
  applicationName: string;
}

export function createPool(opts: PoolOptions, logger: Logger): pg.Pool {
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max,
    connectionTimeoutMillis: opts.connectTimeoutMs,
    idleTimeoutMillis: 30_000,
    // Server-side guards so a runaway query cannot hold a connection forever.
    statement_timeout: opts.statementTimeoutMs,
    idle_in_transaction_session_timeout: Math.max(opts.statementTimeoutMs * 2, 30_000),
    application_name: opts.applicationName,
  });
  // Errors on idle clients (e.g. the server restarted) would otherwise crash the process.
  pool.on('error', (err) => {
    logger.error({ err }, 'postgres idle client error');
  });
  return pool;
}

export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

/**
 * Runs `fn` inside a transaction on a dedicated client. Commits on success, rolls back on any
 * error and rethrows it. If ROLLBACK itself fails the connection is destroyed rather than returned
 * to the pool in an unknown state.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
  isolation: IsolationLevel = 'read committed',
): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation.toUpperCase()}`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      broken = true;
      throw new AggregateError([err, rollbackErr], 'transaction failed and rollback failed', { cause: rollbackErr });
    }
    throw err;
  } finally {
    client.release(broken);
  }
}

/** Postgres error codes we branch on. */
export const PgErrorCode = {
  UniqueViolation: '23505',
  ForeignKeyViolation: '23503',
  CheckViolation: '23514',
  SerializationFailure: '40001',
  DeadlockDetected: '40P01',
  QueryCanceled: '57014',
} as const;

export function pgErrorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string') {
    return err.code;
  }
  return undefined;
}
