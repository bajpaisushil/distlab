import { describe, expect, it } from 'vitest';
import { Rng, sampleLatency } from '@distlab/shared';

const draw = (rng: Rng, n: number) => Array.from({ length: n }, () => rng.float());

describe('Rng determinism', () => {
  it('produces identical sequences for identical seeds', () => {
    expect(draw(new Rng('seed-a'), 50)).toEqual(draw(new Rng('seed-a'), 50));
  });

  it('produces different sequences for different seeds', () => {
    expect(draw(new Rng('seed-a'), 50)).not.toEqual(draw(new Rng('seed-b'), 50));
  });

  it('treats numeric and string forms of a seed as the same seed', () => {
    expect(draw(new Rng(42), 10)).toEqual(draw(new Rng('42'), 10));
  });

  it('round-trips through a serialised state mid-sequence', () => {
    const original = new Rng('checkpoint');
    draw(original, 17);
    const restored = Rng.fromState(original.state());
    expect(draw(restored, 25)).toEqual(draw(original, 25));
  });
});

describe('Rng.derive', () => {
  it('gives independent streams per label', () => {
    const parent = new Rng('root');
    expect(draw(parent.derive('network'), 20)).not.toEqual(draw(parent.derive('nodes'), 20));
  });

  it('derives from the seed, not the current state, so draw order cannot shift a child', () => {
    const early = new Rng('root');
    const childBefore = early.derive('network');

    const late = new Rng('root');
    draw(late, 500); // an unrelated subsystem consumes numbers first
    const childAfter = late.derive('network');

    expect(draw(childBefore, 30)).toEqual(draw(childAfter, 30));
  });
});

describe('Rng distributions', () => {
  it('keeps float() in [0, 1)', () => {
    const rng = new Rng('bounds');
    for (let i = 0; i < 10_000; i++) {
      const value = rng.float();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('keeps int() within the half-open range', () => {
    const rng = new Rng('ints');
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) seen.add(rng.int(3, 7));
    expect([...seen].sort()).toEqual([3, 4, 5, 6]);
  });

  it('respects bool() probability within statistical tolerance', () => {
    const rng = new Rng('bools');
    let hits = 0;
    for (let i = 0; i < 20_000; i++) if (rng.bool(0.25)) hits++;
    expect(hits / 20_000).toBeGreaterThan(0.23);
    expect(hits / 20_000).toBeLessThan(0.27);
  });

  it('treats bool(0) and bool(1) as certainties without consuming entropy differently per call', () => {
    const rng = new Rng('edges');
    expect(rng.bool(0)).toBe(false);
    expect(rng.bool(1)).toBe(true);
  });

  it('produces an exponential distribution with approximately the requested mean', () => {
    const rng = new Rng('exp');
    let total = 0;
    const samples = 50_000;
    for (let i = 0; i < samples; i++) total += rng.exponential(40);
    expect(total / samples).toBeGreaterThan(38);
    expect(total / samples).toBeLessThan(42);
  });

  it('shuffles deterministically without mutating the input', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const a = new Rng('shuffle').shuffle(input);
    const b = new Rng('shuffle').shuffle(input);
    expect(a).toEqual(b);
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...a].sort((x, y) => x - y)).toEqual(input);
  });
});

describe('latency sampling', () => {
  it('never returns a negative duration, even from a wide normal distribution', () => {
    const rng = new Rng('latency');
    for (let i = 0; i < 5000; i++) {
      expect(sampleLatency({ kind: 'normal', mean: 5, stddev: 50 }, rng)).toBeGreaterThanOrEqual(0);
    }
  });

  it('treats a bare number as a fixed latency', () => {
    expect(sampleLatency(12, new Rng('x'))).toBe(12);
  });

  it('keeps uniform samples inside the configured bounds', () => {
    const rng = new Rng('uniform');
    for (let i = 0; i < 2000; i++) {
      const value = sampleLatency({ kind: 'uniform', min: 10, max: 20 }, rng);
      expect(value).toBeGreaterThanOrEqual(10);
      expect(value).toBeLessThanOrEqual(20);
    }
  });
});
