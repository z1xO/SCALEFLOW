'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { JobActions } from '@/components/job-actions';
import { PageHeader } from '@/components/shell';
import { EmptyState, ErrorState, LoadingRows } from '@/components/states';
import { StatusBadge } from '@/components/status';
import { Card, CodeBlock, Notice } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { dateTime, formatDuration, relativeTime } from '@/lib/format';

const ATTEMPT_LABEL = { running: 'Running', succeeded: 'Succeeded', failed: 'Failed', timed_out: 'Timed out', lost: 'Lost (worker died)' };

export default function JobDetailPage() {
  const { projectId, jobId } = useParams<{ projectId: string; jobId: string }>();
  const [actionError, setActionError] = useState<string | null>(null);
  // All three share the ['job', projectId, jobId] prefix, so a live event refreshes them together.
  const job = useQuery({ queryKey: ['job', projectId, jobId], queryFn: () => api.job(projectId, jobId) });
  const attempts = useQuery({ queryKey: ['job', projectId, jobId, 'attempts'], queryFn: () => api.attempts(projectId, jobId) });
  const events = useQuery({ queryKey: ['job', projectId, jobId, 'events'], queryFn: () => api.jobEvents(projectId, jobId) });

  if (job.isPending) return <LoadingRows rows={6} />;
  if (job.isError) {
    if (job.error instanceof ApiError && job.error.status === 404) {
      return (
        <EmptyState title="Job not found" action={<Link className="text-sm text-accent hover:underline" href={`/projects/${projectId}/jobs`}>Back to jobs</Link>}>
          It may belong to another project, or it was removed by the retention policy.
        </EmptyState>
      );
    }
    return <ErrorState error={job.error} onRetry={() => void job.refetch()} />;
  }
  const j = job.data.job;

  return (
    <>
      <PageHeader
        title={j.type}
        description={<span className="font-mono">{j.id}</span>}
        actions={<JobActions job={j} onError={setActionError} />}
      />
      {actionError && (
        <div className="mb-4">
          <Notice tone="error">{actionError}</Notice>
        </div>
      )}
      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Status" className="lg:col-span-1">
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5 text-sm">
            <dt className="text-muted">State</dt>
            <dd data-testid="job-status">
              <StatusBadge status={j.status} />
            </dd>
            <dt className="text-muted">Queue</dt>
            <dd>{j.queue}</dd>
            <dt className="text-muted">Attempts</dt>
            <dd className="tabular">
              {j.runAttempts} of {j.maxAttempts} (total {j.attemptCount})
            </dd>
            <dt className="text-muted">Backoff</dt>
            <dd>
              {j.backoff.type}, {formatDuration(j.backoff.baseDelayMs)}–{formatDuration(j.backoff.maxDelayMs)}
            </dd>
            <dt className="text-muted">Timeout</dt>
            <dd>{formatDuration(j.timeoutMs)}</dd>
            <dt className="text-muted">Created</dt>
            <dd title={dateTime(j.createdAt)}>{relativeTime(j.createdAt)}</dd>
            <dt className="text-muted">{j.status === 'scheduled' || j.status === 'retry_wait' ? 'Runs' : 'Run at'}</dt>
            <dd title={dateTime(j.runAt)}>{relativeTime(j.runAt)}</dd>
            {j.finishedAt && (
              <>
                <dt className="text-muted">Finished</dt>
                <dd title={dateTime(j.finishedAt)}>{relativeTime(j.finishedAt)}</dd>
              </>
            )}
            {j.lockedBy && (
              <>
                <dt className="text-muted">Worker</dt>
                <dd className="truncate font-mono text-xs" title={j.lockedBy}>
                  {j.lockedBy}
                </dd>
              </>
            )}
            {j.idempotencyKey && (
              <>
                <dt className="text-muted">Idempotency key</dt>
                <dd className="truncate font-mono text-xs">{j.idempotencyKey}</dd>
              </>
            )}
            {j.correlationId && (
              <>
                <dt className="text-muted">Correlation id</dt>
                <dd className="truncate font-mono text-xs" title={j.correlationId}>
                  {j.correlationId}
                </dd>
              </>
            )}
          </dl>
        </Card>
        <div className="flex flex-col gap-5 lg:col-span-2">
          {j.lastError && (
            <Card title="Last error">
              <p className="font-mono text-sm text-critical-ink">{j.lastError.code}</p>
              <p className="mt-1 text-sm text-ink-2">{j.lastError.message}</p>
              <p className="mt-1 text-xs text-muted">{j.lastError.retryable ? 'Retryable error' : 'Permanent error (not retried)'}</p>
            </Card>
          )}
          <Card title="Payload">
            <CodeBlock value={j.payload} />
          </Card>
          {j.result !== null && (
            <Card title="Result">
              <CodeBlock value={j.result} />
            </Card>
          )}
        </div>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card title="Attempts">
          {attempts.isPending ? (
            <LoadingRows rows={2} />
          ) : attempts.isError ? (
            <ErrorState error={attempts.error} />
          ) : attempts.data.items.length === 0 ? (
            <p className="text-sm text-muted">Not started yet.</p>
          ) : (
            <ol className="flex flex-col gap-3">
              {attempts.data.items.map((a) => (
                <li key={a.id} className="rounded-md border border-line p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">
                      Attempt {a.attemptNumber} · {ATTEMPT_LABEL[a.status]}
                    </span>
                    <span className="text-xs text-muted">{relativeTime(a.startedAt)}</span>
                  </div>
                  <div className="mt-1 text-xs text-muted">
                    ran {formatDuration(a.durationMs)} · waited {formatDuration(a.queueWaitMs)} in queue ·{' '}
                    <span className="font-mono">{a.workerId}</span>
                  </div>
                  {a.error && (
                    <div className="mt-2 rounded bg-surface-2 p-2 font-mono text-xs text-ink-2">
                      {a.error.code}: {a.error.message}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
        </Card>
        <Card title="Timeline">
          {events.isPending ? (
            <LoadingRows rows={3} />
          ) : events.isError ? (
            <ErrorState error={events.error} />
          ) : (
            <ol className="flex flex-col gap-2 text-sm">
              {events.data.items.map((e) => (
                <li key={e.cursor} className="flex items-center gap-3">
                  <StatusBadge status={e.data.to} />
                  <span className="text-ink-2">{e.type.replace('job.', '').replace('_', ' ')}</span>
                  {e.data.reason && <span className="text-xs text-muted">({e.data.reason.replace('_', ' ')})</span>}
                  <time className="ml-auto text-xs text-muted" dateTime={e.createdAt} title={dateTime(e.createdAt)}>
                    {relativeTime(e.createdAt)}
                  </time>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
    </>
  );
}
