import type { SimEvent } from '@distlab/shared';
import type { TelemetryModule } from './types.js';

export interface FaultsTelemetry {
  /** Faults that took effect, in order. */
  readonly injected: number;
  readonly cleared: number;
  /** Active fault ids at the end of the window. */
  readonly active: readonly string[];
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
        return `link ${p.linkId} ${p.restoring ? 'reverted' : 'impaired'}: loss ${(p.lossRate * 100).toFixed(1)}% (${p.faultId})`;
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
    }
  },
  snapshot(metrics) {
    return {
      injected: metrics.counter('faults.injected').total,
      cleared: metrics.counter('faults.cleared').total,
      active: [...metrics.set('faults.active').values()].sort(),
    };
  },
};
