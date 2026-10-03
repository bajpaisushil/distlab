import type { LatencySpec } from './latency.js';
import type { LinkId, NodeId } from './ids.js';
import type { SimTime } from './time.js';

/**
 * A scheduled fault.
 *
 * Faults are configuration, not a side channel: each one becomes ordinary
 * scheduled events, and everything that follows — timeouts, rerouting,
 * cascading saturation — emerges from the simulation rather than being
 * scripted. Two runs of the same seed break in exactly the same way.
 */
export type FaultSpec =
  /** A process dies. In-flight work at the node is lost. */
  | {
      kind: 'node_crash';
      id?: string;
      at: SimTime;
      nodeId: NodeId;
      /** Virtual milliseconds until it comes back. Omit to leave it down. */
      recoverAfter?: number;
      reason?: string;
    }
  /** A link is cut. Traffic both ways stops. */
  | { kind: 'link_down'; id?: string; at: SimTime; linkId: LinkId; restoreAfter?: number }
  /** The network splits. Nodes in different groups cannot reach each other. */
  | {
      kind: 'partition';
      id?: string;
      at: SimTime;
      groups: readonly (readonly NodeId[])[];
      healAfter?: number;
    }
  /** A link gets slow without going down — often worse than an outage. */
  | {
      kind: 'latency_spike';
      id?: string;
      at: SimTime;
      linkId: LinkId;
      latency: LatencySpec;
      durationMs?: number;
    }
  /** A link starts dropping a fraction of packets. */
  | { kind: 'packet_loss'; id?: string; at: SimTime; linkId: LinkId; lossRate: number; durationMs?: number };

export type FaultKind = FaultSpec['kind'];

export const FAULT_KINDS: readonly FaultKind[] = [
  'node_crash',
  'link_down',
  'partition',
  'latency_spike',
  'packet_loss',
];

/** Human-readable summary, used in the UI and in logs. */
export function describeFault(fault: FaultSpec): string {
  const at = `${(fault.at / 1000).toFixed(2)}s`;
  switch (fault.kind) {
    case 'node_crash':
      return `${fault.nodeId} crashes at ${at}${
        fault.recoverAfter ? `, recovers after ${fault.recoverAfter}ms` : ' and stays down'
      }`;
    case 'link_down':
      return `${fault.linkId} goes down at ${at}${
        fault.restoreAfter ? `, restored after ${fault.restoreAfter}ms` : ' and stays down'
      }`;
    case 'partition':
      return `network splits at ${at} into ${fault.groups.map((g) => `{${g.join(', ')}}`).join(' | ')}${
        fault.healAfter ? `, heals after ${fault.healAfter}ms` : ''
      }`;
    case 'latency_spike':
      return `${fault.linkId} latency spikes at ${at}${
        fault.durationMs ? ` for ${fault.durationMs}ms` : ''
      }`;
    case 'packet_loss':
      return `${fault.linkId} drops ${(fault.lossRate * 100).toFixed(0)}% of packets at ${at}${
        fault.durationMs ? ` for ${fault.durationMs}ms` : ''
      }`;
  }
}
