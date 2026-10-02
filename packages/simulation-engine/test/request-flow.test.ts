import { describe, expect, it } from 'vitest';
import type { SimEvent } from '@distlab/shared';
import { createSimulation } from '../src/world.js';
import { chainScenario, constantLoad } from './helpers.js';

describe('end-to-end request flow', () => {
  it('routes a request through every hop and back, with latency that adds up', () => {
    const world = createSimulation(chainScenario());
    world.run();

    const completed = world.simulation.log.byType('REQUEST_COMPLETED');
    expect(completed).toHaveLength(1);

    const event = completed[0] as SimEvent<'REQUEST_COMPLETED'>;
    expect(event.payload.path).toEqual(['client', 'lb', 'api', 'db']);
    expect(event.payload.hops).toBe(3);

    // 6 network crossings at 10ms (3 out, 3 back) + 1ms LB + 15ms API + 10ms DB read.
    expect(event.payload.latency).toBe(86);
  });

  it('emits the hop sequence as routing events', () => {
    const world = createSimulation(chainScenario());
    world.run();
    const routed = world.simulation.log.byType('REQUEST_ROUTED');
    expect(routed.map((e) => `${e.payload.from}->${e.payload.to}`)).toEqual([
      'client->lb',
      'lb->api',
      'api->db',
    ]);
  });

  it('never delivers a message without sending it across a link first', () => {
    const world = createSimulation(chainScenario({ workloads: [constantLoad(50)], durationMs: 2000 }));
    world.run();
    const sentIds = new Set(world.simulation.log.byType('MESSAGE_SENT').map((e) => e.payload.message.id));
    const received = world.simulation.log.byType('MESSAGE_RECEIVED');
    expect(received.length).toBeGreaterThan(0);
    for (const event of received) {
      const message = event.payload.message;
      const originated = message.duplicateOf ?? message.id;
      expect(sentIds.has(originated)).toBe(true);
      expect(message.deliverAt).toBeGreaterThan(message.createdAt);
    }
  });

  it('uses the write latency for write operations', () => {
    const world = createSimulation(
      chainScenario({
        workloads: [
          { id: 'w', clientId: 'client', operation: 'DB_WRITE', arrival: { kind: 'once', count: 1 } },
        ],
      }),
    );
    world.run();
    const writes = world.simulation.log.byType('DB_WRITE');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.payload.latency).toBe(30);
    expect(world.simulation.log.byType('DB_READ')).toHaveLength(0);
  });

  it('serves the request at the last node when nothing is downstream', () => {
    const world = createSimulation(
      chainScenario({
        nodes: [
          { id: 'client', type: 'client' },
          { id: 'api', type: 'api', config: { processing: 5 } },
        ],
        links: [{ from: 'client', to: 'api', latency: 10 }],
      }),
    );
    world.run();
    const completed = world.simulation.log.byType('REQUEST_COMPLETED');
    expect(completed[0]?.payload.path).toEqual(['client', 'api']);
    expect(completed[0]?.payload.latency).toBe(25);
  });

  it('fails immediately when the client has no outgoing link', () => {
    const world = createSimulation(
      chainScenario({
        nodes: [
          { id: 'client', type: 'client' },
          { id: 'api', type: 'api' },
        ],
        links: [],
      }),
    );
    world.run();
    const failed = world.simulation.log.byType('REQUEST_FAILED');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload.reason).toBe('no_route');
  });

  it('builds a trace whose spans nest from the client down to the database', () => {
    const world = createSimulation(chainScenario());
    world.run();
    const received = world.simulation.log.byType('MESSAGE_RECEIVED');
    const requests = received.filter((e) => e.payload.message.kind === 'REQUEST');
    // Each hop's span is the parent of the next hop's span.
    for (let i = 1; i < requests.length; i++) {
      expect(requests[i]?.payload.message.parentSpanId).toBe(requests[i - 1]?.payload.message.spanId);
    }
    const traceIds = new Set(received.map((e) => e.payload.message.traceId));
    expect(traceIds.size).toBe(1);
  });
});

describe('workload arrival', () => {
  it('emits a constant workload at the configured rate', () => {
    const world = createSimulation(
      chainScenario({ durationMs: 1000, workloads: [constantLoad(20)] }),
    );
    world.run();
    // 20/sec means a 50ms gap, and the horizon is inclusive: t=0, 50, ... 1000.
    const created = world.simulation.log.byType('REQUEST_CREATED');
    expect(created).toHaveLength(21);
    expect(created.map((e) => e.at)).toEqual(Array.from({ length: 21 }, (_, i) => i * 50));
  });

  it('respects maxRequests', () => {
    const world = createSimulation(
      chainScenario({ durationMs: 10_000, workloads: [constantLoad(100, { maxRequests: 7 })] }),
    );
    world.run();
    expect(world.simulation.log.byType('REQUEST_CREATED')).toHaveLength(7);
  });

  it('respects startAt and stopAt', () => {
    const world = createSimulation(
      chainScenario({
        durationMs: 5000,
        workloads: [constantLoad(10, { startAt: 1000, stopAt: 2000 })],
      }),
    );
    world.run();
    const created = world.simulation.log.byType('REQUEST_CREATED');
    expect(created.length).toBeGreaterThan(0);
    for (const event of created) {
      expect(event.at).toBeGreaterThanOrEqual(1000);
      expect(event.at).toBeLessThanOrEqual(2000);
    }
  });

  it('produces bursty but correctly-rated poisson arrivals', () => {
    const world = createSimulation(
      chainScenario({
        durationMs: 60_000,
        workloads: [
          { id: 'p', clientId: 'client', operation: 'HTTP_GET', arrival: { kind: 'poisson', ratePerSec: 10 } },
        ],
      }),
    );
    world.run();
    const created = world.simulation.log.byType('REQUEST_CREATED');
    expect(created.length).toBeGreaterThan(540);
    expect(created.length).toBeLessThan(660);

    const gaps = created.slice(1).map((e, i) => e.at - (created[i] as { at: number }).at);
    const unique = new Set(gaps.map((g) => Math.round(g)));
    expect(unique.size).toBeGreaterThan(20); // not evenly spaced
  });

  it('emits bursts of the configured size', () => {
    const world = createSimulation(
      chainScenario({
        durationMs: 1000,
        workloads: [
          { id: 'b', clientId: 'client', operation: 'HTTP_GET', arrival: { kind: 'burst', count: 5, everyMs: 200 } },
        ],
      }),
    );
    world.run();
    const created = world.simulation.log.byType('REQUEST_CREATED');
    const byTime = new Map<number, number>();
    for (const e of created) byTime.set(e.at, (byTime.get(e.at) ?? 0) + 1);
    expect([...byTime.values()].every((count) => count === 5)).toBe(true);
    expect([...byTime.keys()]).toEqual([0, 200, 400, 600, 800, 1000]);
  });
});

describe('scenario determinism', () => {
  const run = (seed: string) => {
    const world = createSimulation(
      chainScenario({
        seed,
        durationMs: 5000,
        links: [
          { from: 'client', to: 'lb', latency: { kind: 'normal', mean: 10, stddev: 4 } },
          { from: 'lb', to: 'api', latency: { kind: 'normal', mean: 10, stddev: 4 }, lossRate: 0.05 },
          { from: 'api', to: 'db', latency: { kind: 'normal', mean: 10, stddev: 4 }, duplicateRate: 0.05 },
        ],
        workloads: [
          { id: 'p', clientId: 'client', operation: 'HTTP_GET', arrival: { kind: 'poisson', ratePerSec: 40 } },
        ],
      }),
    );
    world.run();
    return world.simulation.log.all().map((e) => `${e.at}|${e.seq}|${e.type}|${e.id}`);
  };

  it('reproduces an impaired, randomised run exactly', () => {
    expect(run('scenario-seed')).toEqual(run('scenario-seed'));
  });

  it('diverges on a different seed', () => {
    expect(run('scenario-seed')).not.toEqual(run('other-seed'));
  });
});
