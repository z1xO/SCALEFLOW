'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { PageHeader } from '@/components/shell';
import { EmptyState, ErrorState, LoadingRows } from '@/components/states';
import { Button, Card, Field, Input, Notice, Select, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime, relativeTime } from '@/lib/format';

export default function SchedulesPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const qc = useQueryClient();
  const schedules = useQuery({ queryKey: ['schedules', projectId], queryFn: () => api.schedules(projectId), refetchInterval: 30_000 });
  const types = useQuery({ queryKey: ['job-types'], queryFn: api.jobTypes, staleTime: 300_000 });
  const refresh = () => qc.invalidateQueries({ queryKey: ['schedules', projectId] });

  const [name, setName] = useState('');
  const [cron, setCron] = useState('*/5 * * * *');
  const [timezone, setTimezone] = useState('UTC');
  const [jobType, setJobType] = useState('demo.echo');
  const [payload, setPayload] = useState('{\n  "message": "scheduled"\n}');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.createSchedule(projectId, {
        name: name.trim(),
        cron: cron.trim(),
        timezone,
        jobType,
        queue: 'default',
        payload: JSON.parse(payload || '{}') as Record<string, unknown>,
      }),
    onSuccess: async () => {
      setName('');
      await refresh();
    },
    onError: (e) => setError(e.message),
  });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.updateSchedule(projectId, id, { enabled }),
    onSuccess: refresh,
    onError: (e) => setError(e.message),
  });
  const trigger = useMutation({
    mutationFn: (id: string) => api.triggerSchedule(projectId, id),
    onSuccess: refresh,
    onError: (e) => setError(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteSchedule(projectId, id),
    onSuccess: refresh,
    onError: (e) => setError(e.message),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      JSON.parse(payload || '{}');
    } catch {
      setError('Payload must be valid JSON.');
      return;
    }
    create.mutate();
  };

  return (
    <>
      <PageHeader title="Schedules" description="Recurring jobs (cron). Each tick creates exactly one job, even with several schedulers running." />
      {error && (
        <div className="mb-4">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Schedules" className="lg:col-span-2">
          {schedules.isPending ? (
            <LoadingRows rows={3} />
          ) : schedules.isError ? (
            <ErrorState error={schedules.error} onRetry={() => void schedules.refetch()} />
          ) : schedules.data.items.length === 0 ? (
            <EmptyState title="No schedules">Create one to run a job type on a cron expression.</EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {schedules.data.items.map((s) => (
                <li key={s.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {s.name} {!s.enabled && <span className="text-xs text-muted">(paused)</span>}
                    </p>
                    <p className="font-mono text-xs text-ink-2">
                      {s.cron} · {s.timezone} · {s.jobType}
                    </p>
                    <p className="text-xs text-muted">
                      next {s.enabled ? <span title={dateTime(s.nextRunAt)}>{relativeTime(s.nextRunAt)}</span> : '—'}
                      {s.lastJobId && (
                        <>
                          {' · '}
                          <Link className="text-accent hover:underline" href={`/projects/${projectId}/jobs/${s.lastJobId}`}>
                            last run {relativeTime(s.lastRunAt)}
                          </Link>
                        </>
                      )}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => trigger.mutate(s.id)} busy={trigger.isPending && trigger.variables === s.id}>
                      Run now
                    </Button>
                    <Button onClick={() => toggle.mutate({ id: s.id, enabled: !s.enabled })}>{s.enabled ? 'Pause' : 'Resume'}</Button>
                    <Button variant="danger" onClick={() => remove.mutate(s.id)} aria-label={`Delete schedule ${s.name}`}>
                      Delete
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="New schedule">
          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />}</Field>
            <Field label="Cron expression" hint="5 fields (min hour day month weekday); at most once a minute.">
              {(id) => <Input id={id} className="font-mono" value={cron} onChange={(e) => setCron(e.target.value)} required />}
            </Field>
            <Field label="Time zone" hint="IANA name, e.g. Europe/Berlin.">
              {(id) => <Input id={id} value={timezone} onChange={(e) => setTimezone(e.target.value)} required />}
            </Field>
            <Field label="Job type">
              {(id) => (
                <Select id={id} value={jobType} onChange={(e) => setJobType(e.target.value)}>
                  {types.data?.items.map((t) => (
                    <option key={t.type} value={t.type}>
                      {t.type}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Payload (JSON)">{(id) => <Textarea id={id} rows={4} value={payload} onChange={(e) => setPayload(e.target.value)} />}</Field>
            <Button type="submit" variant="primary" busy={create.isPending} disabled={!name.trim()}>
              Create schedule
            </Button>
          </form>
        </Card>
      </div>
    </>
  );
}
