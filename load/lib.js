// Shared helpers for the k6 scenarios. Run against an API started with load-test limits
// (see docs/benchmarks.md): RATE_LIMIT_MAX and MAX_ACTIVE_JOBS_PER_PROJECT raised.
import http from 'k6/http';
import { check, fail, sleep } from 'k6';

export const API = __ENV.API_URL || 'http://localhost:4000';
const ORIGIN = __ENV.ORIGIN || 'http://localhost:3000';

/** Creates a fresh user, project and API key so every run is isolated. Returns { key, projectId }. */
export function provisionTenant(label) {
  const email = `k6-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = 'k6-load-test-password';
  const json = { headers: { 'content-type': 'application/json', origin: ORIGIN } };
  let res = http.post(`${API}/v1/auth/register`, JSON.stringify({ email, password, name: 'k6' }), json);
  if (res.status !== 201) fail(`register failed: ${res.status} ${res.body}`);
  res = http.post(`${API}/v1/auth/login`, JSON.stringify({ email, password }), json);
  if (res.status !== 200) fail(`login failed: ${res.status} ${res.body}`);
  res = http.post(`${API}/v1/projects`, JSON.stringify({ name: `k6 ${label}` }), json);
  if (res.status !== 201) fail(`project failed: ${res.status} ${res.body}`);
  const projectId = res.json('project.id');
  res = http.post(`${API}/v1/projects/${projectId}/api-keys`, JSON.stringify({ name: 'k6' }), json);
  if (res.status !== 201) fail(`api key failed: ${res.status} ${res.body}`);
  return { key: res.json('secret'), projectId };
}

export function headers(key, extra = {}) {
  return { headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...extra } };
}

// Optional list of API instances to spread submissions over (e.g. two API processes without a
// load balancer): API_URLS=http://localhost:4000,http://localhost:4001
const SUBMIT_APIS = (__ENV.API_URLS || API).split(',');

export function submitJob(t, body, tags = {}) {
  const base = SUBMIT_APIS[(__VU + __ITER) % SUBMIT_APIS.length];
  const res = http.post(`${base}/v1/projects/${t.projectId}/jobs`, JSON.stringify(body), { ...headers(t.key), tags: { name: 'POST /jobs', ...tags } });
  check(res, { 'submitted (201)': (r) => r.status === 201 });
  return res;
}

export function submitBatch(t, jobs) {
  const res = http.post(`${API}/v1/projects/${t.projectId}/jobs/batch`, JSON.stringify({ jobs }), {
    ...headers(t.key),
    tags: { name: 'POST /jobs/batch' },
    timeout: '60s',
  });
  check(res, { 'batch submitted (201)': (r) => r.status === 201 });
  return res;
}

/** Waits until `n` jobs of the project reached a terminal state, polling the read model. */
export function waitForFinished(t, n, timeoutSeconds = 600) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const res = http.get(`${API}/v1/projects/${t.projectId}/metrics?window=15m`, { ...headers(t.key), tags: { name: 'GET /metrics (poll)' } });
    if (res.status === 200) {
      const c = res.json('counts');
      const done = c.succeeded + c.failed + c.cancelled;
      if (done >= n) return done;
    }
    if (Date.now() > deadline) fail(`timed out waiting for ${n} jobs to finish`);
    sleep(0.25);
  }
}
