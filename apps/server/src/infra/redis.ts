import { Redis, type RedisOptions } from 'ioredis';
import type { Logger } from '../lib/logger.js';

export type { Redis };

/**
 * General-purpose client (cache, rate limits, health checks): commands time out instead of
 * hanging when Redis is unreachable, and fail fast while disconnected so callers can degrade.
 */
export function createRedis(url: string, name: string, logger: Logger, commandTimeoutMs: number): Redis {
  const client = new Redis(url, {
    connectionName: name,
    commandTimeout: commandTimeoutMs,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: true,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });
  attachLogging(client, name, logger);
  return client;
}

/**
 * Connection options for BullMQ. BullMQ requires `maxRetriesPerRequest: null` for workers because
 * blocking commands must survive reconnects; BullMQ creates and owns these connections.
 */
export function bullConnection(url: string, name: string): RedisOptions & { url?: string } {
  const parsed = new URL(url);
  const db = parsed.pathname.length > 1 ? Number(parsed.pathname.slice(1)) : 0;
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db,
    tls: parsed.protocol === 'rediss:' ? {} : undefined,
    connectionName: name,
    maxRetriesPerRequest: null,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  };
}

function attachLogging(client: Redis, name: string, logger: Logger): void {
  let lastErrorLog = 0;
  client.on('error', (err: Error) => {
    // Rate-limit: a down Redis produces an error per reconnect attempt.
    const now = Date.now();
    if (now - lastErrorLog > 5_000) {
      lastErrorLog = now;
      logger.error({ err, client: name }, 'redis client error');
    }
  });
  client.on('ready', () => {
    logger.debug({ client: name }, 'redis ready');
  });
}
