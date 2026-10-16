# Contributing to ScaleFlow

Thanks for your interest! ScaleFlow is a learning-oriented project, so clear reasoning matters as
much as working code.

## Development setup

```bash
cp .env.example .env
docker compose up -d postgres redis   # or any PostgreSQL 16+ and Redis 7+ on the default ports
npm ci
npm run db:migrate
npm run db:seed
npm run dev                           # api, worker, relay, scheduler, dashboard
```

Requirements: Node.js 24 (`.nvmrc`), npm 11.

## Before you open a pull request

```bash
npm run format        # Prettier
npm run lint          # strict type-checked ESLint
npm run typecheck
npm test              # unit + integration (real PostgreSQL + Redis)
npm run test:e2e      # if the dashboard or API contract changed
```

Integration tests create their own database per test file (cloned from a migrated template) and use
Redis DB 1 with a per-file key prefix, so they never touch your development data. Point them
elsewhere with `TEST_DATABASE_URL` and `TEST_REDIS_URL`.

## Project rules

- **State changes** go through the transition table in `apps/server/src/domain/job-state.ts` and are
  implemented as a conditional `UPDATE ... WHERE status = ...`. No read-then-write.
- **Anything that must reach the queue** is written to the `outbox` in the same transaction.
- **Every query** is scoped by `project_id` and backed by an index; say which one in the PR.
- **Migrations** are new files in `apps/server/migrations`; never edit an applied one (checksums are verified).
- **Business logic** lives in `src/modules` and `src/domain`, not in HTTP handlers.
- **Errors** are never swallowed: handle them, or log them with context and rethrow.
- **No `any`** without a comment explaining why.
- **Claims need evidence**: a behaviour change needs a test, a performance claim needs a k6 or
  `EXPLAIN ANALYZE` measurement in `docs/benchmarks.md`.
- **Docs** live next to the change: architecture decisions in `docs/architecture.md`, operational
  behaviour in `docs/operations.md`.

## Adding a job type

1. Create a handler implementing `JobHandler` (`apps/server/src/handlers/types.ts`) with a Zod
   payload schema, a default timeout, and an `execute` that honours `ctx.signal`.
2. Throw `PermanentJobError` for failures retrying cannot fix; anything else is retried.
3. Make it safe to run twice for the same job (use `ctx.jobId` as an idempotency key downstream).
4. Register it in `apps/server/src/handlers/registry.ts` and add tests.

## Commit messages and reviews

Small, focused commits with a message explaining _why_. Reviews look at correctness under
concurrency and failure first, then readability. Be kind; see the [Code of Conduct](CODE_OF_CONDUCT.md).
