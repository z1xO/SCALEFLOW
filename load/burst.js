// High submission rates: ramps the arrival rate to find where latency and errors break down.
//   k6 run -e PEAK=1500 load/burst.js
import { provisionTenant, submitJob } from './lib.js';

const PEAK = Number(__ENV.PEAK || 1500);

export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-arrival-rate',
      startRate: 50,
      timeUnit: '1s',
      preAllocatedVUs: 200,
      maxVUs: 1500,
      stages: [
        { duration: '20s', target: Math.round(PEAK / 4) },
        { duration: '20s', target: Math.round(PEAK / 2) },
        { duration: '20s', target: Math.round((PEAK * 3) / 4) },
        { duration: '20s', target: PEAK },
        { duration: '20s', target: PEAK },
      ],
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  return provisionTenant('burst');
}

export default function (t) {
  submitJob(t, { type: 'demo.echo', payload: {} });
}
