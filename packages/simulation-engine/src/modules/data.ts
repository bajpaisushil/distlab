import { acceptOrdered, unacknowledged, type ReplicationRecord } from '@distlab/algorithms';
import {
  isWriteOperation,
  readTargetOf,
  sampleLatency,
  type EventId,
  type LatencySpec,
  type Message,
  type MessageId,
  type NodeId,
  type ReplicateAckPayload,
  type ReplicatePayload,
  type RequestBody,
  type RequestId,
  type ResponseData,
  type ResponseMessage,
  type SimEvent,
  type SimNode,
} from '@distlab/shared';
import type { DataPlane, ModuleServices, ServeDecision, ServeRequest } from './types.js';

const MODULE = 'data';
const DEFAULT_KEY = 'default';
const DEFAULT_RETRANSMIT_MS = 500;
const DEFAULT_CACHE_CAPACITY = 1000;
const DEFAULT_CACHE_TTL_MS = 30_000;
/** Records re-sent to one replica per retransmission tick. */
const RETRANSMIT_BATCH = 64;

interface StoredValue {
  readonly version: number;
  readonly writtenAt: number;
}

interface PrimaryState {
  lsn: number;
  /** Records not yet acknowledged by every replica. Durable: this is the write-ahead log. */
  log: ReplicationRecord[];
  /** Replica -> everything applied up to this LSN. */
  readonly acked: Map<NodeId, number>;
  retransmitTimer: EventId | undefined;
  /** Writes already applied, by request, for idempotency and duplicate detection. */
  readonly applied: Map<RequestId, { key: string; version: number }>;
}

interface ReplicaState {
  appliedThrough: number;
  /** Arrival mode: individual records applied, since order is not guaranteed. */
  readonly appliedLsns: Set<number>;
  /** Ordered mode: records waiting for an earlier one. In memory; lost in a crash. */
  buffer: Map<number, ReplicationRecord>;
  /** Received while replication was stalled, applied when it resumes. In memory; lost in a crash. */
  stalled: StalledRecord[];
}

interface StalledRecord {
  readonly primaryId: NodeId;
  readonly record: ReplicationRecord;
}

interface SyncWait {
  readonly primaryId: NodeId;
  readonly workId: MessageId;
  readonly lsn: number;
  readonly needed: number;
  readonly acks: Set<NodeId>;
  readonly key: string;
  readonly version: number;
}

interface CacheEntry {
  readonly version: number;
  readonly filledAt: number;
  readonly expiresAt: number;
}

interface Fill {
  readonly leaderWorkId: MessageId;
  readonly leaderRequestId: RequestId;
  readonly waiters: { workId: MessageId; requestId: RequestId }[];
}

interface CacheState {
  /** Insertion order is recency: touching an entry re-inserts it. In memory only. */
  entries: Map<string, CacheEntry>;
  fills: Map<string, Fill>;
}

/** Plain-data checkpoint. */
interface DataState {
  readonly stores: readonly (readonly [NodeId, readonly (readonly [string, StoredValue])[]])[];
  readonly primaries: readonly (readonly [
    NodeId,
    {
      lsn: number;
      log: ReplicationRecord[];
      acked: (readonly [NodeId, number])[];
      retransmitTimer: EventId | undefined;
      applied: (readonly [RequestId, { key: string; version: number }])[];
    },
  ])[];
  readonly replicas: readonly (readonly [
    NodeId,
    { appliedThrough: number; appliedLsns: number[]; buffer: ReplicationRecord[]; stalled?: StalledRecord[] },
  ])[];
  readonly syncWaits: readonly (Omit<SyncWait, 'acks'> & { readonly acks: readonly NodeId[] })[];
  readonly caches: readonly (readonly [
    NodeId,
    { entries: (readonly [string, CacheEntry])[]; fills: (readonly [string, Fill])[] },
  ])[];
}

const STORAGE = new Set(['database', 'replica']);

/**
 * Storage, replication and caching on the request path.
 *
 * Databases keep versioned keys; a write at a primary takes the next log
 * sequence number as its version and is shipped to every replica as a
 * REPLICATE message through the network — so link latency, loss and
 * reordering all apply to replication. Replicas apply after their configured
 * delay, either strictly in LSN order or naively in arrival order, and
 * acknowledge; the primary re-sends anything unacknowledged, so a lost record
 * delays a replica but never strands it. A replica serving a read compares
 * notes with nobody — but the simulator does, and reports a stale read when
 * the primary held something newer at that instant.
 *
 * Caches answer fresh hits themselves, forward misses and fill on the way
 * back, invalidate on writes, evict the least recently used entry at
 * capacity, and — with coalescing on — make concurrent misses for one key
 * wait on a single fill instead of stampeding the database.
 */
export function createDataPlane(services: ModuleServices): DataPlane {
  let stores = new Map<NodeId, Map<string, StoredValue>>();
  let primaries = new Map<NodeId, PrimaryState>();
  let replicas = new Map<NodeId, ReplicaState>();
  let syncWaits: SyncWait[] = [];
  let caches = new Map<NodeId, CacheState>();

  const now = () => services.context.now();
  const nodeOf = (id: NodeId) => services.registry.get(id);

  /** Replicas configured to copy `primaryId`, in id order. */
  const replicasOf = (primaryId: NodeId): NodeId[] =>
    services.registry
      .all()
      .filter((n) => n.type === 'replica' && n.config.replicaOf === primaryId)
      .map((n) => n.id)
      .sort();

  const storeOf = (id: NodeId) => {
    let store = stores.get(id);
    if (!store) {
      store = new Map();
      stores.set(id, store);
    }
    return store;
  };

  const primaryOf = (id: NodeId): PrimaryState => {
    let state = primaries.get(id);
    if (!state) {
      state = { lsn: 0, log: [], acked: new Map(), retransmitTimer: undefined, applied: new Map() };
      primaries.set(id, state);
    }
    return state;
  };

  const replicaOf = (id: NodeId): ReplicaState => {
    let state = replicas.get(id);
    if (!state) {
      state = { appliedThrough: 0, appliedLsns: new Set(), buffer: new Map(), stalled: [] };
      replicas.set(id, state);
    }
    return state;
  };

  const cacheOf = (id: NodeId): CacheState => {
    let state = caches.get(id);
    if (!state) {
      state = { entries: new Map(), fills: new Map() };
      caches.set(id, state);
    }
    return state;
  };

  const meta = (node: SimNode, message: Message, causedBy: EventId) => ({
    nodeId: node.id,
    ...(message.traceId !== undefined ? { traceId: message.traceId } : {}),
    causedBy,
  });

  // --- replication --------------------------------------------------------

  const ship = (primaryId: NodeId, replicaId: NodeId, record: ReplicationRecord, retransmit: boolean, causedBy?: EventId) => {
    const payload: ReplicatePayload = { ...record, retransmit };
    services.emit(
      'REPLICATION',
      { primaryId, replicaId, lsn: record.lsn, key: record.key, version: record.version, retransmit },
      { nodeId: primaryId, ...(causedBy !== undefined ? { causedBy } : {}) },
    );
    services.send({
      kind: 'REPLICATE',
      source: primaryId,
      destination: replicaId,
      type: 'REPLICATE',
      payload,
      sizeBytes: 256,
      hop: 0,
      ...(causedBy !== undefined ? { causedBy } : {}),
    });
  };

  const armRetransmit = (primaryId: NodeId, causedBy?: EventId) => {
    const state = primaryOf(primaryId);
    if (state.retransmitTimer !== undefined || state.log.length === 0) return;
    const policy = nodeOf(primaryId)?.config.replication;
    state.retransmitTimer = services.setTimer(primaryId, MODULE, 'retransmit', policy?.retransmitMs ?? DEFAULT_RETRANSMIT_MS, undefined, causedBy);
  };

  /** Forgets log records every replica has acknowledged. */
  const prune = (primaryId: NodeId) => {
    const state = primaryOf(primaryId);
    const members = replicasOf(primaryId);
    const floor = members.length === 0 ? state.lsn : Math.min(...members.map((r) => state.acked.get(r) ?? 0));
    state.log = state.log.filter((record) => record.lsn > floor);
  };

  const write = (node: SimNode, request: ServeRequest): ServeDecision => {
    const { message, body, causedBy } = request;
    const key = body.key ?? DEFAULT_KEY;
    const state = primaryOf(node.id);
    const previous = state.applied.get(message.requestId);

    if (previous && node.config.idempotentWrites) {
      services.emit(
        'DUPLICATE_WRITE_SUPPRESSED',
        { nodeId: node.id, requestId: message.requestId, key: previous.key, version: previous.version },
        meta(node, message, causedBy),
      );
      return { kind: 'respond', status: 'ok', data: { key: previous.key, version: previous.version } };
    }

    state.lsn += 1;
    const version = state.lsn;
    const record: ReplicationRecord = { lsn: state.lsn, key, version, writtenAt: now() };
    storeOf(node.id).set(key, { version, writtenAt: record.writtenAt });
    services.emit(
      'DB_WRITE',
      { nodeId: node.id, requestId: message.requestId, latency: request.serviceTime, key, version, lsn: record.lsn },
      meta(node, message, causedBy),
    );
    if (previous) {
      services.emit(
        'DUPLICATE_WRITE_APPLIED',
        { nodeId: node.id, requestId: message.requestId, key, firstVersion: previous.version, secondVersion: version },
        meta(node, message, causedBy),
      );
    } else {
      state.applied.set(message.requestId, { key, version });
    }

    const members = replicasOf(node.id);
    if (members.length > 0) {
      state.log.push(record);
      for (const replicaId of members) ship(node.id, replicaId, record, false, causedBy);
      armRetransmit(node.id, causedBy);
    }

    const policy = node.config.replication;
    if (policy?.mode === 'sync' && members.length > 0) {
      // The write is durable on the primary but not acknowledged to the
      // caller until enough replicas have it.
      syncWaits.push({
        primaryId: node.id,
        workId: request.workId,
        lsn: record.lsn,
        needed: Math.min(members.length, policy.syncReplicas ?? members.length),
        acks: new Set(),
        key,
        version,
      });
      return { kind: 'defer' };
    }
    return { kind: 'respond', status: 'ok', data: { key, version } };
  };

  const read = (node: SimNode, request: ServeRequest): ServeDecision => {
    const { message, body, causedBy } = request;
    const key = body.key ?? DEFAULT_KEY;
    const value = storeOf(node.id).get(key);
    const version = value?.version ?? 0;
    let stale = false;

    if (node.type === 'replica' && node.config.replicaOf) {
      const primaryId = node.config.replicaOf;
      const latest = stores.get(primaryId)?.get(key);
      if (latest && latest.version > version) {
        stale = true;
        services.emit(
          'STALE_READ',
          {
            replicaId: node.id,
            primaryId,
            requestId: message.requestId,
            key,
            readVersion: version,
            latestVersion: latest.version,
            stalenessMs: now() - latest.writtenAt,
          },
          meta(node, message, causedBy),
        );
      }
    }
    services.emit(
      'DB_READ',
      { nodeId: node.id, requestId: message.requestId, latency: request.serviceTime, key, version, ...(stale ? { stale } : {}) },
      meta(node, message, causedBy),
    );
    const data: ResponseData = { key, version, ...(stale ? { stale } : {}) };
    return { kind: 'respond', status: 'ok', data };
  };

  const onReplicate = (replica: SimNode, message: Message, event: SimEvent<'MESSAGE_RECEIVED'>) => {
    const record = message.payload as ReplicatePayload;
    const delay = sampleLatency(replica.config.replicationDelay ?? 0, services.rng(MODULE, replica.id));
    services.setTimer(
      replica.id,
      MODULE,
      'apply',
      delay,
      { lsn: record.lsn, key: record.key, version: record.version, writtenAt: record.writtenAt, primary: message.source },
      event.id,
    );
  };

  const apply = (replica: SimNode, event: SimEvent<'TIMER'>) => {
    const data = event.payload.data!;
    const primaryId = String(data.primary);
    const record: ReplicationRecord = {
      lsn: Number(data.lsn),
      key: String(data.key),
      version: Number(data.version),
      writtenAt: Number(data.writtenAt),
    };
    if (replica.state.replicationStalled) {
      // The apply thread is stuck: the record waits, unacknowledged, and the replica serves what it already has.
      const state = replicaOf(replica.id);
      if (!state.stalled.some((s) => s.record.lsn === record.lsn && s.primaryId === primaryId)) {
        state.stalled.push({ primaryId, record });
      }
      return;
    }
    applyRecord(replica, primaryId, record, event.id);
  };

  const applyRecord = (replica: SimNode, primaryId: NodeId, record: ReplicationRecord, causedBy: EventId) => {
    const state = replicaOf(replica.id);
    const store = storeOf(replica.id);
    const primaryLsn = primaryOf(primaryId).lsn;

    const applyOne = (r: ReplicationRecord) => {
      const current = store.get(r.key);
      if (current && current.version > r.version) {
        services.emit(
          'VERSION_REGRESSION',
          { replicaId: replica.id, key: r.key, fromVersion: current.version, toVersion: r.version, lsn: r.lsn },
          { nodeId: replica.id, causedBy },
        );
      }
      store.set(r.key, { version: r.version, writtenAt: r.writtenAt });
      services.emit(
        'REPLICATION_APPLIED',
        {
          replicaId: replica.id,
          primaryId,
          lsn: r.lsn,
          key: r.key,
          version: r.version,
          lagMs: now() - r.writtenAt,
          behindRecords: Math.max(0, primaryLsn - Math.max(state.appliedThrough, r.lsn)),
        },
        { nodeId: replica.id, causedBy },
      );
    };

    if ((replica.config.replicaApply ?? 'ordered') === 'arrival') {
      // Naive: whatever arrives is applied — older records can overwrite newer ones.
      if (!state.appliedLsns.has(record.lsn)) {
        state.appliedLsns.add(record.lsn);
        applyOne(record);
        while (state.appliedLsns.has(state.appliedThrough + 1)) {
          state.appliedLsns.delete(state.appliedThrough + 1);
          state.appliedThrough += 1;
        }
      }
    } else {
      const result = acceptOrdered(state.appliedThrough, state.buffer, record);
      state.appliedThrough = result.appliedThrough;
      state.buffer = new Map(result.buffer);
      for (const r of result.apply) applyOne(r);
    }

    const ack: ReplicateAckPayload = { appliedThrough: state.appliedThrough };
    services.send({
      kind: 'REPLICATE_ACK',
      source: replica.id,
      destination: primaryId,
      type: 'REPLICATE_ACK',
      payload: ack,
      sizeBytes: 64,
      hop: 0,
      causedBy,
    });
  };

  const onAck = (primary: SimNode, message: Message, event: SimEvent<'MESSAGE_RECEIVED'>) => {
    const { appliedThrough } = message.payload as ReplicateAckPayload;
    const state = primaryOf(primary.id);
    const replicaId = message.source;
    if (appliedThrough > (state.acked.get(replicaId) ?? 0)) state.acked.set(replicaId, appliedThrough);

    const completed: SyncWait[] = [];
    for (const wait of syncWaits) {
      if (wait.primaryId !== primary.id || wait.lsn > appliedThrough) continue;
      wait.acks.add(replicaId);
      if (wait.acks.size >= wait.needed) completed.push(wait);
    }
    if (completed.length > 0) {
      syncWaits = syncWaits.filter((w) => !completed.includes(w));
      for (const wait of completed) {
        services.completeDeferred(primary.id, wait.workId, 'ok', { key: wait.key, version: wait.version }, event.id);
      }
    }
    prune(primary.id);
  };

  const retransmit = (primary: SimNode, event: SimEvent<'TIMER'>) => {
    const state = primaryOf(primary.id);
    state.retransmitTimer = undefined;
    prune(primary.id);
    for (const replicaId of replicasOf(primary.id)) {
      const replica = nodeOf(replicaId);
      // Nothing to gain sending to a node that is down; the next tick will try again.
      if (!replica || replica.state.status === 'failed') continue;
      for (const record of unacknowledged(state.log, state.acked.get(replicaId) ?? 0, RETRANSMIT_BATCH)) {
        ship(primary.id, replicaId, record, true, event.id);
      }
    }
    armRetransmit(primary.id, event.id);
  };

  // --- caching ------------------------------------------------------------

  const cacheServe = (node: SimNode, request: ServeRequest): ServeDecision => {
    const { message, body, causedBy, workId } = request;
    const key = body.key ?? DEFAULT_KEY;
    const cache = cacheOf(node.id);

    if (isWriteOperation(body.operation)) {
      if (cache.entries.delete(key)) {
        services.emit('CACHE_INVALIDATED', { nodeId: node.id, requestId: message.requestId, key }, meta(node, message, causedBy));
      }
      return { kind: 'forward' };
    }

    const entry = cache.entries.get(key);
    if (entry && now() < entry.expiresAt) {
      // Re-insert to mark it most recently used.
      cache.entries.delete(key);
      cache.entries.set(key, entry);
      services.emit(
        'CACHE_HIT',
        { nodeId: node.id, requestId: message.requestId, key, version: entry.version, ageMs: now() - entry.filledAt },
        meta(node, message, causedBy),
      );
      return { kind: 'respond', status: 'ok', data: { key, version: entry.version, cache: 'hit' } };
    }

    services.emit(
      'CACHE_MISS',
      { nodeId: node.id, requestId: message.requestId, key, reason: entry ? 'expired' : 'absent' },
      meta(node, message, causedBy),
    );
    const policy = node.config.cache;
    const fill = cache.fills.get(key);
    if (fill && policy?.coalesce) {
      fill.waiters.push({ workId, requestId: message.requestId });
      services.emit(
        'CACHE_COALESCED',
        { nodeId: node.id, requestId: message.requestId, key, waitingOn: fill.leaderRequestId },
        meta(node, message, causedBy),
      );
      return { kind: 'defer' };
    }
    if (!fill) cache.fills.set(key, { leaderWorkId: workId, leaderRequestId: message.requestId, waiters: [] });
    return { kind: 'forward' };
  };

  const cacheFill = (node: SimNode, body: RequestBody, response: ResponseMessage, causedBy: EventId): ResponseData | undefined => {
    if (isWriteOperation(body.operation)) return undefined;
    const key = body.key ?? DEFAULT_KEY;
    const cache = cacheOf(node.id);
    const fill = cache.fills.get(key);
    const ours = fill?.leaderRequestId === response.requestId;
    if (ours) cache.fills.delete(key);
    const ok = response.payload.status === 'ok';
    const version = response.payload.data?.version ?? 0;

    if (ok) {
      const policy = node.config.cache;
      const ttl = policy?.ttlMs ?? DEFAULT_CACHE_TTL_MS;
      cache.entries.delete(key);
      cache.entries.set(key, { version, filledAt: now(), expiresAt: now() + ttl });
      services.emit(
        'CACHE_FILL',
        { nodeId: node.id, requestId: response.requestId, key, version, expiresAt: now() + ttl },
        { nodeId: node.id, traceId: response.traceId, causedBy },
      );
      const capacity = policy?.capacity ?? DEFAULT_CACHE_CAPACITY;
      while (cache.entries.size > capacity) {
        const oldest = cache.entries.keys().next().value as string;
        cache.entries.delete(oldest);
        services.emit('CACHE_EVICTED', { nodeId: node.id, key: oldest }, { nodeId: node.id, causedBy });
      }
    }
    if (ours && fill) {
      for (const waiter of fill.waiters) {
        services.completeDeferred(
          node.id,
          waiter.workId,
          ok ? 'ok' : response.payload.status,
          ok ? { key, version, cache: 'miss' } : undefined,
          causedBy,
        );
      }
    }
    return ok ? { key, version, cache: 'miss' } : undefined;
  };

  /** The fill's leader is gone without an answer: its waiters cannot be served by it. */
  const abandonFill = (node: SimNode, workId: MessageId) => {
    const cache = caches.get(node.id);
    if (!cache) return;
    for (const [key, fill] of cache.fills) {
      if (fill.leaderWorkId === workId) {
        cache.fills.delete(key);
        for (const waiter of fill.waiters) services.completeDeferred(node.id, waiter.workId, 'error', undefined, undefined);
      } else {
        const index = fill.waiters.findIndex((w) => w.workId === workId);
        if (index >= 0) fill.waiters.splice(index, 1);
      }
    }
  };

  return {
    name: MODULE,
    messageKinds: ['REPLICATE', 'REPLICATE_ACK'],
    servesNodeTypes: [],

    attach(on) {
      // A stalled replica catches up the moment it unsticks, in the order records arrived.
      on('NODE_CONDITION_CHANGED', (event) => {
        if (event.payload.replicationStalled) return;
        const replica = services.registry.get(event.payload.nodeId);
        const state = replicas.get(event.payload.nodeId);
        if (!replica || !state || state.stalled.length === 0 || replica.state.status === 'failed') return;
        const backlog = state.stalled;
        state.stalled = [];
        for (const { primaryId, record } of backlog) applyRecord(replica, primaryId, record, event.id);
      });
    },

    onMessage(node, message, event) {
      if (message.kind === 'REPLICATE' && node.type === 'replica') onReplicate(node, message, event);
      else if (message.kind === 'REPLICATE_ACK') onAck(node, message, event);
    },

    onTimer(node, event) {
      if (event.payload.name === 'apply') apply(node, event);
      else if (event.payload.name === 'retransmit') retransmit(node, event);
    },

    onNodeFailed(node) {
      // Storage contents, the write-ahead log and a replica's applied position
      // are on disk and survive. What was only in memory does not: a replica's
      // buffer of early records, writes waiting on replica acknowledgements,
      // the retransmission timer, and the whole contents of a cache.
      const primary = primaries.get(node.id);
      if (primary) primary.retransmitTimer = undefined;
      const replica = replicas.get(node.id);
      if (replica) {
        replica.buffer = new Map();
        replica.stalled = [];
      }
      syncWaits = syncWaits.filter((w) => w.primaryId !== node.id);
      caches.delete(node.id);
    },

    onNodeRecovered(node, event) {
      if (node.type === 'database') armRetransmit(node.id, event.id);
    },

    serviceLatency(node: SimNode, body: RequestBody): LatencySpec {
      if (STORAGE.has(node.type)) {
        const specific = isWriteOperation(body.operation) ? node.config.writeLatency : node.config.readLatency;
        if (specific !== undefined) return specific;
      }
      return node.config.processing;
    },

    serve(request: ServeRequest): ServeDecision {
      const { node, body } = request;
      if (node.type === 'cache') return cacheServe(node, request);
      if (!STORAGE.has(node.type)) return { kind: 'forward' };
      if (isWriteOperation(body.operation)) {
        // Replicas are read-only; a write that reaches one is refused.
        if (node.type === 'replica') return { kind: 'respond', status: 'error' };
        return write(node, request);
      }
      return read(node, request);
    },

    filterCandidates(node, body, candidates) {
      const storage = candidates.filter((c) => STORAGE.has(c.type));
      if (storage.length === 0) return candidates;
      const others = candidates.filter((c) => !STORAGE.has(c.type));
      const primariesOnly = storage.filter((c) => c.type === 'database');
      if (isWriteOperation(body.operation)) return [...others, ...primariesOnly];
      // A request that names its target (READ_PRIMARY / READ_REPLICA) overrides the caller's preference.
      switch (readTargetOf(body.operation) ?? node.config.readPreference ?? 'any') {
        case 'primary':
          return [...others, ...primariesOnly];
        case 'replica': {
          const replicaCandidates = storage.filter((c) => c.type === 'replica');
          // With no healthy replica, fall back to the primary rather than fail.
          return [...others, ...(replicaCandidates.length > 0 ? replicaCandidates : primariesOnly)];
        }
        case 'any':
          return candidates;
      }
    },

    onWorkReleased(node, workId) {
      if (node.type === 'cache') abandonFill(node, workId);
      if (syncWaits.some((w) => w.workId === workId && w.primaryId === node.id)) {
        syncWaits = syncWaits.filter((w) => !(w.workId === workId && w.primaryId === node.id));
      }
    },

    onDownstreamResponse(node, body, response, causedBy) {
      return node.type === 'cache' ? cacheFill(node, body, response, causedBy) : undefined;
    },

    captureState(): DataState {
      return {
        stores: [...stores.entries()].map(([id, store]) => [id, [...store.entries()]] as const),
        primaries: [...primaries.entries()].map(([id, p]) => [
          id,
          {
            lsn: p.lsn,
            log: [...p.log],
            acked: [...p.acked.entries()],
            retransmitTimer: p.retransmitTimer,
            applied: [...p.applied.entries()].map(([r, v]) => [r, { ...v }] as const),
          },
        ]),
        replicas: [...replicas.entries()].map(([id, r]) => [
          id,
          {
            appliedThrough: r.appliedThrough,
            appliedLsns: [...r.appliedLsns],
            buffer: [...r.buffer.values()],
            stalled: r.stalled.map((x) => ({ ...x })),
          },
        ]),
        syncWaits: syncWaits.map((w) => ({ ...w, acks: [...w.acks] })),
        caches: [...caches.entries()].map(([id, c]) => [
          id,
          {
            entries: [...c.entries.entries()].map(([k, e]) => [k, { ...e }] as const),
            fills: [...c.fills.entries()].map(([k, f]) => [k, { ...f, waiters: f.waiters.map((w) => ({ ...w })) }] as const),
          },
        ]),
      };
    },

    restoreState(raw: unknown) {
      const state = raw as DataState;
      stores = new Map((state.stores ?? []).map(([id, entries]) => [id, new Map(entries.map(([k, v]) => [k, { ...v }]))]));
      primaries = new Map(
        (state.primaries ?? []).map(([id, p]) => [
          id,
          {
            lsn: p.lsn,
            log: [...p.log],
            acked: new Map(p.acked),
            retransmitTimer: p.retransmitTimer,
            applied: new Map(p.applied.map(([r, v]) => [r, { ...v }])),
          },
        ]),
      );
      replicas = new Map(
        (state.replicas ?? []).map(([id, r]) => [
          id,
          {
            appliedThrough: r.appliedThrough,
            appliedLsns: new Set(r.appliedLsns),
            buffer: new Map(r.buffer.map((x) => [x.lsn, x])),
            stalled: (r.stalled ?? []).map((x) => ({ ...x })),
          },
        ]),
      );
      syncWaits = (state.syncWaits ?? []).map((w) => ({ ...w, acks: new Set(w.acks) }));
      caches = new Map(
        (state.caches ?? []).map(([id, c]) => [
          id,
          {
            entries: new Map(c.entries.map(([k, e]) => [k, { ...e }])),
            fills: new Map(c.fills.map(([k, f]) => [k, { ...f, waiters: f.waiters.map((w) => ({ ...w })) }])),
          },
        ]),
      );
    },
  };
}
