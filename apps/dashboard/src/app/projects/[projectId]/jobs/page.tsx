'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { JobActions } from '@/components/job-actions';
import { PageHeader } from '@/components/shell';
import { EmptyState, ErrorState, LoadingRows } from '@/components/states';
import { StatusBadge, statusLabel } from '@/components/status';
import { Button, Notice, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { relativeTime, shortId } from '@/lib/format';
import { JOB_STATUSES, type JobStatus } from '@/lib/types';

function JobsTable() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const search = useSearchParams();
  const status = (search.get('status') ?? '') as JobStatus | '';
  const type = search.get('type') ?? '';
  const queue = search.get('queue') ?? '';
  const [actionError, setActionError] = useState<string | null>(null);

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(search.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.replace(`/projects/${projectId}/jobs${next.toString() ? `?${next.toString()}` : ''}`);
  };

  const types = useQuery({ queryKey: ['job-types'], queryFn: api.jobTypes, staleTime: 300_000 });
  const filters = { status: status ? [status] : undefined, type: type || undefined, queue: queue || undefined };
  const jobs = useInfiniteQuery({
    queryKey: ['jobs', projectId, filters],
    queryFn: ({ pageParam }) => api.jobs(projectId, filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = jobs.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHeader
        title="Jobs"
        description="Newest first. Updates live as workers pick jobs up. The “Failed” filter is the dead-letter queue."
        actions={
          <Link href={`/projects/${projectId}/jobs/new`} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink">
            Submit job
          </Link>
        }
      />
      <div className="mb-4 flex flex-wrap gap-3" role="group" aria-label="Filters">
        <label className="flex items-center gap-2 text-sm text-ink-2">
          Status
          <Select value={status} onChange={(e) => setFilter('status', e.target.value)} className="w-auto">
            <option value="">All</option>
            {JOB_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex items-center gap-2 text-sm text-ink-2">
          Type
          <Select value={type} onChange={(e) => setFilter('type', e.target.value)} className="w-auto">
            <option value="">All</option>
            {types.data?.items.map((t) => (
              <option key={t.type} value={t.type}>
                {t.type}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex items-center gap-2 text-sm text-ink-2">
          Queue
          <Select value={queue} onChange={(e) => setFilter('queue', e.target.value)} className="w-auto">
            <option value="">All</option>
            {types.data?.queues.map((q) => (
              <option key={q} value={q}>
                {q}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {actionError && (
        <div className="mb-3">
          <Notice tone="error">{actionError}</Notice>
        </div>
      )}
      {jobs.isPending ? (
        <LoadingRows rows={8} />
      ) : jobs.isError ? (
        <ErrorState error={jobs.error} onRetry={() => void jobs.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={status || type || queue ? 'No jobs match these filters' : 'No jobs yet'}
          action={
            <Link href={`/projects/${projectId}/jobs/new`} className="text-sm font-medium text-accent hover:underline">
              Submit your first job
            </Link>
          }
        >
          Jobs submitted through the API or this dashboard appear here in real time.
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[720px] text-sm">
            <caption className="sr-only">Jobs</caption>
            <thead className="border-b border-line text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Job</th>
                <th className="px-3 py-2 font-medium">Queue</th>
                <th className="px-3 py-2 text-right font-medium">Attempts</th>
                <th className="px-3 py-2 font-medium">Last error</th>
                <th className="px-3 py-2 font-medium">Created</th>
                <th className="px-3 py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((j) => (
                <tr key={j.id} className="border-b border-line last:border-0 hover:bg-surface-2">
                  <td className="px-3 py-2">
                    <StatusBadge status={j.status} />
                  </td>
                  <td className="px-3 py-2">
                    <Link href={`/projects/${projectId}/jobs/${j.id}`} className="text-accent hover:underline">
                      {j.type}
                    </Link>
                    <div className="font-mono text-xs text-muted">…{shortId(j.id)}</div>
                  </td>
                  <td className="px-3 py-2 text-ink-2">{j.queue}</td>
                  <td className="tabular px-3 py-2 text-right text-ink-2">
                    {j.runAttempts}/{j.maxAttempts}
                  </td>
                  <td className="max-w-[16rem] truncate px-3 py-2 font-mono text-xs text-ink-2" title={j.lastError?.message}>
                    {j.lastError?.code ?? ''}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-ink-2">
                    <time dateTime={j.createdAt}>{relativeTime(j.createdAt)}</time>
                  </td>
                  <td className="px-3 py-2">
                    <JobActions job={j} compact onError={setActionError} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {jobs.hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button busy={jobs.isFetchingNextPage} onClick={() => void jobs.fetchNextPage()}>
            Load more
          </Button>
        </div>
      )}
    </>
  );
}

export default function JobsPage() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={<LoadingRows rows={8} />}>
      <JobsTable />
    </Suspense>
  );
}
