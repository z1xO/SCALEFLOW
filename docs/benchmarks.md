# Benchmarks

Every number on this page was measured with the k6 scripts in [`load/`](../load) on the machine
described below, on 2026-10-16. They are **one laptop's numbers**, not a capacity guarantee: k6, the
API, workers, PostgreSQL and Redis all shared the same CPU. Re-run them on your hardware; the
interesting output is _where_ each configuration stops scaling and _why_.

## Environment

|                    |                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Machine            | AMD Ryzen 7 6800H (8 cores / 16 threads), 31 GB RAM, NVMe SSD, Windows 11                                             |
| PostgreSQL         | 17.11 native, `shared_buffers=512MB`, `max_connections=300`, defaults otherwise (`synchronous_commit=on`)             |
| Redis              | 8.10.2 (community Windows build), AOF `everysec`, `noeviction`                                                        |
| Node.js            | 24.21.0; backend run from the compiled build (`dist/`), `LOG_LEVEL=warn`                                              |
| Load generator     | k6 2.3.0 on the same machine                                                                                          |
| API config         | One API process unless stated; `DATABASE_POOL_MAX=20`; rate limits and project quotas raised so they do not interfere |
| Dataset at the end | 352,845 jobs (270 MB incl. indexes), 1,058,556 job events, database 957 MB                                            |

Process CPU was sampled before and after each run (`TotalProcessorTime`); "% of one core" is CPU
seconds divided by wall time.

## Initial targets (hypotheses) vs result

| Hypothesis set before measuring                            | Result                                                            |
| ---------------------------------------------------------- | ----------------------------------------------------------------- |
| Job submission p95 < 150 ms, p99 < 300 ms at 200 req/s     | Holds with a wide margin: p95 4.0 ms, p99 7.4 ms                  |
| Job detail read p95 < 50 ms at 500 req/s                   | Holds at 1,500 req/s: p95 2.1 ms (cached) / 3.7–6.7 ms (uncached) |
| One API process sustains ~500 submissions/s                | Too pessimistic: ~1,000/s, collapses at 1,200/s                   |
| Throughput scales linearly with workers for I/O-bound jobs | **False** beyond ~4 workers - see below                           |

## Write path: job submission (`write-heavy.js`, `burst.js`)

Constant arrival rate (open model: the load does not back off when the server slows), 30 s per step,
`POST /v1/projects/:id/jobs` with `demo.echo`, half the requests with an `Idempotency-Key`. Each
accepted job is one transaction: insert job + event + outbox row. A single worker was running and
processing the jobs at the same time.

| Rate offered | API procs | Achieved | p50     | p95     | p99     | Errors                        | CPU: API / PostgreSQL / Redis |
| ------------ | --------- | -------- | ------- | ------- | ------- | ----------------------------- | ----------------------------- |
| 200/s        | 1         | 197/s    | 3.0 ms  | 4.0 ms  | 7.4 ms  | 0%                            | -                             |
| 400/s        | 1         | 393/s    | 2.6 ms  | 5.0 ms  | 10.8 ms | 0%                            | 45% / 69% / 57%               |
| 600/s        | 1         | 590/s    | 2.7 ms  | 10.3 ms | 23.8 ms | 0%                            | 63% / 189% / 78%              |
| 800/s        | 1         | 785/s    | 3.7 ms  | 15.9 ms | 26.5 ms | 0%                            | 77% / 279% / 95%              |
| 1,000/s      | 1         | 982/s    | 5.4 ms  | 20.9 ms | 33.6 ms | 0%                            | 89% / 219% / 100%             |
| 1,200/s      | 1         | 1,090/s  | 578 ms  | 1.66 s  | 1.79 s  | 0% (1,539 iterations dropped) | **102%** / 283% / 97%         |
| 1,200/s      | 2         | 1,179/s  | 5.8 ms  | 27.0 ms | 391 ms  | 0%                            | 65%+68% / 373% / 105%         |
| 1,600/s      | 2         | 1,568/s  | 13.7 ms | 36.5 ms | 80.6 ms | 0%                            | 85%+80% / 283% / 105%         |

**Reading it.** One API process saturates its single CPU core at ~1,100 requests/s: past that
point requests queue inside Node and latency jumps from milliseconds to seconds (no errors - the
open-model load just waits). A second API process (no shared state, so it is just "run another
one") takes the same machine to 1,568/s with p95 36 ms. The next limits are visible in the CPU column:
**Redis sits at ~100% of a core** (it is single-threaded; per request it serves the rate limiter and
the auth cache, plus BullMQ traffic from the relay and workers), and PostgreSQL is busy with three
inserts and a commit per job. With `synchronous_commit=on`, each commit waits for a WAL flush;
group commit is what makes this rate possible on one SSD.

The ramp test (`burst.js`, 50 → 2,000/s over 100 s, one API process) confirms the knee: overall
861 req/s achieved, 33,002 iterations dropped, median 1.19 s once past ~1,100/s.

**Queue backlog behaviour.** At ≥ 800 submissions/s the single worker (concurrency 10) could not keep
up and the backlog grew to ~19,000 queued jobs. Nothing was rejected or lost: the jobs drained after
the test ended. `MAX_OUTBOX_BACKLOG` / `MAX_ACTIVE_JOBS_PER_PROJECT` were raised for these runs; with
the defaults the API would have started answering 429/503 instead (tested in `limits.test.ts`).

## Read path: polling and lists (`read-heavy.js`)

1,500 req/s for 30 s against 500 jobs: 80% `GET /jobs/:id`, 20% `GET /jobs?limit=25`. `CACHE=off`
sends a read-your-writes token, which by design bypasses the job cache, so both modes run the same
code except for the Redis cache. Runs alternated off/on/off/on with no background work.

| `GET /jobs/:id`   | p50     | p95    | p99     | API CPU |
| ----------------- | ------- | ------ | ------- | ------- |
| cache off (run 1) | 1.55 ms | 3.7 ms | 73.6 ms | 87%     |
| cache on (run 2)  | 1.02 ms | 2.1 ms | 25.8 ms | 78%     |
| cache off (run 3) | 1.55 ms | 6.7 ms | 226 ms  | 88%     |
| cache on (run 4)  | 1.02 ms | 2.1 ms | 39.4 ms | 76%     |

`GET /jobs` (list, never cached): p95 3.1–6.0 ms. Errors: 0% in all runs.

**Reading it.** With 500 hot rows, PostgreSQL answers a primary-key lookup from shared buffers in
well under a millisecond, so the cache's win on the median is small (~0.5 ms). It matters more in
the tail (p99 2–6× lower) and in CPU (~10% less API CPU, and PostgreSQL connections freed for
writes). The cache earns its complexity when the database is the contended resource, or when
reads would otherwise go to a lagging replica; it is not a free 10× here, and this page does not
pretend it is.

An earlier cache-on run done while the worker was still draining 12,000 jobs showed _worse_ latency
than cache-off - Redis was at 108% of a core serving BullMQ at the same time. That run was
discarded as contaminated, but it shows the real coupling: the cache, rate limiter and queue share
one single-threaded Redis. Production should separate them (see [scaling.md](scaling.md)).

## Mixed traffic (`mixed.js`)

600 iterations/s for 60 s (≈ 890 HTTP requests/s): 30% submissions (`demo.sleep` 20 ms), 50% status
polls (list newest + get), 20% filtered lists; two workers × 20 slots processing concurrently.

| Requests | p50     | p95     | p99    | Errors | CPU: API / PostgreSQL / Redis / workers |
| -------- | ------- | ------- | ------ | ------ | --------------------------------------- |
| 53,973   | 1.53 ms | 4.52 ms | 8.6 ms | 0%     | 65% / 95% / 64% / 15%+16%               |

## Indexes and pagination (`load/sql/index-experiment.sql`)

On the 352,845-row `jobs` table, for the largest project (87,490 jobs), `EXPLAIN ANALYZE`:

| Query                                             | With index                                                                   | Without                                                          |         |
| ------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------- |
| Dead-letter view (`status = 'failed'`, newest 51) | **0.041 ms** - index-only scan on `(project_id, status, id DESC)`, 3 buffers | 51.9 ms - parallel seq scan, 16,151 buffers                      | ~1,250× |
| Page 78,741 rows deep                             | **0.088 ms** - keyset cursor (`id < $cursor`)                                | 10.5 ms - `OFFSET 78741` reads and discards 78,792 index entries | ~120×   |

The "without index" plan reads the whole table because few rows match; it gets worse linearly as
`jobs` grows. This is why every filter in the API is backed by an index and pagination is cursor-only.

## Workers: throughput vs worker count (`drain.js`)

Enqueue N jobs through the batch API, then measure until all are finished (polling the read model,
so each figure includes ~0.9 s of enqueue time and up to ~0.75 s of projection lag).

**I/O-bound** (`demo.sleep` 50 ms, 4,000 jobs). Theoretical ceiling = slots / 0.05 s.

| Workers × concurrency | Slots | Jobs/s | Ceiling | PostgreSQL CPU |
| --------------------- | ----- | ------ | ------- | -------------- |
| 1 × 10                | 10    | 151    | 200     | 43%            |
| 2 × 10                | 20    | 244    | 400     | 69%            |
| 4 × 10                | 40    | 346    | 800     | 95%            |
| 8 × 10                | 80    | 576    | 1,600   | 223%           |
| 1 × 40                | 40    | 352    | 800     | 82%            |
| 4 × 40                | 160   | 545    | 3,200   | 228%           |

**CPU-bound** (`demo.cpu`, 20,000 SHA-256 rounds ≈ 30 ms CPU, 1,000 jobs).

| Workers × concurrency | Jobs/s | Worker CPU |
| --------------------- | ------ | ---------- |
| 1 × 10                | 32.5   | 102%       |
| 1 × 40                | 32.1   | 100%       |
| 4 × 10                | 93.7   | 4 × ~92%   |

**Reading it - more workers is not automatically more throughput:**

1. For **CPU-bound** handlers, concurrency inside one Node process does nothing (10 vs 40 slots: same
   32 jobs/s at 100% of one core). Only more processes/cores help, and 4 processes gave 2.9×, not 4×,
   because they compete with PostgreSQL, Redis and k6 for the same 8 cores.
2. For **I/O-bound** handlers, slots help until the **per-job overhead** dominates: each job costs a
   claim transaction (update + attempt insert + event), a completion transaction (update + attempt
   update + event), a BullMQ round trip, an outbox publish and a projection update. At ~550 jobs/s
   that overhead saturates this machine (PostgreSQL ~2.3 cores); 160 slots did no better than 80.
3. The next bottleneck in production would equally be the **downstream** a handler calls (a webhook
   target that can take 50 req/s does not care how many workers you have) - use per-queue concurrency
   and the backpressure limits rather than more workers.

Ways to raise the ceiling, roughly in order of cost: batch claims (claim N jobs per transaction),
drop the per-attempt event for successful fast jobs, `synchronous_commit=off` for the event/attempt
writes (trading durability of history for speed), PgBouncer, and finally partitioning `jobs` and
`job_events` (see [scaling.md](scaling.md)).

## Reproducing

```bash
docker compose up -d postgres redis
npm run db:migrate
npm run build -w @scaleflow/server
# limits raised so they do not interfere with the measurement:
export LOG_LEVEL=warn RATE_LIMIT_MAX=100000000 MAX_ACTIVE_JOBS_PER_PROJECT=100000000 MAX_OUTBOX_BACKLOG=100000000
(cd apps/server && node dist/processes/api.js & node dist/processes/relay.js & node dist/processes/scheduler.js & node dist/processes/worker.js &)

k6 run -e RATE=800 -e DURATION=30s load/write-heavy.js
k6 run -e PEAK=2000 load/burst.js
k6 run -e RATE=1500 -e CACHE=off load/read-heavy.js
k6 run -e RATE=1500 load/read-heavy.js
k6 run -e RATE=600 -e DURATION=60s load/mixed.js
k6 run -e JOBS=4000 -e JOB_TYPE=demo.sleep -e JOB_MS=50 load/drain.js
k6 run -e JOBS=1000 -e JOB_TYPE=demo.cpu -e ITERATIONS=20000 load/drain.js
psql "$DATABASE_URL" -f load/sql/index-experiment.sql
```

To spread submissions over several API processes without a load balancer, pass
`-e API_URLS=http://localhost:4000,http://localhost:4001`. For more workers start more worker
processes, each with its own `WORKER_METRICS_PORT`.

**Interpreting results:** look at the achieved rate vs the offered rate (a gap, or `dropped_iterations`,
means saturation), p99 rather than the average, `http_req_failed`, and which process is near 100% of a
core. Re-run anything that looks surprising - one run in this series was thrown out because background
work was competing for Redis.
