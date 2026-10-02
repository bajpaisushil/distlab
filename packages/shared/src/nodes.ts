import type { LatencySpec } from './latency.js';
import type { NodeId } from './ids.js';
import type { SimTime } from './time.js';

export type NodeType =
  | 'client'
  | 'load_balancer'
  | 'gateway'
  | 'api'
  | 'service'
  | 'cache'
  | 'database'
  | 'replica'
  | 'queue'
  | 'worker';

export type NodeStatus = 'healthy' | 'degraded' | 'overloaded' | 'failed' | 'recovering';

/** Node types that terminate a request instead of forwarding it onward. */
export const TERMINAL_NODE_TYPES: readonly NodeType[] = ['database', 'replica', 'cache'];

export interface NodeConfig {
  /** Service time for a unit of work once the node actually starts on it. */
  processing: LatencySpec;
  /** How many requests the node can work on at once. Everything else waits. */
  concurrency: number;
  /** Waiting slots behind the busy workers. Requests arriving to a full queue are rejected. */
  queueCapacity: number;
  /** Chance that processing a request fails outright, independent of load. */
  failureProbability: number;
  /** Database read path. Falls back to `processing` when unset. */
  readLatency?: LatencySpec;
  /** Database write path. Falls back to `processing` when unset. */
  writeLatency?: LatencySpec;
}

export const DEFAULT_NODE_CONFIG: Readonly<NodeConfig> = Object.freeze({
  processing: 10,
  concurrency: 8,
  queueCapacity: 64,
  failureProbability: 0,
});

/**
 * Per-node defaults chosen so an unconfigured graph still behaves plausibly:
 * a client issues work and does no processing, a load balancer is near-free,
 * a database is slower and far less concurrent than an API tier.
 */
export const NODE_TYPE_DEFAULTS: Readonly<Record<NodeType, Partial<NodeConfig>>> = Object.freeze({
  client: { processing: 0, concurrency: 1024, queueCapacity: 0 },
  load_balancer: { processing: 1, concurrency: 256, queueCapacity: 512 },
  gateway: { processing: 3, concurrency: 128, queueCapacity: 256 },
  api: { processing: 15, concurrency: 16, queueCapacity: 64 },
  service: { processing: 20, concurrency: 16, queueCapacity: 64 },
  cache: { processing: 1, concurrency: 64, queueCapacity: 128 },
  database: { processing: 25, concurrency: 8, queueCapacity: 32, readLatency: 10, writeLatency: 30 },
  replica: { processing: 25, concurrency: 8, queueCapacity: 32, readLatency: 10, writeLatency: 30 },
  queue: { processing: 1, concurrency: 1024, queueCapacity: 10_000 },
  worker: { processing: 50, concurrency: 4, queueCapacity: 64 },
});

/** Mutable per-node simulation state. Owned by the engine; nothing else writes it. */
export interface NodeRuntimeState {
  status: NodeStatus;
  /** Requests currently being processed. */
  inFlight: number;
  /** Requests admitted but waiting for a free worker. */
  queueDepth: number;
  processed: number;
  failed: number;
  /** Rejected on arrival because the queue was full. */
  rejected: number;
  /** Total worker-time spent busy, used to derive utilisation. */
  busyTime: number;
  lastStatusChangeAt: SimTime;
}

export interface SimNode {
  readonly id: NodeId;
  readonly type: NodeType;
  readonly label: string;
  readonly config: NodeConfig;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
  readonly state: NodeRuntimeState;
}

export function createNodeRuntimeState(status: NodeStatus = 'healthy'): NodeRuntimeState {
  return {
    status,
    inFlight: 0,
    queueDepth: 0,
    processed: 0,
    failed: 0,
    rejected: 0,
    busyTime: 0,
    lastStatusChangeAt: 0,
  };
}

/** A failed node neither accepts messages nor emits them. */
export function isNodeReachable(node: SimNode): boolean {
  return node.state.status !== 'failed';
}

/**
 * Busy worker-time as a fraction of available worker-time. 1.0 means every
 * worker was occupied for the whole window.
 */
export function nodeUtilization(node: SimNode, elapsed: SimTime): number {
  if (elapsed <= 0 || node.config.concurrency <= 0) return 0;
  return node.state.busyTime / (elapsed * node.config.concurrency);
}
