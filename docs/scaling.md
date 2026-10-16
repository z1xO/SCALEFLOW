# Scaling ScaleFlow

What scales how, what the measured limits were on one laptop ([benchmarks.md](benchmarks.md)), and
the path to much larger workloads. Nothing on this page beyond the measured numbers has been run at
scale.

## Reads

| Technique | Status |
| --- | --- |
| Cursor (keyset) pagination on UUIDv7 ids, time filters as id ranges | Implemented; 120× faster than OFFSET 78k rows deep (measured) |
| Indexes per query pattern, partial indexes for scheduler/reaper/reconciler | Implemented; dead-letter view 0.04 ms vs 52 ms without its index (measured) |
| Versioned Redis cache for job detail, stampede-protected cache for metrics/queue health | Implemented; tail latency 2-6× lower at 1,500 req/s (measured) |
| Read model (projections) for dashboard counts and charts | Implemented; counts are O(statuses), not O(jobs) |
| PostgreSQL connection pooling (node-postgres pools per process) | Implemented; add PgBouncer when process count × pool size approaches `max_connections` |
| Read replicas with LSN-based read-your-writes | Implemented, not exercised against a real replica (see deployment.md) |

## Writes

One API process handled ~1,000 submissions/s before its CPU saturated; two processes reached 1,568/s
on the same machine (p95 36 ms). The API is stateless: add processes behind a load balancer. The
next limits, in order:

1. **Redis CPU** (single-threaded): rate limiting, auth cache, BullMQ. Split the cache/rate-limit
   Redis from the queue Redis; move rate limiting to the load balancer; cache auth per process for a
   few seconds (trading revocation latency).
2. **PostgreSQL commit rate**: each submission is one transaction with three inserts. Use the batch
   endpoint (up to 100 jobs per transaction), faster storage for WAL, and group commit tuning.
3. **Per-job worker overhead** (claim + complete transactions, events, projection): measured as the
   ceiling for short I/O-bound jobs (~550 jobs/s here). Options: claim jobs in batches, skip
   per-attempt events for fast successes, `synchronous_commit = off` for history tables only.

## Workers

Workers are stateless and scale horizontally; concurrency per process (`WORKER_CONCURRENCY`) helps
I/O-bound handlers only. CPU-bound handlers need more processes/cores (measured: concurrency 10 → 40
changed nothing; 4 processes gave 2.9×). Separate queues (`default`, `critical`, `bulk`) let you run
dedicated worker pools so a flood of bulk work cannot starve critical jobs. The downstream a handler
calls is often the true limit; more workers just move the overload onto it.

## Partitioning and sharding (when one PostgreSQL is not enough)

Single-node PostgreSQL goes a long way; the expected order of steps is:

1. **Time-partition `job_events` and `jobs`** (declarative partitioning by `created_at`, monthly or
   daily). Retention becomes `DROP PARTITION` (no vacuum debt, no long deletes holding back the event
   watermark). UUIDv7 ids keep partition pruning effective for id-range queries. The unique
   `(project_id, idempotency_key)` index must then include the partition key, which bounds the
   idempotency window to a partition - an explicit product decision.
2. **Separate the event log** from the job store when it dominates write volume, or replace polling
   it with logical decoding / CDC (Debezium) into a log (Kafka/Redpanda) that the real-time hub and
   projector consume.
3. **Shard by project** (`project_id` is in every query and every index): Citus, or application-level
   routing to N PostgreSQL clusters with a small directory service mapping projects to shards. Very
   large tenants get their own shard. Cross-project queries (system gauges) become fan-out queries.
4. Replace BullMQ with a partitioned log or a cloud queue when Redis throughput becomes the limit; the
   outbox abstraction is the seam - only the relay and the worker's consumer change.

Kafka, Kubernetes or a service mesh are deliberately not part of the current design: at the measured
scale they would add operational weight without removing a bottleneck.
