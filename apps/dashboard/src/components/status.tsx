import type { JobStatus } from '@/lib/types';

/** Status is never color alone: each state has a glyph and a text label. */
const STATUS: Record<JobStatus, { label: string; glyph: string; color: string }> = {
  scheduled: { label: 'Scheduled', glyph: '◷', color: 'var(--ink-muted)' },
  queued: { label: 'Queued', glyph: '•', color: 'var(--warning)' },
  running: { label: 'Running', glyph: '▶', color: 'var(--accent)' },
  retry_wait: { label: 'Retry wait', glyph: '↻', color: 'var(--serious)' },
  succeeded: { label: 'Succeeded', glyph: '✓', color: 'var(--good)' },
  failed: { label: 'Failed', glyph: '✕', color: 'var(--critical)' },
  cancelled: { label: 'Cancelled', glyph: '⊘', color: 'var(--ink-muted)' },
};

export function statusLabel(s: JobStatus): string {
  return STATUS[s].label;
}

export function StatusBadge({ status }: { status: JobStatus }) {
  const s = STATUS[status];
  return (
    <span
      data-status={status}
      className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-xs font-medium text-ink"
    >
      <span aria-hidden style={{ color: s.color }} className="text-[0.8rem] leading-none">
        {s.glyph}
      </span>
      {s.label}
    </span>
  );
}

export function WorkerBadge({ status }: { status: 'online' | 'draining' | 'offline' }) {
  const map = {
    online: { glyph: '●', color: 'var(--good)', label: 'Online' },
    draining: { glyph: '◐', color: 'var(--warning)', label: 'Draining' },
    offline: { glyph: '○', color: 'var(--ink-muted)', label: 'Offline' },
  }[status];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ink">
      <span aria-hidden style={{ color: map.color }}>
        {map.glyph}
      </span>
      {map.label}
    </span>
  );
}
