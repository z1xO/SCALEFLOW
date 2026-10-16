import type pg from 'pg';
import type { Logger } from '../../lib/logger.js';
import type { Metrics } from '../../lib/metrics.js';

/** Parses a Postgres LSN ("16/B374D848") into a comparable bigint. */
export function parseLsn(lsn: string): bigint | null {
  const m = /^([0-9A-Fa-f]{1,8})\/([0-9A-Fa-f]{1,8})$/.exec(lsn);
  if (!m?.[1] || !m[2]) return null;
  return (BigInt(`0x${m[1]}`) << 32n) | BigInt(`0x${m[2]}`);
}

/**
 * Chooses the pool for a read query.
 *
 * - No replica configured: always the primary. (Local default - nothing pretends to be a replica.)
 * - Replica configured, no consistency token: the replica (accepts replication lag).
 * - Replica configured with a token (`minLsn`, returned by a previous write): the replica only if
 *   it has replayed at least that far, otherwise the primary. This gives read-your-writes.
 */
export class ReadRouter {
  private cachedReplayLsn: { value: bigint | null; at: number } | undefined;

  constructor(
    readonly primary: pg.Pool,
    readonly replica: pg.Pool | null,
    private readonly logger: Logger,
    private readonly metrics: Pick<Metrics, 'readRouting'>,
    private readonly replayCacheMs = 50,
  ) {}

  get hasReplica(): boolean {
    return this.replica !== null;
  }

  async pool(minLsn?: string): Promise<pg.Pool> {
    if (!this.replica) {
      this.metrics.readRouting.inc({ target: 'primary_only' });
      return this.primary;
    }
    if (!minLsn) {
      this.metrics.readRouting.inc({ target: 'replica' });
      return this.replica;
    }
    const wanted = parseLsn(minLsn);
    if (wanted === null) {
      this.metrics.readRouting.inc({ target: 'replica' });
      return this.replica;
    }
    const replayed = await this.replayLsn();
    if (replayed !== null && replayed >= wanted) {
      this.metrics.readRouting.inc({ target: 'replica' });
      return this.replica;
    }
    this.metrics.readRouting.inc({ target: 'primary_fallback' });
    return this.primary;
  }

  /** The commit position to hand back to clients after a write, or null without a replica. */
  async commitLsn(): Promise<string | null> {
    if (!this.replica) return null;
    const { rows } = await this.primary.query<{ lsn: string }>('SELECT pg_current_wal_lsn()::text AS lsn');
    return rows[0]?.lsn ?? null;
  }

  private async replayLsn(): Promise<bigint | null> {
    const now = Date.now();
    if (this.cachedReplayLsn && now - this.cachedReplayLsn.at < this.replayCacheMs) {
      return this.cachedReplayLsn.value;
    }
    if (!this.replica) return null;
    try {
      const { rows } = await this.replica.query<{ lsn: string | null }>(
        'SELECT pg_last_wal_replay_lsn()::text AS lsn',
      );
      const raw = rows[0]?.lsn;
      const value = raw ? parseLsn(raw) : null;
      this.cachedReplayLsn = { value, at: now };
      return value;
    } catch (err) {
      this.logger.warn({ err }, 'could not read replica replay position; routing to primary');
      this.cachedReplayLsn = { value: null, at: now };
      return null;
    }
  }
}
