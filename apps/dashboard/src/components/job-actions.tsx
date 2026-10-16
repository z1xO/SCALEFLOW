'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Job } from '@/lib/types';
import { Button } from './ui';

const CANCELLABLE = new Set(['scheduled', 'queued', 'retry_wait']);

/** Retry (failed jobs) and Cancel (not yet running) - both real API calls. */
export function JobActions({ job, compact = false, onError }: { job: Job; compact?: boolean; onError?: (msg: string) => void }) {
  const qc = useQueryClient();
  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['jobs', job.projectId] }),
      qc.invalidateQueries({ queryKey: ['job', job.projectId, job.id] }),
    ]);
  };
  const retry = useMutation({
    mutationFn: () => api.retryJob(job.projectId, job.id),
    onSuccess: refresh,
    onError: (e) => onError?.(e.message),
  });
  const cancel = useMutation({
    mutationFn: () => api.cancelJob(job.projectId, job.id),
    onSuccess: refresh,
    onError: (e) => onError?.(e.message),
  });
  const size = compact ? 'px-2 py-0.5 text-xs' : '';
  return (
    <div className="flex gap-2">
      {job.status === 'failed' && (
        <Button className={size} busy={retry.isPending} onClick={() => retry.mutate()} aria-label={`Retry job ${job.id}`}>
          Retry
        </Button>
      )}
      {CANCELLABLE.has(job.status) && (
        <Button className={size} variant="danger" busy={cancel.isPending} onClick={() => cancel.mutate()} aria-label={`Cancel job ${job.id}`}>
          Cancel
        </Button>
      )}
    </div>
  );
}
