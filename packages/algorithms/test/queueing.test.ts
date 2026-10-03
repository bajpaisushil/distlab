import { describe, expect, it } from 'vitest';
import { afterFailure, nextConsumer } from '../src/queueing.js';

describe('nextConsumer', () => {
  const slots = (spec: [string, number, number, boolean][]) =>
    spec.map(([id, inFlight, prefetch, available]) => ({ id, inFlight, prefetch, available }));

  it('rotates across consumers with room', () => {
    const consumers = slots([
      ['a', 0, 2, true],
      ['b', 0, 2, true],
      ['c', 0, 2, true],
    ]);
    expect(nextConsumer(consumers, undefined)).toBe('a');
    expect(nextConsumer(consumers, 'a')).toBe('b');
    expect(nextConsumer(consumers, 'c')).toBe('a');
  });

  it('skips consumers that are full or down', () => {
    expect(nextConsumer(slots([['a', 2, 2, true], ['b', 0, 2, false], ['c', 1, 2, true]]), undefined)).toBe('c');
    expect(nextConsumer(slots([['a', 2, 2, true]]), undefined)).toBeUndefined();
  });
});

describe('afterFailure', () => {
  it('dead-letters only once the deliveries are used up', () => {
    expect(afterFailure(1, 3)).toBe('redeliver');
    expect(afterFailure(3, 3)).toBe('dead_letter');
  });
});
