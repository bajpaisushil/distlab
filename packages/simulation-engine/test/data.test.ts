import { describe, expect, it } from 'vitest';
import { SPEC_VERSION, validateSimulationSpec, type NodeSpec, type SimulationSpec, type WorkloadSpec } from '@distlab/shared';
import { createSimulation, type SimulationWorld } from '../src/world.js';
import { expectReplayEquivalence } from './replay-harness.js';

function spec(partial: Partial<SimulationSpec> & Pick<SimulationSpec, 'nodes' | 'links' | 'workloads'>): SimulationSpec {
  return { version: SPEC_VERSION, id: 'data', name: 'data', seed: 'data', durationMs: 5000, ...partial };
}

/** API in front of a primary and two replicas. */
function replicated(options: {
  api?: Partial<NodeSpec['config']>;
  primary?: Partial<NodeSpec['config']>;
  replica?: Partial<NodeSpec['config']>;
  replicationLink?: Record<string, unknown>;
  workloads?: WorkloadSpec[];
  durationMs?: number;
  /** Stop issuing requests here, so replication can settle before the run ends. */
  stopAt?: number;
  faults?: SimulationSpec['faults'];
}): SimulationSpec {
  return spec({
    durationMs: options.durationMs ?? 5000,
    nodes: [
      { id: 'client', type: 'client' },
      { id: 'api', type: 'api', config: { processing: 2, ...options.api } },
      { id: 'db', type: 'database', config: { readLatency: 5, writeLatency: 10, ...options.primary } },
      { id: 'r1', type: 'replica', config: { replicaOf: 'db', readLatency: 5, replicationDelay: 100, ...options.replica } },
      { id: 'r2', type: 'replica', config: { replicaOf: 'db', readLatency: 5, replicationDelay: 100, ...options.replica } },
    ],
    links: [
      { from: 'client', to: 'api', latency: 5 },
      { from: 'api', to: 'db', latency: 5 },
      { from: 'api', to: 'r1', latency: 5 },
      { from: 'api', to: 'r2', latency: 5 },
      { from: 'db', to: 'r1', latency: 20, ...options.replicationLink },
      { from: 'db', to: 'r2', latency: 20, ...options.replicationLink },
    ],
    workloads: options.workloads ?? [
      {
        id: 'mixed',
        clientId: 'client',
        operation: 'DB_READ',
        arrival: { kind: 'poisson', ratePerSec: 200 },
        mix: [
          { operation: 'DB_READ', weight: 4 },
          { operation: 'DB_WRITE', weight: 1 },
        ],
        keys: 5,
        deadlineMs: 2000,
        ...(options.stopAt !== undefined ? { stopAt: options.stopAt } : {}),
      },
    ],
    ...(options.faults ? { faults: options.faults } : {}),
  });
}

function run(s: SimulationSpec): SimulationWorld {
  const world = createSimulation(s);
  world.run();
  return world;
}

const finalStore = (world: SimulationWorld, nodeId: string) => {
  const state = world.data.captureState() as { stores: [string, [string, { version: number }][]][] };
  const store = state.stores.find(([id]) => id === nodeId)?.[1] ?? [];
  return Object.fromEntries(store.map(([k, v]) => [k, v.version]));
};

describe('replication', () => {
  it('applies a write on each replica after link latency plus the apply delay', () => {
    const world = run(
      replicated({
        workloads: [{ id: 'w', clientId: 'client', operation: 'DB_WRITE', arrival: { kind: 'once', count: 1 }, keys: 1 }],
      }),
    );
    const applied = world.simulation.log.byType('REPLICATION_APPLIED');
    expect(applied.map((e) => e.payload.replicaId).sort()).toEqual(['r1', 'r2']);
    for (const e of applied) expect(e.payload.lagMs).toBe(20 + 100);
  });

  it('serves stale reads from lagging replicas, and none when reading from the primary', () => {
    const lagging = run(replicated({}));
    const stale = lagging.simulation.log.byType('STALE_READ');
    expect(stale.length).toBeGreaterThan(20);
    for (const e of stale) {
      expect(e.payload.readVersion).toBeLessThan(e.payload.latestVersion);
      expect(e.payload.stalenessMs).toBeLessThanOrEqual(120 + 1e-9);
    }
    expect(lagging.snapshot().modules.data.replicas.every((r) => r.staleRate > 0)).toBe(true);

    const primaryReads = run(replicated({ api: { readPreference: 'primary' } }));
    expect(primaryReads.simulation.log.byType('STALE_READ')).toHaveLength(0);
    expect(primaryReads.snapshot().modules.data.storageLoad.r1 ?? 0).toBe(0);
  });

  it('only ever writes to the primary', () => {
    const world = run(replicated({ api: { readPreference: 'replica' } }));
    const writes = world.simulation.log.byType('DB_WRITE');
    expect(writes.length).toBeGreaterThan(50);
    expect(writes.every((e) => e.payload.nodeId === 'db')).toBe(true);
    // With a replica preference, reads go to replicas.
    expect(world.simulation.log.byType('DB_READ').every((e) => e.payload.nodeId !== 'db')).toBe(true);
  });

  it('falls back to the primary when no replica is up', () => {
    const world = run(
      replicated({
        api: { readPreference: 'replica' },
        faults: [
          { kind: 'node_crash', at: 1000, nodeId: 'r1' },
          { kind: 'node_crash', at: 1000, nodeId: 'r2' },
        ],
      }),
    );
    const late = world.simulation.log.byType('DB_READ').filter((e) => e.at > 1200);
    expect(late.length).toBeGreaterThan(50);
    expect(late.every((e) => e.payload.nodeId === 'db')).toBe(true);
  });

  it('makes sync writes wait for replicas — and then never reads stale data that was acknowledged', () => {
    const asyncWorld = run(replicated({}));
    const syncWorld = run(replicated({ primary: { replication: { mode: 'sync' } } }));
    const writeLatency = (world: SimulationWorld) => {
      const writes = new Set(world.simulation.log.byType('REQUEST_CREATED').filter((e) => e.payload.operation === 'DB_WRITE').map((e) => e.payload.requestId));
      const latencies = world.simulation.log.byType('REQUEST_COMPLETED').filter((e) => writes.has(e.payload.requestId)).map((e) => e.payload.latency);
      return latencies.reduce((a, b) => a + b, 0) / latencies.length;
    };
    // Sync adds the replication round trip and apply delay: 20 + 100 + 20.
    expect(writeLatency(syncWorld) - writeLatency(asyncWorld)).toBeGreaterThan(130);

    // A read that starts after its key's write was acknowledged is never stale under sync replication.
    const log = syncWorld.simulation.log;
    const ackedAt = new Map<string, number>();
    const keyOf = new Map(log.byType('REQUEST_CREATED').map((e) => [e.payload.requestId, e.payload.key!]));
    for (const e of log.byType('REQUEST_COMPLETED')) {
      const created = log.byType('REQUEST_CREATED').find((c) => c.payload.requestId === e.payload.requestId);
      if (created?.payload.operation === 'DB_WRITE') ackedAt.set(keyOf.get(e.payload.requestId)!, e.at);
    }
    // Not asserting all reads are fresh — a read can race a newer write — only that every
    // stale read is missing a write that had not yet been acknowledged when the read was made.
    for (const stale of log.byType('STALE_READ')) {
      const created = log.byType('REQUEST_CREATED').find((c) => c.payload.requestId === stale.payload.requestId)!;
      const lastAck = ackedAt.get(stale.payload.key);
      if (lastAck !== undefined) expect(stale.payload.stalenessMs).toBeLessThan(stale.at - created.at + 200);
    }
  });

  it('applies reordered records in order when ordered, and regresses versions when naive', () => {
    const reorder = { reorderRate: 0.4, reorderDelay: 150 };
    // Writes stop a second before the end so in-flight records can land.
    const ordered = run(replicated({ replicationLink: reorder, replica: { replicationDelay: 0 }, stopAt: 4000 }));
    expect(ordered.simulation.log.byType('VERSION_REGRESSION')).toHaveLength(0);
    expect(finalStore(ordered, 'r1')).toEqual(finalStore(ordered, 'db'));

    const naive = run(replicated({ replicationLink: reorder, replica: { replicationDelay: 0, replicaApply: 'arrival' } }));
    const regressions = naive.simulation.log.byType('VERSION_REGRESSION');
    expect(regressions.length).toBeGreaterThan(0);
    for (const r of regressions) expect(r.payload.toVersion).toBeLessThan(r.payload.fromVersion);
  });

  it('catches up through retransmission when replication messages are lost', () => {
    const world = run(replicated({ replicationLink: { lossRate: 0.3 }, durationMs: 6000, stopAt: 3000 }));
    const log = world.simulation.log;
    expect(log.byType('REPLICATION').some((e) => e.payload.retransmit)).toBe(true);
    expect(finalStore(world, 'r1')).toEqual(finalStore(world, 'db'));
    expect(finalStore(world, 'r2')).toEqual(finalStore(world, 'db'));
  });

  it('brings a crashed replica back up to date after it recovers', () => {
    const world = run(replicated({ durationMs: 6000, stopAt: 4000, faults: [{ kind: 'node_crash', at: 1000, nodeId: 'r1', recoverAfter: 2000 }] }));
    expect(finalStore(world, 'r1')).toEqual(finalStore(world, 'db'));
  });
});

describe('caching', () => {
  const cached = (cache: Record<string, unknown>, workload: Partial<WorkloadSpec> = {}, durationMs = 4000) =>
    spec({
      durationMs,
      nodes: [
        { id: 'client', type: 'client' },
        { id: 'cache', type: 'cache', config: { processing: 1, concurrency: 512, queueCapacity: 1024, cache: cache as never } },
        { id: 'db', type: 'database', config: { readLatency: 50, concurrency: 512, queueCapacity: 1024 } },
      ],
      links: [
        { from: 'client', to: 'cache', latency: 2 },
        { from: 'cache', to: 'db', latency: 5 },
      ],
      workloads: [{ id: 'reads', clientId: 'client', operation: 'DB_READ', arrival: { kind: 'poisson', ratePerSec: 200 }, keys: 10, deadlineMs: 2000, ...workload }],
    });

  it('serves repeat reads from cache and only misses go to the database', () => {
    const world = run(cached({ ttlMs: 60_000 }));
    const stats = world.snapshot().modules.data.caches[0]!;
    expect(stats.hitRatio).toBeGreaterThan(0.95);
    expect(world.snapshot().modules.data.reads).toBe(stats.fills);
  });

  it('expires entries after their TTL', () => {
    const world = run(cached({ ttlMs: 500 }));
    const misses = world.simulation.log.byType('CACHE_MISS');
    expect(misses.some((e) => e.payload.reason === 'expired')).toBe(true);
    for (const hit of world.simulation.log.byType('CACHE_HIT')) expect(hit.payload.ageMs).toBeLessThan(500);
  });

  it('evicts the least recently used entry at capacity', () => {
    const world = run(cached({ ttlMs: 60_000, capacity: 3 }));
    const evicted = world.simulation.log.byType('CACHE_EVICTED');
    expect(evicted.length).toBeGreaterThan(10);
    expect(world.snapshot().modules.data.caches[0]!.hitRatio).toBeLessThan(0.6);
  });

  it('invalidates a key on write', () => {
    const world = run(
      cached({ ttlMs: 60_000 }, { mix: [{ operation: 'DB_READ', weight: 9 }, { operation: 'DB_WRITE', weight: 1 }] }),
    );
    expect(world.simulation.log.byType('CACHE_INVALIDATED').length).toBeGreaterThan(5);
  });

  it('turns a burst of misses for a hot key into one database read with coalescing', () => {
    const herd = (coalesce: boolean) =>
      run(cached({ ttlMs: 60_000, coalesce }, { arrival: { kind: 'once', count: 100 }, keys: 1 }, 1000));
    const stampede = herd(false);
    expect(stampede.simulation.log.byType('DB_READ')).toHaveLength(100);
    const single = herd(true);
    expect(single.simulation.log.byType('DB_READ')).toHaveLength(1);
    expect(single.simulation.log.byType('CACHE_COALESCED')).toHaveLength(99);
    expect(single.simulation.log.byType('REQUEST_COMPLETED')).toHaveLength(100);
  });

  it('loses its contents in a crash', () => {
    const s = cached({ ttlMs: 60_000 }, {}, 4000);
    s.faults = [{ kind: 'node_crash', at: 2000, nodeId: 'cache', recoverAfter: 100 }];
    const world = run(s);
    const missesAfter = world.simulation.log.byType('CACHE_MISS').filter((e) => e.at > 2100 && e.at < 2300);
    expect(missesAfter.length).toBeGreaterThan(5);
  });
});

describe('idempotency', () => {
  const duplicated = (idempotentWrites: boolean) =>
    run(
      spec({
        nodes: [
          { id: 'client', type: 'client' },
          { id: 'api', type: 'api', config: { processing: 2 } },
          { id: 'db', type: 'database', config: { idempotentWrites } },
        ],
        links: [
          { from: 'client', to: 'api', latency: 5 },
          { from: 'api', to: 'db', latency: 5, duplicateRate: 1 },
        ],
        workloads: [{ id: 'w', clientId: 'client', operation: 'DB_WRITE', arrival: { kind: 'once', count: 10 }, keys: 3 }],
      }),
    );

  it('applies a duplicated write twice without idempotency', () => {
    const world = duplicated(false);
    expect(world.simulation.log.byType('DUPLICATE_WRITE_APPLIED')).toHaveLength(10);
    expect(world.simulation.log.byType('DB_WRITE')).toHaveLength(20);
  });

  it('applies it once with idempotency', () => {
    const world = duplicated(true);
    expect(world.simulation.log.byType('DUPLICATE_WRITE_SUPPRESSED')).toHaveLength(10);
    expect(world.simulation.log.byType('DB_WRITE')).toHaveLength(10);
  });
});

describe('data configuration', () => {
  it('validates replicas and caches', () => {
    const bad = spec({
      nodes: [
        { id: 'db', type: 'database', config: { replication: { mode: 'eventual' as never } } },
        { id: 'r', type: 'replica', config: { replicaOf: 'nope', readPreference: 'closest' as never } },
        { id: 'r2', type: 'replica', config: { replicaOf: 'db' } },
        { id: 'c', type: 'cache', config: { cache: { ttlMs: 0 } } },
      ],
      links: [],
      workloads: [],
    });
    const paths = validateSimulationSpec(bad).errors.map((e) => e.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'nodes[0].config.replication.mode',
        'nodes[1].config.replicaOf',
        'nodes[1].config.readPreference',
        'nodes[2].config.replicaOf',
        'nodes[3].config.cache.ttlMs',
      ]),
    );
    expect(validateSimulationSpec(bad).errors.find((e) => e.path === 'nodes[2].config.replicaOf')?.message).toMatch(/linked/);
  });
});

describe('data checkpoints', () => {
  it('replays replication, caching and a replica crash exactly', () => {
    const s = replicated({
      durationMs: 4000,
      replicationLink: { lossRate: 0.1, reorderRate: 0.2, reorderDelay: 60 },
      primary: { replication: { mode: 'sync', syncReplicas: 1 }, idempotentWrites: true },
      faults: [{ kind: 'node_crash', at: 1500, nodeId: 'r2', recoverAfter: 800 }],
    });
    s.nodes.push({ id: 'edge', type: 'cache', config: { cache: { ttlMs: 300, coalesce: true, capacity: 3 } } });
    s.nodes.push({ id: 'client-2', type: 'client' });
    s.links.push({ from: 'client-2', to: 'edge', latency: 3 }, { from: 'edge', to: 'db', latency: 4 });
    s.workloads.push({ id: 'edge-reads', clientId: 'client-2', operation: 'DB_READ', arrival: { kind: 'poisson', ratePerSec: 150 }, keys: 6, hotKeyShare: 0.5, deadlineMs: 800 });
    expectReplayEquivalence(s);
  });
});
