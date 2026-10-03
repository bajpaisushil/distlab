import { describe, expect, it } from 'vitest';
import { validateSimulationSpec } from '@distlab/shared';
import { createSimulation, type SimulationWorld } from '@distlab/simulation-engine';
import { SCENARIOS, findScenario } from '../src/index.js';

function run(id: string): SimulationWorld {
  const scenario = findScenario(id);
  if (!scenario) throw new Error(`no scenario ${id}`);
  const world = createSimulation(scenario.spec);
  world.run();
  return world;
}

const failuresBetween = (world: SimulationWorld, from: number, to: number) =>
  world.simulation.log.byType('REQUEST_FAILED').filter((e) => e.at >= from && e.at < to);

describe('scenario library', () => {
  it.each(SCENARIOS.map((s) => [s.spec.id, s] as const))('%s is valid, documented and laid out', (_id, scenario) => {
    expect(validateSimulationSpec(scenario.spec)).toEqual({ valid: true, errors: [] });
    expect(scenario.spec.learningObjectives?.length).toBeGreaterThan(0);
    expect(scenario.spec.description?.length).toBeGreaterThan(40);
    for (const node of scenario.spec.nodes) expect(scenario.spec.layout?.[node.id], `${node.id} unplaced`).toBeDefined();
  });

  it('has unique ids', () => {
    const ids = SCENARIOS.map((s) => s.spec.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('each scenario shows what it says it shows', () => {
  it('load-balancing: round robin is blind to the slow server; least connections is not', () => {
    const scenario = findScenario('load-balancing')!;
    const share = (world: SimulationWorld) => {
      const lb = world.snapshot().modules.routing.nodes.find((n) => n.nodeId === 'lb')!;
      return lb.targets.find((t) => t.id === 'api-3')!.share;
    };
    const roundRobin = run('load-balancing');
    expect(share(roundRobin)).toBeCloseTo(1 / 3, 2);

    const spec = structuredClone(scenario.spec);
    spec.nodes[1]!.config = { ...spec.nodes[1]!.config, routing: 'least_connections' };
    const least = createSimulation(spec);
    least.run();
    expect(share(least)).toBeLessThan(0.25);
    expect(least.snapshot().latency.p99).toBeLessThan(roundRobin.snapshot().latency.p99);
  });

  it('web-service: healthy, with a tail', () => {
    const s = run('web-service').snapshot();
    expect(s.requests.successRate).toBeGreaterThan(0.995);
    expect(s.latency.p99).toBeGreaterThan(s.latency.p50 * 1.2);
  });

  it('node-failure: losses at the crash, traffic carried by the survivor, recovery after', () => {
    const world = run('node-failure');
    const log = world.simulation.log;
    // The crash strands in-flight work: failures cluster right after 5s.
    expect(failuresBetween(world, 5000, 5700).length).toBeGreaterThan(0);
    // During the outage requests still complete, through API 2.
    const during = log.byType('REQUEST_COMPLETED').filter((e) => e.at > 5700 && e.at < 11_000);
    expect(during.length).toBeGreaterThan(300);
    expect(during.every((e) => e.payload.path.includes('api-2'))).toBe(true);
    // And API 1 serves again after it recovers.
    expect(log.byType('REQUEST_COMPLETED').some((e) => e.at > 11_200 && e.payload.path.includes('api-1'))).toBe(true);
  });

  it('network-partition: silent drops only during the split, each failure costing the full deadline', () => {
    const world = run('network-partition');
    const drops = world.simulation.log.byType('MESSAGE_DROPPED').filter((e) => e.payload.reason === 'partitioned');
    expect(drops.length).toBeGreaterThan(50);
    expect(drops.every((e) => e.at >= 5000 && e.at < 9000)).toBe(true);
    const failed = world.simulation.log.byType('REQUEST_FAILED');
    expect(failed.length).toBeGreaterThan(50);
    expect(failed.every((e) => e.payload.reason === 'timeout' && Math.abs(e.payload.latency - 700) < 1e-6)).toBe(true);
  });

  it('packet-loss: about twice the loss rate fails, always at the deadline', () => {
    const s = run('packet-loss').snapshot();
    const failureRate = 1 - s.requests.successRate;
    expect(failureRate).toBeGreaterThan(0.05);
    expect(failureRate).toBeLessThan(0.12);
    expect(s.failuresByReason).toEqual({ timeout: s.requests.failed });
    expect(s.latency.max).toBeLessThan(500);
  });

  it('capacity-saturation: queueing then rejection, only during the surge', () => {
    const world = run('capacity-saturation');
    const rejected = world.simulation.log.byType('REQUEST_REJECTED');
    expect(rejected.length).toBeGreaterThan(20);
    expect(rejected.every((e) => e.at >= 6000)).toBe(true);
    const api = world.snapshot().nodes.find((n) => n.id === 'api')!;
    expect(api.maxQueueDepth).toBe(40);
    const percentiles = world.snapshot().throughput.percentiles;
    const before = percentiles.filter((p) => p.t < 5000).map((p) => p.p95);
    const surge = percentiles.filter((p) => p.t >= 7000 && p.t < 10_000).map((p) => p.p95);
    expect(Math.min(...surge)).toBeGreaterThan(Math.max(...before));
  });

  it('cascading-failure: a slow database saturates healthy API servers', () => {
    const world = run('cascading-failure');
    const rejectedAtApi = world.simulation.log
      .byType('REQUEST_REJECTED')
      .filter((e) => e.payload.nodeId.startsWith('api') && e.at >= 5000 && e.at < 11_000);
    expect(rejectedAtApi.length).toBeGreaterThan(50);
    expect(failuresBetween(world, 0, 5000).length).toBe(0);
    // The API's own processing time never changed: only waiting did.
    const started = world.simulation.log
      .byType('REQUEST_PROCESSING_STARTED')
      .filter((e) => e.payload.nodeId.startsWith('api'));
    expect(new Set(started.map((e) => e.payload.serviceTime))).toEqual(new Set([10]));
  });

  it('retry-storm: a one-second blip becomes a lasting outage', () => {
    const world = run('retry-storm');
    const log = world.simulation.log;
    const before = log.byType('REQUEST_COMPLETED').filter((e) => e.at < 3000).length;
    expect(before).toBeGreaterThan(200);
    const lateCreated = log.byType('REQUEST_CREATED').filter((e) => e.at > 9000).length;
    const lateCompleted = log.byType('REQUEST_COMPLETED').filter((e) => e.at > 9000).length;
    expect(lateCompleted / lateCreated).toBeLessThan(0.1);
    expect(world.snapshot().modules.reliability.retries).toBeGreaterThan(1000);
  });

  it('circuit-breaker: opens, fails fast, probes, and closes after the partition heals', () => {
    const world = run('circuit-breaker');
    const log = world.simulation.log;
    expect(log.byType('CIRCUIT_OPENED').length).toBeGreaterThan(1);
    expect(log.byType('CIRCUIT_CLOSED')).toHaveLength(1);
    expect(log.byType('CIRCUIT_CLOSED')[0]!.at).toBeGreaterThan(5000);
    const fastFails = log.byType('REQUEST_FAILED').filter((e) => e.payload.reason === 'circuit_open');
    expect(fastFails.length).toBeGreaterThan(50);
    expect(Math.max(...fastFails.map((e) => e.payload.latency))).toBeLessThan(50);
  });

  it('message-duplication: the ledger records charges twice', () => {
    const world = run('message-duplication');
    const twice = world.snapshot().modules.data.duplicateWritesApplied;
    const created = world.simulation.log.byType('REQUEST_CREATED').length;
    expect(twice).toBeGreaterThan(created * 0.08);
    // Clients settle each request exactly once all the same.
    const settled = world.snapshot().requests.completed + world.snapshot().requests.failed;
    expect(settled).toBeLessThanOrEqual(created);
  });

  it('database-replication: replicas take read load, with occasional stale reads', () => {
    const data = run('database-replication').snapshot().modules.data;
    expect(data.storageLoad['replica-a']).toBeGreaterThan(data.reads * 0.2);
    expect(data.storageLoad['replica-b']).toBeGreaterThan(data.reads * 0.2);
    expect(data.staleReads).toBeGreaterThan(0);
    expect(data.staleReads / data.reads).toBeLessThan(0.15);
  });

  it('replica-lag: the distant replica is far more stale than the near one', () => {
    const data = run('replica-lag').snapshot().modules.data;
    const near = data.replicas.find((r) => r.replicaId === 'replica-a')!;
    const far = data.replicas.find((r) => r.replicaId === 'replica-b')!;
    expect(far.meanLagMs).toBeGreaterThan(near.meanLagMs * 5);
    expect(far.staleRate).toBeGreaterThan(near.staleRate * 3);
  });

  it('message-reordering: arrival-order apply rolls keys back', () => {
    const world = run('message-reordering');
    expect(world.snapshot().modules.data.versionRegressions).toBeGreaterThan(5);
  });

  it('queue-overload: depth climbs, then the producer is refused', () => {
    const world = run('queue-overload');
    const queue = world.snapshot().modules.queues.queues[0]!;
    expect(Math.max(...queue.depth.map((p) => p.value))).toBeGreaterThan(150);
    expect(queue.rejected).toBeGreaterThan(50);
    expect(world.simulation.log.byType('QUEUE_REJECTED').every((e) => e.at > 2000)).toBe(true);
  });

  it('dead-letter-queue: poison messages end up dead-lettered after three attempts', () => {
    const world = run('dead-letter-queue');
    const dead = world.simulation.log.byType('QUEUE_DEAD_LETTERED');
    expect(dead.length).toBeGreaterThan(10);
    expect(dead.every((e) => e.payload.attempts === 3)).toBe(true);
    const dlq = world.snapshot().modules.queues.queues.find((q) => q.queueId === 'dlq')!;
    expect(dlq.enqueued).toBe(dead.length - (dead.filter((e) => e.at > 14_990).length));
  });

  it('thundering-herd: each expiry of the hot key stampedes the database', () => {
    const world = run('thundering-herd');
    const misses = world.simulation.log.byType('CACHE_MISS').filter((e) => e.payload.key === 'key-0' && e.payload.reason === 'expired');
    // Misses cluster just after each 2s expiry.
    const bursts = new Map<number, number>();
    for (const miss of misses) {
      const bucket = Math.floor(miss.at / 100);
      bursts.set(bucket, (bursts.get(bucket) ?? 0) + 1);
    }
    expect(Math.max(...bursts.values())).toBeGreaterThan(20);
    const db = world.snapshot().nodes.find((n) => n.id === 'db')!;
    expect(db.maxQueueDepth).toBeGreaterThan(20);
  });
});
