import { z } from 'zod';

export const BackoffSchema = z
  .object({
    type: z.enum(['exponential', 'fixed']).default('exponential'),
    baseDelayMs: z.number().int().min(100).max(3_600_000).default(1_000),
    maxDelayMs: z.number().int().min(100).max(86_400_000).default(300_000),
  })
  .refine((b) => b.maxDelayMs >= b.baseDelayMs, { message: 'maxDelayMs must be >= baseDelayMs' });

export type Backoff = z.infer<typeof BackoffSchema>;

export const DEFAULT_BACKOFF: Backoff = { type: 'exponential', baseDelayMs: 1_000, maxDelayMs: 300_000 };

/**
 * Upper bound of the delay before the retry that follows attempt `attempt` (1-based).
 * exponential: base * 2^(attempt-1), capped at max. fixed: base.
 */
export function backoffCeilingMs(backoff: Backoff, attempt: number): number {
  if (backoff.type === 'fixed') return backoff.baseDelayMs;
  const exp = backoff.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(backoff.maxDelayMs, exp);
}

/**
 * "Full jitter" (AWS Architecture Blog, Exponential Backoff And Jitter): uniform in [floor, ceiling].
 * A small floor (10% of the ceiling, at least 100ms) avoids immediate hot retries.
 * `random` is injectable so tests are deterministic.
 */
export function retryDelayMs(backoff: Backoff, attempt: number, random: () => number = Math.random): number {
  const ceiling = backoffCeilingMs(backoff, attempt);
  if (backoff.type === 'fixed') return ceiling;
  const floor = Math.min(ceiling, Math.max(100, Math.floor(ceiling * 0.1)));
  return Math.floor(floor + random() * (ceiling - floor));
}

export type RetryDecision =
  | { kind: 'retry'; delayMs: number }
  | { kind: 'fail'; reason: 'permanent_error' | 'attempts_exhausted' };

export function decideRetry(input: {
  retryable: boolean;
  runAttempts: number; // attempts in the current run, including the one that just failed
  maxAttempts: number;
  backoff: Backoff;
  random?: () => number;
}): RetryDecision {
  if (!input.retryable) return { kind: 'fail', reason: 'permanent_error' };
  if (input.runAttempts >= input.maxAttempts) return { kind: 'fail', reason: 'attempts_exhausted' };
  return { kind: 'retry', delayMs: retryDelayMs(input.backoff, input.runAttempts, input.random) };
}
