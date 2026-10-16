import { hostname } from 'node:os';
import type pg from 'pg';
import { randomToken } from '../../lib/crypto.js';

export interface WorkerDto {
  id: string;
  hostname: string;
  pid: number;
  queues: string[];
  concurrency: number;
  status: 'online' | 'draining' | 'offline';
  activeJobs: number;
  processedTotal: number;
  failedTotal: number;
  version: string;
  startedAt: string;
  lastHeartbeatAt: string;
  stoppedAt: string | null;
}

interface WorkerRow {
  id: string;
  hostname: string;
  pid: number;
  queues: string[];
  concurrency: number;
  status: WorkerDto['status'];
  active_jobs: number;
  processed_total: string;
  failed_total: string;
  version: string;
  started_at: Date;
  last_heartbeat_at: Date;
  stopped_at: Date | null;
}

const toDto = (r: WorkerRow): WorkerDto => ({
  id: r.id,
  hostname: r.hostname,
  pid: r.pid,
  queues: r.queues,
  concurrency: r.concurrency,
  status: r.status,
  activeJobs: r.active_jobs,
  processedTotal: Number(r.processed_total),
  failedTotal: Number(r.failed_total),
  version: r.version,
  startedAt: r.started_at.toISOString(),
  lastHeartbeatAt: r.last_heartbeat_at.toISOString(),
  stoppedAt: r.stopped_at?.toISOString() ?? null,
});

export function newWorkerId(): string {
  return `${hostname()}-${process.pid}-${randomToken(4).replace(/[^A-Za-z0-9]/g, 'x')}`;
}

/** Durable record of worker processes: registration, heartbeats, liveness. */
export class WorkerRegistry {
  constructor(private readonly pool: pg.Pool) {}

  async register(w: { id: string; queues: string[]; concurrency: number; version: string }): Promise<void> {
    await this.pool.query(
      `INSERT INTO workers (id, hostname, pid, queues, concurrency, status, version)
       VALUES ($1, $2, $3, $4, $5, 'online', $6)`,
      [w.id, hostname(), process.pid, w.queues, w.concurrency, w.version],
    );
  }

  async heartbeat(id: string, stats: { activeJobs: number; processed: number; failed: number }): Promise<void> {
    await this.pool.query(
      `UPDATE workers SET last_heartbeat_at = now(), active_jobs = $2, processed_total = $3, failed_total = $4,
              status = CASE WHEN status = 'offline' THEN 'online' ELSE status END, stopped_at = NULL
       WHERE id = $1`,
      [id, stats.activeJobs, stats.processed, stats.failed],
    );
  }

  async setStatus(id: string, status: 'draining' | 'offline'): Promise<void> {
    await this.pool.query(
      `UPDATE workers SET status = $2, stopped_at = CASE WHEN $2 = 'offline' THEN now() ELSE stopped_at END,
              active_jobs = CASE WHEN $2 = 'offline' THEN 0 ELSE active_jobs END
       WHERE id = $1`,
      [id, status],
    );
  }

  /** Marks workers without a recent heartbeat offline (crash, kill -9, network partition). */
  async markStale(staleAfterMs: number): Promise<string[]> {
    const { rows } = await this.pool.query<{ id: string }>(
      `UPDATE workers SET status = 'offline', stopped_at = now(), active_jobs = 0
       WHERE status <> 'offline' AND last_heartbeat_at < now() - make_interval(secs => $1::double precision / 1000)
       RETURNING id`,
      [staleAfterMs],
    );
    return rows.map((r) => r.id);
  }

  async list(includeOfflineForMs = 3_600_000): Promise<WorkerDto[]> {
    const { rows } = await this.pool.query<WorkerRow>(
      `SELECT * FROM workers
       WHERE status <> 'offline' OR stopped_at > now() - make_interval(secs => $1::double precision / 1000)
       ORDER BY status, started_at DESC LIMIT 200`,
      [includeOfflineForMs],
    );
    return rows.map(toDto);
  }

  async onlineCount(): Promise<number> {
    const { rows } = await this.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM workers WHERE status = 'online'");
    return rows[0]?.n ?? 0;
  }
}
