import { describe, expect, it } from 'vitest';
import { SPEC_VERSION, validateSimulationSpec, type FaultSpec, type SimulationSpec } from '@distlab/shared';
import { createSimulation } from '../src/world.js';
import { chainScenario, constantLoad } from './helpers.js';
import { expectReplayEquivalence } from './replay-harness.js';

function chain(faults: FaultSpec[], durationMs = 4000): SimulationSpec {
  return { ...chainScenario({ durationMs, workloads: [constantLoad(20, { deadlineMs: 2000 })] }), faults };
}

function run(spec: SimulationSpec) {
  const world = createSimulation(spec);
  world.run();
  return world;
}

/** End-to-end latency of requests by when they were issued. */
function latenciesIssuedBetween(world: ReturnType<typeof run>, from: number, to: number): number[] {
  return world.simulation.log
    .byType('REQUEST_COMPLETED')
    .filter((e) => e.at - e.payload.latency >= from && e.at - e.payload.latency < to)
    .map((e) => e.payload.latency);
}

describe('node pause (stop-the-world)', () => {
  const paused = chain([{ kind: 'node_pause', at: 1000, nodeId: 'api', durationMs: 800 }]);

  it('freezes the node: nothing at it runs until it resumes, then everything that waited runs', () => {
    const world = run(paused);
    const log = world.simulation.log;
    expect(log.byType('NODE_PAUSED').map((e) => e.at)).toEqual([1000]);
    const [resumed] = log.byType('NODE_RESUMED');
    expect(resumed!.at).toBe(1800);
    expect(resumed!.payload.pausedForMs).toBe(800);
    expect(resumed!.payload.heldEvents).toBeGreaterThan(10);

    // Nothing at the API was dispatched while it was frozen.
    const atApi = log.all().filter((e) => e.nodeId === 'api' && e.at > 1000 && e.at < 1800);
    expect(atApi.map((e) => e.type).filter((t) => t !== 'NODE_PAUSED')).toEqual([]);
    // The frozen node is still "up": the balancer keeps sending to it.
    expect(log.byType('MESSAGE_SENT').some((e) => e.payload.message.destination === 'api' && e.at > 1100 && e.at < 1700)).toBe(true);
  });

  it('delivers held work in its original order and charges the pause to its latency', () => {
    const world = run(paused);
    const log = world.simulation.log;
    const arrivals = log
      .byType('MESSAGE_RECEIVED')
      .filter((e) => e.at === 1800 && e.payload.message.destination === 'api')
      .map((e) => e.payload.message.createdAt);
    expect(arrivals.length).toBeGreaterThan(5);
    expect(arrivals).toEqual([...arrivals].sort((a, b) => a - b));

    const during = latenciesIssuedBetween(world, 1100, 1700);
    expect(Math.min(...during)).toBeGreaterThan(100);
    expect(Math.max(...latenciesIssuedBetween(world, 2000, 3000))).toBeLessThan(100);
    expect(world.snapshot().modules.faults.frozenMs).toEqual({ api: 800 });
  });

  it('defers module timers: a frozen Raft leader stops heartbeating and is replaced', () => {
    const members = ['n1', 'n2', 'n3'];
    const spec: SimulationSpec = {
      version: SPEC_VERSION,
      id: 'pause-raft',
      name: 'pause raft',
      seed: 'pause-raft',
      durationMs: 3000,
      nodes: members.map((id, i) => ({
        id,
        type: 'consensus' as const,
        config: { consensus: { electionTimeoutMs: i === 0 ? { min: 80, max: 90 } : { min: 150, max: 300 }, heartbeatIntervalMs: 30 } },
      })),
      links: members.flatMap((a, i) => members.slice(i + 1).map((b) => ({ from: a, to: b, latency: 5 }))),
      workloads: [],
      faults: [{ kind: 'node_pause', at: 1000, nodeId: 'n1', durationMs: 1000 }],
    };
    const log = run(spec).simulation.log;
    const elected = log.byType('LEADER_ELECTED');
    expect(elected[0]!.payload.leaderId).toBe('n1');
    const replacement = elected.find((e) => e.at > 1000)!;
    expect(replacement.payload.leaderId).not.toBe('n1');
    expect(replacement.at).toBeLessThan(2000);
    // On waking, the old leader is told about the higher term and steps down.
    const down = log.byType('STEPPED_DOWN').find((e) => e.payload.nodeId === 'n1')!;
    expect(down.at).toBeGreaterThanOrEqual(2000);
    expect(down.payload.reason).toBe('higher_term');
  });

  it('ends the freeze if the node crashes during it', () => {
    const world = run(
      chain([
        { kind: 'node_pause', at: 1000, nodeId: 'api', durationMs: 2000 },
        { kind: 'node_crash', at: 1500, nodeId: 'api', recoverAfter: 500 },
      ]),
    );
    const log = world.simulation.log;
    expect(log.byType('NODE_RESUMED')).toHaveLength(0);
    // Requests that waited for the frozen process now meet a dead one.
    expect(log.byType('MESSAGE_DROPPED').some((e) => e.at === 1500 && e.payload.reason === 'destination_failed')).toBe(true);
    expect(world.registry.require('api').state.paused).toBe(false);
    expect(log.byType('REQUEST_COMPLETED').filter((e) => e.at > 2100 && e.at < 2900).length).toBeGreaterThan(10);
  });

  it('survives checkpoints taken mid-pause', () => {
    expectReplayEquivalence(paused, { fractions: [0.2, 0.3, 0.45, 0.6] });
  });
});

describe('node conditions', () => {
  it('slows a node down by a factor while the fault lasts', () => {
    const world = run(chain([{ kind: 'node_slowdown', at: 1000, nodeId: 'api', factor: 4, durationMs: 1000 }]));
    // API processing is 15ms; at a quarter speed it is 60ms.
    const before = latenciesIssuedBetween(world, 200, 900);
    const during = latenciesIssuedBetween(world, 1100, 1900);
    const after = latenciesIssuedBetween(world, 2200, 3500);
    expect(Math.max(...before)).toBeLessThan(100);
    expect(Math.min(...during)).toBeGreaterThanOrEqual(Math.min(...before) + 45);
    expect(Math.max(...after)).toBeLessThan(100);
    expect(world.registry.require('api').state.slowdown).toBe(1);
  });

  it('makes an unavailable node refuse work at once, then serve again', () => {
    const world = run(chain([{ kind: 'node_unavailable', at: 1000, nodeId: 'db', durationMs: 1000 }]));
    const log = world.simulation.log;
    const refused = log.byType('REQUEST_REJECTED').filter((e) => e.payload.nodeId === 'db');
    expect(refused.length).toBeGreaterThan(10);
    expect(refused.every((e) => e.payload.reason === 'unavailable' && e.at >= 1000 && e.at < 2000)).toBe(true);
    const failed = log.byType('REQUEST_FAILED');
    expect(failed.every((e) => e.payload.reason === 'unavailable')).toBe(true);
    expect(log.byType('REQUEST_COMPLETED').filter((e) => e.at > 2100).length).toBeGreaterThan(20);
  });

  it('takes the worst of overlapping slowdowns and restores each in turn', () => {
    const world = run(
      chain([
        { kind: 'node_slowdown', id: 'a', at: 1000, nodeId: 'api', factor: 2, durationMs: 2000 },
        { kind: 'node_slowdown', id: 'b', at: 1500, nodeId: 'api', factor: 5, durationMs: 500 },
      ]),
    );
    const changes = world.simulation.log.byType('NODE_CONDITION_CHANGED').map((e) => [e.at, e.payload.slowdown]);
    expect(changes).toEqual([
      [1000, 2],
      [1500, 5],
      [2000, 2],
      [3000, 1],
    ]);
  });

  it('delays every message to and from a congested host', () => {
    const world = run(chain([{ kind: 'message_delay', at: 1000, nodeId: 'api', delay: 100, durationMs: 1000 }]));
    const hops = world.simulation.log
      .byType('MESSAGE_RECEIVED')
      .filter((e) => e.payload.message.source === 'lb' && e.payload.message.destination === 'api')
      .map((e) => ({ sentAt: e.payload.message.createdAt, latency: e.at - e.payload.message.createdAt }));
    expect(hops.filter((h) => h.sentAt >= 1000 && h.sentAt < 2000).every((h) => h.latency === 110)).toBe(true);
    expect(hops.filter((h) => h.sentAt < 1000 || h.sentAt >= 2000).every((h) => h.latency === 10)).toBe(true);
  });

  it('duplicates packets on a link only while the fault lasts', () => {
    const world = run(chain([{ kind: 'packet_duplication', at: 1000, linkId: 'lb->api', duplicateRate: 0.5, durationMs: 1000 }]));
    const duplicated = world.simulation.log.byType('MESSAGE_DUPLICATED');
    expect(duplicated.length).toBeGreaterThan(5);
    expect(duplicated.every((e) => e.payload.linkId === 'lb->api' && e.at >= 1000 && e.at < 2000)).toBe(true);
    expect(world.network.topology.getLink('lb->api')?.duplicateRate).toBe(0);
  });
});

describe('stale replica', () => {
  const spec: SimulationSpec = {
    version: SPEC_VERSION,
    id: 'stale',
    name: 'stale',
    seed: 'stale',
    durationMs: 5000,
    nodes: [
      { id: 'client', type: 'client' },
      { id: 'api', type: 'api', config: { processing: 2, readPreference: 'replica' } },
      { id: 'db', type: 'database', config: { readLatency: 5, writeLatency: 10 } },
      { id: 'r1', type: 'replica', config: { replicaOf: 'db', readLatency: 5, replicationDelay: 20 } },
    ],
    links: [
      { from: 'client', to: 'api', latency: 5 },
      { from: 'api', to: 'db', latency: 5 },
      { from: 'api', to: 'r1', latency: 5 },
      { from: 'db', to: 'r1', latency: 10 },
    ],
    workloads: [
      {
        id: 'mixed',
        clientId: 'client',
        operation: 'DB_READ',
        arrival: { kind: 'poisson', ratePerSec: 100 },
        mix: [
          { operation: 'DB_READ', weight: 3 },
          { operation: 'DB_WRITE', weight: 1 },
        ],
        keys: 3,
        stopAt: 4000,
      },
    ],
    faults: [{ kind: 'stale_replica', at: 1000, nodeId: 'r1', durationMs: 1500 }],
  };

  it('stops applying while stalled, serves stale reads, then catches up in order', () => {
    const world = run(spec);
    const log = world.simulation.log;
    const applied = log.byType('REPLICATION_APPLIED');
    expect(applied.filter((e) => e.at > 1060 && e.at < 2500)).toHaveLength(0);
    const burst = applied.filter((e) => e.at === 2500).map((e) => e.payload.lsn);
    expect(burst.length).toBeGreaterThan(10);
    expect(burst).toEqual([...burst].sort((a, b) => a - b));
    // The lag on the catch-up burst reflects the whole stall.
    expect(Math.max(...applied.filter((e) => e.at === 2500).map((e) => e.payload.lagMs))).toBeGreaterThan(1000);

    const stale = log.byType('STALE_READ');
    expect(stale.filter((e) => e.at > 1200 && e.at < 2500).length).toBeGreaterThan(stale.filter((e) => e.at < 1000).length);
    // Fully caught up by the end.
    expect(applied[applied.length - 1]!.payload.behindRecords).toBe(0);
  });

  it('survives checkpoints taken while records are parked', () => {
    expectReplayEquivalence(spec, { fractions: [0.3, 0.45, 0.55] });
  });
});

describe('degradation fault validation', () => {
  const base = chainScenario();
  const check = (fault: FaultSpec) => validateSimulationSpec({ ...base, faults: [fault] }).errors.map((i) => i.path);

  it('accepts well-formed degradation faults', () => {
    expect(check({ kind: 'node_pause', at: 100, nodeId: 'api', durationMs: 500 })).toEqual([]);
    expect(check({ kind: 'node_slowdown', at: 100, nodeId: 'api', factor: 3 })).toEqual([]);
    expect(check({ kind: 'node_unavailable', at: 100, nodeId: 'db' })).toEqual([]);
    expect(check({ kind: 'message_delay', at: 100, nodeId: 'api', delay: { kind: 'uniform', min: 10, max: 50 } })).toEqual([]);
    expect(check({ kind: 'packet_duplication', at: 100, linkId: 'lb->api', duplicateRate: 0.2 })).toEqual([]);
  });

  it('rejects malformed ones', () => {
    expect(check({ kind: 'node_pause', at: 100, nodeId: 'api' } as unknown as FaultSpec)).toContain('faults[0].durationMs');
    expect(check({ kind: 'node_slowdown', at: 100, nodeId: 'api', factor: 0.5 })).toContain('faults[0].factor');
    expect(check({ kind: 'stale_replica', at: 100, nodeId: 'db' })).toContain('faults[0].nodeId');
    expect(check({ kind: 'packet_duplication', at: 100, linkId: 'lb->api', duplicateRate: 2 })).toContain('faults[0].duplicateRate');
  });
});
