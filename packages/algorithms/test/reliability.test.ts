import { describe, expect, it } from 'vitest';
import { Rng } from '@distlab/shared';
import { backoffDelay, type BackoffPolicy } from '../src/backoff.js';
import { CLOSED, permit, record, type BreakerPolicy, type BreakerState } from '../src/circuit-breaker.js';

const policy = (overrides: Partial<BackoffPolicy> = {}): BackoffPolicy => ({
  backoff: 'exponential',
  baseDelayMs: 100,
  maxDelayMs: 1000,
  multiplier: 2,
  jitter: 'none',
  ...overrides,
});

describe('backoffDelay', () => {
  const rng = () => new Rng('backoff');

  it('doubles without jitter and caps at the maximum', () => {
    expect([1, 2, 3, 4, 5].map((r) => backoffDelay(policy(), r, undefined, rng()))).toEqual([100, 200, 400, 800, 1000]);
  });

  it('is constant for fixed backoff and zero for none', () => {
    expect(backoffDelay(policy({ backoff: 'fixed' }), 4, undefined, rng())).toBe(100);
    expect(backoffDelay(policy({ backoff: 'none' }), 4, undefined, rng())).toBe(0);
  });

  it('draws full jitter uniformly below the backoff', () => {
    const r = rng();
    for (let retry = 1; retry <= 5; retry++) {
      const delay = backoffDelay(policy({ jitter: 'full' }), retry, undefined, r);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(Math.min(1000, 100 * 2 ** (retry - 1)));
    }
  });

  it('keeps equal jitter in the upper half', () => {
    const r = rng();
    for (let i = 0; i < 100; i++) {
      const delay = backoffDelay(policy({ jitter: 'equal' }), 3, undefined, r);
      expect(delay).toBeGreaterThanOrEqual(200);
      expect(delay).toBeLessThan(400);
    }
  });

  it('grows decorrelated jitter from the previous delay, within base and cap', () => {
    const r = rng();
    let previous: number | undefined;
    for (let i = 0; i < 50; i++) {
      const delay = backoffDelay(policy({ jitter: 'decorrelated' }), i + 1, previous, r);
      expect(delay).toBeGreaterThanOrEqual(100);
      expect(delay).toBeLessThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(Math.max(100, (previous ?? 100) * 3));
      previous = delay;
    }
  });

  it('is reproducible for a seed', () => {
    const run = () => Array.from({ length: 6 }, (_, i) => backoffDelay(policy({ jitter: 'full' }), i + 1, undefined, new Rng('same')));
    expect(run()).toEqual(run());
  });
});

describe('circuit breaker', () => {
  const breaker: BreakerPolicy = { failureThreshold: 3, cooldownMs: 1000, halfOpenMaxCalls: 1, minimumRequests: 3 };
  const fail = (state: BreakerState, at: number) => record(breaker, state, at, false);

  it('opens after the threshold of consecutive failures', () => {
    let state = CLOSED;
    state = fail(state, 1).state;
    state = fail(state, 2).state;
    const third = fail(state, 3);
    expect(third.transition).toEqual({ kind: 'opened', failures: 3, reopened: false });
    expect(third.state.mode).toBe('open');
  });

  it('resets the count on a success', () => {
    let state = fail(fail(CLOSED, 1).state, 2).state;
    state = record(breaker, state, 3, true).state;
    expect(fail(state, 4).state.mode).toBe('closed');
  });

  it('refuses calls during the cooldown, then admits exactly one probe', () => {
    const open = fail(fail(fail(CLOSED, 0).state, 0).state, 0).state;
    expect(permit(breaker, open, 999).allowed).toBe(false);
    const probe = permit(breaker, open, 1000);
    expect(probe.allowed).toBe(true);
    expect(probe.transition).toEqual({ kind: 'half_opened', openForMs: 1000 });
    expect(permit(breaker, probe.state, 1001).allowed).toBe(false);
  });

  it('closes on a successful probe and re-opens on a failed one', () => {
    const open = fail(fail(fail(CLOSED, 0).state, 0).state, 0).state;
    const halfOpen = permit(breaker, open, 1000).state;
    expect(record(breaker, halfOpen, 1050, true).transition).toEqual({ kind: 'closed' });
    const reopened = record(breaker, halfOpen, 1050, false);
    expect(reopened.transition?.kind).toBe('opened');
    expect(reopened.state.openedAt).toBe(1050);
  });

  it('opens on a failure rate within a window in rate mode', () => {
    const rate: BreakerPolicy = { failureThreshold: 1, cooldownMs: 500, halfOpenMaxCalls: 1, failureRateThreshold: 0.5, windowMs: 1000, minimumRequests: 4 };
    let state = CLOSED;
    state = record(rate, state, 0, true).state;
    state = record(rate, state, 10, false).state;
    state = record(rate, state, 20, true).state;
    const fourth = record(rate, state, 30, false);
    expect(fourth.transition).toEqual({ kind: 'opened', failures: 2, calls: 4, reopened: false });
  });

  it('forgets failures that slid out of the window', () => {
    const rate: BreakerPolicy = { failureThreshold: 1, cooldownMs: 500, halfOpenMaxCalls: 1, failureRateThreshold: 0.5, windowMs: 100, minimumRequests: 2 };
    let state = record(rate, CLOSED, 0, false).state;
    state = record(rate, state, 500, true).state;
    expect(record(rate, state, 510, true).state.mode).toBe('closed');
  });
});
