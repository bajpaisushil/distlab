/**
 * Distributed lock, lease and fencing contracts.
 *
 * An educational model of a lease-based lock service — the shape of Chubby,
 * ZooKeeper or etcd locks, not any one of them. A client asks a lock service
 * for a named lock; the service grants it for a lease, with a fencing token
 * that rises with every grant. If the holder neither renews nor releases
 * before the lease runs out, the service gives the lock to the next waiter.
 *
 * The service can only guarantee one holder *in its own view*. A holder that
 * freezes, or whose messages are delayed, can wake up still believing it
 * holds the lock. The fencing token is what makes that safe: storage that
 * remembers the highest token it has accepted can refuse the stale holder.
 */
import type { NodeId } from '../ids.js';
import type { LatencySpec } from '../latency.js';
import {
  checkLatency,
  checkNonNegative,
  checkPositive,
  type IssueReporter,
  type SpecValidationContext,
} from '../validation.js';

export interface LockServicePolicy {
  /** Lease granted to a client that asks for none. Default 1000ms. */
  defaultLeaseMs?: number;
  /** Clients that may queue for one lock; beyond this a request is refused at once. Default unlimited. */
  maxWaiters?: number;
  /**
   * After a restart, grant nothing for this long. The lock table was in
   * memory, so old holders may still believe in leases the restarted service
   * has forgotten; waiting out the longest lease makes that safe. Default:
   * the longest lease it has granted, or the default lease if longer. 0
   * grants at once — and risks two holders.
   */
  recoveryGraceMs?: number;
}

export interface LockClientPolicy {
  /** The lock service to ask. */
  service: NodeId;
  /** The lock's name. Names are global: two services handing out "invoice-42" would be two different locks with one name. */
  resource: string;
  /** Lease to ask for. Default 1000ms. */
  leaseMs?: number;
  /** Renew the lease this often while holding it; 0 never renews. Default a third of the lease. */
  renewEveryMs?: number;
  /** Work done while holding the lock, before the write. Default 200ms. */
  holdMs?: LatencySpec;
  /** Pause between finishing and asking again. Default 100ms. */
  thinkMs?: LatencySpec;
  /** Give up waiting for the lock after this. Default 2000ms. */
  acquireTimeoutMs?: number;
  /** Where the critical section writes when its work is done, carrying its fencing token. */
  storage?: NodeId;
  /**
   * Check the lease is still valid right before writing. Narrows the window
   * but cannot close it: the write can still be delayed after the check.
   * Default false — most code just writes.
   */
  checkLeaseBeforeWrite?: boolean;
  /** When this client first asks. Default 0. */
  startAt?: number;
}

export interface LockNodeConfig {
  lockService?: LockServicePolicy;
  lockClient?: LockClientPolicy;
  /** Storage: refuse writes whose fencing token is older than one already accepted. */
  fencing?: boolean;
}

export const DEFAULT_LEASE_MS = 1000;
export const DEFAULT_HOLD_MS = 200;
export const DEFAULT_THINK_MS = 100;
export const DEFAULT_ACQUIRE_TIMEOUT_MS = 2000;

export function renewIntervalOf(policy: LockClientPolicy): number {
  return policy.renewEveryMs ?? Math.round((policy.leaseMs ?? DEFAULT_LEASE_MS) / 3);
}

export type LockMessageKind =
  | 'LOCK_ACQUIRE'
  | 'LOCK_GRANT'
  | 'LOCK_REFUSE'
  | 'LOCK_RENEW'
  | 'LOCK_RENEW_RESULT'
  | 'LOCK_RELEASE'
  | 'FENCED_WRITE'
  | 'FENCED_WRITE_RESULT';

export type LockRefusal = 'wait_timeout' | 'too_many_waiters';

export interface LockAcquirePayload {
  readonly resource: string;
  readonly leaseMs: number;
  /** How long the client is prepared to wait in the queue. */
  readonly waitMs: number;
  /** The client's attempt number, echoed in the answer so stale answers can be recognised. */
  readonly attempt: number;
}

export interface LockGrantPayload {
  readonly resource: string;
  readonly token: number;
  readonly leaseMs: number;
  readonly attempt: number;
}

export interface LockRefusePayload {
  readonly resource: string;
  readonly attempt: number;
  readonly reason: LockRefusal;
}

export interface LockRenewPayload {
  readonly resource: string;
  readonly token: number;
}

export interface LockRenewResultPayload {
  readonly resource: string;
  readonly token: number;
  readonly ok: boolean;
}

export interface LockReleasePayload {
  readonly resource: string;
  readonly token: number;
}

export interface FencedWritePayload {
  readonly resource: string;
  readonly token: number;
  readonly attempt: number;
}

export interface FencedWriteResultPayload {
  readonly resource: string;
  readonly token: number;
  readonly attempt: number;
  readonly accepted: boolean;
  /** The highest token the storage had accepted when it decided. */
  readonly highestToken: number;
}

export type LockMessagePayload =
  | LockAcquirePayload
  | LockGrantPayload
  | LockRefusePayload
  | LockRenewPayload
  | LockRenewResultPayload
  | LockReleasePayload
  | FencedWritePayload
  | FencedWriteResultPayload;

/** How a client's critical section ended. */
export type CriticalSectionOutcome =
  /** Work done, write accepted (or no write), lock released. */
  | 'completed'
  /** It learned it no longer held the lease — a renewal refused, or its own check before writing. */
  | 'lost_lease'
  /** Storage refused its write: a newer holder had already written. */
  | 'fenced'
  /** The write was never answered. */
  | 'write_unconfirmed'
  | 'crashed';

export interface LockEventPayloads {
  LOCK_REQUESTED: { clientId: NodeId; serviceId: NodeId; resource: string; attempt: number };
  LOCK_QUEUED: { serviceId: NodeId; resource: string; clientId: NodeId; position: number; holder: NodeId | null };
  LOCK_ACQUIRED: {
    serviceId: NodeId;
    resource: string;
    holder: NodeId;
    token: number;
    leaseMs: number;
    waitedMs: number;
    /** It had been queued, rather than finding the lock free. */
    fromQueue: boolean;
  };
  /** The client did not get the lock: the service refused, or the client stopped waiting. */
  LOCK_DENIED: { serviceId: NodeId; resource: string; clientId: NodeId; reason: LockRefusal | 'gave_up' };
  LOCK_RENEWED: { serviceId: NodeId; resource: string; holder: NodeId; token: number; leaseMs: number };
  LOCK_RELEASED: { serviceId: NodeId; resource: string; holder: NodeId; token: number; heldMs: number };
  /** The holder neither renewed nor released in time; the service takes the lock back. */
  LOCK_EXPIRED: { serviceId: NodeId; resource: string; holder: NodeId; token: number; heldMs: number };
  /** The client believes it holds the lock from here. */
  CRITICAL_SECTION_STARTED: { clientId: NodeId; serviceId: NodeId; resource: string; token: number };
  CRITICAL_SECTION_ENDED: { clientId: NodeId; resource: string; token: number; outcome: CriticalSectionOutcome; heldMs: number };
  FENCED_WRITE_ACCEPTED: { storageId: NodeId; resource: string; token: number; writer: NodeId };
  FENCED_WRITE_REJECTED: {
    storageId: NodeId;
    resource: string;
    token: number;
    writer: NodeId;
    highestToken: number;
    highestWriter: NodeId | null;
  };
  /**
   * Storage accepted a write from a holder whose lock had already been
   * granted to someone else, after that someone else had written: two
   * critical sections overlapped and the older one overwrote the newer.
   */
  SAFETY_VIOLATION: {
    storageId: NodeId;
    resource: string;
    token: number;
    writer: NodeId;
    highestToken: number;
    highestWriter: NodeId | null;
  };
}

export function validateLockConfig(
  config: LockNodeConfig,
  path: string,
  push: IssueReporter,
  context: SpecValidationContext,
): void {
  const raw = config as Record<string, unknown>;
  const self = context.self;

  if (raw.lockService !== undefined) {
    const at = `${path}.lockService`;
    const service = raw.lockService as Record<string, unknown>;
    if (typeof service !== 'object' || service === null) push(at, 'must be an object');
    else {
      if (self && self.type !== 'lock_service') push(at, 'only lock service nodes take lock service settings');
      checkPositive(service.defaultLeaseMs, `${at}.defaultLeaseMs`, push, true);
      checkPositive(service.maxWaiters, `${at}.maxWaiters`, push, true);
      if (service.recoveryGraceMs !== undefined) checkNonNegative(service.recoveryGraceMs, `${at}.recoveryGraceMs`, push);
    }
  }

  if (raw.fencing !== undefined) {
    if (typeof raw.fencing !== 'boolean') push(`${path}.fencing`, 'must be true or false');
    if (self && (self.type === 'client' || self.type === 'lock_service')) push(`${path}.fencing`, 'only storage can enforce fencing tokens');
  }

  if (raw.lockClient === undefined) return;
  const at = `${path}.lockClient`;
  const client = raw.lockClient as Record<string, unknown>;
  if (typeof client !== 'object' || client === null) {
    push(at, 'must be an object');
    return;
  }
  if (self && (self.type === 'client' || self.type === 'lock_service')) push(at, 'clients and lock services cannot hold locks');
  const linked = (other: string) =>
    self === undefined ||
    context.links.some((l) => (l.from === self.id && l.to === other) || (l.from === other && l.to === self.id));

  if (typeof client.service !== 'string' || !context.nodeIds.has(client.service)) {
    push(`${at}.service`, `unknown node "${String(client.service)}"`);
  } else if (context.nodeTypes.get(client.service) !== 'lock_service') {
    push(`${at}.service`, 'must be a lock service');
  } else if (!linked(client.service)) {
    push(`${at}.service`, 'needs a link to the lock service');
  }
  if (typeof client.resource !== 'string' || client.resource.length === 0) push(`${at}.resource`, 'must be a non-empty name');
  checkPositive(client.leaseMs, `${at}.leaseMs`, push, true);
  if (client.renewEveryMs !== undefined) {
    checkNonNegative(client.renewEveryMs, `${at}.renewEveryMs`, push);
    const lease = typeof client.leaseMs === 'number' ? client.leaseMs : DEFAULT_LEASE_MS;
    if (typeof client.renewEveryMs === 'number' && client.renewEveryMs >= lease) {
      push(`${at}.renewEveryMs`, 'must be shorter than the lease, or the lease runs out before it is renewed');
    }
  }
  checkLatency(client.holdMs as LatencySpec | undefined, `${at}.holdMs`, push);
  checkLatency(client.thinkMs as LatencySpec | undefined, `${at}.thinkMs`, push);
  checkPositive(client.acquireTimeoutMs, `${at}.acquireTimeoutMs`, push, true);
  if (client.startAt !== undefined) checkNonNegative(client.startAt, `${at}.startAt`, push);
  if (client.checkLeaseBeforeWrite !== undefined && typeof client.checkLeaseBeforeWrite !== 'boolean') {
    push(`${at}.checkLeaseBeforeWrite`, 'must be true or false');
  }
  if (client.storage !== undefined) {
    if (typeof client.storage !== 'string' || !context.nodeIds.has(client.storage)) {
      push(`${at}.storage`, `unknown node "${String(client.storage)}"`);
    } else if (['client', 'lock_service'].includes(context.nodeTypes.get(client.storage) ?? '')) {
      push(`${at}.storage`, 'must be a storage node');
    } else if (!linked(client.storage)) {
      push(`${at}.storage`, 'needs a link to the storage node');
    }
  }
}
