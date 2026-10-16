/**
 * Integration tests need a PostgreSQL server (any database; we create our own) and Redis.
 * Defaults match docker-compose.yml; CI sets these explicitly.
 */
export function adminDatabaseUrl(): string {
  return process.env.TEST_DATABASE_URL ?? 'postgres://scaleflow:scaleflow@localhost:5432/postgres';
}

export function testRedisUrl(): string {
  return process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1';
}

export const TEMPLATE_DB = 'scaleflow_test_template';

export function workerId(): string {
  return process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '1';
}
