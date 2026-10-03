import { meanLatency, type SimEvent } from '@distlab/shared';
import type { TelemetryModule } from './types.js';

export interface FaultsTelemetry {
  /** Faults that took effect, in order. */
  readonly injected: number;
  readonly cleared: number;
  /** Active fault ids at the end of the window. */
  readonly active: readonly string[];
  /** Time each node spent frozen, and how many events piled up waiting for it, over completed pauses. */
  readonly frozenMs: Readonly<Record<string, number>>;
  readonly heldEvents: Readonly<Record<string, number>>;
}

export const faultsTelemetry: TelemetryModule<FaultsTelemetry> = {
  name: 'faults',
  levels: {
    FAULT_INJECTED: 'warn',
    FAULT_CLEARED: 'info',
    LINK_STATE_CHANGED: 'warn',
    LINK_CONFIG_CHANGED: 'warn',
    PARTITION_STARTED: 'error',
    PARTITION_HEALED: 'warn',
    NODE_PAUSED: 'error',
    NODE_RESUMED: 'warn',
    NODE_CONDITION_CHANGED: 'warn',
  },
  describe(event) {
    switch (event.type) {
      case 'FAULT_INJECTED': {
        const p = (event as SimEvent<'FAULT_INJECTED'>).payload;
        return `fault ${p.faultId}: ${p.description}`;
      }
      case 'FAULT_CLEARED': {
        const p = (event as SimEvent<'FAULT_CLEARED'>).payload;
        return `fault ${p.faultId} (${p.kind}) cleared`;
      }
      case 'LINK_STATE_CHANGED': {
        const p = (event as SimEvent<'LINK_STATE_CHANGED'>).payload;
        return `link ${p.linkId} ${p.enabled ? 'restored' : 'cut'} (${p.faultId})`;
      }
      case 'LINK_CONFIG_CHANGED': {
        const p = (event as SimEvent<'LINK_CONFIG_CHANGED'>).payload;
        const parts = [`latency ~${Math.round(meanLatency(p.latency))}ms`, `loss ${(p.lossRate * 100).toFixed(1)}%`];
        if (p.duplicateRate > 0) parts.push(`duplicates ${(p.duplicateRate * 100).toFixed(1)}%`);
        return `link ${p.linkId} ${p.restoring ? 'reverted' : 'impaired'}: ${parts.join(', ')} (${p.faultId})`;
      }
      case 'NODE_PAUSED': {
        const p = (event as SimEvent<'NODE_PAUSED'>).payload;
        return `${p.nodeId} froze (${p.faultId}): it keeps its state but does nothing — no timers, no messages handled`;
      }
      case 'NODE_RESUMED': {
        const p = (event as SimEvent<'NODE_RESUMED'>).payload;
        return `${p.nodeId} resumed after ${Math.round(p.pausedForMs)}ms frozen, with ${p.heldEvents} event${p.heldEvents === 1 ? '' : 's'} waiting — it carries on as if no time had passed`;
      }
      case 'NODE_CONDITION_CHANGED': {
        const p = (event as SimEvent<'NODE_CONDITION_CHANGED'>).payload;
        const parts: string[] = [];
        if (p.slowdown > 1) parts.push(`${p.slowdown}× slower`);
        if (p.unavailable) parts.push('refusing work');
        if (p.replicationStalled) parts.push('not applying replication');
        if (p.messageDelay !== undefined) parts.push(`messages delayed ~${Math.round(meanLatency(p.messageDelay))}ms`);
        return `${p.nodeId} ${parts.length > 0 ? `is now ${parts.join(', ')}` : 'is back to normal'} (${p.faultId})`;
      }
      case 'PARTITION_STARTED': {
        const p = (event as SimEvent<'PARTITION_STARTED'>).payload;
        return `partition ${p.partitionId}: ${p.groups.map((g) => `{${g.join(', ')}}`).join(' | ')}`;
      }
      case 'PARTITION_HEALED':
        return `partition ${(event as SimEvent<'PARTITION_HEALED'>).payload.partitionId} healed`;
      default:
        return undefined;
    }
  },
  record(event, metrics) {
    if (event.type === 'FAULT_INJECTED') {
      const p = (event as SimEvent<'FAULT_INJECTED'>).payload;
      metrics.counter('faults.injected').add(1, p.kind);
      metrics.set('faults.active').add(p.faultId);
      metrics.timeline('faults.active_count').record(event.at, metrics.set('faults.active').size);
    } else if (event.type === 'FAULT_CLEARED') {
      const p = (event as SimEvent<'FAULT_CLEARED'>).payload;
      metrics.counter('faults.cleared').add(1, p.kind);
      metrics.set('faults.active').delete(p.faultId);
      metrics.timeline('faults.active_count').record(event.at, metrics.set('faults.active').size);
    } else if (event.type === 'NODE_RESUMED') {
      const p = (event as SimEvent<'NODE_RESUMED'>).payload;
      metrics.counter('faults.frozen_ms').add(p.pausedForMs, p.nodeId);
      metrics.counter('faults.held_events').add(p.heldEvents, p.nodeId);
    }
  },
  snapshot(metrics) {
    return {
      injected: metrics.counter('faults.injected').total,
      cleared: metrics.counter('faults.cleared').total,
      active: [...metrics.set('faults.active').values()].sort(),
      frozenMs: metrics.counter('faults.frozen_ms').byLabel(),
      heldEvents: metrics.counter('faults.held_events').byLabel(),
    };
  },
};
