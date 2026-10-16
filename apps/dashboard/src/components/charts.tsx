'use client';

import { useState } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ProjectMetrics } from '@/lib/types';
import { Button } from './ui';

/**
 * Categorical slots 1-4 in fixed order (validated light + dark; see docs/dashboard.md). Text never
 * wears series colors; identity is carried by the legend (end labels collided when lines overlap at
 * zero), and a table view is one click away - light-mode slots 3-4 are below 3:1 contrast, so the
 * table is the required relief.
 */
const SERIES = [
  { key: 'submitted', label: 'Submitted', color: 'var(--series-1)' },
  { key: 'succeeded', label: 'Succeeded', color: 'var(--series-2)' },
  { key: 'failed', label: 'Failed', color: 'var(--series-3)' },
  { key: 'retried', label: 'Retried', color: 'var(--series-4)' },
] as const;

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function ThroughputChart({ series }: { series: ProjectMetrics['series'] }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <Button variant="ghost" onClick={() => setAsTable(!asTable)} aria-pressed={asTable}>
          {asTable ? 'Show chart' : 'Show as table'}
        </Button>
      </div>
      {asTable ? (
        <div className="max-h-72 overflow-auto">
          <table className="w-full text-sm tabular">
            <caption className="sr-only">Jobs per interval</caption>
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="py-1 pr-3 font-medium">Time</th>
                {SERIES.map((s) => (
                  <th key={s.key} className="py-1 pr-3 text-right font-medium">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {series.map((row) => (
                <tr key={row.t} className="border-t border-line">
                  <td className="py-1 pr-3 text-ink-2">{timeLabel(row.t)}</td>
                  {SERIES.map((s) => (
                    <td key={s.key} className="py-1 pr-3 text-right text-ink">
                      {row[s.key]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="h-72 w-full" role="img" aria-label="Jobs submitted, succeeded, failed and retried per interval">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={series} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis
                dataKey="t"
                tickFormatter={timeLabel}
                stroke="var(--axis)"
                tick={{ fill: 'var(--ink-muted)', fontSize: 11 }}
                tickLine={false}
                minTickGap={40}
              />
              <YAxis allowDecimals={false} stroke="var(--axis)" tick={{ fill: 'var(--ink-muted)', fontSize: 11 }} tickLine={false} axisLine={false} />
              <Tooltip
                labelFormatter={(v) => timeLabel(String(v))}
                contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--ink)', fontSize: 12 }}
                itemStyle={{ color: 'var(--ink)' }}
                cursor={{ stroke: 'var(--axis)', strokeWidth: 1 }}
              />
              {/* itemSorter={null}: keep the fixed series order (Recharts sorts alphabetically by default). */}
              <Legend verticalAlign="top" align="left" height={28} iconType="plainline" itemSorter={null} wrapperStyle={{ fontSize: 12, color: 'var(--ink-2)' }} />
              {SERIES.map((s) => (
                <Line
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.label}
                  stroke={s.color}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

/** A single headline number. Not a chart: one value reads best as text. */
export function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-ink">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}
