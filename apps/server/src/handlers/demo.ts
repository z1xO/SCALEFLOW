import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sleep } from '../lib/async.js';
import { PermanentJobError, RetryableJobError, type JobHandler } from './types.js';

/**
 * Built-in demo handlers. They have no external dependencies so they are what the load tests,
 * E2E tests and the dashboard's "submit job" form use to exercise every code path.
 */

function abortable(ms: number, signal: AbortSignal): Promise<void> {
  return sleep(ms, signal).then(() => {
    if (signal.aborted) throw new RetryableJobError('aborted', 'Execution aborted');
  });
}

const EchoPayload = z.object({ message: z.unknown().optional(), delayMs: z.number().int().min(0).max(60_000).optional() });
export const echoHandler: JobHandler<z.infer<typeof EchoPayload>> = {
  type: 'demo.echo',
  description: 'Returns its payload as the result.',
  payloadSchema: EchoPayload,
  defaultTimeoutMs: 30_000,
  async execute(payload, ctx) {
    if (payload.delayMs) await abortable(payload.delayMs, ctx.signal);
    return { echo: payload.message ?? null, attempt: ctx.attempt };
  },
};

const SleepPayload = z.object({ durationMs: z.number().int().min(0).max(600_000) });
export const sleepHandler: JobHandler<z.infer<typeof SleepPayload>> = {
  type: 'demo.sleep',
  description: 'Waits for durationMs (simulates I/O-bound work). Honours timeouts.',
  payloadSchema: SleepPayload,
  defaultTimeoutMs: 60_000,
  async execute(payload, ctx) {
    await abortable(payload.durationMs, ctx.signal);
    return { sleptMs: payload.durationMs };
  },
};

const FlakyPayload = z.object({
  /** Probability in [0,1] that an attempt fails. */
  failureRate: z.number().min(0).max(1).default(0.5),
  /** Deterministic alternative: fail every attempt before this attempt number, then succeed. */
  succeedOnAttempt: z.number().int().min(1).max(100).optional(),
  /** Fail with a non-retryable error instead. */
  permanent: z.boolean().default(false),
  durationMs: z.number().int().min(0).max(60_000).default(0),
});
export const flakyHandler: JobHandler<z.infer<typeof FlakyPayload>> = {
  type: 'demo.flaky',
  description: 'Fails randomly (failureRate) or until a given attempt (succeedOnAttempt). Exercises retries.',
  payloadSchema: FlakyPayload,
  defaultTimeoutMs: 60_000,
  async execute(payload, ctx) {
    if (payload.durationMs) await abortable(payload.durationMs, ctx.signal);
    const shouldFail =
      payload.succeedOnAttempt !== undefined
        ? ctx.attempt < payload.succeedOnAttempt
        : Math.random() < payload.failureRate;
    if (shouldFail) {
      if (payload.permanent) throw new PermanentJobError('demo_permanent_failure', 'Simulated permanent failure');
      throw new RetryableJobError('demo_transient_failure', `Simulated transient failure on attempt ${ctx.attempt}`);
    }
    return { ok: true, attempt: ctx.attempt };
  },
};

const CpuPayload = z.object({ iterations: z.number().int().min(1).max(5_000_000) });
export const cpuHandler: JobHandler<z.infer<typeof CpuPayload>> = {
  type: 'demo.cpu',
  description: 'Burns CPU by hashing (simulates CPU-bound work; shows why more concurrency is not free).',
  payloadSchema: CpuPayload,
  defaultTimeoutMs: 120_000,
  execute(payload, ctx) {
    let digest = Buffer.from(ctx.jobId);
    for (let i = 0; i < payload.iterations; i++) {
      digest = createHash('sha256').update(digest).digest();
      if (i % 10_000 === 0 && ctx.signal.aborted) {
        return Promise.reject(new RetryableJobError('aborted', 'Execution aborted'));
      }
    }
    return Promise.resolve({ digest: digest.toString('hex'), iterations: payload.iterations });
  },
};
