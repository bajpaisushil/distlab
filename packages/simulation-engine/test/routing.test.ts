import { describe, expect, it } from 'vitest';
import { SPEC_VERSION, validateSimulationSpec, type RoutingStrategyName, type SimulationSpec } from '@distlab/shared';
import { createSimulation } from '../src/world.js';
import { expectReplayEquivalence } from './replay-harness.js';

/** A balancer over three backends; `slow` makes the last one sluggish. */
function pool(
  strategy: RoutingStrategyName,
  options: { slow?: boolean; weights?: number[]; rate?: number; durationMs?: number; keys?: number; maxRequests?: number } = {},
): SimulationSpec {
  const weights = options.weights ?? [1, 1, 1];
  return {
    version: SPEC_VERSION,
    id: `pool-${strategy}`,
    name: 'pool',
    seed: 'routing',
    durationMs: options.durationMs ?? 6000,
    nodes: [
      { id: 'client', type: 'client' },
      { id: 'lb', type: 'load_balancer', config: { processing: 1, routing: strategy } },
      { id: 'b-1', type: 'api', config: { processing: 10, concurrency: 32, weight: weights[0]! } },
      { id: 'b-2', type: 'api', config: { processing: 10, concurrency: 32, weight: weights[1]! } },
      {
        id: 'b-3',
        type: 'api',
        config: { processing: options.slow ? 150 : 10, concurrency: 32, weight: weights[2]! },
      },
    ],
    links: [
      { from: 'client', to: 'lb', latency: 2 },
      { from: 'lb', to: 'b-1', latency: 2 },
      { from: 'lb', to: 'b-2', latency: 2 },
      { from: 'lb', to: 'b-3', latency: 2 },
    ],
    workloads: [
      {
        id: 'w',
        clientId: 'client',
        operation: 'HTTP_GET',
        arrival: { kind: 'constant', ratePerSec: options.rate ?? 60 },
        deadlineMs: 2000,
        ...(options.keys ? { keys: options.keys } : {}),
        ...(options.maxRequests ? { maxRequests: options.maxRequests } : {}),
      },
    ],
  };
}

function dispatchCounts(spec: SimulationSpec) {
  const world = createSimulation(spec);
  world.run();
  const counts = new Map<string, number>();
  for (const e of world.simulation.log.byType('REQUEST_ROUTED')) {
    if (e.payload.from === 'lb') counts.set(e.payload.to, (counts.get(e.payload.to) ?? 0) + 1);
  }
  return { counts, world };
}

describe('round robin', () => {
  it('splits exactly evenly', () => {
    const { counts } = dispatchCounts(pool('round_robin', { rate: 100, maxRequests: 300 }));
    expect([...counts.values()]).toEqual([100, 100, 100]);
  });

  it('is the default', () => {
    const spec = pool('round_robin');
    delete spec.nodes[1]!.config!.routing;
    const { counts, world } = dispatchCounts(spec);
    expect(counts.size).toBe(3);
    expect(world.simulation.log.byType('REQUEST_ROUTED')[1]!.payload.strategy).toBe('round_robin');
  });
});

describe('weighted round robin', () => {
  it('sends traffic in exact proportion to target weights', () => {
    const { counts } = dispatchCounts(pool('weighted_round_robin', { weights: [3, 2, 1], rate: 100, maxRequests: 600 }));
    expect([counts.get('b-1'), counts.get('b-2'), counts.get('b-3')]).toEqual([300, 200, 100]);
  });
});

describe('load-aware strategies steer away from a slow backend', () => {
  for (const strategy of ['least_connections', 'latency_aware'] as const) {
    it(`${strategy} sends the slow backend far less than its fair share`, () => {
      const { counts } = dispatchCounts(pool(strategy, { slow: true, rate: 150 }));
      const total = [...counts.values()].reduce((a, b) => a + b, 0);
      expect(counts.get('b-3')! / total).toBeLessThan(0.2);
    });
  }

  it('latency_aware lets traffic back once the backend recovers', () => {
    const spec = pool('latency_aware', { rate: 150, durationMs: 9000 });
    spec.faults = [{ kind: 'latency_spike', at: 1000, linkId: 'lb->b-3', latency: 300, durationMs: 3000 }];
    const { world } = dispatchCounts(spec);
    const routed = world.simulation.log.byType('REQUEST_ROUTED').filter((e) => e.payload.from === 'lb');
    const share = (from: number, to: number) => {
      const window = routed.filter((e) => e.at >= from && e.at < to);
      return window.filter((e) => e.payload.to === 'b-3').length / window.length;
    };
    expect(share(2500, 4000)).toBeLessThan(0.15);
    expect(share(6500, 9000)).toBeGreaterThan(0.2);
  });

  it('measurably improves p99 over round robin under the same load', () => {
    const p99 = (strategy: RoutingStrategyName) => dispatchCounts(pool(strategy, { slow: true, rate: 150 })).world.snapshot().latency.p99;
    expect(p99('least_connections')).toBeLessThan(p99('round_robin'));
    expect(p99('latency_aware')).toBeLessThan(p99('round_robin'));
  });
});

describe('random', () => {
  it('is roughly uniform and reproducible', () => {
    const { counts } = dispatchCounts(pool('random', { rate: 200 }));
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(330);
      expect(count).toBeLessThan(470);
    }
    expect([...dispatchCounts(pool('random', { rate: 200 })).counts]).toEqual([...counts]);
  });
});

describe('consistent hash', () => {
  it('sends every request for a key to the same backend', () => {
    const { world } = dispatchCounts(pool('consistent_hash', { keys: 20 }));
    const owner = new Map<string, Set<string>>();
    const created = new Map(world.simulation.log.byType('REQUEST_CREATED').map((e) => [e.payload.requestId, e.payload.key!]));
    for (const e of world.simulation.log.byType('REQUEST_ROUTED')) {
      if (e.payload.from !== 'lb') continue;
      const key = created.get(e.payload.requestId)!;
      owner.set(key, (owner.get(key) ?? new Set()).add(e.payload.to));
    }
    expect(owner.size).toBe(20);
    for (const targets of owner.values()) expect(targets.size).toBe(1);
  });

  it('remaps only the failed backend’s keys', () => {
    const spec = pool('consistent_hash', { keys: 60, durationMs: 8000 });
    spec.faults = [{ kind: 'node_crash', at: 4000, nodeId: 'b-2' }];
    const { world } = dispatchCounts(spec);
    const keyOf = new Map(world.simulation.log.byType('REQUEST_CREATED').map((e) => [e.payload.requestId, e.payload.key!]));
    const ownerIn = (from: number, to: number) => {
      const owners = new Map<string, string>();
      for (const e of world.simulation.log.byType('REQUEST_ROUTED')) {
        if (e.payload.from === 'lb' && e.at >= from && e.at < to) owners.set(keyOf.get(e.payload.requestId)!, e.payload.to);
      }
      return owners;
    };
    const before = ownerIn(0, 4000);
    const after = ownerIn(4100, 8000);
    for (const [key, target] of after) {
      if (before.get(key) !== target) expect(before.get(key)).toBe('b-2');
    }
  });
});

describe('routing decisions', () => {
  it('explains each multi-candidate choice right after its REQUEST_ROUTED', () => {
    const world = createSimulation(pool('least_connections'));
    world.run();
    const log = world.simulation.log.all();
    const decisions = world.simulation.log.byType('ROUTING_DECISION');
    expect(decisions.length).toBe(world.simulation.log.byType('REQUEST_ROUTED').filter((e) => e.payload.from === 'lb').length);
    for (const decision of decisions) {
      const index = log.indexOf(decision);
      const routed = log[index - 1]!;
      expect(routed.type).toBe('REQUEST_ROUTED');
      expect((routed as typeof decisions[number] & { payload: { to: string } }).payload.to).toBe(decision.payload.chosen);
      expect(decision.payload.candidates.map((c) => c.id)).toEqual(['b-1', 'b-2', 'b-3']);
      expect(decision.traceId).toBe(routed.traceId);
    }
  });

  it('says why a configured backend was not a candidate', () => {
    const spec = pool('round_robin');
    spec.faults = [{ kind: 'node_crash', at: 1000, nodeId: 'b-2' }];
    const world = createSimulation(spec);
    world.run();
    const late = world.simulation.log.byType('ROUTING_DECISION').filter((e) => e.at > 1100);
    expect(late.length).toBeGreaterThan(0);
    expect(late.every((e) => e.payload.excluded?.some((x) => x.id === 'b-2' && x.reason === 'node_failed'))).toBe(true);
  });

  it('emits nothing for single-path hops', () => {
    const world = createSimulation(pool('round_robin'));
    world.run();
    expect(world.simulation.log.byType('ROUTING_DECISION').every((e) => e.payload.nodeId === 'lb')).toBe(true);
  });
});

describe('routing configuration', () => {
  it('validates strategies and parameters', () => {
    const spec = pool('round_robin');
    spec.nodes[1]!.config = { routing: 'teleport' as never, ewmaAlpha: 2, virtualNodes: 0 };
    spec.nodes[2]!.config = { weight: -1 };
    const paths = validateSimulationSpec(spec).errors.map((e) => e.path);
    expect(paths).toEqual(
      expect.arrayContaining(['nodes[1].config.routing', 'nodes[1].config.ewmaAlpha', 'nodes[1].config.virtualNodes', 'nodes[2].config.weight']),
    );
  });
});

describe('routing checkpoints', () => {
  it('replays mixed strategies exactly across a crash', () => {
    const spec = pool('latency_aware', { slow: true, rate: 120, keys: 30 });
    spec.nodes.push({ id: 'client-2', type: 'client' }, { id: 'lb-2', type: 'load_balancer', config: { routing: 'weighted_round_robin' } });
    spec.links.push({ from: 'client-2', to: 'lb-2', latency: 3 }, { from: 'lb-2', to: 'b-1', latency: 2 }, { from: 'lb-2', to: 'b-2', latency: 2 });
    spec.workloads.push({ id: 'w2', clientId: 'client-2', operation: 'HTTP_GET', arrival: { kind: 'poisson', ratePerSec: 80 }, deadlineMs: 800 });
    spec.faults = [{ kind: 'node_crash', at: 2500, nodeId: 'b-1', recoverAfter: 1500 }];
    expectReplayEquivalence(spec);
  });
});
