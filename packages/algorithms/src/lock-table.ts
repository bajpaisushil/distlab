/**
 * A lease-based lock table with fencing tokens.
 *
 * One entry per lock name: who holds it, until when, who is waiting, and the
 * last fencing token issued. Every grant takes the next token, so tokens only
 * ever rise — a later holder always carries a larger number than an earlier
 * one. Pure: the engine arms the timers and sends the messages.
 */

export interface LockWaiter {
  readonly clientId: string;
  /** The client's attempt number, so a grant can be matched to the request it answers. */
  readonly attempt: number;
  readonly leaseMs: number;
  readonly enqueuedAt: number;
}

export interface LockEntry {
  readonly holder: string | null;
  /** The last token issued; the current holder's token when there is one. */
  readonly token: number;
  readonly heldSince: number;
  readonly leaseMs: number;
  readonly leaseUntil: number;
  /** First come, first served. */
  readonly waiters: readonly LockWaiter[];
}

export const FREE_LOCK: LockEntry = { holder: null, token: 0, heldSince: 0, leaseMs: 0, leaseUntil: 0, waiters: [] };

export interface Grant {
  readonly waiter: LockWaiter;
  readonly token: number;
}

export type LockRequestOutcome =
  | { readonly kind: 'granted'; readonly grant: Grant }
  | { readonly kind: 'queued'; readonly position: number }
  | { readonly kind: 'refused'; readonly reason: 'too_many_waiters' };

function grantTo(entry: LockEntry, waiter: LockWaiter, now: number): { entry: LockEntry; grant: Grant } {
  const token = entry.token + 1;
  return {
    entry: { ...entry, holder: waiter.clientId, token, heldSince: now, leaseMs: waiter.leaseMs, leaseUntil: now + waiter.leaseMs },
    grant: { waiter, token },
  };
}

/**
 * Asks for the lock. Granted at once if it is free, nobody is ahead in the
 * queue and grants are allowed; otherwise queued, unless the queue is full.
 */
export function requestLock(
  entry: LockEntry,
  waiter: LockWaiter,
  now: number,
  options: { readonly maxWaiters?: number; readonly granting: boolean },
): { entry: LockEntry; outcome: LockRequestOutcome } {
  if (entry.holder === null && entry.waiters.length === 0 && options.granting) {
    const result = grantTo(entry, waiter, now);
    return { entry: result.entry, outcome: { kind: 'granted', grant: result.grant } };
  }
  if (options.maxWaiters !== undefined && entry.waiters.length >= options.maxWaiters) {
    return { entry, outcome: { kind: 'refused', reason: 'too_many_waiters' } };
  }
  const waiters = [...entry.waiters, waiter];
  return { entry: { ...entry, waiters }, outcome: { kind: 'queued', position: waiters.length } };
}

/** Hands a free lock to the first waiter. Nothing changes if it is held, nobody waits, or grants are paused. */
export function grantNext(entry: LockEntry, now: number, granting: boolean): { entry: LockEntry; grant?: Grant } {
  const [next, ...rest] = entry.waiters;
  if (entry.holder !== null || next === undefined || !granting) return { entry };
  return grantTo({ ...entry, waiters: rest }, next, now);
}

/** Only the current holder, with the current token, can release. Anything else is a stale release and is ignored. */
export function releaseLock(entry: LockEntry, clientId: string, token: number): { entry: LockEntry; released: boolean } {
  if (entry.holder !== clientId || entry.token !== token) return { entry, released: false };
  return { entry: { ...entry, holder: null }, released: true };
}

/** Extends the current holder's lease from `now`. A renewal with an old token is refused: that lease is gone. */
export function renewLease(entry: LockEntry, clientId: string, token: number, now: number): { entry: LockEntry; renewed: boolean } {
  if (entry.holder !== clientId || entry.token !== token) return { entry, renewed: false };
  return { entry: { ...entry, leaseUntil: now + entry.leaseMs }, renewed: true };
}

/** The lease timer for `token` fired. It only counts if that grant is still the current one and has really run out. */
export function expireLease(entry: LockEntry, token: number, now: number): { entry: LockEntry; expired: boolean } {
  if (entry.holder === null || entry.token !== token || now < entry.leaseUntil) return { entry, expired: false };
  return { entry: { ...entry, holder: null }, expired: true };
}

/** A waiter gave up or timed out. */
export function removeWaiter(entry: LockEntry, clientId: string, attempt: number): { entry: LockEntry; removed: boolean } {
  const waiters = entry.waiters.filter((w) => !(w.clientId === clientId && w.attempt === attempt));
  if (waiters.length === entry.waiters.length) return { entry, removed: false };
  return { entry: { ...entry, waiters }, removed: true };
}

/**
 * The storage-side check. A token lower than one already accepted comes from
 * a holder whose lock has since been granted to someone else.
 */
export function checkFencingToken(highestAccepted: number, token: number): 'current' | 'stale' {
  return token < highestAccepted ? 'stale' : 'current';
}
