import { describe, expect, it } from 'vitest';
import { backoffCeilingMs, decideRetry, retryDelayMs, type Backoff } from '../../src/domain/retry-policy.js';

const exp: Backoff = { type: 'exponential', baseDelayMs: 1000, maxDelayMs: 60_000 };

describe('retry policy', () => {
  it('doubles the ceiling per attempt and caps it', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((a) => backoffCeilingMs(exp, a))).toEqual([
      1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000,
    ]);
  });

  it('fixed backoff ignores the attempt number and has no jitter', () => {
    const fixed: Backoff = { type: 'fixed', baseDelayMs: 5000, maxDelayMs: 5000 };
    expect(retryDelayMs(fixed, 1, () => 0)).toBe(5000);
    expect(retryDelayMs(fixed, 9, () => 0.99)).toBe(5000);
  });

  it('jitters between 10% of the ceiling (min 100ms) and the ceiling', () => {
    expect(retryDelayMs(exp, 3, () => 0)).toBe(400); // ceiling 4000 -> floor 400
    expect(retryDelayMs(exp, 3, () => 0.999999)).toBe(3999);
    expect(retryDelayMs(exp, 1, () => 0)).toBe(100); // ceiling 1000 -> floor 100
    for (let i = 0; i < 1000; i++) {
      const d = retryDelayMs(exp, 5);
      expect(d).toBeGreaterThanOrEqual(1600);
      expect(d).toBeLessThanOrEqual(16000);
    }
  });

  it('spreads retries (jitter actually varies)', () => {
    const samples = new Set(Array.from({ length: 50 }, () => retryDelayMs(exp, 6)));
    expect(samples.size).toBeGreaterThan(40);
  });

  it('fails immediately on permanent errors', () => {
    expect(decideRetry({ retryable: false, runAttempts: 1, maxAttempts: 5, backoff: exp })).toEqual({
      kind: 'fail',
      reason: 'permanent_error',
    });
  });

  it('retries until the attempt budget is used, then fails', () => {
    const r = (runAttempts: number) =>
      decideRetry({ retryable: true, runAttempts, maxAttempts: 3, backoff: exp, random: () => 0.5 });
    expect(r(1)).toEqual({ kind: 'retry', delayMs: 550 });
    expect(r(2)).toEqual({ kind: 'retry', delayMs: 1100 });
    expect(r(3)).toEqual({ kind: 'fail', reason: 'attempts_exhausted' });
  });

  it('maxAttempts 1 means no retries', () => {
    expect(decideRetry({ retryable: true, runAttempts: 1, maxAttempts: 1, backoff: exp }).kind).toBe('fail');
  });
});
