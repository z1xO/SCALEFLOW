import pg from 'pg';
import { loadDotEnv } from '../lib/dotenv.js';
import { createLogger } from '../lib/logger.js';
import { migrate } from '../infra/db/migrate.js';

loadDotEnv();
const logger = createLogger({ LOG_LEVEL: 'info', LOG_PRETTY: false }, 'migrate');
const url = process.env.DATABASE_URL;
if (!url) {
  logger.fatal('DATABASE_URL is not set');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 1, application_name: 'scaleflow-migrate' });
try {
  const result = await migrate(pool, logger);
  logger.info({ applied: result.applied.length, alreadyApplied: result.skipped.length }, 'migrations complete');
} catch (err) {
  logger.fatal({ err }, 'migration failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
