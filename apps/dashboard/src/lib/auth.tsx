'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { ErrorState } from '@/components/states';
import { Spinner } from '@/components/ui';
import { api, ApiError } from './api';

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: 60_000 });
}

/** Renders children only for a logged-in user; redirects to /login on 401. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const me = useMe();
  const router = useRouter();
  const unauthorized = me.error instanceof ApiError && me.error.status === 401;
  useEffect(() => {
    if (unauthorized) router.replace('/login');
  }, [unauthorized, router]);

  if (me.isPending || unauthorized) {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted">
        <Spinner label="Checking your session" />
      </div>
    );
  }
  if (me.isError) {
    return (
      <div className="mx-auto mt-20 max-w-lg px-4">
        <ErrorState error={me.error} onRetry={() => void me.refetch()} />
      </div>
    );
  }
  return <>{children}</>;
}
