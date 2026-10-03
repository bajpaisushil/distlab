import type { LatencySpec } from './latency.js';
import type { LinkId, NodeId } from './ids.js';
import type { SimTime } from './time.js';
import {
  checkLatency,
  checkNonNegative,
  checkPositive,
  checkProbability,
  type IssueReporter,
  type SpecValidationContext,
} from './validation.js';

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

export interface FaultEventPayloads {
  /** A scheduled fault took effect. Its concrete consequences follow as their own events. */
  FAULT_INJECTED: { faultId: string; kind: FaultKind; description: string };
  /** A scheduled fault's duration ended. */
  FAULT_CLEARED: { faultId: string; kind: FaultKind };

  /** A link was cut or restored by a fault, not by reconfiguration. */
  LINK_STATE_CHANGED: { linkId: LinkId; enabled: boolean; faultId: string };
  /** A link's impairments changed — a latency spike or a burst of packet loss. */
  LINK_CONFIG_CHANGED: {
    linkId: LinkId;
    faultId: string;
    /** True when the change came from a fault ending rather than starting. */
    restoring: boolean;
    /** The link's effective settings after the change, with every active fault applied. */
    lossRate: number;
    latency: LatencySpec;
  };
  PARTITION_STARTED: { partitionId: string; groups: readonly (readonly NodeId[])[] };
  PARTITION_HEALED: { partitionId: string };
}

export function validateFault(
  fault: FaultSpec | undefined,
  path: string,
  push: IssueReporter,
  context: SpecValidationContext,
  seenIds: Set<string>,
): void {
  if (!fault || typeof fault !== 'object') {
    push(path, 'must be a fault spec');
    return;
  }
  if (fault.id !== undefined) {
    if (seenIds.has(fault.id)) push(`${path}.id`, `duplicate fault id "${fault.id}"`);
    seenIds.add(fault.id);
  }
  if (fault.at === undefined) push(`${path}.at`, 'is required');
  checkNonNegative(fault.at, `${path}.at`, push);

  const requireNode = (id: NodeId | undefined, field: string) => {
    if (typeof id !== 'string' || !context.nodeIds.has(id)) push(`${path}.${field}`, `unknown node "${String(id)}"`);
  };
  const requireLink = (id: LinkId | undefined, field: string) => {
    if (typeof id !== 'string' || !context.linkIds.has(id)) push(`${path}.${field}`, `unknown link "${String(id)}"`);
  };

  switch (fault.kind) {
    case 'node_crash':
      requireNode(fault.nodeId, 'nodeId');
      checkPositive(fault.recoverAfter, `${path}.recoverAfter`, push, true);
      return;
    case 'link_down':
      requireLink(fault.linkId, 'linkId');
      checkPositive(fault.restoreAfter, `${path}.restoreAfter`, push, true);
      return;
    case 'partition':
      if (!Array.isArray(fault.groups) || fault.groups.length < 2) {
        push(`${path}.groups`, 'a partition needs at least two groups');
        return;
      }
      fault.groups.forEach((group, g) => {
        if (!Array.isArray(group) || group.length === 0) {
          push(`${path}.groups[${g}]`, 'must be a non-empty array of node ids');
          return;
        }
        group.forEach((id, n) => requireNode(id, `groups[${g}][${n}]`));
      });
      checkPositive(fault.healAfter, `${path}.healAfter`, push, true);
      return;
    case 'latency_spike':
      requireLink(fault.linkId, 'linkId');
      if (fault.latency === undefined) push(`${path}.latency`, 'is required');
      checkLatency(fault.latency, `${path}.latency`, push);
      checkPositive(fault.durationMs, `${path}.durationMs`, push, true);
      return;
    case 'packet_loss':
      requireLink(fault.linkId, 'linkId');
      if (fault.lossRate === undefined) push(`${path}.lossRate`, 'is required');
      checkProbability(fault.lossRate, `${path}.lossRate`, push);
      checkPositive(fault.durationMs, `${path}.durationMs`, push, true);
      return;
    default:
      push(`${path}.kind`, `unknown fault kind "${String((fault as { kind: string }).kind)}"`);
  }
}
