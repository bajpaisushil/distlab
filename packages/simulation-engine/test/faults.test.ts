import { describe, expect, it } from 'vitest';
import { validateSimulationSpec, type FaultSpec, type SimEvent } from '@distlab/shared';
import { createSimulation } from '../src/world.js';
import { chainScenario, constantLoad } from './helpers.js';

function run(faults: FaultSpec[], durationMs = 6000) {
  const spec = {
    ...chainScenario({ durationMs, workloads: [constantLoad(20, { deadlineMs: 400 })] }),
    faults,
  };
  const world = createSimulation(spec);
  world.run();
  return world;
}

/** Latency of the client->lb hop for every request message, keyed by send time. */
function hopLatencies(world: ReturnType<typeof run>, from: string, to: string) {
  return world.simulation.log
    .byType('MESSAGE_RECEIVED')
    .filter((e) => e.payload.message.source === from && e.payload.message.destination === to)
    .map((e) => ({ sentAt: e.payload.message.createdAt, latency: e.at - e.payload.message.createdAt }));
}

describe('node crash faults', () => {
  it('takes the node down and brings it back on schedule', () => {
    const world = run([{ kind: 'node_crash', at: 1000, nodeId: 'api', recoverAfter: 1500 }]);
    const log = world.simulation.log;
    expect(log.byType('NODE_FAILED').map((e) => e.at)).toEqual([1000]);
    expect(log.byType('NODE_RECOVERED').map((e) => e.at)).toEqual([2500]);

    const completed = log.byType('REQUEST_COMPLETED');
    expect(completed.filter((e) => e.at > 1100 && e.at < 2500)).toHaveLength(0);
    expect(completed.filter((e) => e.at > 2600).length).toBeGreaterThan(20);
  });

  it('leaves the node down when no recovery is scheduled', () => {
    const world = run([{ kind: 'node_crash', at: 1000, nodeId: 'api' }]);
    expect(world.simulation.log.byType('NODE_RECOVERED')).toHaveLength(0);
    expect(world.registry.require('api').state.status).toBe('failed');
  });

  it('keeps a node down until the last of two overlapping crashes ends', () => {
    // A long outage with a short one nested inside it. The short one ending
    // must not resurrect the node while the long one still holds it down.
    const world = run([
      { kind: 'node_crash', id: 'long', at: 1000, nodeId: 'api', recoverAfter: 3000 },
      { kind: 'node_crash', id: 'short', at: 1500, nodeId: 'api', recoverAfter: 500 },
    ]);
    const log = world.simulation.log;
    expect(log.byType('NODE_FAILED').map((e) => e.at)).toEqual([1000]);
    expect(log.byType('NODE_RECOVERED').map((e) => e.at)).toEqual([4000]);
  });

  it('handles overlapping crashes that end in the opposite order', () => {
    const world = run([
      { kind: 'node_crash', id: 'first', at: 1000, nodeId: 'api', recoverAfter: 1000 },
      { kind: 'node_crash', id: 'second', at: 1500, nodeId: 'api', recoverAfter: 1500 },
    ]);
    expect(world.simulation.log.byType('NODE_RECOVERED').map((e) => e.at)).toEqual([3000]);
  });
});

describe('link faults', () => {
  it('cuts a link and restores it, failing fast because a dead link is locally visible', () => {
    const world = run([{ kind: 'link_down', at: 1000, linkId: 'lb->api', restoreAfter: 1000 }]);
    const log = world.simulation.log;

    // A cut link is detectable at the sender — the interface is down — so the
    // balancer refuses immediately instead of sending into the void. Contrast
    // with a partition, where packets vanish silently.
    const refused = log.byType('REQUEST_FAILED').filter((e) => e.payload.reason === 'unreachable');
    expect(refused.length).toBeGreaterThan(10);
    expect(refused.every((e) => e.at >= 1000 && e.at < 2100)).toBe(true);
    expect(refused.every((e) => e.payload.failedAt === 'lb')).toBe(true);

    expect(log.byType('REQUEST_COMPLETED').filter((e) => e.at > 2200).length).toBeGreaterThan(20);
    expect(world.network.topology.getLink('lb->api')?.enabled).toBe(true);
  });

  it('applies a latency spike only while it lasts', () => {
    const world = run([
      { kind: 'latency_spike', at: 2000, linkId: 'client->lb', latency: 200, durationMs: 1000 },
    ]);
    const hops = hopLatencies(world, 'client', 'lb');
    expect(hops.filter((h) => h.sentAt < 2000).every((h) => h.latency === 10)).toBe(true);
    expect(hops.filter((h) => h.sentAt >= 2000 && h.sentAt < 3000).every((h) => h.latency === 200)).toBe(true);
    expect(hops.filter((h) => h.sentAt >= 3000).every((h) => h.latency === 10)).toBe(true);
  });

  it('composes overlapping spikes so neither ending clobbers the other', () => {
    // Outer 2000-5000 at 100ms, inner 3000-4000 at 300ms. Nesting order is the
    // case a naive save-and-restore gets wrong.
    const world = run([
      { kind: 'latency_spike', id: 'outer', at: 2000, linkId: 'client->lb', latency: 100, durationMs: 3000 },
      { kind: 'latency_spike', id: 'inner', at: 3000, linkId: 'client->lb', latency: 300, durationMs: 1000 },
    ]);
    const at = (from: number, to: number) =>
      new Set(hopLatencies(world, 'client', 'lb').filter((h) => h.sentAt >= from && h.sentAt < to).map((h) => h.latency));
    expect(at(0, 2000)).toEqual(new Set([10]));
    expect(at(2000, 3000)).toEqual(new Set([100]));
    expect(at(3000, 4000)).toEqual(new Set([300]));
    expect(at(4000, 5000)).toEqual(new Set([100]));
    expect(at(5000, 6000)).toEqual(new Set([10]));
  });

  it('composes overlapping spikes that end in the opposite order', () => {
    // First 2000-4000 at 100ms, second 3000-5000 at 300ms. When the first ends,
    // the second is still active and must stay in force.
    const world = run([
      { kind: 'latency_spike', id: 'a', at: 2000, linkId: 'client->lb', latency: 100, durationMs: 2000 },
      { kind: 'latency_spike', id: 'b', at: 3000, linkId: 'client->lb', latency: 300, durationMs: 2000 },
    ]);
    const at = (from: number, to: number) =>
      new Set(hopLatencies(world, 'client', 'lb').filter((h) => h.sentAt >= from && h.sentAt < to).map((h) => h.latency));
    expect(at(2000, 3000)).toEqual(new Set([100]));
    expect(at(3000, 5000)).toEqual(new Set([300]));
    expect(at(5000, 6000)).toEqual(new Set([10]));
  });

  it('drops packets during a packet-loss window', () => {
    const world = run([{ kind: 'packet_loss', at: 1000, linkId: 'api->db', lossRate: 1, durationMs: 1000 }]);
    const drops = world.simulation.log
      .byType('MESSAGE_DROPPED')
      .filter((e) => e.payload.reason === 'packet_loss');
    expect(drops.length).toBeGreaterThan(10);
    expect(drops.every((e) => e.at >= 1000 && e.at < 2000)).toBe(true);
    expect(world.network.topology.getLink('api->db')?.lossRate).toBe(0);
  });
});

describe('partition faults', () => {
  it('splits the network and heals it', () => {
    const world = run([
      { kind: 'partition', at: 1000, groups: [['client', 'lb'], ['api', 'db']], healAfter: 1000 },
    ]);
    const drops = world.simulation.log.byType('MESSAGE_DROPPED').filter((e) => e.payload.reason === 'partitioned');
    expect(drops.length).toBeGreaterThan(5);
    expect(drops.every((e) => e.at >= 1000 && e.at < 2000)).toBe(true);
    expect(world.network.topology.activePartitions()).toHaveLength(0);
  });
});

describe('fault bookkeeping', () => {
  it('emits an injected/cleared pair per fault with readable descriptions', () => {
    const world = run([
      { kind: 'node_crash', id: 'crash', at: 1000, nodeId: 'api', recoverAfter: 500 },
      { kind: 'packet_loss', at: 2000, linkId: 'api->db', lossRate: 0.5 },
    ]);
    const injected = world.simulation.log.byType('FAULT_INJECTED');
    expect(injected.map((e) => e.payload.faultId)).toEqual(['crash', 'fault-2']);
    expect(injected[0]?.payload.description).toMatch(/api crashes at 1.00s, recovers after 500ms/);
    expect(world.simulation.log.byType('FAULT_CLEARED').map((e) => e.payload.faultId)).toEqual(['crash']);
  });

  it('chains every effect back to the fault that caused it', () => {
    const world = run([{ kind: 'node_crash', id: 'crash', at: 1000, nodeId: 'api', recoverAfter: 500 }]);
    const failed = world.simulation.log.byType('NODE_FAILED')[0] as SimEvent<'NODE_FAILED'>;
    const chain = world.simulation.log.causalChain(failed.id).map((e) => e.type);
    expect(chain).toEqual(['SIMULATION_STARTED', 'FAULT_INJECTED', 'NODE_FAILED']);
  });

  it('reproduces a faulted run exactly', () => {
    const faults: FaultSpec[] = [
      { kind: 'node_crash', at: 1200, nodeId: 'api', recoverAfter: 700 },
      { kind: 'latency_spike', at: 2000, linkId: 'lb->api', latency: { kind: 'uniform', min: 50, max: 150 }, durationMs: 900 },
      { kind: 'packet_loss', at: 3000, linkId: 'client->lb', lossRate: 0.3, durationMs: 1000 },
    ];
    const fingerprint = () => run(faults).simulation.log.all().map((e) => `${e.at}|${e.type}|${e.id}`);
    expect(fingerprint()).toEqual(fingerprint());
  });
});

describe('fault validation', () => {
  const spec = (faults: unknown[]) => ({ ...chainScenario(), faults }) as never;
  const paths = (faults: unknown[]) => validateSimulationSpec(spec(faults)).errors.map((e) => e.path);

  it('accepts well-formed faults', () => {
    expect(
      validateSimulationSpec(
        spec([
          { kind: 'node_crash', at: 100, nodeId: 'api', recoverAfter: 50 },
          { kind: 'link_down', at: 100, linkId: 'lb->api' },
          { kind: 'partition', at: 100, groups: [['client'], ['db']] },
          { kind: 'latency_spike', at: 100, linkId: 'api->db', latency: 90 },
          { kind: 'packet_loss', at: 100, linkId: 'api->db', lossRate: 0.2 },
        ]),
      ).valid,
    ).toBe(true);
  });

  it('rejects faults that reference unknown nodes or links', () => {
    expect(paths([{ kind: 'node_crash', at: 1, nodeId: 'ghost' }])).toContain('faults[0].nodeId');
    expect(paths([{ kind: 'link_down', at: 1, linkId: 'nope' }])).toContain('faults[0].linkId');
  });

  it('rejects malformed faults', () => {
    expect(paths([{ kind: 'meteor', at: 1 }])).toContain('faults[0].kind');
    expect(paths([{ kind: 'packet_loss', at: 1, linkId: 'api->db', lossRate: 3 }])).toContain('faults[0].lossRate');
    expect(paths([{ kind: 'partition', at: 1, groups: [['api']] }])).toContain('faults[0].groups');
    expect(paths([{ kind: 'node_crash', nodeId: 'api' }])).toContain('faults[0].at');
  });

  it('rejects duplicate fault ids', () => {
    expect(
      paths([
        { kind: 'node_crash', id: 'x', at: 1, nodeId: 'api' },
        { kind: 'node_crash', id: 'x', at: 2, nodeId: 'db' },
      ]),
    ).toContain('faults[1].id');
  });
});
