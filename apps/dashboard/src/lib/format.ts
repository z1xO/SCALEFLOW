export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '-';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '-';
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  if (abs < 5_000) return 'just now';
  if (abs < 60_000) return rtf.format(Math.round(diff / 1000), 'second');
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), 'hour');
  return rtf.format(Math.round(diff / 86_400_000), 'day');
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function shortId(id: string): string {
  return id.slice(-8);
}

export function percent(v: number | null | undefined): string {
  if (v === null || v === undefined) return '-';
  return `${(v * 100).toFixed(v >= 0.999 || v === 0 ? 0 : 1)}%`;
}

export function compact(n: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}
