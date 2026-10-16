import type { Logger } from './logger.js';
import type { Metrics } from './metrics.js';
import { sleep } from './async.js';

type Cleanup = { name: string; fn: () => Promise<void> };

/**
 * Ordered graceful shutdown. Cleanups run in reverse registration order (last started, first
 * stopped): e.g. stop accepting HTTP traffic, then drain workers, then close Redis, then Postgres.
 * A hard deadline guarantees the process exits even if a cleanup hangs.
 */
export class Lifecycle {
  private readonly cleanups: Cleanup[] = [];
  private shuttingDown: Promise<void> | undefined;
  private readonly abort = new AbortController();

  constructor(
    private readonly logger: Logger,
    private readonly hardTimeoutMs = 30_000,
  ) {}

  /** Aborted as soon as shutdown begins; background loops watch it. */
  get signal(): AbortSignal {
    return this.abort.signal;
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown !== undefined;
  }

  onShutdown(name: string, fn: () => Promise<void>): void {
    this.cleanups.push({ name, fn });
  }

  installSignalHandlers(): void {
    for (const sig of ['SIGTERM', 'SIGINT'] as const) {
      process.once(sig, () => {
        this.logger.info({ signal: sig }, 'shutdown requested');
        void this.shutdown(0);
      });
    }
    process.on('unhandledRejection', (reason) => {
      this.logger.error({ err: reason }, 'unhandled promise rejection');
    });
    process.once('uncaughtException', (err) => {
      this.logger.fatal({ err }, 'uncaught exception - shutting down');
      void this.shutdown(1);
    });
  }

  shutdown(exitCode = 0): Promise<void> {
    if (this.shuttingDown) return this.shuttingDown;
    this.abort.abort();
    this.shuttingDown = (async () => {
      const timer = setTimeout(() => {
        this.logger.error({ timeoutMs: this.hardTimeoutMs }, 'graceful shutdown timed out - forcing exit');
        process.exit(exitCode || 1);
      }, this.hardTimeoutMs);
      timer.unref();
      for (const c of [...this.cleanups].reverse()) {
        try {
          await c.fn();
          this.logger.debug({ step: c.name }, 'shutdown step complete');
        } catch (err) {
          this.logger.error({ err, step: c.name }, 'shutdown step failed');
          exitCode = exitCode || 1;
        }
      }
      clearTimeout(timer);
      this.logger.info('shutdown complete');
      process.exitCode = exitCode;
    })();
    return this.shuttingDown;
  }
}

/**
 * Runs `tick` repeatedly until `signal` aborts. `tick` returns true if there may be more work
 * immediately (e.g. a full batch), in which case the next iteration starts without waiting.
 * Errors are logged and counted, never swallowed, and followed by a capped backoff.
 */
export async function runLoop(opts: {
  name: string;
  intervalMs: number;
  signal: AbortSignal;
  logger: Logger;
  metrics: Pick<Metrics, 'loopErrors' | 'loopDuration'>;
  tick: () => Promise<boolean>;
}): Promise<void> {
  let consecutiveErrors = 0;
  while (!opts.signal.aborted) {
    const end = opts.metrics.loopDuration.startTimer({ loop: opts.name });
    let more = false;
    try {
      more = await opts.tick();
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      opts.metrics.loopErrors.inc({ loop: opts.name });
      opts.logger.error({ err, loop: opts.name, consecutiveErrors }, 'background loop iteration failed');
    } finally {
      end();
    }
    if (more && consecutiveErrors === 0) continue;
    const backoff = consecutiveErrors > 0 ? Math.min(opts.intervalMs * 2 ** consecutiveErrors, 30_000) : 0;
    await sleep(opts.intervalMs + backoff, opts.signal);
  }
}
