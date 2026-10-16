import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const csv = z
  .string()
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: bool.default(false),
  SERVICE_VERSION: z.string().default('0.1.0'),

  DATABASE_URL: z.url(),
  /** Optional read replica. When unset, the read pool points at the primary. */
  DATABASE_READ_URL: z.url().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
  DATABASE_READ_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),
  DATABASE_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).default(5_000),

  REDIS_URL: z.url(),
  REDIS_KEY_PREFIX: z.string().default('sf'),
  REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(50).default(2_000),

  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).default(1_048_576),
  /** Origins allowed for CORS and for cookie-authenticated state-changing requests (CSRF check). */
  CORS_ORIGINS: csv.default(['http://localhost:3000']),
  TRUST_PROXY: bool.default(false),
  PUBLIC_API_URL: z.url().default('http://localhost:4000'),

  COOKIE_SECURE: bool.default(false),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 90).default(24 * 7),
  ALLOW_REGISTRATION: bool.default(true),
  /** log2(N) for scrypt. 17 follows OWASP guidance; tests lower it for speed. */
  PASSWORD_SCRYPT_LOG_N: z.coerce.number().int().min(10).max(20).default(17),
  /** If set, GET /metrics requires `Authorization: Bearer <token>`. */
  METRICS_TOKEN: z.string().min(16).optional(),

  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(600),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(20),
  /** Backpressure: reject submissions when a project has this many non-terminal jobs. */
  MAX_ACTIVE_JOBS_PER_PROJECT: z.coerce.number().int().min(1).default(100_000),
  /** Backpressure: reject submissions when the outbox backlog exceeds this many rows. */
  MAX_OUTBOX_BACKLOG: z.coerce.number().int().min(1).default(50_000),
  MAX_PAYLOAD_BYTES: z.coerce.number().int().min(256).default(64 * 1024),

  QUEUES: csv.default(['default', 'critical', 'bulk']),
  WORKER_QUEUES: csv.default(['default', 'critical', 'bulk']),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(1000).default(10),
  WORKER_LEASE_MS: z.coerce.number().int().min(1000).default(30_000),
  WORKER_SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).default(25_000),
  WORKER_HEARTBEAT_MS: z.coerce.number().int().min(500).default(5_000),

  WORKER_METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(9465),
  RELAY_METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(9466),
  SCHEDULER_METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(9467),

  RELAY_POLL_MS: z.coerce.number().int().min(10).default(200),
  RELAY_BATCH_SIZE: z.coerce.number().int().min(1).max(5000).default(200),
  PROJECTOR_POLL_MS: z.coerce.number().int().min(10).default(500),
  SSE_POLL_MS: z.coerce.number().int().min(10).default(250),
  SSE_REPLAY_MAX_EVENTS: z.coerce.number().int().min(1).default(1000),
  SSE_HEARTBEAT_MS: z.coerce.number().int().min(1000).default(15_000),
  SCHEDULER_PROMOTE_MS: z.coerce.number().int().min(10).default(500),
  RECONCILER_QUEUED_THRESHOLD_MS: z.coerce.number().int().min(1000).default(120_000),

  WEBHOOK_ALLOW_PRIVATE_NETWORKS: bool.default(false),
  WEBHOOK_SIGNING_SECRET: z.string().min(16).default('dev-only-webhook-signing-secret'),

  RETENTION_JOBS_DAYS: z.coerce.number().int().min(1).default(30),
  RETENTION_EVENTS_DAYS: z.coerce.number().int().min(1).default(14),
  RETENTION_OUTBOX_HOURS: z.coerce.number().int().min(1).default(24),
  RETENTION_STATS_DAYS: z.coerce.number().int().min(1).default(90),
  RETENTION_AUDIT_DAYS: z.coerce.number().int().min(1).default(365),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const config = parsed.data;
  if (config.NODE_ENV === 'production') {
    if (config.WEBHOOK_SIGNING_SECRET === 'dev-only-webhook-signing-secret') {
      throw new Error('WEBHOOK_SIGNING_SECRET must be set in production');
    }
    if (!config.COOKIE_SECURE) {
      throw new Error('COOKIE_SECURE must be true in production');
    }
  }
  return config;
}
