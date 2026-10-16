'use client';

import type { ReactNode } from 'react';
import { ApiError } from '@/lib/api';
import { Button, Skeleton } from './ui';

export function LoadingRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line px-6 py-10 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {children && <div className="max-w-md text-sm text-muted">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Something went wrong';
  const requestId = error instanceof ApiError ? error.requestId : null;
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-2 rounded-lg border border-critical/40 bg-critical/10 px-4 py-3"
    >
      <p className="text-sm font-medium text-critical-ink">Could not load this data</p>
      <p className="text-sm text-ink-2">{message}</p>
      {requestId && <p className="font-mono text-xs text-muted">request id: {requestId}</p>}
      {onRetry && (
        <Button onClick={onRetry} variant="secondary">
          Try again
        </Button>
      )}
    </div>
  );
}
