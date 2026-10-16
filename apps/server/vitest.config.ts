import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          sequence: { groupOrder: 0 },
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          sequence: { groupOrder: 1 },
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          // Real PostgreSQL + Redis. Each Vitest worker gets its own database (cloned from a
          // migrated template) and its own Redis key prefix, so files can run in parallel.
          globalSetup: ['test/integration/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
          maxWorkers: 4,
        },
      },
    ],
  },
});
