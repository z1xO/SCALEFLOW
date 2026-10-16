import type {
  ApiKey,
  Attempt,
  Job,
  JobEvent,
  JobStatus,
  JobType,
  Member,
  Membership,
  MetricWindow,
  Page,
  Project,
  ProjectMetrics,
  Role,
  Schedule,
  SystemSnapshot,
  User,
  Worker,
} from './types';

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');

/** An RFC 9457 problem returned by the API. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Read-your-writes token. When the API runs with a read replica, every write returns the commit
 * position; sending it back on later reads makes the API serve them from a replica that has
 * caught up (or from the primary). Without a replica the header is simply never set.
 */
let minLsn: string | null = null;

async function request<T>(method: string, path: string, body?: unknown, init?: { idempotencyKey?: string }): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (init?.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey;
  if (minLsn && method === 'GET') headers['x-scaleflow-min-lsn'] = minLsn;
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      credentials: 'include',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network_error', 'Cannot reach the ScaleFlow API. Is it running?', null);
  }
  const lsn = res.headers.get('x-scaleflow-commit-lsn');
  if (lsn) minLsn = lsn;
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const p = (data ?? {}) as { code?: string; detail?: string; requestId?: string; errors?: unknown };
    throw new ApiError(res.status, p.code ?? 'error', p.detail ?? res.statusText, p.requestId ?? null, p.errors);
  }
  return data as T;
}

export interface JobFilters {
  status?: JobStatus[];
  type?: string;
  queue?: string;
}

export interface CreateJobBody {
  type: string;
  queue?: string;
  payload?: Record<string, unknown>;
  runAt?: string;
  delayMs?: number;
  maxAttempts?: number;
  backoff?: { type: 'exponential' | 'fixed'; baseDelayMs: number; maxDelayMs: number };
  timeoutMs?: number;
}

function qs(params: Record<string, string | number | undefined>): string {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : '';
}

export const api = {
  // auth
  me: () => request<{ user: User; memberships: Membership[] }>('GET', '/v1/auth/me'),
  login: (email: string, password: string) =>
    request<{ user: User; expiresAt: string }>('POST', '/v1/auth/login', { email, password }),
  register: (email: string, password: string, name: string) =>
    request<{ user: User }>('POST', '/v1/auth/register', { email, password, name }),
  logout: () => request<void>('POST', '/v1/auth/logout'),

  // projects
  projects: () => request<{ items: Project[] }>('GET', '/v1/projects'),
  project: (id: string) => request<{ project: Project }>('GET', `/v1/projects/${id}`),
  createProject: (name: string) => request<{ project: Project }>('POST', '/v1/projects', { name }),
  members: (id: string) => request<{ items: Member[] }>('GET', `/v1/projects/${id}/members`),
  addMember: (id: string, email: string, role: Role) =>
    request<{ member: Member }>('POST', `/v1/projects/${id}/members`, { email, role }),
  removeMember: (id: string, userId: string) => request<void>('DELETE', `/v1/projects/${id}/members/${userId}`),

  // api keys
  apiKeys: (id: string) => request<{ items: ApiKey[] }>('GET', `/v1/projects/${id}/api-keys`),
  createApiKey: (id: string, name: string, scopes: ApiKey['scopes'], expiresInDays?: number) =>
    request<{ apiKey: ApiKey; secret: string }>('POST', `/v1/projects/${id}/api-keys`, { name, scopes, expiresInDays }),
  rotateApiKey: (id: string, keyId: string, gracePeriodSeconds: number) =>
    request<{ apiKey: ApiKey; secret: string; previous: ApiKey }>('POST', `/v1/projects/${id}/api-keys/${keyId}/rotate`, {
      gracePeriodSeconds,
    }),
  revokeApiKey: (id: string, keyId: string) => request<{ apiKey: ApiKey }>('DELETE', `/v1/projects/${id}/api-keys/${keyId}`),

  // jobs
  jobTypes: () => request<{ items: JobType[]; queues: string[] }>('GET', '/v1/job-types'),
  jobs: (id: string, f: JobFilters, cursor?: string, limit = 25) =>
    request<Page<Job>>(
      'GET',
      `/v1/projects/${id}/jobs${qs({ status: f.status?.join(','), type: f.type, queue: f.queue, cursor, limit })}`,
    ),
  job: (id: string, jobId: string) => request<{ job: Job }>('GET', `/v1/projects/${id}/jobs/${jobId}`),
  attempts: (id: string, jobId: string) => request<{ items: Attempt[] }>('GET', `/v1/projects/${id}/jobs/${jobId}/attempts`),
  jobEvents: (id: string, jobId: string) => request<{ items: JobEvent[] }>('GET', `/v1/projects/${id}/jobs/${jobId}/events`),
  projectEvents: (id: string, limit = 30) => request<Page<JobEvent>>('GET', `/v1/projects/${id}/events${qs({ limit })}`),
  createJob: (id: string, body: CreateJobBody, idempotencyKey?: string) =>
    request<{ job: Job }>('POST', `/v1/projects/${id}/jobs`, body, { idempotencyKey }),
  cancelJob: (id: string, jobId: string) => request<{ job: Job }>('POST', `/v1/projects/${id}/jobs/${jobId}/cancel`),
  retryJob: (id: string, jobId: string) => request<{ job: Job }>('POST', `/v1/projects/${id}/jobs/${jobId}/retry`),

  // schedules
  schedules: (id: string) => request<{ items: Schedule[] }>('GET', `/v1/projects/${id}/schedules`),
  createSchedule: (
    id: string,
    body: { name: string; cron: string; timezone: string; jobType: string; queue: string; payload: Record<string, unknown> },
  ) => request<{ schedule: Schedule }>('POST', `/v1/projects/${id}/schedules`, body),
  updateSchedule: (id: string, sid: string, body: { enabled?: boolean }) =>
    request<{ schedule: Schedule }>('PATCH', `/v1/projects/${id}/schedules/${sid}`, body),
  deleteSchedule: (id: string, sid: string) => request<void>('DELETE', `/v1/projects/${id}/schedules/${sid}`),
  triggerSchedule: (id: string, sid: string) => request<{ job: Job }>('POST', `/v1/projects/${id}/schedules/${sid}/trigger`),

  // metrics & system
  metrics: (id: string, window: MetricWindow) =>
    request<ProjectMetrics>('GET', `/v1/projects/${id}/metrics${qs({ window })}`),
  systemQueues: () => request<SystemSnapshot>('GET', '/v1/system/queues'),
  workers: () => request<{ items: Worker[] }>('GET', '/v1/system/workers'),
};

export function streamUrl(projectId: string): string {
  return `${API_URL}/v1/projects/${projectId}/stream`;
}
