// Generates infra/grafana/dashboards/scaleflow.json (kept as generated JSON; edit this script's panel list).
import { writeFileSync } from 'node:fs';

const ds = { type: 'prometheus', uid: 'prometheus' };
let id = 1;
const panels = [];
let y = 0;
function row(title) {
  panels.push({ id: id++, type: 'row', title, collapsed: false, gridPos: { h: 1, w: 24, x: 0, y }, panels: [] });
  y += 1;
}
function ts(title, targets, { unit = 'short', w = 8, h = 8, x = 0, desc = '' } = {}) {
  panels.push({
    id: id++,
    type: 'timeseries',
    title,
    description: desc,
    datasource: ds,
    gridPos: { h, w, x, y },
    fieldConfig: { defaults: { unit, custom: { lineWidth: 2, fillOpacity: 0, showPoints: 'never' } }, overrides: [] },
    options: { legend: { displayMode: 'list', placement: 'bottom' }, tooltip: { mode: 'multi', sort: 'none' } },
    targets: targets.map(([expr, legendFormat], i) => ({ refId: String.fromCharCode(65 + i), datasource: ds, expr, legendFormat })),
  });
}
function stat(title, expr, { unit = 'short', w = 4, x = 0, desc = '' } = {}) {
  panels.push({
    id: id++,
    type: 'stat',
    title,
    description: desc,
    datasource: ds,
    gridPos: { h: 4, w, x, y },
    fieldConfig: { defaults: { unit }, overrides: [] },
    options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, colorMode: 'none', graphMode: 'area', textMode: 'value' },
    targets: [{ refId: 'A', datasource: ds, expr }],
  });
}

row('Overview');
stat('Jobs submitted / s', 'sum(rate(scaleflow_jobs_submitted_total[1m]))', { unit: 'reqps', x: 0 });
stat('Jobs finished / s', 'sum(rate(scaleflow_jobs_completed_total{outcome=~"succeeded|failed"}[1m]))', { unit: 'reqps', x: 4 });
stat('Failure rate (10m)', 'sum(rate(scaleflow_jobs_completed_total{outcome="failed"}[10m])) / clamp_min(sum(rate(scaleflow_jobs_completed_total{outcome=~"succeeded|failed"}[10m])), 1e-9)', { unit: 'percentunit', x: 8 });
stat('Queued (Postgres)', 'max(scaleflow_jobs_active{status="queued"})', { x: 12 });
stat('Oldest queued', 'max(scaleflow_oldest_queued_job_age_seconds)', { unit: 's', x: 16 });
stat('Workers online', 'max(scaleflow_workers_online)', { x: 20 });
y += 4;

row('Throughput');
ts('Submitted vs finished', [
  ['sum(rate(scaleflow_jobs_submitted_total[1m]))', 'submitted'],
  ['sum by (outcome) (rate(scaleflow_jobs_completed_total[1m]))', '{{outcome}}'],
], { unit: 'reqps', w: 12 });
ts('Queue depth (BullMQ)', [['max by (queue, state) (scaleflow_queue_depth)', '{{queue}} {{state}}']], { w: 12, x: 12 });
y += 8;

row('Latency');
ts('Execution time', [
  ['histogram_quantile(0.5, sum by (le) (rate(scaleflow_job_execution_duration_seconds_bucket[5m])))', 'p50'],
  ['histogram_quantile(0.95, sum by (le) (rate(scaleflow_job_execution_duration_seconds_bucket[5m])))', 'p95'],
  ['histogram_quantile(0.99, sum by (le) (rate(scaleflow_job_execution_duration_seconds_bucket[5m])))', 'p99'],
], { unit: 's', w: 12 });
ts('Queue wait (queued -> claimed)', [
  ['histogram_quantile(0.5, sum by (le) (rate(scaleflow_job_queue_wait_seconds_bucket[5m])))', 'p50'],
  ['histogram_quantile(0.95, sum by (le) (rate(scaleflow_job_queue_wait_seconds_bucket[5m])))', 'p95'],
  ['histogram_quantile(0.99, sum by (le) (rate(scaleflow_job_queue_wait_seconds_bucket[5m])))', 'p99'],
], { unit: 's', w: 12, x: 12 });
y += 8;

row('Workers');
ts('Worker utilization', [
  ['sum(scaleflow_worker_active_jobs{job="worker"}) / clamp_min(sum(scaleflow_worker_concurrency{job="worker"}), 1)', 'busy slots / total'],
], { unit: 'percentunit', w: 8, desc: 'Above ~80% sustained: add workers - if the downstream and database can take it.' });
ts('Retries, duplicates, recoveries', [
  ['sum(rate(scaleflow_jobs_completed_total{outcome="retry"}[5m]))', 'retries scheduled'],
  ['sum(rate(scaleflow_duplicate_deliveries_total[5m]))', 'duplicate deliveries skipped'],
  ['sum(rate(scaleflow_leases_recovered_total[5m]))', 'leases recovered'],
  ['sum(rate(scaleflow_stale_completions_total[5m]))', 'stale results discarded'],
], { unit: 'reqps', w: 8, x: 8 });
ts('Event loop lag p99', [['max by (job, instance) (scaleflow_nodejs_eventloop_lag_p99_seconds)', '{{job}} {{instance}}']], { unit: 's', w: 8, x: 16 });
y += 8;

row('Pipeline');
ts('Outbox backlog', [
  ['max(scaleflow_outbox_pending)', 'pending rows'],
], { w: 8 });
ts('Outbox age / publish latency', [
  ['max(scaleflow_outbox_oldest_pending_age_seconds)', 'oldest pending'],
  ['histogram_quantile(0.99, sum by (le) (rate(scaleflow_outbox_publish_latency_seconds_bucket[5m])))', 'publish p99'],
], { unit: 's', w: 8, x: 8 });
ts('Read model lag', [['max(scaleflow_projection_lag_seconds)', 'projection lag']], { unit: 's', w: 8, x: 16 });
y += 8;

row('API');
ts('Requests by status', [['sum by (status_code) (rate(scaleflow_http_request_duration_seconds_count{job="api"}[1m]))', '{{status_code}}']], { unit: 'reqps', w: 8 });
ts('Latency', [
  ['histogram_quantile(0.5, sum by (le) (rate(scaleflow_http_request_duration_seconds_bucket{job="api"}[5m])))', 'p50'],
  ['histogram_quantile(0.95, sum by (le) (rate(scaleflow_http_request_duration_seconds_bucket{job="api"}[5m])))', 'p95'],
  ['histogram_quantile(0.99, sum by (le) (rate(scaleflow_http_request_duration_seconds_bucket{job="api"}[5m])))', 'p99'],
], { unit: 's', w: 8, x: 8 });
ts('Protection', [
  ['sum(rate(scaleflow_rate_limited_total[1m]))', 'rate limited'],
  ['sum by (reason) (rate(scaleflow_backpressure_rejections_total[1m]))', 'backpressure {{reason}}'],
  ['sum(scaleflow_realtime_connections{job="api"})', 'SSE connections'],
], { w: 8, x: 16 });
y += 8;

const dashboard = {
  uid: 'scaleflow-overview',
  title: 'ScaleFlow',
  tags: ['scaleflow'],
  timezone: 'browser',
  schemaVersion: 41,
  version: 1,
  refresh: '10s',
  time: { from: 'now-1h', to: 'now' },
  editable: false,
  panels,
  templating: { list: [] },
  annotations: { list: [] },
};
writeFileSync(process.argv[2], JSON.stringify(dashboard, null, 2) + '\n');
console.log(`wrote ${panels.length} panels`);
