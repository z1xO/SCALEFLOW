# Engineering report

Final report on building ScaleFlow v0.1: what was built, how it was verified, what was learned, and
what is not done. Dated 2026-10-16.

## Summary

ScaleFlow is a working distributed job platform: a Fastify API, horizontally scalable workers, an
outbox relay with a CQRS projector, and a scheduler, backed by PostgreSQL (source of truth) and Redis
(BullMQ delivery, cache, rate limits), with a live Next.js dashboard. Every acceptance criterion that
could be exercised without Docker or GitHub was exercised and passes; the rest are listed under
[Not verified](#not-verified).

## What was built

| Area       | Delivered                                                                                                                                                                                                |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data model | 15 tables, one forward-only migration with checksums; every index annotated with the query it serves; retention for all high-volume tables                                                               |
| Write path | Idempotent single and batch submission (`ON CONFLICT` on a unique index), conditional-UPDATE state machine, transactional outbox, backpressure, payload limits                                           |
| Delivery   | Outbox relay with leases and `SKIP LOCKED`, deterministic BullMQ ids, attempt-scoped claims, worker leases + reaper, dispatch reconciler for Redis data loss                                             |
| Execution  | Retries (exponential/fixed, jittered), permanent vs retryable errors, timeouts that cannot be ignored, graceful drain, dead-letter + replay, cron schedules with exactly-once ticks and a misfire policy |
| Read path  | Cursor pagination with UUIDv7 time ranges, versioned job cache, stampede-protected metrics cache, projected read model, replica routing with LSN read-your-writes                                        |
| Real time  | SSE hub per API process with a commit-ordered `(xid8, id)` cursor shared by live tail and replay, reset when too far behind, per-principal limits, graceful stream shutdown                              |
| Security   | scrypt passwords, hashed sessions and API keys, scopes, rotation/revocation, roles, 404-on-cross-tenant, CSRF origin check, SSRF-safe signed webhooks, log redaction, audit log                          |
| Operations | Health/readiness on every process, Prometheus metrics, Grafana dashboard, 10 alert rules with runbooks, repair CLI for the read model, Dockerfiles, compose stack                                        |
| Dashboard  | 9 pages, all wired to the real API, live updates with reconciliation, accessible status encoding, validated chart palette                                                                                |
| Quality    | Strict TypeScript (no `any`), type-checked ESLint, Prettier, CI workflow, Dependabot, templates                                                                                                          |

## Verification

| Check                                                   | Result                                                                                |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Lint, typecheck, format (both workspaces)               | Clean                                                                                 |
| Unit + integration tests (real PostgreSQL 17 + Redis 8) | 136 passing, stable over repeated runs, also from a clean clone                       |
| E2E (Playwright, real stack)                            | 7 journeys passing                                                                    |
| Clean clone                                             | `npm ci` → lint → typecheck → migrate (fresh DB) → seed → test → build: all succeeded |
| Production artifacts                                    | Compiled backend and Next.js standalone server run                                    |
| Multi-process crash recovery                            | Worker hard-killed mid-job; recovered by the reaper and completed on another worker   |
| Dependency audit                                        | 0 known vulnerabilities in production dependencies                                    |
| Load tests                                              | Measured; see [benchmarks.md](benchmarks.md)                                          |

Integration tests cover the hard cases deliberately: 50-way idempotency races, 200 concurrent
submissions, 40 cancel-vs-claim races, transaction rollback, duplicate and stale deliveries, zombie
workers, crash recovery, lease renewal, graceful shutdown, Redis outages during publish, Redis data
loss, scheduler races and downtime, the event-log watermark under an open transaction, projection
idempotency and repair, cache races and stampedes, cross-tenant access through every route, SSE
authorization, resume and reset.

## Measured performance (one laptop, everything co-located)

- One API process: ~1,000 submissions/s at p95 21 ms; collapses at 1,200/s (CPU-bound). Two processes: 1,568/s at p95 36 ms.
- Reads at 1,500 req/s: job detail p95 2.1 ms with cache, 3.7-6.7 ms without; p99 2-6× better with cache.
- Indexes: dead-letter view 0.04 ms vs 52 ms without its index; keyset page 120× faster than OFFSET.
- Workers: ~550 jobs/s ceiling for short I/O-bound jobs regardless of slot count (per-job DB overhead);
  CPU-bound jobs gain nothing from concurrency, only from processes.

## What the tests caught

1. **Lexical event ordering.** `SELECT id::text ... ORDER BY id` sorted by the text alias, so event
   10 came before 9. It would have scrambled timelines and broken the real-time cursor. Fixed by
   qualifying columns; a regression test checks numeric ordering.
2. **Lease renewal slower than short leases.** A 500 ms floor on the renewal interval let healthy
   workers lose leases shorter than that.
3. **Cluster-wide watermark.** Transactions in _other databases_ on the same PostgreSQL server hold
   back the event watermark. Correct behaviour, but it made two tests flaky and is now documented as an
   operational requirement (own cluster, alert on projection lag).
4. **Recording vs handler failure.** A database error while recording a success would have been
   misclassified as a job failure; the executor now separates the two (the lease reaper covers it).
5. **SSE vs shutdown.** Hijacked SSE connections would have blocked graceful API shutdown; streams are
   now closed in `preClose`.

## Notable trade-offs

- PostgreSQL holds all job state and timing; BullMQ is used only for delivery. Costs more database
  writes per job (the measured worker ceiling) in exchange for durability and a single source of truth.
- Real-time events are tailed from the database rather than pushed through Redis pub/sub, so live
  delivery and replay share one commit-ordered sequence and resume is exact.
- Rate limiting fails open when Redis is down: availability over strict limits.
- `eslint-config-next` is not used because its React/a11y plugins do not support ESLint 10 yet;
  accessibility is covered by role-based E2E selectors instead of jsx-a11y.

## Not verified

- Docker images and `docker-compose.yml` were not built or run (no Docker on the machine).
- The GitHub Actions workflow has not run on GitHub.
- Prometheus and Grafana were not run with these configs.
- Read-replica routing was not run against a real replica.

## Recommended next steps

1. Push to GitHub, let CI run, fix anything Linux-specific (Docker builds, native optional dependencies).
2. `docker compose up -d --build` and confirm Grafana panels and alert rules evaluate.
3. Batch claims in workers to lift the ~550 jobs/s ceiling; separate cache/rate-limit Redis from queue Redis.
4. Time-partition `jobs` and `job_events`.
5. Per-project webhook secrets, SSO/MFA, email verification before any external users.
