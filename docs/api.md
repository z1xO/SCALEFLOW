# API guide

The full, generated reference is served by the API itself: **`/docs`** (Swagger UI) and
**`/openapi.json`** (OpenAPI 3.1). This page explains the conventions and walks through the common
flows with `curl`.

## Conventions

| | |
| --- | --- |
| Base URL | `http://localhost:4000` locally; all routes are versioned under `/v1` |
| Auth (services) | `Authorization: Bearer sf_...` - an API key, scoped to **one** project, with scopes `jobs:read` / `jobs:write` |
| Auth (dashboard) | `sf_session` HttpOnly cookie from `POST /v1/auth/login`. Cookie-authenticated writes must send an allowed `Origin` (CSRF protection) |
| Errors | [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem details, `content-type: application/problem+json`, always with a stable `code` and the `requestId` |
| Correlation | Send `X-Request-Id` (8-128 chars of `[A-Za-z0-9._:-]`) or one is generated; it is echoed back, logged everywhere, and stored on jobs as `correlationId` |
| Idempotency | `Idempotency-Key` header on `POST /jobs` (or `idempotencyKey` per item in a batch) |
| Pagination | Cursor based: `?limit=50&cursor=<nextCursor>`; `nextCursor: null` means the last page. Ordering is newest first |
| Rate limits | Per API key / user (default 600 req/min), stricter on login/registration; `429` with `Retry-After` |
| Backpressure | `429 project_queue_full` (per-project active-job quota) and `503 system_overloaded` (outbox backlog), both with `Retry-After` |
| Read-your-writes | With a read replica configured, writes return `X-ScaleFlow-Commit-LSN`; send it back as `X-ScaleFlow-Min-LSN` |

Error example:

```json
{
  "type": "urn:scaleflow:problem:idempotency_key_reused",
  "title": "Unprocessable Content",
  "status": 422,
  "detail": "This Idempotency-Key was already used with a different request body",
  "code": "idempotency_key_reused",
  "requestId": "01a144a3-6f0e-7b2c-9d1e-5c3b2a1f0e9d",
  "errors": { "index": 0, "idempotencyKey": "order-42", "existingJobId": "01a144a3-..." }
}
```

| Status | Typical codes |
| --- | --- |
| 400 | `validation_failed` (schema), invalid cursor |
| 401 | `unauthorized` (missing/expired/revoked credentials) |
| 403 | `forbidden` (role or scope too weak, CSRF origin rejected) |
| 404 | `not_found` - also for resources in projects you cannot access |
| 409 | `invalid_transition`, `job_not_cancellable`, `job_not_retryable`, `email_taken`, `last_owner` |
| 413 | `payload_too_large` (request body over 1 MiB) |
| 422 | `unknown_job_type`, `invalid_payload`, `unknown_queue`, `payload_too_large` (payload over 64 KiB), `idempotency_key_reused`, `invalid_cron` |
| 429 | `rate_limited`, `project_queue_full`, `too_many_streams` |
| 503 | `system_overloaded` |

## Walkthrough

```bash
API=http://localhost:4000
ORIGIN=http://localhost:3000
```

### 1. Account, project and API key (dashboard session)

```bash
curl -s -c cookies.txt -X POST $API/v1/auth/register -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"a-long-password","name":"Ada"}'
curl -s -c cookies.txt -X POST $API/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"a-long-password"}'

PROJECT=$(curl -s -b cookies.txt -X POST $API/v1/projects -H "origin: $ORIGIN" \
  -H 'content-type: application/json' -d '{"name":"Billing"}' | jq -r .project.id)

KEY=$(curl -s -b cookies.txt -X POST $API/v1/projects/$PROJECT/api-keys -H "origin: $ORIGIN" \
  -H 'content-type: application/json' -d '{"name":"billing-service","scopes":["jobs:read","jobs:write"]}' | jq -r .secret)
# The secret is shown exactly once. Only its SHA-256 is stored.
```

### 2. Submit a job

```bash
curl -s -X POST $API/v1/projects/$PROJECT/jobs \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -H 'Idempotency-Key: invoice-2026-0042' \
  -d '{
        "type": "webhook.deliver",
        "payload": { "url": "https://billing.example.com/hooks/invoice", "body": { "invoice": 42 } },
        "maxAttempts": 5,
        "backoff": { "type": "exponential", "baseDelayMs": 2000, "maxDelayMs": 300000 },
        "timeoutMs": 10000
      }'
```

```json
{
  "job": {
    "id": "01a144a3-6f0e-7b2c-9d1e-5c3b2a1f0e9d",
    "status": "queued",
    "type": "webhook.deliver",
    "queue": "default",
    "attemptCount": 0,
    "maxAttempts": 5,
    "idempotencyKey": "invoice-2026-0042",
    "correlationId": "01a144a3-6f0d-7a51-8a3c-2b7e9f0d1c4a",
    "runAt": "2026-10-16T12:00:00.000Z"
  }
}
```

`201` for a new job, `200` + `Idempotent-Replayed: true` when the same key and body were already
submitted (safe to retry after a timeout), `422 idempotency_key_reused` for the same key with a
different body. Delay a job with `"delayMs": 60000` or `"runAt": "2026-10-17T09:00:00Z"`; submit up to
100 jobs atomically with `POST /v1/projects/$PROJECT/jobs/batch` and `{"jobs": [...]}`.

Built-in job types (`GET /v1/job-types`):

| Type | Payload | Notes |
| --- | --- | --- |
| `webhook.deliver` | `{ url, method?, headers?, body }` | Signed with HMAC-SHA256 (`ScaleFlow-Signature: v1=<hex>` over `<ScaleFlow-Timestamp>.<body>`), sends `Idempotency-Key: <jobId>`; 2xx ok, 408/429/5xx retry, other 4xx permanent. Private/loopback targets are blocked unless `WEBHOOK_ALLOW_PRIVATE_NETWORKS=true` |
| `demo.echo` | `{ message?, delayMs? }` | Returns its input |
| `demo.sleep` | `{ durationMs }` | I/O-bound work |
| `demo.flaky` | `{ failureRate?, succeedOnAttempt?, permanent?, durationMs? }` | Exercises retries and dead-lettering |
| `demo.cpu` | `{ iterations }` | CPU-bound work |

### 3. Check status, attempts and history

```bash
curl -s -H "Authorization: Bearer $KEY" $API/v1/projects/$PROJECT/jobs/$JOB | jq .job.status
curl -s -H "Authorization: Bearer $KEY" $API/v1/projects/$PROJECT/jobs/$JOB/attempts | jq '.items[] | {attemptNumber, status, error}'
curl -s -H "Authorization: Bearer $KEY" $API/v1/projects/$PROJECT/jobs/$JOB/events | jq '.items[] | {type, data}'

# List with filters and cursor pagination
curl -s -H "Authorization: Bearer $KEY" "$API/v1/projects/$PROJECT/jobs?status=failed,retry_wait&type=webhook.deliver&limit=50"
curl -s -H "Authorization: Bearer $KEY" "$API/v1/projects/$PROJECT/jobs?limit=50&cursor=$NEXT"
```

### 4. Retry a failure, cancel a pending job

```bash
# Dead-letter view
curl -s -H "Authorization: Bearer $KEY" "$API/v1/projects/$PROJECT/jobs?status=failed" | jq '.items[] | {id, lastError}'

# Replay one (fresh attempt budget; 409 job_not_retryable unless it is failed)
curl -s -X POST -H "Authorization: Bearer $KEY" $API/v1/projects/$PROJECT/jobs/$JOB/retry

# Cancel (only scheduled / queued / retry_wait; 409 job_not_cancellable while running)
curl -s -X POST -H "Authorization: Bearer $KEY" $API/v1/projects/$PROJECT/jobs/$JOB/cancel
```

### 5. Receive real-time updates

```bash
curl -N -H "Authorization: Bearer $KEY" $API/v1/projects/$PROJECT/stream
```

```text
retry: 3000

id: 59213.18342
event: ready
data: {"cursor":"59213.18342"}

id: 59240.18350
event: job
data: {"cursor":"59240.18350","id":"18350","jobId":"01a144a3-...","type":"job.started","data":{"from":"queued","to":"running","type":"webhook.deliver","queue":"default","attempt":1,"workerId":"host-4312-k2Xb","queueWaitMs":41},"createdAt":"2026-10-16T12:00:01.204Z"}

event: system
data: {"queues":{"default":{"waiting":0,"active":1,...}},"workers":{"online":2,...},...}

: ping
```

Resume after a disconnect without gaps or duplicates: `-H 'Last-Event-ID: 59240.18350'` (browsers'
`EventSource` does this automatically) or `?since=59240.18350`. A `reset` event means you were away
for more than `SSE_REPLAY_MAX_EVENTS` events: re-fetch state instead of replaying. Treat events as
at-least-once and de-duplicate by `cursor`.

### 6. Schedules

```bash
curl -s -X POST $API/v1/projects/$PROJECT/schedules -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"name":"nightly-report","cron":"0 3 * * *","timezone":"Europe/Berlin","jobType":"demo.echo","payload":{"report":"daily"}}'
curl -s -X POST -H "Authorization: Bearer $KEY" $API/v1/projects/$PROJECT/schedules/$SCHEDULE/trigger   # run now
curl -s -X PATCH -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"enabled":false}' $API/v1/projects/$PROJECT/schedules/$SCHEDULE
```

### 7. Metrics and health

```bash
curl -s -H "Authorization: Bearer $KEY" "$API/v1/projects/$PROJECT/metrics?window=1h" | jq '{counts, totals, latency}'
curl -s -H "Authorization: Bearer $KEY" $API/v1/system/queues
curl -s -H "Authorization: Bearer $KEY" $API/v1/system/workers
curl -s $API/readyz
curl -s $API/metrics | grep scaleflow_jobs_submitted_total
```

## Verifying webhook signatures (receiver side)

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(req, rawBody, secret) {
  const ts = req.headers['scaleflow-timestamp'];
  const sig = (req.headers['scaleflow-signature'] ?? '').replace(/^v1=/, '');
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // replay window
  const expected = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
// Deduplicate on req.headers['idempotency-key'] (the job id): delivery is at-least-once.
```
