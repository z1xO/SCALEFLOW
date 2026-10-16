'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { useStream, type StreamStatus } from '@/lib/stream';
import { Button, Select } from './ui';

const CONNECTION: Record<StreamStatus, { label: string; glyph: string; color: string; hint: string }> = {
  connecting: {
    label: 'Connecting',
    glyph: '◌',
    color: 'var(--ink-muted)',
    hint: 'Opening the live event stream',
  },
  live: { label: 'Live', glyph: '●', color: 'var(--good)', hint: 'Receiving real-time updates' },
  reconnecting: {
    label: 'Reconnecting',
    glyph: '◐',
    color: 'var(--warning)',
    hint: 'Connection lost; resuming from the last received event',
  },
  offline: {
    label: 'Offline',
    glyph: '○',
    color: 'var(--critical)',
    hint: 'Live updates paused; data may be stale',
  },
};

export function ConnectionIndicator() {
  const { status } = useStream();
  const c = CONNECTION[status];
  return (
    <span
      title={c.hint}
      data-testid="connection-status"
      data-state={status}
      className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-2"
    >
      <span aria-hidden style={{ color: c.color }}>
        {c.glyph}
      </span>
      <span aria-live="polite">{c.label}</span>
    </span>
  );
}

const NAV = [
  { href: '', label: 'Overview' },
  { href: '/jobs', label: 'Jobs' },
  { href: '/jobs/new', label: 'Submit job' },
  { href: '/schedules', label: 'Schedules' },
  { href: '/system', label: 'Workers & queues' },
  { href: '/settings', label: 'API keys & members' },
];

export function ProjectShell({ projectId, children }: { projectId: string; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const qc = useQueryClient();
  const me = useMe();
  const logout = useMutation({
    mutationFn: api.logout,
    onSettled: () => {
      qc.clear();
      router.replace('/login');
    },
  });
  const base = `/projects/${projectId}`;
  const isActive = (href: string) => {
    const full = `${base}${href}`;
    if (href === '') return pathname === base;
    if (href === '/jobs') return pathname.startsWith(full) && !pathname.startsWith(`${base}/jobs/new`);
    return pathname.startsWith(full);
  };

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col gap-4 border-b border-line bg-surface p-4 md:w-60 md:border-r md:border-b-0">
        <div className="flex items-center justify-between">
          <Link href="/projects" className="text-base font-semibold text-ink">
            ScaleFlow
          </Link>
          <ConnectionIndicator />
        </div>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Project
          <Select
            aria-label="Switch project"
            value={projectId}
            onChange={(e) => {
              if (e.target.value === '__all') router.push('/projects');
              else router.push(`/projects/${e.target.value}`);
            }}
          >
            {(me.data?.memberships ?? []).map((m) => (
              <option key={m.projectId} value={m.projectId}>
                {m.projectName}
              </option>
            ))}
            <option value="__all">All projects…</option>
          </Select>
        </label>
        <nav aria-label="Project" className="-mx-1 flex gap-1 overflow-x-auto md:flex-col">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={`${base}${item.href}`}
              aria-current={isActive(item.href) ? 'page' : undefined}
              className={`whitespace-nowrap rounded-md px-2 py-1.5 text-sm ${
                isActive(item.href) ? 'bg-surface-2 font-medium text-ink' : 'text-ink-2 hover:bg-surface-2'
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto hidden flex-col gap-2 border-t border-line pt-3 md:flex">
          <span className="truncate text-xs text-muted" title={me.data?.user.email}>
            {me.data?.user.email}
          </span>
          <Button
            variant="ghost"
            className="justify-start"
            busy={logout.isPending}
            onClick={() => logout.mutate()}
          >
            Log out
          </Button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-4 md:p-6">{children}</main>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-xl font-semibold text-ink">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
