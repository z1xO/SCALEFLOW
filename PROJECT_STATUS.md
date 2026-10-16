# Project status

Living record of what is done, what is verified, and what is next. Updated at the end of each phase.

## Environment used for development

- Windows 11, AMD Ryzen 7 6800H (8C/16T), 31 GB RAM.
- No Docker available on the development machine. Integration tests run against **native**
  PostgreSQL 17.11 and Redis 8.10.2 (Windows build) on the default ports; the Docker Compose files
  are provided for everyone else but were **not executed** during development.
- Node.js 24.21.0, npm 11.19.0.

## Phases

| Phase | Status |
| ----- | ------ |
| 1. Architecture and repository foundation | done |
| 2. Durable backend | done |
| 3. Background processing | done |
| 4. Real-time events | done |
| 5. Dashboard | in progress |
| 6. Reliability and observability | pending |
| 7. Testing and performance | pending |
| 8. Release readiness | pending |

## Verified so far (commands actually run)

- `npm run typecheck`, `npm run lint` (strict type-checked ESLint) - clean for `apps/server`.
- `npm test -w @scaleflow/server` - 136 tests (unit + integration against real PostgreSQL/Redis), passing
  on two consecutive runs.
- Multi-process run (api, worker, relay, scheduler as separate OS processes): seed jobs processed;
  a worker hard-killed mid-job was recovered by the lease reaper ~30 s later and the job completed on
  a new worker (attempt 1 recorded as `lost`, attempt 2 `succeeded`).

## Bugs found by the tests (fixed)

- `ORDER BY id` on a `SELECT id::text ...` sorted lexically (output alias shadows the column), which
  would have broken event ordering and the real-time cursor. Fixed by qualifying columns.
- Lease renewal interval had a 500 ms floor, longer than short leases; short leases expired while healthy.
- Event-log watermark is cluster-wide (other databases' transactions hold it back) - documented.

## Next steps

1. Phase 5: Next.js dashboard against the real API.
2. Phase 6: Prometheus/Grafana provisioning, alert rules, Dockerfiles, docker-compose.
3. Phase 7: E2E (Playwright), k6 load tests with measured results.
4. Phase 8: README, docs, CI, community files.
