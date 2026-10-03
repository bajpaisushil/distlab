import { describe, expect, it } from 'vitest';
import { Rng, compareNodeIds } from '@distlab/shared';
import {
  buildRing,
  leastOutstanding,
  murmur3,
  nextInRotation,
  powerOfTwoChoices,
  ringLookup,
  smoothWeighted,
} from '../src/load-balancing.js';

describe('nextInRotation', () => {
  it('continues after the previous pick and wraps', () => {
    const ids = ['a', 'b', 'c'];
    expect(nextInRotation(ids, undefined, compareNodeIds)).toBe('a');
    expect(nextInRotation(ids, 'a', compareNodeIds)).toBe('b');
    expect(nextInRotation(ids, 'c', compareNodeIds)).toBe('a');
  });

  it('stays fair when the previous pick has left the set', () => {
    expect(nextInRotation(['a', 'c'], 'b', compareNodeIds)).toBe('c');
  });

  it('orders ids the way people read them', () => {
    expect(nextInRotation(['api-2', 'api-10'], 'api-2', compareNodeIds)).toBe('api-10');
  });
});

describe('smoothWeighted', () => {
  it('interleaves 5:1:1 exactly as nginx does', () => {
    let current = new Map<string, number>();
    const picks: string[] = [];
    for (let i = 0; i < 7; i++) {
      const result = smoothWeighted(
        [
          { id: 'a', weight: 5 },
          { id: 'b', weight: 1 },
          { id: 'c', weight: 1 },
        ],
        current,
      )!;
      picks.push(result.chosen);
      current = result.next;
    }
    expect(picks.join('')).toBe('aabacaa');
  });
});

describe('leastOutstanding', () => {
  it('picks the least loaded, rotating among ties', () => {
    const outstanding = new Map([
      ['a', 2],
      ['b', 0],
      ['c', 0],
    ]);
    expect(leastOutstanding(['a', 'b', 'c'], outstanding, undefined, compareNodeIds)).toEqual({ chosen: 'b', tied: ['b', 'c'] });
    expect(leastOutstanding(['a', 'b', 'c'], outstanding, 'b', compareNodeIds)).toEqual({ chosen: 'c', tied: ['b', 'c'] });
  });
});

describe('powerOfTwoChoices', () => {
  it('compares two distinct candidates and takes the cheaper', () => {
    const rng = new Rng('p2c');
    const candidates = [
      { id: 'fast', outstanding: 0, estimate: 10 },
      { id: 'slow', outstanding: 0, estimate: 500 },
    ];
    for (let i = 0; i < 50; i++) {
      const result = powerOfTwoChoices(candidates, rng, 100)!;
      expect(result.sampled.map((s) => s.id).sort()).toEqual(['fast', 'slow']);
      expect(result.chosen).toBe('fast');
    }
  });

  it('weighs latency by load, so an idle slow node can beat a swamped fast one', () => {
    const result = powerOfTwoChoices(
      [
        { id: 'fast-busy', outstanding: 9, estimate: 10 },
        { id: 'slow-idle', outstanding: 0, estimate: 50 },
      ],
      new Rng('x'),
      1,
    )!;
    expect(result.chosen).toBe('slow-idle');
  });
});

describe('murmur3', () => {
  it('matches the reference implementation', () => {
    expect(murmur3('')).toBe(0);
    expect(murmur3('hello')).toBe(613153351);
    expect(murmur3('The quick brown fox jumps over the lazy dog')).toBe(0x2e4ff723);
  });
});

describe('consistent hashing', () => {
  it('moves only the departed backend’s keys when one leaves', () => {
    const keys = Array.from({ length: 2000 }, (_, i) => `key-${i}`);
    const owners = (ids: string[]) => {
      const ring = buildRing(ids, 100);
      return new Map(keys.map((k) => [k, ringLookup(ring, murmur3(k))!.owner]));
    };
    const before = owners(['a', 'b', 'c', 'd']);
    const after = owners(['a', 'b', 'd']);
    let moved = 0;
    for (const key of keys) {
      if (before.get(key) !== after.get(key)) {
        moved += 1;
        expect(before.get(key)).toBe('c');
      }
    }
    // Roughly a quarter of the keys belonged to c.
    expect(moved / keys.length).toBeGreaterThan(0.18);
    expect(moved / keys.length).toBeLessThan(0.32);
  });

  it('spreads keys roughly evenly with enough virtual nodes', () => {
    const ring = buildRing(['a', 'b', 'c'], 200);
    const counts = new Map<string, number>();
    for (let i = 0; i < 6000; i++) {
      const owner = ringLookup(ring, murmur3(`k${i}`))!.owner;
      counts.set(owner, (counts.get(owner) ?? 0) + 1);
    }
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(1600);
      expect(count).toBeLessThan(2400);
    }
  });
});
