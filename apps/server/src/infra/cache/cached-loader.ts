import type { Redis } from 'ioredis';
import { randomToken } from '../../lib/crypto.js';
import { SingleFlight, sleep } from '../../lib/async.js';
import type { Logger } from '../../lib/logger.js';
import type { Metrics } from '../../lib/metrics.js';

interface Envelope<T> {
  v: T;
  freshUntil: number;
}

const RELEASE_LOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

export interface LoadOptions {
  /** Serve without recomputing for this long. */
  freshMs: number;
  /** Keep serving the previous value (while one caller refreshes) for this long after it went stale. */
  staleMs: number;
  /** Max time a recompute may hold the distributed lock. */
  lockMs?: number;
}

/**
 * Cache for expensive, time-tolerant reads (metrics, queue health) with stampede protection:
 *
 * 1. In-process single-flight: concurrent callers in one process share one promise.
 * 2. Distributed lock (SET NX PX): across processes only one caller recomputes.
 * 3. Stale-while-revalidate: while one caller recomputes, others get the previous value.
 *
 * If there is no previous value and another process holds the lock, callers wait briefly for it to
 * publish; if the lock holder died they fall back to computing themselves (bounded by lockMs).
 */
export class CachedLoader {
  private readonly flight = new SingleFlight<unknown>();

  constructor(
    private readonly redis: Redis,
    private readonly name: string,
    private readonly logger: Logger,
    private readonly metrics: Pick<Metrics, 'cacheRequests'>,
  ) {}

  get<T>(key: string, opts: LoadOptions, load: () => Promise<T>): Promise<T> {
    return this.flight.do(key, () => this.getUncoalesced(key, opts, load)) as Promise<T>;
  }

  private async getUncoalesced<T>(key: string, opts: LoadOptions, load: () => Promise<T>): Promise<T> {
    const lockMs = opts.lockMs ?? 5_000;
    const lockKey = `${key}:lock`;
    const current = await this.read<T>(key);
    const now = Date.now();
    if (current && now < current.freshUntil) {
      this.count('hit');
      return current.v;
    }

    const token = randomToken(12);
    const gotLock = await this.tryLock(lockKey, token, lockMs);

    if (current) {
      // Stale value available: serve it; refresh in the background if we won the lock.
      this.count('stale');
      if (gotLock) {
        void this.refresh(key, lockKey, token, opts, load).catch((err: unknown) => {
          this.logger.warn({ err, cache: this.name }, 'background cache refresh failed');
        });
      }
      return current.v;
    }

    if (gotLock) {
      this.count('miss');
      return this.refresh(key, lockKey, token, opts, load);
    }

    // Someone else is computing and we have nothing to serve: wait for their result.
    const deadline = Date.now() + Math.min(lockMs, 2_000);
    while (Date.now() < deadline) {
      await sleep(25);
      const v = await this.read<T>(key);
      if (v) {
        this.count('waited');
        return v.v;
      }
    }
    this.count('lock_timeout');
    return load();
  }

  private async refresh<T>(
    key: string,
    lockKey: string,
    token: string,
    opts: LoadOptions,
    load: () => Promise<T>,
  ): Promise<T> {
    try {
      const v = await load();
      const envelope: Envelope<T> = { v, freshUntil: Date.now() + opts.freshMs };
      try {
        await this.redis.set(key, JSON.stringify(envelope), 'PX', opts.freshMs + opts.staleMs);
      } catch (err) {
        this.logger.warn({ err, cache: this.name }, 'cache write failed');
      }
      return v;
    } finally {
      try {
        await this.redis.eval(RELEASE_LOCK, 1, lockKey, token);
      } catch (err) {
        this.logger.warn({ err, cache: this.name }, 'cache lock release failed; it will expire');
      }
    }
  }

  private async read<T>(key: string): Promise<Envelope<T> | null> {
    try {
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as Envelope<T>) : null;
    } catch (err) {
      this.logger.warn({ err, cache: this.name }, 'cache read failed; treating as miss');
      return null;
    }
  }

  private async tryLock(lockKey: string, token: string, lockMs: number): Promise<boolean> {
    try {
      return (await this.redis.set(lockKey, token, 'PX', lockMs, 'NX')) === 'OK';
    } catch (err) {
      // Redis unavailable: behave as if we hold the lock so the request still succeeds.
      this.logger.warn({ err, cache: this.name }, 'cache lock unavailable');
      return true;
    }
  }

  private count(result: string): void {
    this.metrics.cacheRequests.inc({ cache: this.name, result });
  }
}
