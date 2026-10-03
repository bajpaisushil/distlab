/**
 * Retry backoff and jitter.
 *
 * Backoff spaces retries out so a struggling dependency gets room to recover;
 * jitter randomises them so a thousand clients that failed at the same moment
 * do not all retry at the same moment too. Without jitter, exponential
 * backoff merely postpones the stampede.
 */

export interface BackoffPolicy {
  readonly backoff: 'none' | 'fixed' | 'exponential';
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly multiplier: number;
  readonly jitter: 'none' | 'full' | 'equal' | 'decorrelated';
}

export interface Uniform {
  /** Uniform in [min, max). */
  range(min: number, max: number): number;
}

/**
 * Delay before retry number `retry` (1 is the first retry).
 * `previousDelay` is only used by decorrelated jitter, which grows from the
 * last delay rather than from the attempt count.
 */
export function backoffDelay(policy: BackoffPolicy, retry: number, previousDelay: number | undefined, rng: Uniform): number {
  if (policy.backoff === 'none') return 0;
  const cap = policy.maxDelayMs;
  const base = policy.baseDelayMs;

  if (policy.jitter === 'decorrelated') {
    // AWS's "decorrelated jitter": sleep = min(cap, random(base, previous × 3)).
    const previous = previousDelay ?? base;
    return Math.min(cap, rng.range(base, Math.max(base, previous * 3)));
  }

  const raw = policy.backoff === 'fixed' ? base : base * policy.multiplier ** Math.max(0, retry - 1);
  const delay = Math.min(cap, raw);
  switch (policy.jitter) {
    case 'none':
      return delay;
    case 'full':
      return rng.range(0, delay);
    case 'equal':
      return delay / 2 + rng.range(0, delay / 2);
  }
}
