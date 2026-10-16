'use client';

import Link from 'next/link';
import type { JobEvent } from '@/lib/types';
import { formatDuration, relativeTime, shortId } from '@/lib/format';
import { StatusBadge } from './status';

const VERB: Record<JobEvent['type'], string> = {
  'job.created': 'created',
  'job.queued': 'queued',
  'job.started': 'started',
  'job.succeeded': 'succeeded',
  'job.retry_scheduled': 'will retry',
  'job.failed': 'failed',
  'job.cancelled': 'cancelled',
};

function detail(e: JobEvent): string {
  const d = e.data;
  if (e.type === 'job.started' && d.attempt) return `attempt ${d.attempt}${d.workerId ? ` on ${d.workerId}` : ''}`;
  if (e.type === 'job.succeeded') return `in ${formatDuration(d.durationMs)}`;
  if (e.type === 'job.retry_scheduled') return `${d.error?.code ?? 'error'} · retry in ${formatDuration(d.delayMs)}`;
  if (e.type === 'job.failed') return `${d.error?.code ?? 'error'}${d.reason ? ` · ${d.reason.replace('_', ' ')}` : ''}`;
  if (e.type === 'job.queued' && d.reason) return d.reason.replace('_', ' ');
  return d.queue;
}

export function EventFeed({ events, projectId, empty }: { events: JobEvent[]; projectId: string; empty?: string }) {
  if (events.length === 0) {
    return <p className="text-sm text-muted">{empty ?? 'No events yet.'}</p>;
  }
  return (
    <ol className="flex flex-col divide-y divide-line" aria-live="polite" aria-relevant="additions">
      {events.map((e) => (
        <li key={e.cursor} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
          <StatusBadge status={e.data.to} />
          <Link href={`/projects/${projectId}/jobs/${e.jobId}`} className="font-mono text-xs text-accent hover:underline">
            {e.data.type} …{shortId(e.jobId)}
          </Link>
          <span className="text-ink-2">{VERB[e.type]}</span>
          <span className="text-xs text-muted">{detail(e)}</span>
          <time className="ml-auto text-xs text-muted" dateTime={e.createdAt}>
            {relativeTime(e.createdAt)}
          </time>
        </li>
      ))}
    </ol>
  );
}
