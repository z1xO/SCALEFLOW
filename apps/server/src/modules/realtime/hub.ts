import type pg from 'pg';
import type { Logger } from '../../lib/logger.js';
import type { Metrics } from '../../lib/metrics.js';
import { runLoop } from '../../lib/lifecycle.js';
import {
  cursorOf,
  formatCursor,
  headCursor,
  readCommittedEvents,
  type EventCursor,
} from '../events/event-log.js';
import { toEventDto, type JobEventDto } from '../jobs/model.js';
import type { SystemSnapshot } from '../maintenance/gauges.js';

export interface Subscriber {
  projectId: string;
  principalKey: string;
  onEvent(event: JobEventDto): void;
  onSystem(snapshot: SystemSnapshot): void;
  /** Ends the stream (process shutdown). The client reconnects elsewhere and resumes by cursor. */
  close(): void;
}

export function compareCursors(a: EventCursor, b: EventCursor): number {
  const ta = BigInt(a.txId);
  const tb = BigInt(b.txId);
  if (ta !== tb) return ta < tb ? -1 : 1;
  const ia = BigInt(a.id);
  const ib = BigInt(b.id);
  return ia === ib ? 0 : ia < ib ? -1 : 1;
}

export interface HubOptions {
  pollMs: number;
  batchSize: number;
  systemSnapshotMs: number;
  maxConnectionsPerPrincipal: number;
}

/**
 * Per-API-process fan-out for real-time events.
 *
 * One tailer per process reads the job event log with the commit-ordered cursor (the same query
 * used for reconnect replay, so live delivery and replay agree on order) and hands each event to
 * the subscribers of its project. Cost: one indexed query per `pollMs` per API process, regardless
 * of how many browsers are connected.
 */
export class RealtimeHub {
  private readonly subscribers = new Set<Subscriber>();
  private readonly perPrincipal = new Map<string, number>();
  private cursor: EventCursor | undefined;
  private readonly abort = new AbortController();
  private loops: Promise<void>[] = [];
  private started: Promise<void> | undefined;

  constructor(
    private readonly pool: pg.Pool,
    private readonly snapshot: () => Promise<SystemSnapshot>,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
    private readonly opts: HubOptions,
  ) {}

  /** Position of the live tail; new subscribers without a resume cursor start here. */
  get position(): EventCursor {
    if (!this.cursor) throw new Error('hub not started');
    return this.cursor;
  }

  start(): Promise<void> {
    this.started ??= (async () => {
      this.cursor = await headCursor(this.pool);
      const common = { signal: this.abort.signal, logger: this.logger, metrics: this.metrics };
      this.loops = [
        runLoop({ ...common, name: 'realtime_tail', intervalMs: this.opts.pollMs, tick: () => this.tail() }),
        runLoop({
          ...common,
          name: 'realtime_system',
          intervalMs: this.opts.systemSnapshotMs,
          tick: async () => {
            if (this.subscribers.size === 0) return false;
            const s = await this.snapshot();
            for (const sub of this.subscribers) sub.onSystem(s);
            return false;
          },
        }),
      ];
    })();
    return this.started;
  }

  /** Ends every open stream so HTTP shutdown is not held open by long-lived connections. */
  closeAll(): void {
    for (const sub of [...this.subscribers]) sub.close();
  }

  async stop(): Promise<void> {
    this.closeAll();
    this.abort.abort();
    await Promise.all(this.loops);
  }

  /** Returns an unsubscribe function, or null if the principal has too many open streams. */
  subscribe(sub: Subscriber): (() => void) | null {
    const n = this.perPrincipal.get(sub.principalKey) ?? 0;
    if (n >= this.opts.maxConnectionsPerPrincipal) return null;
    this.perPrincipal.set(sub.principalKey, n + 1);
    this.subscribers.add(sub);
    this.metrics.realtimeConnections.set(this.subscribers.size);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.subscribers.delete(sub);
      const left = (this.perPrincipal.get(sub.principalKey) ?? 1) - 1;
      if (left <= 0) this.perPrincipal.delete(sub.principalKey);
      else this.perPrincipal.set(sub.principalKey, left);
      this.metrics.realtimeConnections.set(this.subscribers.size);
    };
  }

  /**
   * Replays a project's events after `from`. Returns null if the client is further behind than
   * `max` events: it must then re-fetch state instead of replaying (the `reset` event).
   */
  async replay(projectId: string, from: EventCursor, max: number): Promise<JobEventDto[] | null> {
    const rows = await readCommittedEvents(this.pool, from, max + 1, [projectId]);
    if (rows.length > max) return null;
    return rows.map(toEventDto);
  }

  private async tail(): Promise<boolean> {
    if (!this.cursor) return false;
    const rows = await readCommittedEvents(this.pool, this.cursor, this.opts.batchSize);
    if (rows.length === 0) return false;
    const last = rows[rows.length - 1];
    if (last) this.cursor = cursorOf(last);
    if (this.subscribers.size > 0) {
      for (const row of rows) {
        const event = toEventDto(row);
        for (const sub of this.subscribers) {
          if (sub.projectId === row.project_id) sub.onEvent(event);
        }
      }
    }
    return rows.length === this.opts.batchSize;
  }
}

export { formatCursor };
