import type { Rng } from './rng.js';

/**
 * How long something takes in virtual time.
 *
 * A bare number is accepted anywhere a `LatencySpec` is, and normalises to
 * `{ kind: 'fixed' }`. Scenario JSON stays readable (`"latency": 20`) without
 * the engine growing a second code path.
 */
export type LatencySpec =
  | number
  | { kind: 'fixed'; value: number }
  | { kind: 'uniform'; min: number; max: number }
  | { kind: 'normal'; mean: number; stddev: number; min?: number; max?: number }
  | { kind: 'exponential'; mean: number; max?: number };

export type ResolvedLatencySpec = Exclude<LatencySpec, number>;

export function normalizeLatency(spec: LatencySpec): ResolvedLatencySpec {
  return typeof spec === 'number' ? { kind: 'fixed', value: spec } : spec;
}

/** `base ± jitter`, the form network links are usually described in. */
export function jittered(base: number, jitter: number): ResolvedLatencySpec {
  if (jitter <= 0) return { kind: 'fixed', value: base };
  return { kind: 'uniform', min: Math.max(0, base - jitter), max: base + jitter };
}

/** Draws one sample. Never negative: time cannot run backwards. */
export function sampleLatency(spec: LatencySpec, rng: Rng): number {
  const s = normalizeLatency(spec);
  switch (s.kind) {
    case 'fixed':
      return Math.max(0, s.value);
    case 'uniform':
      return Math.max(0, rng.range(Math.min(s.min, s.max), Math.max(s.min, s.max)));
    case 'normal': {
      const v = rng.normal(s.mean, s.stddev);
      const lo = s.min ?? 0;
      const hi = s.max ?? Number.POSITIVE_INFINITY;
      return Math.max(0, Math.min(hi, Math.max(lo, v)));
    }
    case 'exponential': {
      const v = rng.exponential(s.mean);
      return Math.max(0, Math.min(s.max ?? Number.POSITIVE_INFINITY, v));
    }
  }
}

/** Expected value, used for reporting configuration without running a sample. */
export function meanLatency(spec: LatencySpec): number {
  const s = normalizeLatency(spec);
  switch (s.kind) {
    case 'fixed':
      return s.value;
    case 'uniform':
      return (s.min + s.max) / 2;
    case 'normal':
      return s.mean;
    case 'exponential':
      return s.mean;
  }
}
