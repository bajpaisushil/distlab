/**
 * Storage, replication and caching contracts.
 *
 * Databases hold versioned keys. A write at a primary takes the next log
 * sequence number (LSN), which is also the key's new version, and is shipped
 * to replicas through the network like any other message. A replica applies
 * records after a configurable delay — so replicas lag, and reads served by a
 * lagging replica can be stale. Caches sit in front and expire entries.
 */
import type { NodeId, RequestId } from '../ids.js';
import type { LatencySpec } from '../latency.js';
import type { SimTime } from '../time.js';
import {
  checkLatency,
  checkNodeRef,
  checkOneOf,
  checkPositive,
  checkInteger,
  type IssueReporter,
  type SpecValidationContext,
} from '../validation.js';

export type ReadPreference = 'primary' | 'replica' | 'any';
export type ReplicationMode = 'async' | 'sync';
/**
 * `ordered`: apply records strictly in LSN order, buffering gaps (what a real
 * write-ahead log does). `arrival`: apply whatever arrives, whenever it
 * arrives — naive, and able to roll a key back to an older value.
 */
export type ReplicaApplyMode = 'ordered' | 'arrival';

export const READ_PREFERENCES: readonly ReadPreference[] = ['primary', 'replica', 'any'];
export const REPLICATION_MODES: readonly ReplicationMode[] = ['async', 'sync'];
export const REPLICA_APPLY_MODES: readonly ReplicaApplyMode[] = ['ordered', 'arrival'];

export interface ReplicationPolicy {
  mode: ReplicationMode;
  /** Sync mode: replica acknowledgements a write waits for. Default all replicas. */
  syncReplicas?: number;
  /** How often unacknowledged records are re-sent. Default 500ms. */
  retransmitMs?: number;
}

export interface CachePolicy {
  ttlMs: number;
  /** Entries kept before the least recently used is evicted. Default 1000. */
  capacity?: number;
  /** Concurrent misses for one key wait for a single fill instead of all hitting the database. */
  coalesce?: boolean;
}

export interface DataNodeConfig {
  /** On a node that reads from storage: which copies it may read. Default any. */
  readPreference?: ReadPreference;
  /** On a replica: the primary it copies. */
  replicaOf?: NodeId;
  /** On a replica: time to apply a record once it arrives. Default 0. */
  replicationDelay?: LatencySpec;
  /** On a replica. Default ordered. */
  replicaApply?: ReplicaApplyMode;
  /** On a primary. Default async. */
  replication?: ReplicationPolicy;
  /** On a primary: recognise a repeated write by its request id and apply it once. */
  idempotentWrites?: boolean;
  /** On a cache node. */
  cache?: CachePolicy;
}

export type DataMessageKind = 'REPLICATE' | 'REPLICATE_ACK';

export interface ReplicatePayload {
  readonly lsn: number;
  readonly key: string;
  readonly version: number;
  readonly writtenAt: SimTime;
  readonly retransmit: boolean;
}

export interface ReplicateAckPayload {
  /** Every record up to this LSN has been applied. */
  readonly appliedThrough: number;
}

export type DataMessagePayload = ReplicatePayload | ReplicateAckPayload;

export interface DataEventPayloads {
  DB_READ: {
    nodeId: NodeId;
    requestId: RequestId;
    latency: number;
    key: string;
    /** 0 when the key has never been written. */
    version: number;
    stale?: boolean;
  };
  DB_WRITE: { nodeId: NodeId; requestId: RequestId; latency: number; key: string; version: number; lsn: number };
  /** A primary shipped a record to a replica. */
  REPLICATION: { primaryId: NodeId; replicaId: NodeId; lsn: number; key: string; version: number; retransmit: boolean };
  REPLICATION_APPLIED: {
    replicaId: NodeId;
    primaryId: NodeId;
    lsn: number;
    key: string;
    version: number;
    /** Time from the write at the primary to it being visible here. */
    lagMs: number;
    /** Records the primary had committed that this replica had not yet applied. */
    behindRecords: number;
  };
  /** A replica answered a read with an older version than the primary held at that instant. */
  STALE_READ: {
    replicaId: NodeId;
    primaryId: NodeId;
    requestId: RequestId;
    key: string;
    readVersion: number;
    latestVersion: number;
    /** How long ago the newest, still-invisible write happened. */
    stalenessMs: number;
  };
  /** Arrival-order apply rolled a key back to an older version. */
  VERSION_REGRESSION: { replicaId: NodeId; key: string; fromVersion: number; toVersion: number; lsn: number };
  CACHE_HIT: { nodeId: NodeId; requestId: RequestId; key: string; version: number; ageMs: number };
  CACHE_MISS: { nodeId: NodeId; requestId: RequestId; key: string; reason: 'absent' | 'expired' };
  CACHE_FILL: { nodeId: NodeId; requestId: RequestId; key: string; version: number; expiresAt: SimTime };
  CACHE_INVALIDATED: { nodeId: NodeId; requestId: RequestId; key: string };
  CACHE_EVICTED: { nodeId: NodeId; key: string };
  /** A miss joined a fill already in flight for the same key instead of going to the database. */
  CACHE_COALESCED: { nodeId: NodeId; requestId: RequestId; key: string; waitingOn: RequestId };
  DUPLICATE_WRITE_SUPPRESSED: { nodeId: NodeId; requestId: RequestId; key: string; version: number };
  /** The same request's write applied a second time — idempotency was off. */
  DUPLICATE_WRITE_APPLIED: { nodeId: NodeId; requestId: RequestId; key: string; firstVersion: number; secondVersion: number };
}

export function validateDataConfig(
  config: DataNodeConfig,
  path: string,
  push: IssueReporter,
  context: SpecValidationContext,
): void {
  const raw = config as Record<string, unknown>;
  checkOneOf(raw.readPreference, READ_PREFERENCES, `${path}.readPreference`, push);
  checkOneOf(raw.replicaApply, REPLICA_APPLY_MODES, `${path}.replicaApply`, push);
  checkLatency(raw.replicationDelay as LatencySpec | undefined, `${path}.replicationDelay`, push);
  if (raw.replicaOf !== undefined) {
    checkNodeRef(raw.replicaOf, `${path}.replicaOf`, push, context, ['database']);
    const primary = raw.replicaOf;
    const self = context.self?.id;
    if (typeof primary === 'string' && context.nodeIds.has(primary) && self !== undefined) {
      // Replication travels over the network, so the two must be linked.
      const linked = context.links.some(
        (l) => (l.from === primary && l.to === self) || (l.to === primary && l.from === self),
      );
      if (!linked) push(`${path}.replicaOf`, `replica must be linked to its primary "${primary}"`);
    }
  }
  if (raw.replication !== undefined) {
    const replication = raw.replication as Record<string, unknown>;
    if (typeof replication !== 'object' || replication === null) push(`${path}.replication`, 'must be an object');
    else {
      checkOneOf(replication.mode, REPLICATION_MODES, `${path}.replication.mode`, push);
      if (replication.mode === undefined) push(`${path}.replication.mode`, 'is required');
      checkInteger(replication.syncReplicas, `${path}.replication.syncReplicas`, push, 1);
      checkPositive(replication.retransmitMs, `${path}.replication.retransmitMs`, push, true);
    }
  }
  if (raw.cache !== undefined) {
    const cache = raw.cache as Record<string, unknown>;
    if (typeof cache !== 'object' || cache === null) push(`${path}.cache`, 'must be an object');
    else {
      checkPositive(cache.ttlMs, `${path}.cache.ttlMs`, push, false);
      checkInteger(cache.capacity, `${path}.cache.capacity`, push, 1);
    }
  }
}
