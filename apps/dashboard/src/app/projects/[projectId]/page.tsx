'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { StatTile, ThroughputChart } from '@/components/charts';
import { EventFeed } from '@/components/event-feed';
import { PageHeader } from '@/components/shell';
import { ErrorState, LoadingRows } from '@/components/states';
import { Card, Select, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { compact, formatDuration, percent, relativeTime } from '@/lib/format';
import { useStream } from '@/lib/stream';
import type { JobEvent, MetricWindow } from '@/lib/types';

export default function OverviewPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [window, setWindow] = useState<MetricWindow>('1h');
  const metrics = useQuery({
    queryKey: ['metrics', projectId, window],
    queryFn: () => api.metrics(projectId, window),
    refetchInterval: 15_000,
  });
  const system = useQuery({ queryKey: ['system', 'queues'], queryFn: api.systemQueues, refetchInterval: 10_000 });
  const history = useQuery({ queryKey: ['events', projectId, 'recent'], queryFn: () => api.projectEvents(projectId, 30) });
  const { recent } = useStream();

  // Live events first, then history, de-duplicated by cursor.
  const seen = new Set<string>();
  const feed: JobEvent[] = [];
  for (const e of [...recent, ...(history.data?.items ?? [])]) {
    if (!seen.has(e.cursor)) {
      seen.add(e.cursor);
      feed.push(e);
    }
  }

  const m = metrics.data;
  const active = m ? m.counts.queued + m.counts.running + m.counts.retry_wait + m.counts.scheduled : 0;

  return (
    <>
      <PageHeader
        title="Overview"
        description={m?.readModelAsOf ? `Read model updated ${relativeTime(m.readModelAsOf)} (eventually consistent, ~1 s behind)` : undefined}
        actions={
          <label className="flex items-center gap-2 text-sm text-ink-2">
            Window
            <Select value={window} onChange={(e) => setWindow(e.target.value as MetricWindow)} className="w-auto">
              <option value="15m">Last 15 minutes</option>
              <option value="1h">Last hour</option>
              <option value="6h">Last 6 hours</option>
              <option value="24h">Last 24 hours</option>
            </Select>
          </label>
        }
      />
      {metrics.isError ? (
        <ErrorState error={metrics.error} onRetry={() => void metrics.refetch()} />
      ) : (
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            {!m ? (
              Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-20" />)
            ) : (
              <>
                <StatTile label="Success rate" value={percent(m.totals.successRate)} sub={`${compact(m.totals.succeeded)} ok · ${compact(m.totals.failed)} failed`} />
                <StatTile label="Submitted" value={compact(m.totals.submitted)} sub={`${compact(m.totals.retried)} retries scheduled`} />
                <StatTile label="Active jobs" value={compact(active)} sub={`${m.counts.running} running · ${m.counts.queued} queued`} />
                <StatTile
                  label="Execution time"
                  value={formatDuration(m.latency.execution.p50Ms)}
                  sub={`p95 ${formatDuration(m.latency.execution.p95Ms)} · p99 ${formatDuration(m.latency.execution.p99Ms)}`}
                />
                <StatTile
                  label="Queue wait"
                  value={formatDuration(m.latency.queueWait.p50Ms)}
                  sub={`p95 ${formatDuration(m.latency.queueWait.p95Ms)} · p99 ${formatDuration(m.latency.queueWait.p99Ms)}`}
                />
              </>
            )}
          </div>

          <Card title="Throughput">{m ? <ThroughputChart series={m.series} /> : <Skeleton className="h-72" />}</Card>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card title="Queue health" actions={<Link className="text-xs text-accent hover:underline" href={`/projects/${projectId}/system`}>Details</Link>}>
              {system.isPending ? (
                <LoadingRows rows={3} />
              ) : system.isError ? (
                <ErrorState error={system.error} onRetry={() => void system.refetch()} />
              ) : (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
                  {Object.entries(system.data.queues).map(([name, c]) => (
                    <div key={name}>
                      <dt className="text-xs text-muted">Queue “{name}”</dt>
                      <dd className="tabular text-ink">
                        {c.waiting ?? 0} waiting · {c.active ?? 0} active
                      </dd>
                    </div>
                  ))}
                  <div>
                    <dt className="text-xs text-muted">Oldest queued job</dt>
                    <dd className="tabular text-ink">{formatDuration(system.data.oldestQueuedAgeSeconds * 1000)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Outbox backlog</dt>
                    <dd className="tabular text-ink">{system.data.outbox.pending} rows</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Workers</dt>
                    <dd className="tabular text-ink">
                      {system.data.workers.online} online · {system.data.workers.activeJobs}/{system.data.workers.capacity} slots busy
                    </dd>
                  </div>
                </dl>
              )}
            </Card>
            <Card title="Recent events" actions={<span className="text-xs text-muted">live</span>}>
              {history.isPending ? (
                <LoadingRows rows={4} />
              ) : history.isError ? (
                <ErrorState error={history.error} onRetry={() => void history.refetch()} />
              ) : (
                <div className="max-h-96 overflow-auto">
                  <EventFeed events={feed.slice(0, 40)} projectId={projectId} empty="No events yet. Submit a job to see it flow through." />
                </div>
              )}
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
