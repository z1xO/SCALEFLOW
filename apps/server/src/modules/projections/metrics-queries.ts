import type { CachedLoader } from '../../infra/cache/cached-loader.js';
import type { ReadRouter } from '../../infra/db/read-router.js';
import { JOB_STATUSES, type JobStatus } from '../../domain/job-state.js';
import { HISTOGRAM_SIZE, LATENCY_BUCKETS_MS } from './projector.js';

export const METRIC_WINDOWS = {
  '15m': { minutes: 15, stepMinutes: 1 },
  '1h': { minutes: 60, stepMinutes: 1 },
  '6h': { minutes: 360, stepMinutes: 5 },
  '24h': { minutes: 1440, stepMinutes: 15 },
} as const;
export type MetricWindow = keyof typeof METRIC_WINDOWS;

export interface LatencySummary {
  count: number;
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

export interface ProjectMetrics {
  window: MetricWindow;
  generatedAt: string;
  /** When the projector last folded events; the read model is eventually consistent. */
  readModelAsOf: string | null;
  counts: Record<JobStatus, number>;
  totals: {
    submitted: number;
    started: number;
    succeeded: number;
    failed: number;
    retried: number;
    cancelled: number;
    successRate: number | null;
  };
  latency: { execution: LatencySummary; queueWait: LatencySummary };
  series: { t: string; submitted: number; succeeded: number; failed: number; retried: number }[];
}

/**
 * Approximate percentile from a fixed-bucket histogram (same technique as Prometheus'
 * histogram_quantile): linear interpolation inside the bucket that contains the rank.
 */
export function histogramQuantile(hist: number[], q: number): number | null {
  const total = hist.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const rank = q * total;
  let cumulative = 0;
  for (let i = 0; i < hist.length; i++) {
    const n = hist[i] ?? 0;
    if (cumulative + n >= rank && n > 0) {
      const lower = i === 0 ? 0 : (LATENCY_BUCKETS_MS[i - 1] ?? 0);
      const upper = LATENCY_BUCKETS_MS[i];
      if (upper === undefined) return lower; // +Inf bucket: report its lower bound
      return Math.round(lower + ((rank - cumulative) / n) * (upper - lower));
    }
    cumulative += n;
  }
  return LATENCY_BUCKETS_MS[LATENCY_BUCKETS_MS.length - 1] ?? null;
}

function summarize(hist: number[], sum: number): LatencySummary {
  const count = hist.reduce((a, b) => a + b, 0);
  return {
    count,
    avgMs: count ? Math.round(sum / count) : null,
    p50Ms: histogramQuantile(hist, 0.5),
    p95Ms: histogramQuantile(hist, 0.95),
    p99Ms: histogramQuantile(hist, 0.99),
  };
}

/** Read side for dashboards: served from the projections, never from `jobs`, and cached with stampede protection. */
export class MetricsQueries {
  constructor(
    private readonly router: ReadRouter,
    private readonly loader: CachedLoader,
    private readonly prefix: string,
  ) {}

  get(projectId: string, window: MetricWindow): Promise<ProjectMetrics> {
    return this.loader.get(`${this.prefix}:metrics:${projectId}:${window}`, { freshMs: 5_000, staleMs: 60_000 }, () =>
      this.compute(projectId, window),
    );
  }

  async compute(projectId: string, window: MetricWindow): Promise<ProjectMetrics> {
    const { minutes, stepMinutes } = METRIC_WINDOWS[window];
    const pool = await this.router.pool();
    const since = new Date(Math.floor((Date.now() - minutes * 60_000) / 60_000) * 60_000);
    const [counts, totals, series, checkpoint] = await Promise.all([
      pool.query<{ status: JobStatus; count: string }>(
        'SELECT status, count::text FROM project_job_counts WHERE project_id = $1',
        [projectId],
      ),
      pool.query<{
        submitted: number;
        started: number;
        succeeded: number;
        failed: number;
        retried: number;
        cancelled: number;
        exec_sum: string;
        wait_sum: string;
        exec_hist: number[] | null;
        wait_hist: number[] | null;
      }>(
        `SELECT coalesce(sum(submitted), 0)::int AS submitted, coalesce(sum(started), 0)::int AS started,
                coalesce(sum(succeeded), 0)::int AS succeeded, coalesce(sum(failed), 0)::int AS failed,
                coalesce(sum(retried), 0)::int AS retried, coalesce(sum(cancelled), 0)::int AS cancelled,
                coalesce(sum(exec_ms_sum), 0)::text AS exec_sum, coalesce(sum(wait_ms_sum), 0)::text AS wait_sum,
                (SELECT array_agg(v ORDER BY i) FROM (
                   SELECT h.i, sum(h.v)::int AS v FROM job_stats_minutely s2, unnest(s2.exec_ms_hist) WITH ORDINALITY AS h(v, i)
                   WHERE s2.project_id = $1 AND s2.bucket >= $2 GROUP BY h.i) x) AS exec_hist,
                (SELECT array_agg(v ORDER BY i) FROM (
                   SELECT h.i, sum(h.v)::int AS v FROM job_stats_minutely s2, unnest(s2.wait_ms_hist) WITH ORDINALITY AS h(v, i)
                   WHERE s2.project_id = $1 AND s2.bucket >= $2 GROUP BY h.i) x) AS wait_hist
         FROM job_stats_minutely WHERE project_id = $1 AND bucket >= $2`,
        [projectId, since],
      ),
      pool.query<{ t: Date; submitted: number; succeeded: number; failed: number; retried: number }>(
        `SELECT date_bin(make_interval(mins => $3), bucket, TIMESTAMPTZ 'epoch') AS t,
                sum(submitted)::int AS submitted, sum(succeeded)::int AS succeeded,
                sum(failed)::int AS failed, sum(retried)::int AS retried
         FROM job_stats_minutely WHERE project_id = $1 AND bucket >= $2
         GROUP BY 1 ORDER BY 1`,
        [projectId, since, stepMinutes],
      ),
      pool.query<{ updated_at: Date }>("SELECT updated_at FROM projection_checkpoints WHERE name = 'job_read_model'"),
    ]);

    const countMap = Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])) as Record<JobStatus, number>;
    for (const r of counts.rows) countMap[r.status] = Math.max(0, Number(r.count));

    const t = totals.rows[0];
    const empty = new Array<number>(HISTOGRAM_SIZE).fill(0);
    const finished = (t?.succeeded ?? 0) + (t?.failed ?? 0);

    // Fill empty steps so charts show gaps as zeros rather than interpolating across them.
    const step = stepMinutes * 60_000;
    const byTime = new Map(series.rows.map((r) => [r.t.getTime(), r]));
    const filled: ProjectMetrics['series'] = [];
    for (let ts = Math.floor(since.getTime() / step) * step; ts <= Date.now(); ts += step) {
      const r = byTime.get(ts);
      filled.push({
        t: new Date(ts).toISOString(),
        submitted: r?.submitted ?? 0,
        succeeded: r?.succeeded ?? 0,
        failed: r?.failed ?? 0,
        retried: r?.retried ?? 0,
      });
    }

    return {
      window,
      generatedAt: new Date().toISOString(),
      readModelAsOf: checkpoint.rows[0]?.updated_at.toISOString() ?? null,
      counts: countMap,
      totals: {
        submitted: t?.submitted ?? 0,
        started: t?.started ?? 0,
        succeeded: t?.succeeded ?? 0,
        failed: t?.failed ?? 0,
        retried: t?.retried ?? 0,
        cancelled: t?.cancelled ?? 0,
        successRate: finished ? (t?.succeeded ?? 0) / finished : null,
      },
      latency: {
        execution: summarize(t?.exec_hist ?? empty, Number(t?.exec_sum ?? 0)),
        queueWait: summarize(t?.wait_hist ?? empty, Number(t?.wait_sum ?? 0)),
      },
      series: filled,
    };
  }
}
