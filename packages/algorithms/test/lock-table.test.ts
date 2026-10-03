import { describe, expect, it } from 'vitest';
import {
  FREE_LOCK,
  checkFencingToken,
  expireLease,
  grantNext,
  releaseLock,
  removeWaiter,
  renewLease,
  requestLock,
  type LockEntry,
} from '../src/lock-table.js';

const waiter = (clientId: string, attempt = 1, enqueuedAt = 0) => ({ clientId, attempt, leaseMs: 1000, enqueuedAt });

describe('lock table', () => {
  it('grants a free lock with the next token and a lease from now', () => {
    const { entry, outcome } = requestLock(FREE_LOCK, waiter('a'), 100, { granting: true });
    expect(outcome).toEqual({ kind: 'granted', grant: { waiter: waiter('a'), token: 1 } });
    expect(entry).toMatchObject({ holder: 'a', token: 1, heldSince: 100, leaseUntil: 1100 });
  });

  it('queues behind a holder, first come first served', () => {
    let entry: LockEntry = requestLock(FREE_LOCK, waiter('a'), 0, { granting: true }).entry;
    const b = requestLock(entry, waiter('b'), 10, { granting: true });
    expect(b.outcome).toEqual({ kind: 'queued', position: 1 });
    const c = requestLock(b.entry, waiter('c'), 20, { granting: true });
    expect(c.outcome).toEqual({ kind: 'queued', position: 2 });
    entry = releaseLock(c.entry, 'a', 1).entry;
    const next = grantNext(entry, 30, true);
    expect(next.grant).toEqual({ waiter: waiter('b'), token: 2 });
    expect(next.entry.waiters.map((w) => w.clientId)).toEqual(['c']);
  });

  it('never lets a newcomer jump a queue, even when the lock is momentarily free', () => {
    let entry: LockEntry = { ...FREE_LOCK, waiters: [waiter('b')] };
    const late = requestLock(entry, waiter('c'), 0, { granting: true });
    expect(late.outcome).toEqual({ kind: 'queued', position: 2 });
    entry = late.entry;
    expect(grantNext(entry, 0, true).grant?.waiter.clientId).toBe('b');
  });

  it('refuses when the queue is full', () => {
    const held = requestLock(FREE_LOCK, waiter('a'), 0, { granting: true }).entry;
    const one = requestLock(held, waiter('b'), 0, { granting: true, maxWaiters: 1 });
    expect(requestLock(one.entry, waiter('c'), 0, { granting: true, maxWaiters: 1 }).outcome).toEqual({
      kind: 'refused',
      reason: 'too_many_waiters',
    });
  });

  it('holds grants while granting is paused', () => {
    const queued = requestLock(FREE_LOCK, waiter('a'), 0, { granting: false });
    expect(queued.outcome.kind).toBe('queued');
    expect(grantNext(queued.entry, 0, false).grant).toBeUndefined();
    expect(grantNext(queued.entry, 0, true).grant?.token).toBe(1);
  });

  it('ignores stale releases and renewals', () => {
    const held = requestLock(FREE_LOCK, waiter('a'), 0, { granting: true }).entry;
    expect(releaseLock(held, 'b', 1).released).toBe(false);
    expect(releaseLock(held, 'a', 0).released).toBe(false);
    expect(renewLease(held, 'a', 0, 500).renewed).toBe(false);
    const renewed = renewLease(held, 'a', 1, 500);
    expect(renewed.renewed).toBe(true);
    expect(renewed.entry.leaseUntil).toBe(1500);
  });

  it('expires only the current grant, and only once its lease has really run out', () => {
    const held = requestLock(FREE_LOCK, waiter('a'), 0, { granting: true }).entry;
    const renewed = renewLease(held, 'a', 1, 800).entry;
    expect(expireLease(renewed, 1, 1000).expired).toBe(false);
    expect(expireLease(renewed, 0, 2000).expired).toBe(false);
    const gone = expireLease(renewed, 1, 1800);
    expect(gone.expired).toBe(true);
    expect(gone.entry.holder).toBeNull();
  });

  it('issues strictly rising tokens across holders', () => {
    let entry: LockEntry = FREE_LOCK;
    const tokens: number[] = [];
    for (const id of ['a', 'b', 'c', 'a']) {
      const result = requestLock(entry, waiter(id), 0, { granting: true });
      if (result.outcome.kind === 'granted') tokens.push(result.outcome.grant.token);
      entry = releaseLock(result.entry, id, result.entry.token).entry;
    }
    expect(tokens).toEqual([1, 2, 3, 4]);
  });

  it('removes a waiter that gives up', () => {
    const held = requestLock(FREE_LOCK, waiter('a'), 0, { granting: true }).entry;
    const queued = requestLock(held, waiter('b', 3), 0, { granting: true }).entry;
    expect(removeWaiter(queued, 'b', 2).removed).toBe(false);
    expect(removeWaiter(queued, 'b', 3).entry.waiters).toEqual([]);
  });

  it('fences tokens older than the highest accepted', () => {
    expect(checkFencingToken(34, 33)).toBe('stale');
    expect(checkFencingToken(34, 34)).toBe('current');
    expect(checkFencingToken(34, 35)).toBe('current');
  });
});
