// Worker throughput: enqueue N jobs at once (batch API), then measure how long the workers take to
// finish them all. Run with different worker counts / concurrency to see where scaling stops.
//   k6 run -e JOBS=3000 -e JOB_TYPE=demo.sleep -e JOB_MS=50 load/drain.js
//   k6 run -e JOBS=600 -e JOB_TYPE=demo.cpu -e ITERATIONS=20000 load/drain.js
import { Counter, Trend } from 'k6/metrics';
import { provisionTenant, submitBatch, waitForFinished } from './lib.js';

const JOBS = Number(__ENV.JOBS || 3000);
const TYPE = __ENV.JOB_TYPE || 'demo.sleep';
const drainSeconds = new Trend('drain_seconds');
const enqueueSeconds = new Trend('enqueue_seconds');
const throughput = new Trend('jobs_per_second');
const jobsDone = new Counter('jobs_done');

export const options = {
  scenarios: { drain: { executor: 'shared-iterations', vus: 1, iterations: 1, maxDuration: '20m' } },
  summaryTrendStats: ['avg', 'min', 'max'],
};

function payload() {
  if (TYPE === 'demo.cpu') return { iterations: Number(__ENV.ITERATIONS || 20000) };
  return { durationMs: Number(__ENV.JOB_MS || 50) };
}

export function setup() {
  return provisionTenant('drain');
}

export default function (t) {
  const started = Date.now();
  for (let i = 0; i < JOBS; i += 100) {
    submitBatch(
      t,
      Array.from({ length: Math.min(100, JOBS - i) }, () => ({ type: TYPE, payload: payload(), maxAttempts: 1 })),
    );
  }
  const enqueued = Date.now();
  const done = waitForFinished(t, JOBS);
  const finished = Date.now();
  enqueueSeconds.add((enqueued - started) / 1000);
  drainSeconds.add((finished - started) / 1000);
  throughput.add(JOBS / ((finished - started) / 1000));
  jobsDone.add(done);
}
