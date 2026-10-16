# Project status

## Environment used for development

Windows 11, Ryzen 7 6800H, 31 GB RAM. No Docker: integration/E2E/load tests ran against native
PostgreSQL 17.11 and Redis 8.10.2. Node.js 24.21.0.

## Phases

| Phase | Status |
| --- | --- |
| 1-7 | done |
| 8. Release readiness | partly done (see below) |

## Verified (commands actually run)

- `npm run lint`, `npm run typecheck`, `npm run format:check` - clean (both workspaces).
- Server tests: 136 (unit + integration, real PostgreSQL/Redis), green on repeated runs.
- E2E: 7 Playwright journeys green on two consecutive runs.
- `npm audit --omit=dev --audit-level=high`: 0 vulnerabilities.
- Compiled `dist/` processes and the Next.js standalone server run.
- Multi-process crash recovery (worker killed mid-job → recovered by the lease reaper).
- Load tests: see docs/benchmarks.md (all measured).

## Not verified

- Docker images / docker-compose (not built), GitHub Actions (not run), Prometheus/Grafana configs
  (not loaded into running instances), read replica routing against a real replica.
- Tests were not re-run after the final Prettier formatting pass (formatting only).

## Remaining tasks (next steps)

1. Re-run `npm test` and `npm run test:e2e` after the formatting commit.
2. Write CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md (referenced by docs/templates).
3. Replace `OWNER` in `.github/ISSUE_TEMPLATE/config.yml` with the GitHub org/user.
4. Push to GitHub and confirm CI passes (fix any Linux-only issues, e.g. Docker builds).
5. Optionally run Prometheus/Grafana (`docker compose up prometheus grafana`) to validate configs.
6. Final engineering report (docs/engineering-report.md).
