import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { loadConfig, type Config } from '../../src/config/env.js';
import { createServices, type Services } from '../../src/container.js';
import { buildApp, type AppOptions } from '../../src/http/app.js';
import { SESSION_COOKIE } from '../../src/http/auth.js';
import { randomToken } from '../../src/lib/crypto.js';
import type { ApiKeyScope } from '../../src/modules/auth/principal.js';
import { adminDatabaseUrl, TEMPLATE_DB, testRedisUrl, workerId } from './env.js';

export const ORIGIN = 'http://localhost:3000';

/**
 * Gives a test file its own database (cloned from the migrated template - fast, and fully
 * isolated from other files running in parallel) and its own Redis key prefix.
 */
export async function createTestDatabase(): Promise<string> {
  const name = `scaleflow_test_w${workerId()}_${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
  const admin = new pg.Client({ connectionString: adminDatabaseUrl() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`);
  } finally {
    await admin.end();
  }
  const url = new URL(adminDatabaseUrl());
  url.pathname = `/${name}`;
  return url.toString();
}

export async function dropTestDatabase(url: string): Promise<void> {
  const name = new URL(url).pathname.slice(1);
  const admin = new pg.Client({ connectionString: adminDatabaseUrl() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

export function testConfig(databaseUrl: string, overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
    DATABASE_URL: databaseUrl,
    DATABASE_POOL_MAX: '10',
    REDIS_URL: testRedisUrl(),
    REDIS_KEY_PREFIX: `sft${workerId()}${randomToken(4).replace(/[^A-Za-z0-9]/g, 'x')}`,
    PASSWORD_SCRYPT_LOG_N: '12',
    CORS_ORIGINS: ORIGIN,
    WEBHOOK_ALLOW_PRIVATE_NETWORKS: 'true',
    RATE_LIMIT_MAX: '100000',
    AUTH_RATE_LIMIT_MAX: '100000',
    ...overrides,
  });
}

export interface TestContext {
  databaseUrl: string;
  services: Services;
  app: FastifyInstance;
  close(): Promise<void>;
}

export async function createTestContext(
  opts: { env?: Record<string, string>; app?: AppOptions; service?: string } = {},
): Promise<TestContext> {
  const databaseUrl = await createTestDatabase();
  const services = createServices(testConfig(databaseUrl, opts.env), opts.service ?? 'test');
  const app = await buildApp(services, opts.app);
  await app.ready();
  return {
    databaseUrl,
    services,
    app,
    async close() {
      await app.close();
      await deleteRedisPrefix(services);
      await services.close();
      await dropTestDatabase(databaseUrl);
    },
  };
}

async function deleteRedisPrefix(services: Services): Promise<void> {
  const prefix = services.config.REDIS_KEY_PREFIX;
  let cursor = '0';
  do {
    const [next, keys] = await services.redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 1000);
    cursor = next;
    if (keys.length > 0) await services.redis.del(...keys);
  } while (cursor !== '0');
}

// ----------------------------------------------------------------------------- fixtures

export interface TestUser {
  id: string;
  email: string;
  cookie: string;
}

export async function createUser(services: Services, name = 'Test User'): Promise<TestUser> {
  const email = `${randomToken(6).replace(/[^A-Za-z0-9]/g, 'x').toLowerCase()}@example.test`;
  const password = 'correct-horse-battery-staple';
  const user = await services.auth.register({ email, password, name });
  const { token } = await services.auth.login({ email, password }, {});
  return { id: user.id, email, cookie: `${SESSION_COOKIE}=${token}` };
}

export async function createProject(services: Services, user: TestUser, name = 'Test project'): Promise<string> {
  const project = await services.projects.create(user.id, { name });
  return project.id;
}

export async function createApiKey(
  services: Services,
  projectId: string,
  user: TestUser,
  scopes: ApiKeyScope[] = ['jobs:read', 'jobs:write'],
): Promise<string> {
  const { secret } = await services.apiKeys.create(
    projectId,
    { name: 'test key', scopes },
    { type: 'user', id: user.id },
    user.id,
  );
  return secret;
}

/** Sets up one user with one project and one API key. */
export async function createTenant(services: Services): Promise<{ user: TestUser; projectId: string; apiKey: string }> {
  const user = await createUser(services);
  const projectId = await createProject(services, user);
  const apiKey = await createApiKey(services, projectId, user);
  return { user, projectId, apiKey };
}

export function asKey(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}` };
}

export function asUser(user: TestUser): Record<string, string> {
  return { cookie: user.cookie, origin: ORIGIN };
}

export async function inject(app: FastifyInstance, opts: InjectOptions): Promise<LightMyRequestResponse> {
  return app.inject(opts);
}
