import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  canTransition,
  InvalidTransitionError,
  isTerminal,
  JOB_STATUSES,
  sourcesOf,
  type JobStatus,
} from '../../src/domain/job-state.js';

/** The legal transitions, written out independently of the implementation table. */
const LEGAL: [JobStatus, JobStatus][] = [
  ['scheduled', 'queued'],
  ['scheduled', 'cancelled'],
  ['queued', 'running'],
  ['queued', 'cancelled'],
  ['running', 'succeeded'],
  ['running', 'retry_wait'],
  ['running', 'failed'],
  ['retry_wait', 'queued'],
  ['retry_wait', 'cancelled'],
  ['failed', 'queued'],
];

describe('job state machine', () => {
  it('allows exactly the documented transitions (all 49 pairs checked)', () => {
    const legal = new Set(LEGAL.map(([a, b]) => `${a}->${b}`));
    let checked = 0;
    for (const from of JOB_STATUSES) {
      for (const to of JOB_STATUSES) {
        checked++;
        const expected = legal.has(`${from}->${to}`);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected);
        if (expected) expect(() => assertTransition(from, to)).not.toThrow();
        else expect(() => assertTransition(from, to)).toThrow(InvalidTransitionError);
      }
    }
    expect(checked).toBe(49);
  });

  it('never leaves succeeded or cancelled', () => {
    for (const to of JOB_STATUSES) {
      expect(canTransition('succeeded', to)).toBe(false);
      expect(canTransition('cancelled', to)).toBe(false);
    }
  });

  it('cannot cancel a running job', () => {
    expect(canTransition('running', 'cancelled')).toBe(false);
  });

  it('computes source states for conditional updates', () => {
    expect(sourcesOf('cancelled').sort()).toEqual(['queued', 'retry_wait', 'scheduled']);
    expect(sourcesOf('queued').sort()).toEqual(['failed', 'retry_wait', 'scheduled']);
    expect(sourcesOf('running')).toEqual(['queued']);
  });

  it('classifies terminal states', () => {
    expect(JOB_STATUSES.filter(isTerminal).sort()).toEqual(['cancelled', 'failed', 'succeeded']);
  });

  it('InvalidTransitionError is a 409 with details', () => {
    const err = new InvalidTransitionError('succeeded', 'running');
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('invalid_transition');
    expect(err.details).toEqual({ from: 'succeeded', to: 'running' });
  });
});
