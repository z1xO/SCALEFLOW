import { loadConfig } from '../config/env.js';
import { createServices } from '../container.js';
import { loadDotEnv } from '../lib/dotenv.js';
import { migrate } from '../infra/db/migrate.js';

/**
 * Development seed. Idempotent: re-running it does not duplicate the user, project or schedule.
 *   - demo user (SEED_EMAIL / SEED_PASSWORD)
 *   - "Demo project" with an API key (printed once; pass --new-key to mint another)
 *   - a recurring schedule and a handful of sample jobs (succeeding, retrying, failing, delayed)
 * Never run this against production.
 */
loadDotEnv();
const config = loadConfig();
if (config.NODE_ENV === 'production') {
  console.error('Refusing to seed a production environment.');
  process.exit(1);
}
const services = createServices({ ...config, LOG_LEVEL: 'warn' }, 'seed');
const email = process.env.SEED_EMAIL ?? 'demo@scaleflow.dev';
const password = process.env.SEED_PASSWORD ?? 'scaleflow-demo-password';
const newKey = process.argv.includes('--new-key');

try {
  await migrate(services.pool, services.logger);
  const { rows: users } = await services.pool.query<{ id: string }>('SELECT id FROM users WHERE lower(email) = lower($1)', [email]);
  const userId = users[0]?.id ?? (await services.auth.register({ email, password, name: 'Demo User' })).id;
  const actor = { type: 'user' as const, id: userId };

  const projects = await services.projects.listForUser(userId);
  const project = projects.find((p) => p.name === 'Demo project') ?? (await services.projects.create(userId, { name: 'Demo project' }));

  const keys = await services.apiKeys.list(project.id);
  let secret: string | null = null;
  if (newKey || !keys.some((k) => k.name === 'seed' && !k.revokedAt)) {
    secret = (await services.apiKeys.create(project.id, { name: 'seed', scopes: ['jobs:read', 'jobs:write'] }, actor, userId)).secret;
  }

  const schedules = await services.schedules.list(project.id);
  if (!schedules.some((s) => s.name === 'heartbeat')) {
    await services.schedules.create(
      project.id,
      {
        name: 'heartbeat',
        cron: '*/5 * * * *',
        timezone: 'UTC',
        jobType: 'demo.echo',
        queue: 'default',
        payload: { message: 'scheduled heartbeat' },
        jobOptions: { maxAttempts: 3 },
        enabled: true,
      },
      actor,
    );
  }

  const { results } = await services.jobCommands.create(
    project.id,
    [
      ...Array.from({ length: 10 }, (_, i) => ({
        type: 'demo.sleep',
        queue: 'default',
        payload: { durationMs: 100 + i * 50 },
        maxAttempts: 3,
        idempotencyKey: `seed-sleep-${i}`,
      })),
      { type: 'demo.flaky', queue: 'default', payload: { succeedOnAttempt: 3 }, maxAttempts: 5, idempotencyKey: 'seed-flaky-recovers', backoff: { type: 'exponential' as const, baseDelayMs: 1000, maxDelayMs: 10000 } },
      { type: 'demo.flaky', queue: 'default', payload: { failureRate: 1, permanent: true }, maxAttempts: 3, idempotencyKey: 'seed-flaky-dead-letter' },
      { type: 'demo.echo', queue: 'critical', payload: { message: 'priority work' }, maxAttempts: 3, idempotencyKey: 'seed-echo-critical' },
      { type: 'demo.echo', queue: 'default', payload: { message: 'later' }, delayMs: 120_000, maxAttempts: 3, idempotencyKey: 'seed-delayed' },
    ],
    { actor, correlationId: 'seed' },
  );

  console.log('\nScaleFlow seed complete');
  console.log('  dashboard login :', email, '/', password);
  console.log('  project id      :', project.id);
  console.log('  sample jobs     :', results.filter((r) => r.created).length, 'created,', results.filter((r) => !r.created).length, 'already present');
  if (secret) {
    console.log('  API key         :', secret, '   <- shown once; store it now');
  } else {
    console.log('  API key         : a "seed" key already exists (secrets are not stored). Run with --new-key to mint one.');
  }
} finally {
  await services.close();
}
