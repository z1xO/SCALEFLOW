// Mixed traffic: 70% reads (status polls, list pages), 30% submissions, while workers process.
//   k6 run -e RATE=300 load/mixed.js
import http from 'k6/http';
import { check } from 'k6';
import { API, headers, provisionTenant, submitJob } from './lib.js';

const RATE = Number(__ENV.RATE || 300);

export const options = {
  scenarios: {
    mixed: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: __ENV.DURATION || '60s',
      preAllocatedVUs: Math.max(20, RATE / 2),
      maxVUs: Math.max(100, RATE * 2),
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<150'],
  },
};

export function setup() {
  return provisionTenant('mixed');
}

export default function (t) {
  const r = Math.random();
  if (r < 0.3) {
    submitJob(t, { type: 'demo.sleep', payload: { durationMs: 20 } });
  } else if (r < 0.8) {
    // Poll the newest job (what an SDK waiting on a job would do).
    const list = http.get(`${API}/v1/projects/${t.projectId}/jobs?limit=1`, { ...headers(t.key), tags: { name: 'GET /jobs' } });
    const id = list.status === 200 ? list.json('items.0.id') : null;
    if (id) {
      const res = http.get(`${API}/v1/projects/${t.projectId}/jobs/${id}`, { ...headers(t.key), tags: { name: 'GET /jobs/:id' } });
      check(res, { 'job read (200)': (x) => x.status === 200 });
    }
  } else {
    const res = http.get(`${API}/v1/projects/${t.projectId}/jobs?status=succeeded&limit=25`, {
      ...headers(t.key),
      tags: { name: 'GET /jobs?status' },
    });
    check(res, { 'filtered list (200)': (x) => x.status === 200 });
  }
}
