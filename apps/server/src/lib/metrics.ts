import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from '@prometheus-io/client';

/**
 * All ScaleFlow metrics. Label sets are deliberately bounded: no project ids, job ids or user input
 * (job `type` is restricted to registered handler types, `queue` to configured queues).
 */
export function createMetrics(service: string) {
  const registry = new Registry();
  registry.setDefaultLabels({ service });
  collectDefaultMetrics({ register: registry, prefix: 'scaleflow_' });

  const durationBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];

  return {
    registry,

    // --- API -------------------------------------------------------------
    httpRequestDuration: new Histogram({
      name: 'scaleflow_http_request_duration_seconds',
      help: 'HTTP request latency by route template and status code',
      labelNames: ['method', 'route', 'status_code'] as const,
      buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [registry],
    }),
    jobsSubmitted: new Counter({
      name: 'scaleflow_jobs_submitted_total',
      help: 'Jobs accepted by the API (idempotent replays excluded)',
      labelNames: ['queue', 'type'] as const,
      registers: [registry],
    }),
    idempotentReplays: new Counter({
      name: 'scaleflow_idempotent_replays_total',
      help: 'Submissions answered from an existing job with the same idempotency key',
      registers: [registry],
    }),
    backpressureRejections: new Counter({
      name: 'scaleflow_backpressure_rejections_total',
      help: 'Submissions rejected because of backpressure',
      labelNames: ['reason'] as const,
      registers: [registry],
    }),
    rateLimited: new Counter({
      name: 'scaleflow_rate_limited_total',
      help: 'Requests rejected by the rate limiter',
      registers: [registry],
    }),
    cacheRequests: new Counter({
      name: 'scaleflow_cache_requests_total',
      help: 'Cache lookups by cache and result',
      labelNames: ['cache', 'result'] as const,
      registers: [registry],
    }),
    realtimeConnections: new Gauge({
      name: 'scaleflow_realtime_connections',
      help: 'Open SSE connections on this API process',
      registers: [registry],
    }),
    realtimeEventsSent: new Counter({
      name: 'scaleflow_realtime_events_sent_total',
      help: 'Events written to SSE connections',
      registers: [registry],
    }),
    readRouting: new Counter({
      name: 'scaleflow_read_routing_total',
      help: 'Read-pool routing decisions',
      labelNames: ['target'] as const,
      registers: [registry],
    }),

    // --- Workers ---------------------------------------------------------
    jobsCompleted: new Counter({
      name: 'scaleflow_jobs_completed_total',
      help: 'Finished job attempts by outcome (succeeded, retry, failed)',
      labelNames: ['queue', 'type', 'outcome'] as const,
      registers: [registry],
    }),
    jobExecutionDuration: new Histogram({
      name: 'scaleflow_job_execution_duration_seconds',
      help: 'Handler execution time per attempt',
      labelNames: ['queue', 'type', 'outcome'] as const,
      buckets: durationBuckets,
      registers: [registry],
    }),
    jobQueueWait: new Histogram({
      name: 'scaleflow_job_queue_wait_seconds',
      help: 'Time from becoming queued to being claimed by a worker',
      labelNames: ['queue'] as const,
      buckets: durationBuckets,
      registers: [registry],
    }),
    duplicateDeliveries: new Counter({
      name: 'scaleflow_duplicate_deliveries_total',
      help: 'Queue deliveries skipped because the job was not claimable (duplicate or stale)',
      labelNames: ['queue'] as const,
      registers: [registry],
    }),
    staleCompletions: new Counter({
      name: 'scaleflow_stale_completions_total',
      help: 'Attempt results discarded because the worker no longer held the lease',
      registers: [registry],
    }),
    workerActiveJobs: new Gauge({
      name: 'scaleflow_worker_active_jobs',
      help: 'Jobs currently executing in this worker',
      registers: [registry],
    }),
    workerConcurrency: new Gauge({
      name: 'scaleflow_worker_concurrency',
      help: 'Configured concurrency of this worker',
      registers: [registry],
    }),

    // --- Relay -----------------------------------------------------------
    outboxPublished: new Counter({
      name: 'scaleflow_outbox_published_total',
      help: 'Outbox rows published to the queue',
      registers: [registry],
    }),
    outboxPublishFailures: new Counter({
      name: 'scaleflow_outbox_publish_failures_total',
      help: 'Outbox publish attempts that failed and will be retried',
      registers: [registry],
    }),
    outboxPending: new Gauge({
      name: 'scaleflow_outbox_pending',
      help: 'Unpublished outbox rows',
      registers: [registry],
    }),
    outboxOldestPendingAge: new Gauge({
      name: 'scaleflow_outbox_oldest_pending_age_seconds',
      help: 'Age of the oldest unpublished outbox row that is due',
      registers: [registry],
    }),
    outboxPublishLatency: new Histogram({
      name: 'scaleflow_outbox_publish_latency_seconds',
      help: 'Time from outbox row becoming available to being published',
      buckets: durationBuckets,
      registers: [registry],
    }),
    projectionLag: new Gauge({
      name: 'scaleflow_projection_lag_seconds',
      help: 'Age of the newest event folded into the read model at the time it was folded',
      registers: [registry],
    }),
    projectedEvents: new Counter({
      name: 'scaleflow_projected_events_total',
      help: 'Events folded into the read model',
      registers: [registry],
    }),

    // --- Scheduler -------------------------------------------------------
    queueDepth: new Gauge({
      name: 'scaleflow_queue_depth',
      help: 'BullMQ jobs by queue and state',
      labelNames: ['queue', 'state'] as const,
      registers: [registry],
    }),
    jobsByStatus: new Gauge({
      name: 'scaleflow_jobs_active',
      help: 'Non-terminal jobs in PostgreSQL by status',
      labelNames: ['status'] as const,
      registers: [registry],
    }),
    oldestQueuedAge: new Gauge({
      name: 'scaleflow_oldest_queued_job_age_seconds',
      help: 'Age of the oldest job in status queued',
      registers: [registry],
    }),
    jobsPromoted: new Counter({
      name: 'scaleflow_jobs_promoted_total',
      help: 'Jobs moved from scheduled/retry_wait to queued',
      labelNames: ['from'] as const,
      registers: [registry],
    }),
    leasesRecovered: new Counter({
      name: 'scaleflow_leases_recovered_total',
      help: 'Running jobs recovered after their worker lease expired',
      registers: [registry],
    }),
    dispatchesReconciled: new Counter({
      name: 'scaleflow_dispatches_reconciled_total',
      help: 'Queued jobs re-dispatched because their queue entry was missing',
      registers: [registry],
    }),
    schedulesFired: new Counter({
      name: 'scaleflow_schedules_fired_total',
      help: 'Jobs created by recurring schedules',
      registers: [registry],
    }),
    workersOnline: new Gauge({
      name: 'scaleflow_workers_online',
      help: 'Workers with a recent heartbeat',
      registers: [registry],
    }),
    retentionDeleted: new Counter({
      name: 'scaleflow_retention_deleted_total',
      help: 'Rows deleted by retention',
      labelNames: ['table'] as const,
      registers: [registry],
    }),

    // --- Shared ----------------------------------------------------------
    loopErrors: new Counter({
      name: 'scaleflow_loop_errors_total',
      help: 'Errors in background loops',
      labelNames: ['loop'] as const,
      registers: [registry],
    }),
    loopDuration: new Histogram({
      name: 'scaleflow_loop_duration_seconds',
      help: 'Duration of one iteration of a background loop',
      labelNames: ['loop'] as const,
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    }),
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
