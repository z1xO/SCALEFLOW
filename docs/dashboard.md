# Dashboard

A Next.js (App Router) client application in `apps/dashboard`. Every page talks to the real API
with `fetch(..., { credentials: 'include' })`; there is no mock data anywhere.

| Page                        | What it does                                                                                                                                            | API                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `/login`                    | Sign in / create account                                                                                                                                | `POST /v1/auth/login`, `/register`           |
| `/projects`                 | List and create projects                                                                                                                                | `GET/POST /v1/projects`                      |
| `/projects/:id`             | Overview: success rate, submitted, active jobs, execution and queue-wait percentiles, throughput chart (with table view), queue health, live event feed | `/metrics`, `/system/queues`, `/events`, SSE |
| `/projects/:id/jobs`        | Filterable job table (status/type/queue in the URL), cursor "load more", inline retry/cancel, live updates. `?status=failed` is the dead-letter view    | `/jobs`, `/retry`, `/cancel`                 |
| `/projects/:id/jobs/:jobId` | Status, payload, result, last error, attempt history with errors, state timeline, retry/cancel                                                          | `/jobs/:id`, `/attempts`, `/events`          |
| `/projects/:id/jobs/new`    | Submission form with per-type payload templates, delay, retries/backoff, timeout, idempotency key; shows server validation issues                       | `POST /jobs`, `/job-types`                   |
| `/projects/:id/schedules`   | Create, pause/resume, run now, delete cron schedules                                                                                                    | `/schedules`                                 |
| `/projects/:id/system`      | Workers (heartbeat, utilization) and queue depth                                                                                                        | `/system/workers`, `/system/queues`          |
| `/projects/:id/settings`    | API keys (create - secret shown once - rotate, revoke) and members                                                                                      | `/api-keys`, `/members`                      |

**State handling.** TanStack Query owns server state. Every page has loading (skeletons), empty,
error (with request id and retry) states; the sidebar shows the live-connection state (Connecting,
Live, Reconnecting, Offline).

**Real time.** `src/lib/stream.tsx` keeps one `EventSource` per open project. Job events invalidate
the affected queries (throttled to one refresh per 400 ms); after a reconnect or a `reset` event it
invalidates everything for the project, so the UI re-reads state from the API rather than trusting
that it saw every event.

**Charts.** The throughput chart uses four categorical colors in a fixed order (blue, orange, aqua,
yellow), validated for color-vision deficiency in light and dark mode. Light-mode aqua and yellow are
below 3:1 contrast against the surface, so the chart has a "Show as table" view and a legend;
identity is never carried by color alone. Status badges pair a color with a glyph and a label.
Single numbers (success rate, percentiles) are stat tiles, not charts.

**Accessibility.** Labelled form controls, `aria-live` for the connection status and the event
feed, visible focus rings, native `<dialog>` for the key secret, `prefers-color-scheme` dark mode,
responsive down to phone width (tables scroll inside their container). The E2E tests select
elements by role and accessible name, which fails if labels are missing. There is no automated
axe/jsx-a11y check (see the ESLint note in `apps/dashboard/eslint.config.js`).

**Configuration.** `NEXT_PUBLIC_API_URL` (build time). The API must list the dashboard origin in
`CORS_ORIGINS`.
