// Read-heavy: clients polling job status plus dashboard-style list pages.
//   k6 run -e RATE=500 load/read-heavy.js            # with the Redis job cache
//   k6 run -e RATE=500 -e CACHE=off load/read-heavy.js   # every read goes to PostgreSQL
// CACHE=off sends a read-your-writes token, which (by design) bypasses the job cache.
import http from 'k6/http';
import { check } from 'k6';
import { API, headers, provisionTenant, submitBatch } from './lib.js';

const RATE = Number(__ENV.RATE || 500);
const JOBS = Number(__ENV.JOBS || 500);
const bypass = __ENV.CACHE === 'off' ? { 'x-scaleflow-min-lsn': '0/0' } : {};

export const options = {
  scenarios: {
    read: {
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
    'http_req_duration{name:GET /jobs/:id}': ['p(95)<50'],
    'http_req_duration{name:GET /jobs}': ['p(95)<100'],
  },
};

export function setup() {
  const t = provisionTenant('read');
  const ids = [];
  for (let i = 0; i < JOBS; i += 100) {
    const res = submitBatch(
      t,
      Array.from({ length: Math.min(100, JOBS - i) }, (_, j) => ({
        type: 'demo.echo',
        payload: { i: i + j },
      })),
    );
    for (const item of res.json('items')) ids.push(item.job.id);
  }
  return { ...t, ids };
}

export default function (t) {
  if (Math.random() < 0.8) {
    const id = t.ids[Math.floor(Math.random() * t.ids.length)];
    const res = http.get(`${API}/v1/projects/${t.projectId}/jobs/${id}`, {
      ...headers(t.key, bypass),
      tags: { name: 'GET /jobs/:id' },
    });
    check(res, { 'job read (200)': (r) => r.status === 200 });
  } else {
    const res = http.get(`${API}/v1/projects/${t.projectId}/jobs?limit=25`, {
      ...headers(t.key, bypass),
      tags: { name: 'GET /jobs' },
    });
    check(res, { 'list read (200)': (r) => r.status === 200 });
  }
}
