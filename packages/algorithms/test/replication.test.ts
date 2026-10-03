import { describe, expect, it } from 'vitest';
import { acceptOrdered, unacknowledged, type ReplicationRecord } from '../src/replication.js';

const r = (lsn: number): ReplicationRecord => ({ lsn, key: `k${lsn}`, version: lsn, writtenAt: lsn * 10 });

describe('acceptOrdered', () => {
  it('applies in order and buffers a gap until it fills', () => {
    let state = { appliedThrough: 0, buffer: new Map<number, ReplicationRecord>() as ReadonlyMap<number, ReplicationRecord> };
    const applied: number[] = [];
    for (const lsn of [1, 3, 4, 2, 5]) {
      const result = acceptOrdered(state.appliedThrough, state.buffer, r(lsn));
      applied.push(...result.apply.map((x) => x.lsn));
      state = { appliedThrough: result.appliedThrough, buffer: result.buffer };
    }
    expect(applied).toEqual([1, 2, 3, 4, 5]);
    expect(state.buffer.size).toBe(0);
  });

  it('recognises retransmissions and duplicates', () => {
    const first = acceptOrdered(0, new Map(), r(1));
    expect(acceptOrdered(first.appliedThrough, first.buffer, r(1)).duplicate).toBe(true);
    const early = acceptOrdered(0, new Map(), r(3));
    expect(acceptOrdered(early.appliedThrough, early.buffer, r(3)).duplicate).toBe(true);
  });

  it('converges to the same state for any arrival order', () => {
    const orders = [
      [1, 2, 3, 4, 5, 6],
      [6, 5, 4, 3, 2, 1],
      [2, 4, 6, 1, 3, 5],
    ];
    for (const order of orders) {
      let through = 0;
      let buffer: ReadonlyMap<number, ReplicationRecord> = new Map();
      const applied: number[] = [];
      for (const lsn of order) {
        const result = acceptOrdered(through, buffer, r(lsn));
        applied.push(...result.apply.map((x) => x.lsn));
        through = result.appliedThrough;
        buffer = result.buffer;
      }
      expect(applied).toEqual([1, 2, 3, 4, 5, 6]);
    }
  });
});

describe('unacknowledged', () => {
  it('returns records after the acknowledged point, bounded', () => {
    const log = [1, 2, 3, 4, 5].map(r);
    expect(unacknowledged(log, 2, 10).map((x) => x.lsn)).toEqual([3, 4, 5]);
    expect(unacknowledged(log, 0, 2).map((x) => x.lsn)).toEqual([1, 2]);
  });
});
