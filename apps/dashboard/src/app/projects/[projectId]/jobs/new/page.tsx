'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { PageHeader } from '@/components/shell';
import { ErrorState, LoadingRows } from '@/components/states';
import { Button, Card, Field, Input, Notice, Select, Textarea } from '@/components/ui';
import { api, ApiError, type CreateJobBody } from '@/lib/api';

const TEMPLATES: Record<string, Record<string, unknown>> = {
  'demo.echo': { message: 'hello from the dashboard' },
  'demo.sleep': { durationMs: 2000 },
  'demo.flaky': { succeedOnAttempt: 3 },
  'demo.cpu': { iterations: 200000 },
  'webhook.deliver': {
    url: 'https://example.com/webhooks/scaleflow',
    method: 'POST',
    body: { event: 'order.paid', orderId: 42 },
  },
};

function issuesOf(err: unknown): string[] {
  if (!(err instanceof ApiError)) return [];
  const d = err.details as
    { issues?: { path: string; message: string }[] } | { path?: string; message?: string }[] | undefined;
  if (Array.isArray(d)) return d.map((i) => `${i.path ?? ''} ${i.message ?? ''}`.trim());
  return d?.issues?.map((i) => `${i.path || 'payload'}: ${i.message}`) ?? [];
}

export default function SubmitJobPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const types = useQuery({ queryKey: ['job-types'], queryFn: api.jobTypes, staleTime: 300_000 });

  const [type, setType] = useState('demo.sleep');
  const [queue, setQueue] = useState('default');
  const [payload, setPayload] = useState(JSON.stringify(TEMPLATES['demo.sleep'], null, 2));
  const [delaySeconds, setDelaySeconds] = useState('0');
  const [maxAttempts, setMaxAttempts] = useState('3');
  const [backoffType, setBackoffType] = useState<'exponential' | 'fixed'>('exponential');
  const [baseDelayMs, setBaseDelayMs] = useState('1000');
  const [maxDelayMs, setMaxDelayMs] = useState('60000');
  const [timeoutMs, setTimeoutMs] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);

  const submit = useMutation({
    mutationFn: (body: CreateJobBody) => api.createJob(projectId, body, idempotencyKey.trim() || undefined),
    onSuccess: ({ job }) => router.push(`/projects/${projectId}/jobs/${job.id}`),
  });

  const onTypeChange = (t: string) => {
    setType(t);
    setPayload(JSON.stringify(TEMPLATES[t] ?? {}, null, 2));
    setJsonError(null);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload || '{}');
    } catch {
      setJsonError('Payload must be valid JSON.');
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setJsonError('Payload must be a JSON object.');
      return;
    }
    setJsonError(null);
    const delay = Number(delaySeconds) * 1000;
    submit.mutate({
      type,
      queue,
      payload: parsed as Record<string, unknown>,
      maxAttempts: Number(maxAttempts),
      backoff: { type: backoffType, baseDelayMs: Number(baseDelayMs), maxDelayMs: Number(maxDelayMs) },
      ...(delay > 0 ? { delayMs: delay } : {}),
      ...(timeoutMs ? { timeoutMs: Number(timeoutMs) } : {}),
    });
  };

  if (types.isPending) return <LoadingRows rows={6} />;
  if (types.isError) return <ErrorState error={types.error} onRetry={() => void types.refetch()} />;
  const description = types.data.items.find((t) => t.type === type)?.description;
  const issues = issuesOf(submit.error);

  return (
    <>
      <PageHeader title="Submit a job" description="Creates a real job through POST /v1/projects/:id/jobs." />
      <form onSubmit={onSubmit} className="grid gap-5 lg:grid-cols-3">
        <Card title="Job" className="lg:col-span-2">
          <div className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Type" hint={description}>
                {(id) => (
                  <Select id={id} value={type} onChange={(e) => onTypeChange(e.target.value)}>
                    {types.data.items.map((t) => (
                      <option key={t.type} value={t.type}>
                        {t.type}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Queue">
                {(id) => (
                  <Select id={id} value={queue} onChange={(e) => setQueue(e.target.value)}>
                    {types.data.queues.map((q) => (
                      <option key={q} value={q}>
                        {q}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            <Field label="Payload (JSON)" error={jsonError}>
              {(id) => (
                <Textarea
                  id={id}
                  rows={10}
                  value={payload}
                  onChange={(e) => setPayload(e.target.value)}
                  spellCheck={false}
                />
              )}
            </Field>
          </div>
        </Card>
        <Card title="Delivery options">
          <div className="flex flex-col gap-4">
            <Field label="Delay (seconds)" hint="0 runs immediately; anything else creates a scheduled job.">
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min={0}
                  max={2592000}
                  value={delaySeconds}
                  onChange={(e) => setDelaySeconds(e.target.value)}
                />
              )}
            </Field>
            <Field label="Max attempts">
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min={1}
                  max={25}
                  value={maxAttempts}
                  onChange={(e) => setMaxAttempts(e.target.value)}
                />
              )}
            </Field>
            <Field label="Backoff">
              {(id) => (
                <Select
                  id={id}
                  value={backoffType}
                  onChange={(e) => setBackoffType(e.target.value as 'exponential' | 'fixed')}
                >
                  <option value="exponential">Exponential with jitter</option>
                  <option value="fixed">Fixed</option>
                </Select>
              )}
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Base delay (ms)">
                {(id) => (
                  <Input
                    id={id}
                    type="number"
                    min={100}
                    value={baseDelayMs}
                    onChange={(e) => setBaseDelayMs(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Max delay (ms)">
                {(id) => (
                  <Input
                    id={id}
                    type="number"
                    min={100}
                    value={maxDelayMs}
                    onChange={(e) => setMaxDelayMs(e.target.value)}
                  />
                )}
              </Field>
            </div>
            <Field label="Timeout (ms)" hint="Leave empty for the job type's default.">
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min={100}
                  value={timeoutMs}
                  onChange={(e) => setTimeoutMs(e.target.value)}
                />
              )}
            </Field>
            <Field
              label="Idempotency key"
              hint="Optional. Re-submitting with the same key returns the same job."
            >
              {(id) => (
                <Input
                  id={id}
                  value={idempotencyKey}
                  onChange={(e) => setIdempotencyKey(e.target.value)}
                  maxLength={200}
                />
              )}
            </Field>
          </div>
        </Card>
        <div className="flex flex-col gap-3 lg:col-span-3">
          {submit.error && (
            <Notice tone="error">
              <p>{submit.error.message}</p>
              {issues.length > 0 && (
                <ul className="mt-1 list-disc pl-5">
                  {issues.map((i) => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
              )}
            </Notice>
          )}
          <div>
            <Button type="submit" variant="primary" busy={submit.isPending}>
              Submit job
            </Button>
          </div>
        </div>
      </form>
    </>
  );
}
