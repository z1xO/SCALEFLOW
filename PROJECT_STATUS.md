# Project status

Living record of what is done, what is verified, and what is next. Updated at the end of each phase.

## Environment used for development

- Windows 11, AMD Ryzen 7 6800H (8C/16T), 31 GB RAM.
- No Docker available on the development machine. Integration tests run against **native**
  PostgreSQL 17.11 and Redis 8.10.2 (Windows build) on the default ports; the Docker Compose files
  are provided for everyone else but were **not executed** during development (see Phase 8 notes).
- Node.js 24.21.0, npm 11.19.0.

## Phases

| Phase | Status |
| ----- | ------ |
| 1. Architecture and repository foundation | done |
| 2. Durable backend | in progress |
| 3. Background processing | pending |
| 4. Real-time events | pending |
| 5. Dashboard | pending |
| 6. Reliability and observability | pending |
| 7. Testing and performance | pending |
| 8. Release readiness | pending |

## Phase 1 — verified

- `npm install` succeeds with exact pinned versions.
- `npm run db:migrate` applies `0001_initial_schema.sql`; a second run is a no-op (checksum tracked).
