import type { Redis } from 'ioredis';
import type { Logger } from '../../lib/logger.js';
import type { Metrics } from '../../lib/metrics.js';

/**
 * Cache entries are stored as "<version>|<json>". A tombstone is "<version>|" (empty body).
 * Both scripts refuse to lower the stored version, which closes the classic cache-aside race
 * (reader loads v3, writer commits v4 + invalidates, reader writes v3 back).
 */
const FILL_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
if cur then
  local sep = string.find(cur, '|', 1, true)
  local v = tonumber(string.sub(cur, 1, sep - 1))
  if v and v > tonumber(ARGV[1]) then return 0 end
end
redis.call('SET', KEYS[1], ARGV[1] .. '|' .. ARGV[2], 'PX', ARGV[3])
return 1
`;

const INVALIDATE_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
if cur then
  local sep = string.find(cur, '|', 1, true)
  local v = tonumber(string.sub(cur, 1, sep - 1))
  if v and v > tonumber(ARGV[1]) then return 0 end
end
redis.call('SET', KEYS[1], ARGV[1] .. '|', 'PX', ARGV[2])
return 1
`;

export interface VersionedValue {
  version: number;
}

/**
 * Versioned cache-aside. Failures talking to Redis degrade to a cache miss (logged + counted) -
 * the database stays the source of truth, so a Redis outage costs latency, not correctness.
 */
export class VersionedCache<T extends VersionedValue> {
  constructor(
    private readonly redis: Redis,
    private readonly name: string,
    private readonly logger: Logger,
    private readonly metrics: Pick<Metrics, 'cacheRequests'>,
    private readonly tombstoneTtlMs = 30_000,
  ) {}

  async get(key: string): Promise<T | null> {
    try {
      const raw = await this.redis.get(key);
      if (raw === null) {
        this.metrics.cacheRequests.inc({ cache: this.name, result: 'miss' });
        return null;
      }
      const sep = raw.indexOf('|');
      const body = raw.slice(sep + 1);
      if (body.length === 0) {
        this.metrics.cacheRequests.inc({ cache: this.name, result: 'tombstone' });
        return null;
      }
      this.metrics.cacheRequests.inc({ cache: this.name, result: 'hit' });
      return JSON.parse(body) as T;
    } catch (err) {
      this.metrics.cacheRequests.inc({ cache: this.name, result: 'error' });
      this.logger.warn({ err, cache: this.name }, 'cache read failed; treating as miss');
      return null;
    }
  }

  /** Returns true if the value was stored, false if a newer version (or tombstone) is present. */
  async fill(key: string, value: T, ttlMs: number): Promise<boolean> {
    try {
      const res = await this.redis.eval(FILL_SCRIPT, 1, key, String(value.version), JSON.stringify(value), ttlMs);
      return res === 1;
    } catch (err) {
      this.logger.warn({ err, cache: this.name }, 'cache fill failed');
      return false;
    }
  }

  async invalidate(key: string, version: number): Promise<void> {
    try {
      await this.redis.eval(INVALIDATE_SCRIPT, 1, key, String(version), this.tombstoneTtlMs);
    } catch (err) {
      // Bounded staleness: the entry expires by TTL. Logged so the operator can see it.
      this.logger.warn({ err, cache: this.name, key }, 'cache invalidation failed; entry will expire by TTL');
    }
  }
}
