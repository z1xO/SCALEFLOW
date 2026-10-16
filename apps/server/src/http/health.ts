import type pg from 'pg';
import type { Redis } from 'ioredis';
import { withTimeout } from '../lib/async.js';
import { errorMessage } from '../lib/errors.js';

export interface DependencyStatus {
  status: 'ok' | 'error';
  latencyMs: number;
  error?: string;
}

async function probe(fn: () => Promise<unknown>, timeoutMs: number, name: string): Promise<DependencyStatus> {
  const started = performance.now();
  try {
    await withTimeout(fn(), timeoutMs, `${name} health check`);
    return { status: 'ok', latencyMs: Math.round(performance.now() - started) };
  } catch (err) {
    return { status: 'error', latencyMs: Math.round(performance.now() - started), error: errorMessage(err) };
  }
}

/** Readiness: can this process do useful work right now? Each dependency check is time-boxed. */
export async function checkDependencies(
  pool: pg.Pool,
  redis: Redis,
  timeoutMs = 1_000,
): Promise<{ ok: boolean; checks: Record<string, DependencyStatus> }> {
  const [postgres, redisStatus] = await Promise.all([
    probe(() => pool.query('SELECT 1'), timeoutMs, 'postgres'),
    probe(() => redis.ping(), timeoutMs, 'redis'),
  ]);
  return {
    ok: postgres.status === 'ok' && redisStatus.status === 'ok',
    checks: { postgres, redis: redisStatus },
  };
}
