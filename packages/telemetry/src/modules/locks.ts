import type { SimEvent } from '@distlab/shared';
import type { MetricsRegistry } from '../metrics.js';
import type { TelemetryModule } from './types.js';

export interface OwnershipInterval {
  readonly holder: string;
  readonly token: number;
  readonly from: number;
  readonly to: number | null;
}

export interface LockResourceTelemetry {
  readonly resource: string;
  readonly serviceId: string;
  /** Holder in the lock service's view. */
  readonly holder: string | null;
  readonly token: number;
  readonly waiting: number;
  readonly acquisitions: number;
  readonly acquisitionsByClient: Readonly<Record<string, number>>;
  readonly releases: number;
  readonly expirations: number;
  readonly renewals: number;
  readonly denied: number;
  readonly wait: { readonly count: number; readonly p50: number; readonly p95: number; readonly p99: number; readonly max: number };
  readonly meanHoldMs: number;
  /** Most clients that believed they held the lock at the same moment (2+ means a stale holder was still working). */
  readonly maxBelievedHolders: number;
  readonly believedHolders: readonly { readonly t: number; readonly value: number }[];
  readonly ownership: readonly OwnershipInterval[];
  readonly writesAccepted: number;
  readonly fencedRejections: number;
  readonly safetyViolations: number;
}

export interface LockClientTelemetry {
  readonly clientId: string;
  readonly resource: string;
  readonly phase: 'idle' | 'waiting' | 'holding' | 'down';
  readonly token: number;
  /** Believes it holds the lock, but the service has given it to someone else. */
  readonly stale: boolean;
}

export interface LockTelemetry {
  readonly resources: readonly LockResourceTelemetry[];
  readonly clients: readonly LockClientTelemetry[];
}

const believers = (metrics: MetricsRegistry, resource: string) => metrics.set(`locks.believers.${resource}`);

export const locksTelemetry: TelemetryModule<LockTelemetry> = {
  name: 'locks',
  levels: {
    LOCK_REQUESTED: 'debug',
    LOCK_QUEUED: 'debug',
    LOCK_ACQUIRED: 'info',
    LOCK_DENIED: 'warn',
    LOCK_RENEWED: 'debug',
    LOCK_RELEASED: 'info',
    LOCK_EXPIRED: 'warn',
    CRITICAL_SECTION_STARTED: 'debug',
    CRITICAL_SECTION_ENDED: 'debug',
    FENCED_WRITE_ACCEPTED: 'debug',
    FENCED_WRITE_REJECTED: 'warn',
    SAFETY_VIOLATION: 'error',
  },
  describe(event) {
    switch (event.type) {
      case 'LOCK_REQUESTED': {
        const p = (event as SimEvent<'LOCK_REQUESTED'>).payload;
        return `${p.clientId} asked ${p.serviceId} for lock "${p.resource}"`;
      }
      case 'LOCK_QUEUED': {
        const p = (event as SimEvent<'LOCK_QUEUED'>).payload;
        return `${p.clientId} queued for "${p.resource}" at position ${p.position}${p.holder ? `; ${p.holder} holds it` : ''}`;
      }
      case 'LOCK_ACQUIRED': {
        const p = (event as SimEvent<'LOCK_ACQUIRED'>).payload;
        return `${p.serviceId} granted "${p.resource}" to ${p.holder} with fencing token ${p.token} and a ${p.leaseMs}ms lease, after ${Math.round(p.waitedMs)}ms waiting`;
      }
      case 'LOCK_DENIED': {
        const p = (event as SimEvent<'LOCK_DENIED'>).payload;
        const why = { wait_timeout: 'waited too long in the queue', too_many_waiters: 'the queue was full', gave_up: 'it stopped waiting for an answer' }[p.reason];
        return `${p.clientId} did not get "${p.resource}": ${why}`;
      }
      case 'LOCK_RENEWED': {
        const p = (event as SimEvent<'LOCK_RENEWED'>).payload;
        return `${p.holder} renewed its lease on "${p.resource}" (token ${p.token}) for another ${p.leaseMs}ms`;
      }
      case 'LOCK_RELEASED': {
        const p = (event as SimEvent<'LOCK_RELEASED'>).payload;
        return `${p.holder} released "${p.resource}" (token ${p.token}) after ${Math.round(p.heldMs)}ms`;
      }
      case 'LOCK_EXPIRED': {
        const p = (event as SimEvent<'LOCK_EXPIRED'>).payload;
        return `${p.holder}'s lease on "${p.resource}" (token ${p.token}) ran out after ${Math.round(p.heldMs)}ms without a renewal; the service took the lock back — ${p.holder} is not told`;
      }
      case 'CRITICAL_SECTION_STARTED': {
        const p = (event as SimEvent<'CRITICAL_SECTION_STARTED'>).payload;
        return `${p.clientId} now believes it holds "${p.resource}" (token ${p.token})`;
      }
      case 'CRITICAL_SECTION_ENDED': {
        const p = (event as SimEvent<'CRITICAL_SECTION_ENDED'>).payload;
        const how = {
          completed: 'finished its work',
          lost_lease: 'learned its lease was gone',
          fenced: 'had its write refused as stale',
          write_unconfirmed: 'never heard whether its write landed',
          crashed: 'crashed',
        }[p.outcome];
        return `${p.clientId} ${how} and stopped acting on "${p.resource}" (token ${p.token}) after ${Math.round(p.heldMs)}ms`;
      }
      case 'FENCED_WRITE_ACCEPTED': {
        const p = (event as SimEvent<'FENCED_WRITE_ACCEPTED'>).payload;
        return `${p.storageId} accepted ${p.writer}'s write to "${p.resource}" with token ${p.token}`;
      }
      case 'FENCED_WRITE_REJECTED': {
        const p = (event as SimEvent<'FENCED_WRITE_REJECTED'>).payload;
        return `${p.storageId} refused ${p.writer}'s write to "${p.resource}": token ${p.token} is older than ${p.highestToken}${p.highestWriter ? ` from ${p.highestWriter}` : ''} — the fencing token stopped a stale holder`;
      }
      case 'SAFETY_VIOLATION': {
        const p = (event as SimEvent<'SAFETY_VIOLATION'>).payload;
        return `SAFETY VIOLATION: ${p.storageId} accepted ${p.writer}'s write to "${p.resource}" with token ${p.token} after ${p.highestWriter ?? 'a newer holder'} had written with token ${p.highestToken} — an expired holder overwrote newer data`;
      }
      default:
        return undefined;
    }
  },
  record(event, metrics) {
    const holderChanged = (resource: string, holder: string | null, token?: number) => {
      metrics.timeline(`locks.holder.${resource}`).record(event.at, holder);
      if (token !== undefined) metrics.timeline(`locks.token.${resource}`).record(event.at, token);
    };
    const believe = (resource: string, clientId: string, holds: boolean) => {
      const set = believers(metrics, resource);
      if (holds) set.add(clientId);
      else set.delete(clientId);
      metrics.timeline(`locks.believed.${resource}`).record(event.at, set.size);
      const peak = metrics.gauge(`locks.max_believed.${resource}`);
      peak.set(Math.max(peak.max, set.size));
    };
    const phase = (clientId: string, value: string) => metrics.timeline(`locks.phase.${clientId}`).record(event.at, value);
    const waiting = (resource: string, delta: number) => {
      const gauge = metrics.gauge(`locks.waiting.${resource}`);
      gauge.set(Math.max(0, gauge.value + delta));
    };

    switch (event.type) {
      case 'LOCK_REQUESTED': {
        const p = (event as SimEvent<'LOCK_REQUESTED'>).payload;
        metrics.set('locks.resources').add(`${p.resource}|${p.serviceId}`);
        metrics.set('locks.clients').add(`${p.clientId}|${p.resource}`);
        phase(p.clientId, 'waiting');
        return;
      }
      case 'LOCK_QUEUED':
        waiting((event as SimEvent<'LOCK_QUEUED'>).payload.resource, 1);
        return;
      case 'LOCK_ACQUIRED': {
        const p = (event as SimEvent<'LOCK_ACQUIRED'>).payload;
        metrics.set('locks.resources').add(`${p.resource}|${p.serviceId}`);
        metrics.counter(`locks.acquired.${p.resource}`).add(1, p.holder);
        metrics.histogram(`locks.wait.${p.resource}`).record(p.waitedMs);
        if (p.fromQueue) waiting(p.resource, -1);
        holderChanged(p.resource, p.holder, p.token);
        return;
      }
      case 'LOCK_DENIED': {
        const p = (event as SimEvent<'LOCK_DENIED'>).payload;
        metrics.counter(`locks.denied.${p.resource}`).add(1, p.reason);
        if (p.reason === 'wait_timeout') waiting(p.resource, -1);
        if (p.reason !== 'too_many_waiters') phase(p.clientId, 'idle');
        return;
      }
      case 'LOCK_RENEWED':
        metrics.counter(`locks.renewed.${(event as SimEvent<'LOCK_RENEWED'>).payload.resource}`).add();
        return;
      case 'LOCK_RELEASED': {
        const p = (event as SimEvent<'LOCK_RELEASED'>).payload;
        metrics.counter(`locks.released.${p.resource}`).add();
        metrics.histogram(`locks.held.${p.resource}`).record(p.heldMs);
        holderChanged(p.resource, null);
        return;
      }
      case 'LOCK_EXPIRED': {
        const p = (event as SimEvent<'LOCK_EXPIRED'>).payload;
        metrics.counter(`locks.expired.${p.resource}`).add();
        metrics.histogram(`locks.held.${p.resource}`).record(p.heldMs);
        holderChanged(p.resource, null);
        return;
      }
      case 'CRITICAL_SECTION_STARTED': {
        const p = (event as SimEvent<'CRITICAL_SECTION_STARTED'>).payload;
        believe(p.resource, p.clientId, true);
        phase(p.clientId, 'holding');
        metrics.timeline(`locks.client_token.${p.clientId}`).record(event.at, p.token);
        return;
      }
      case 'CRITICAL_SECTION_ENDED': {
        const p = (event as SimEvent<'CRITICAL_SECTION_ENDED'>).payload;
        believe(p.resource, p.clientId, false);
        phase(p.clientId, p.outcome === 'crashed' ? 'down' : 'idle');
        return;
      }
      case 'FENCED_WRITE_ACCEPTED':
        metrics.counter(`locks.writes.${(event as SimEvent<'FENCED_WRITE_ACCEPTED'>).payload.resource}`).add();
        return;
      case 'FENCED_WRITE_REJECTED':
        metrics.counter(`locks.fenced.${(event as SimEvent<'FENCED_WRITE_REJECTED'>).payload.resource}`).add();
        return;
      case 'SAFETY_VIOLATION':
        metrics.counter(`locks.violations.${(event as SimEvent<'SAFETY_VIOLATION'>).payload.resource}`).add();
        return;
      case 'NODE_FAILED': {
        const nodeId = (event as SimEvent<'NODE_FAILED'>).payload.nodeId;
        // A crashed lock service forgets its table: no holder, nobody waiting.
        for (const key of metrics.set('locks.resources').values()) {
          const [resource, serviceId] = key.split('|') as [string, string];
          if (serviceId !== nodeId) continue;
          holderChanged(resource, null);
          metrics.gauge(`locks.waiting.${resource}`).set(0);
        }
        if ([...metrics.set('locks.clients').values()].some((k) => k.startsWith(`${nodeId}|`))) phase(nodeId, 'down');
        return;
      }
      case 'NODE_RECOVERED': {
        const nodeId = (event as SimEvent<'NODE_RECOVERED'>).payload.nodeId;
        if ([...metrics.set('locks.clients').values()].some((k) => k.startsWith(`${nodeId}|`))) phase(nodeId, 'idle');
        return;
      }
      default:
        return;
    }
  },
  snapshot(metrics, elapsedMs) {
    const resources: LockResourceTelemetry[] = [...metrics.set('locks.resources').values()].sort().map((key) => {
      const [resource, serviceId] = key.split('|') as [string, string];
      const holderPoints = metrics.timeline(`locks.holder.${resource}`).points();
      const tokenTimeline = metrics.timeline(`locks.token.${resource}`);
      const ownership: OwnershipInterval[] = [];
      holderPoints.forEach((point, i) => {
        if (point.value === null) return;
        ownership.push({
          holder: String(point.value),
          token: Number(tokenTimeline.valueAt(point.t) ?? 0),
          from: point.t,
          to: holderPoints[i + 1]?.t ?? null,
        });
      });
      const wait = metrics.histogram(`locks.wait.${resource}`).percentiles();
      const held = metrics.histogram(`locks.held.${resource}`).percentiles();
      const acquired = metrics.counter(`locks.acquired.${resource}`);
      const holder = (metrics.timeline(`locks.holder.${resource}`).last as string | null | undefined) ?? null;
      return {
        resource,
        serviceId,
        holder,
        token: Number(tokenTimeline.last ?? 0),
        waiting: metrics.gauge(`locks.waiting.${resource}`).value,
        acquisitions: acquired.total,
        acquisitionsByClient: acquired.byLabel(),
        releases: metrics.counter(`locks.released.${resource}`).total,
        expirations: metrics.counter(`locks.expired.${resource}`).total,
        renewals: metrics.counter(`locks.renewed.${resource}`).total,
        denied: metrics.counter(`locks.denied.${resource}`).total,
        wait: { count: wait.count, p50: wait.p50, p95: wait.p95, p99: wait.p99, max: wait.count > 0 ? wait.max : 0 },
        meanHoldMs: held.count > 0 ? held.mean : 0,
        maxBelievedHolders: metrics.gauge(`locks.max_believed.${resource}`).max,
        believedHolders: metrics.timeline(`locks.believed.${resource}`).points().map((p) => ({ t: p.t, value: Number(p.value) })),
        ownership: ownership.map((o) => (o.to === null && elapsedMs < o.from ? { ...o, to: o.from } : o)),
        writesAccepted: metrics.counter(`locks.writes.${resource}`).total,
        fencedRejections: metrics.counter(`locks.fenced.${resource}`).total,
        safetyViolations: metrics.counter(`locks.violations.${resource}`).total,
      };
    });
    const clients: LockClientTelemetry[] = [...metrics.set('locks.clients').values()].sort().map((key) => {
      const [clientId, resource] = key.split('|') as [string, string];
      const phase = (metrics.timeline(`locks.phase.${clientId}`).last as LockClientTelemetry['phase'] | undefined) ?? 'idle';
      const token = Number(metrics.timeline(`locks.client_token.${clientId}`).last ?? 0);
      const holder = resources.find((r) => r.resource === resource)?.holder ?? null;
      return { clientId, resource, phase, token, stale: phase === 'holding' && holder !== clientId };
    });
    return { resources, clients };
  },
};
