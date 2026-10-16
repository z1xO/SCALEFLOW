# Operations guide

How to observe ScaleFlow, what happens when things break, and what to do about it.

- [Signals](#signals)
- [Failure scenarios](#failure-scenarios)
- [Runbooks](#runbooks)
- [Single points of failure](#single-points-of-failure)
- [Recovery procedures](#recovery-procedures)

## Signals

| Where                                                                                | What                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz` (api), `:9465/healthz` (worker), `:9466` (relay), `:9467` (scheduler) | Liveness - the process is running. Restart if it fails.                                                                                                                                               |
| `GET /readyz` on the same ports                                                      | Readiness - PostgreSQL and Redis answer within 1 s. Returns 503 while shutting down so load balancers drain the instance first.                                                                       |
| `GET /metrics` (same ports)                                                          | Prometheus metrics, all prefixed `scaleflow_`. Protect with `METRICS_TOKEN` outside a private network.                                                                                                |
| Logs                                                                                 | One JSON object per line (pino). Every API request logs `requestId`; jobs carry `correlationId` = the request id that created them, and worker log lines include `jobId`, `attempt`, `correlationId`. |
| Grafana                                                                              | `ScaleFlow` dashboard (provisioned from `infra/grafana/dashboards/scaleflow.json`).                                                                                                                   |
| Alerts                                                                               | `infra/prometheus/alerts.yml`; each alert names a runbook section below.                                                                                                                              |

Gauges that describe the whole system (queue depth, outbox backlog, oldest queued job, workers
online) are computed by the scheduler and the relay; other processes export them as 0. Aggregate
them with `max()`, as the dashboard and alerts do.

**Following one job across processes:**

```bash
# 1. the API response carries x-request-id; the job stores it as correlationId
curl -s -H "Authorization: Bearer $KEY" $API/v1/projects/$PROJECT/jobs/$JOB | jq .job.correlationId
# 2. grep every process's logs for it (docker compose)
docker compose logs api worker relay scheduler | grep "$CORRELATION_ID"
# 3. or read the durable timeline
curl -s -H "Authorization: Bearer $KEY" $API/v1/projects/$PROJECT/jobs/$JOB/events | jq '.items[] | {type, data, createdAt}'
```

## Failure scenarios

What the system does on its own, measured or tested where noted.

| Scenario                                                                 | Behaviour                                                                                                                                                                                                                                                                                                              | Data loss?                                         | Evidence                                                                         |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------- |
| Worker crashes mid-job (OOM, `kill -9`, node failure)                    | Lease stops being renewed; the scheduler's reaper marks the attempt `lost` after `WORKER_LEASE_MS` (30 s) and schedules a retry (or dead-letters if attempts are exhausted). The handler may have partially run: side effects can repeat.                                                                              | No                                                 | `worker.test.ts` "worker crash recovery"; multi-process run in PROJECT_STATUS.md |
| Worker receives SIGTERM                                                  | Marks itself `draining`, stops taking deliveries, waits up to `WORKER_SHUTDOWN_GRACE_MS` for running jobs, then aborts the rest as retryable `worker_shutdown` failures.                                                                                                                                               | No                                                 | `worker.test.ts` "graceful shutdown"                                             |
| Duplicate delivery from BullMQ (stalled-job redelivery, relay republish) | The second claim matches zero rows; the delivery is acknowledged and skipped (`scaleflow_duplicate_deliveries_total`).                                                                                                                                                                                                 | No duplicates executed for the same attempt        | `worker.test.ts` "delivery guarantees"                                           |
| A "zombie" worker finishes after its lease was recovered                 | Its result is discarded (`scaleflow_stale_completions_total`); the newer attempt's result wins.                                                                                                                                                                                                                        | No                                                 | `worker.test.ts`                                                                 |
| API crashes between committing a job and anything else                   | Nothing else was needed: job, event and outbox row committed atomically. The client may not have received the response; it retries with the same `Idempotency-Key` and gets the original job.                                                                                                                          | No                                                 | `jobs-api.test.ts` idempotency + rollback                                        |
| Relay crashes after publishing, before marking rows published            | Rows are re-published after the lease (30 s); BullMQ ignores the duplicate job id and the claim guards execution.                                                                                                                                                                                                      | No                                                 | `outbox.test.ts`                                                                 |
| Redis unavailable                                                        | Job submission still succeeds (outbox only needs PostgreSQL). The relay retries publishing with backoff (`scaleflow_outbox_publish_failures_total`, growing backlog). Rate limiting fails open (`skipOnError`), caches fall back to the database. Workers stop receiving work. When Redis returns, the backlog drains. | No                                                 | `outbox.test.ts` "Redis is unreachable"                                          |
| Redis loses data (no AOF, failover, `FLUSHALL`)                          | Queued jobs have no queue entry. The dispatch reconciler (every 30 s) finds jobs queued for more than 2 minutes with no live BullMQ entry and re-dispatches them through the outbox.                                                                                                                                   | No (delayed by up to ~2.5 min)                     | `background.test.ts` "dispatch reconciler"                                       |
| PostgreSQL unavailable                                                   | API returns 500/503 for anything touching state, `/readyz` fails. Workers cannot claim or record: running jobs keep running, their results fail to record, the leases expire, and they are retried once PostgreSQL is back (side effects may repeat).                                                                  | Nothing committed is lost; in-flight requests fail | - (by construction)                                                              |
| Scheduler down                                                           | Delayed jobs and retries are not promoted, leases are not recovered, cron does not fire. Nothing is lost: on restart, due jobs are promoted, and each schedule fires **once** for its missed ticks.                                                                                                                    | No                                                 | `background.test.ts` "recovers after downtime"                                   |
| Projector (relay) down                                                   | Dashboard counts and charts freeze; job lists, details and the API keep working (they read `jobs`). On restart the projector resumes from its checkpoint.                                                                                                                                                              | No                                                 | `background.test.ts` projection tests                                            |
| Browser loses its SSE connection                                         | It reconnects and resumes from `Last-Event-ID`; if it was away for more than `SSE_REPLAY_MAX_EVENTS`, it gets `reset` and re-fetches. The dashboard always re-fetches state after a reconnect.                                                                                                                         | No                                                 | `realtime.test.ts`                                                               |
| A tenant floods submissions                                              | Rate limit per key (429) and per-project active-job quota (429 `project_queue_full`).                                                                                                                                                                                                                                  | No                                                 | `limits.test.ts`                                                                 |
| Relay or Redis cannot keep up                                            | Submissions get 503 `system_overloaded` + `Retry-After` once the outbox backlog exceeds `MAX_OUTBOX_BACKLOG`.                                                                                                                                                                                                          | No                                                 | `limits.test.ts`                                                                 |

## Runbooks

### Jobs stay queued

The job shows `queued` and never starts.

1. **Is any worker online for that queue?** `GET /v1/system/workers` or the "Workers & queues" page.
   Workers only consume the queues in `WORKER_QUEUES`. A job on `bulk` with workers listening to
   `default` waits forever. Alert: `ScaleFlowNoWorkers`.
2. **Is it still in the outbox?** `scaleflow_outbox_pending` / "Outbox backlog". If the backlog grows,
   go to [Outbox backlog](#outbox-backlog).
   ```sql
   SELECT id, attempts, last_error, available_at FROM outbox WHERE aggregate_id = '<job id>' ORDER BY id;
   ```
3. **Is it in BullMQ?** The dispatch id is `<jobId>-a<attemptCount+1>`.
   ```bash
   redis-cli -n 0 HGETALL "sf-bull:jobs-default:<jobId>-a1"
   ```
   If the queue has a large `waiting` count, the workers are simply busy: check utilization and queue wait p95.
4. **Missing from both?** The dispatch reconciler re-dispatches automatically within ~2.5 minutes.
   Check `scaleflow_dispatches_reconciled_total` and scheduler logs (`re-dispatched queued jobs missing from the queue`).
5. **Workers busy but slow?** Check `scaleflow_job_execution_duration_seconds` and event loop lag.
   Adding workers helps only if the bottleneck is worker concurrency - see docs/benchmarks.md for
   where it stops helping.

### Jobs fail repeatedly

1. Open the job: the **Attempts** panel shows each attempt's error code and message; `lastError.retryable`
   tells you whether ScaleFlow will retry.
2. Common codes: `timeout` (raise `timeoutMs` or fix the handler), `http_5xx`/`network_error` (the
   webhook target is down - retries with backoff are expected), `http_4xx` (permanent: bad URL or
   payload; fix and **retry** from the dead-letter view), `lease_expired` (worker died - see below),
   `worker_shutdown` (deploys; harmless).
3. To find the pattern across jobs: `GET /v1/projects/:id/jobs?status=failed` (the dead-letter view)
   and group by `lastError.code`.
4. After fixing the cause, replay with `POST /v1/projects/:id/jobs/:jobId/retry` (or the Retry
   button). Each replay gets a fresh attempt budget.

### A job "disappears" from the dashboard

Jobs are not deleted except by retention (`RETENTION_JOBS_DAYS`, default 30 days after they finish).

1. **Filters**: the jobs table filters by status/type/queue in the URL.
2. **Wrong project**: a job id from another project returns 404 by design.
3. **Retention**: `SELECT * FROM audit_log WHERE target_id = '<job id>'` shows manual actions;
   `scaleflow_retention_deleted_total{table="jobs"}` shows deletions.
4. **Stale counts**: the overview tiles come from the read model; if they disagree with the jobs
   table, see [Dashboard numbers look stale](#dashboard-numbers-look-stale).

### Outbox backlog

`scaleflow_outbox_oldest_pending_age_seconds` grows.

1. Is the relay running? `up{job="relay"}`; its logs show `outbox publish failed; will retry` with the Redis error.
2. Is Redis healthy? `redis-cli ping`, memory (`INFO memory`), and `maxmemory-policy` must be `noeviction`.
3. Inspect failing rows: `SELECT attempts, last_error FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT 20;`
4. A row with `last_error` mentioning an unknown queue means `QUEUES` was changed while jobs for
   the removed queue were pending: re-add the queue or move those jobs.

### Workers crash or lose leases

`ScaleFlowWorkersCrashing` / `scaleflow_leases_recovered_total` increasing.

- Look for OOM kills (container `OOMKilled`), unhandled errors in worker logs, or high event-loop lag.
  A CPU-bound handler blocks the event loop; lease renewals then run late and leases expire even
  though the worker is alive. Lower `WORKER_CONCURRENCY` for CPU-heavy queues or move them to their own workers.

### API errors or latency

1. 5xx: logs at `level=error` with `requestId`; the response body carries the same `requestId`.
2. Latency: compare API p99 with PostgreSQL (`pg_stat_statements`) and Redis latency. Pool
   exhaustion shows as requests waiting on connections: raise `DATABASE_POOL_MAX` within
   PostgreSQL's `max_connections`, or add PgBouncer.
3. 429s are rate limiting or backpressure doing their job; check which (`code` in the problem body).

### Dashboard numbers look stale

The overview reads the projection, typically < 1 s behind.

1. `scaleflow_projection_lag_seconds`, relay logs.
2. A long-running transaction anywhere on the PostgreSQL cluster holds back the event-log watermark
   (see architecture §6): `SELECT pid, now() - xact_start, state, query FROM pg_stat_activity WHERE backend_xid IS NOT NULL ORDER BY xact_start;`
3. If the counts have drifted (for example after restoring a backup), rebuild them:
   `npm run projections:rebuild -w @scaleflow/server` (or `node dist/cli/rebuild-projections.js` in
   the image). It briefly blocks job writes.

### A process is down

Restart it; all processes are stateless. Running two instances of the relay or scheduler is safe
(`SKIP LOCKED` leases and an advisory lock for the projector).

## Single points of failure

The local Docker Compose stack is **not highly available**, and running more containers on one
host does not change that.

| Component         | Local setup                     | What production needs                                                                                                             |
| ----------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL        | One container, one volume       | Managed PostgreSQL or Patroni with synchronous standby, automated failover, PITR backups (WAL archiving), tested restores         |
| Redis             | One container, AOF every second | Redis Sentinel or a managed Redis with replicas; AOF; `noeviction`. Losing Redis is survivable (reconciler) but stalls processing |
| API               | One container                   | ≥2 replicas behind a load balancer using `/readyz`; TLS termination                                                               |
| Relay / scheduler | One each                        | ≥2 replicas each (safe by design)                                                                                                 |
| Workers           | 2 replicas on one host          | Spread across hosts/zones                                                                                                         |
| Host              | One machine                     | Multiple nodes / availability zones                                                                                               |

## Recovery procedures

| Situation                          | Procedure                                                                                                                                                                                                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jobs stuck `running` after a crash | Nothing to do: the lease reaper recovers them within `WORKER_LEASE_MS` + 5 s. To force it, set `lease_expires_at = now()` for those rows.                                                                                                                         |
| Redis was flushed                  | Nothing to do: the reconciler re-dispatches queued jobs. Delayed/retrying jobs live in PostgreSQL and are unaffected.                                                                                                                                             |
| Bad deploy dead-lettered many jobs | Fix, then replay: list `?status=failed`, `POST .../retry` per job (idempotent: retrying a non-failed job is a 409).                                                                                                                                               |
| Read-model counts wrong            | `npm run projections:rebuild`.                                                                                                                                                                                                                                    |
| Restore PostgreSQL from backup     | Restore, run migrations, flush the Redis queue keys (`sf-bull:*`) and cache keys (`sf:*`), start the processes, then run `projections:rebuild`. The reconciler re-dispatches every queued job; jobs that were running at backup time are recovered by the reaper. |
| Revoke a leaked API key            | `DELETE /v1/projects/:id/api-keys/:keyId` - effective on the next request. Then check `audit_log` and `api_keys.last_used_at`.                                                                                                                                    |
