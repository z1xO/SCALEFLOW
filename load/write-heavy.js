// Write-heavy: sustained job submission at a fixed arrival rate (open model - the rate does not
// drop when the system slows down, so latency and errors show saturation honestly).
//   k6 run -e RATE=200 -e DURATION=60s load/write-heavy.js
import { provisionTenant, submitJob } from './lib.js';

const RATE = Number(__ENV.RATE || 200);

export const options = {
  scenarios: {
    submit: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: __ENV.DURATION || '60s',
      preAllocatedVUs: Math.max(20, RATE / 2),
      maxVUs: Math.max(100, RATE * 2),
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  // Initial targets (hypotheses, see docs/benchmarks.md) - validated or revised by measurement.
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:POST /jobs}': ['p(95)<150', 'p(99)<300'],
  },
};

export function setup() {
  return provisionTenant('write');
}

export default function (t) {
  const withKey = Math.random() < 0.5;
  submitJob(t, {
    type: 'demo.echo',
    payload: { n: Math.floor(Math.random() * 1e9) },
    ...(withKey ? { idempotencyKey: `k6-${__VU}-${__ITER}-${Date.now()}` } : {}),
  });
}
