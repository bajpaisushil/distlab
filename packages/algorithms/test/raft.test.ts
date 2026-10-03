import { describe, expect, it } from 'vitest';
import { appendEntries, candidateIsUpToDate, commitIndexFor, quorum, type Entry } from '../src/raft.js';

const e = (index: number, term: number): Entry => ({ index, term, command: `c${index}` });

describe('quorum', () => {
  it('is a strict majority', () => {
    expect([1, 2, 3, 4, 5].map(quorum)).toEqual([1, 2, 2, 3, 3]);
  });
});

describe('candidateIsUpToDate', () => {
  const log = [e(1, 1), e(2, 2)];
  it('prefers a later last term regardless of length', () => {
    expect(candidateIsUpToDate(3, 1, log)).toBe(true);
    expect(candidateIsUpToDate(1, 9, log)).toBe(false);
  });
  it('compares length when last terms match', () => {
    expect(candidateIsUpToDate(2, 2, log)).toBe(true);
    expect(candidateIsUpToDate(2, 1, log)).toBe(false);
  });
});

describe('appendEntries', () => {
  it('appends after a matching previous entry', () => {
    const result = appendEntries([e(1, 1)], 1, 1, [e(2, 1), e(3, 1)]);
    expect(result).toEqual({ ok: true, log: [e(1, 1), e(2, 1), e(3, 1)], matchIndex: 3 });
  });

  it('rejects a gap or a term mismatch with a retry hint', () => {
    expect(appendEntries([e(1, 1)], 3, 1, [])).toEqual({ ok: false, hint: 1 });
    expect(appendEntries([e(1, 1), e(2, 1)], 2, 2, [])).toEqual({ ok: false, hint: 1 });
  });

  it('truncates a conflicting suffix', () => {
    const result = appendEntries([e(1, 1), e(2, 1), e(3, 1)], 1, 1, [e(2, 2)]);
    expect(result.ok && result.log).toEqual([e(1, 1), e(2, 2)]);
    expect(result.ok && result.truncatedFrom).toBe(2);
  });

  it('is idempotent for entries it already has', () => {
    const log = [e(1, 1), e(2, 1)];
    const result = appendEntries(log, 0, 0, [e(1, 1), e(2, 1)]);
    expect(result.ok && result.log).toEqual(log);
  });
});

describe('commitIndexFor', () => {
  it('commits what a majority holds from the current term', () => {
    const log = [e(1, 1), e(2, 1), e(3, 1)];
    expect(commitIndexFor(log, 1, 0, [3, 1, 0, 0], 5)).toBe(1);
    expect(commitIndexFor(log, 1, 0, [3, 3, 0, 0], 5)).toBe(3);
  });

  it('never commits an earlier term’s entry by counting replicas (Figure 8)', () => {
    const log = [e(1, 1), e(2, 2)];
    // Entry 2 is on a majority, but it is from term 2 and the leader is in term 4.
    expect(commitIndexFor(log, 4, 1, [2, 2, 0, 0], 5)).toBe(1);
    // Once a term-4 entry is on a majority, everything before it commits too.
    expect(commitIndexFor([...log, e(3, 4)], 4, 1, [3, 3, 0, 0], 5)).toBe(3);
  });
});
