import pg from 'pg';
import { migrate } from '../../src/infra/db/migrate.js';
import { createLogger } from '../../src/lib/logger.js';
import { adminDatabaseUrl, TEMPLATE_DB } from '../helpers/env.js';

/** Builds a freshly migrated template database once per test run. Workers clone it. */
export default async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: adminDatabaseUrl() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  } finally {
    await admin.end();
  }
  const url = new URL(adminDatabaseUrl());
  url.pathname = `/${TEMPLATE_DB}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 1 });
  try {
    await migrate(pool, createLogger({ LOG_LEVEL: 'warn', LOG_PRETTY: false }, 'test-migrate'));
  } finally {
    await pool.end();
  }
}
