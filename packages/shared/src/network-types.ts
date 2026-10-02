import type { LatencySpec } from './latency.js';
import type { LinkId, NodeId } from './ids.js';

/**
 * A directed (or, by default, bidirectional) network link.
 *
 * Impairments live on the link rather than on nodes because that is where they
 * live in reality: the same pair of healthy services behaves differently across
 * a datacentre backplane and a congested WAN.
 */
export interface LinkConfig {
  readonly id: LinkId;
  readonly from: NodeId;
  readonly to: NodeId;
  /** When true the link also carries traffic from `to` back to `from`. */
  readonly bidirectional: boolean;
  readonly latency: LatencySpec;
  /** Probability a message is silently discarded, 0..1. */
  readonly lossRate: number;
  /** Probability a delivered message is also delivered a second time, 0..1. */
  readonly duplicateRate: number;
  /** Probability a message takes an extra `reorderDelay`, which can push it behind later messages. */
  readonly reorderRate: number;
  readonly reorderDelay: LatencySpec;
  /** 0 means unlimited. Otherwise messages serialise onto the link and queue behind each other. */
  readonly bandwidthBytesPerSec: number;
  readonly enabled: boolean;
}

export const DEFAULT_LINK_CONFIG: Readonly<Omit<LinkConfig, 'id' | 'from' | 'to'>> = Object.freeze({
  bidirectional: true,
  latency: 5,
  lossRate: 0,
  duplicateRate: 0,
  reorderRate: 0,
  reorderDelay: 20,
  bandwidthBytesPerSec: 0,
  enabled: true,
});

/**
 * A network partition.
 *
 * Nodes in different groups cannot exchange messages. A node absent from every
 * group is unaffected, so a partition can be described by naming only the sides
 * that matter.
 */
export interface PartitionSpec {
  readonly id: string;
  readonly groups: readonly (readonly NodeId[])[];
}

export interface NetworkConfig {
  readonly links: readonly LinkConfig[];
  readonly partitions: readonly PartitionSpec[];
}
