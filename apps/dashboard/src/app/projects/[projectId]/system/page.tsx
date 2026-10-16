'use client';

import { useQuery } from '@tanstack/react-query';
import { StatTile } from '@/components/charts';
import { PageHeader } from '@/components/shell';
import { EmptyState, ErrorState, LoadingRows } from '@/components/states';
import { WorkerBadge } from '@/components/status';
import { Card } from '@/components/ui';
import { api } from '@/lib/api';
import { compact, formatDuration, relativeTime } from '@/lib/format';

export default function SystemPage() {
  const system = useQuery({
    queryKey: ['system', 'queues'],
    queryFn: api.systemQueues,
    refetchInterval: 5_000,
  });
  const workers = useQuery({ queryKey: ['system', 'workers'], queryFn: api.workers, refetchInterval: 5_000 });
  const s = system.data;

  return (
    <>
      <PageHeader
        title="Workers & queues"
        description="Shared infrastructure for all projects. Snapshots refresh every few seconds and arrive over the live stream."
      />
      {system.isError ? (
        <ErrorState error={system.error} onRetry={() => void system.refetch()} />
      ) : !s ? (
        <LoadingRows rows={3} />
      ) : (
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile
              label="Workers online"
              value={String(s.workers.online)}
              sub={s.workers.draining ? `${s.workers.draining} draining` : undefined}
            />
            <StatTile
              label="Worker utilization"
              value={
                s.workers.capacity ? `${Math.round((s.workers.activeJobs / s.workers.capacity) * 100)}%` : '-'
              }
              sub={`${s.workers.activeJobs} of ${s.workers.capacity} slots`}
            />
            <StatTile
              label="Oldest queued job"
              value={formatDuration(s.oldestQueuedAgeSeconds * 1000)}
              sub={`${compact(s.jobs.queued)} queued in total`}
            />
            <StatTile
              label="Outbox backlog"
              value={compact(s.outbox.pending)}
              sub={`oldest ${formatDuration(s.outbox.oldestAgeSeconds * 1000)}`}
            />
          </div>
          <Card title="Queues">
            <div className="overflow-x-auto">
              <table className="w-full text-sm tabular">
                <caption className="sr-only">Queue depth by state</caption>
                <thead className="text-left text-xs text-muted">
                  <tr>
                    <th className="py-1.5 pr-4 font-medium">Queue</th>
                    {['waiting', 'active', 'delayed', 'completed', 'failed'].map((h) => (
                      <th key={h} className="py-1.5 pr-4 text-right font-medium capitalize">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(s.queues).map(([name, c]) => (
                    <tr key={name} className="border-t border-line">
                      <td className="py-1.5 pr-4 font-medium">{name}</td>
                      {['waiting', 'active', 'delayed', 'completed', 'failed'].map((h) => (
                        <td key={h} className="py-1.5 pr-4 text-right">
                          {c[h] ?? 0}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-muted">
                BullMQ counts. “completed/failed” are delivery records kept for an hour/day; job outcomes live
                in PostgreSQL. Jobs in PostgreSQL: {s.jobs.scheduled} scheduled · {s.jobs.queued} queued ·{' '}
                {s.jobs.running} running · {s.jobs.retry_wait} waiting to retry.
              </p>
            </div>
          </Card>
          <Card title="Workers">
            {workers.isPending ? (
              <LoadingRows rows={2} />
            ) : workers.isError ? (
              <ErrorState error={workers.error} />
            ) : workers.data.items.length === 0 ? (
              <EmptyState title="No workers have reported in the last hour">
                Start one with <code className="font-mono">npm run dev:worker -w @scaleflow/server</code>.
                Queued jobs wait until a worker is available; nothing is lost.
              </EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <caption className="sr-only">Workers</caption>
                  <thead className="text-left text-xs text-muted">
                    <tr>
                      <th className="py-1.5 pr-4 font-medium">Worker</th>
                      <th className="py-1.5 pr-4 font-medium">Status</th>
                      <th className="py-1.5 pr-4 font-medium">Queues</th>
                      <th className="py-1.5 pr-4 text-right font-medium">Busy</th>
                      <th className="py-1.5 pr-4 text-right font-medium">Processed</th>
                      <th className="py-1.5 pr-4 font-medium">Heartbeat</th>
                    </tr>
                  </thead>
                  <tbody>
                    {workers.data.items.map((w) => (
                      <tr key={w.id} className="border-t border-line">
                        <td className="py-1.5 pr-4 font-mono text-xs">{w.id}</td>
                        <td className="py-1.5 pr-4">
                          <WorkerBadge status={w.status} />
                        </td>
                        <td className="py-1.5 pr-4 text-ink-2">{w.queues.join(', ')}</td>
                        <td className="tabular py-1.5 pr-4 text-right">
                          {w.activeJobs}/{w.concurrency}
                        </td>
                        <td className="tabular py-1.5 pr-4 text-right">{compact(w.processedTotal)}</td>
                        <td className="py-1.5 pr-4 text-ink-2">{relativeTime(w.lastHeartbeatAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
