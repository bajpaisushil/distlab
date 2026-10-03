import { describe, expect, it } from 'vitest';
import { nodeUtilization } from '@distlab/shared';
import { createSimulation } from '../src/world.js';
import { chainScenario, constantLoad } from './helpers.js';

describe('message loss', () => {
  it('fails the request at its deadline when the message never arrives', () => {
    const world = createSimulation(
      chainScenario({
        durationMs: 2000,
        links: [
          { from: 'client', to: 'lb', latency: 10, lossRate: 1 },
          { from: 'lb', to: 'api', latency: 10 },
          { from: 'api', to: 'db', latency: 10 },
        ],
        workloads: [
          {
            id: 'w',
            clientId: 'client',
            operation: 'HTTP_GET',
            arrival: { kind: 'once', count: 1 },
            deadlineMs: 500,
          },
        ],
      }),
    );
    world.run();

    const failed = world.simulation.log.byType('REQUEST_FAILED');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload.reason).toBe('timeout');
    expect(failed[0]?.payload.latency).toBe(500);
    expect(world.simulation.log.byType('REQUEST_COMPLETED')).toHaveLength(0);
  });

  it('leaves no request unresolved — every one completes or fails', () => {
    const world = createSimulation(
      chainScenario({
        durationMs: 10_000,
        links: [
          { from: 'client', to: 'lb', latency: 10, lossRate: 0.3 },
          { from: 'lb', to: 'api', latency: 10, lossRate: 0.3 },
          { from: 'api', to: 'db', latency: 10, lossRate: 0.3 },
        ],
        workloads: [constantLoad(20, { deadlineMs: 400, stopAt: 5000 })],
      }),
    );
    world.run();

    const created = world.simulation.log.byType('REQUEST_CREATED').length;
    const completed = world.simulation.log.byType('REQUEST_COMPLETED').length;
    const failed = world.simulation.log.byType('REQUEST_FAILED').length;
    expect(created).toBeGreaterThan(50);
    expect(completed + failed).toBe(created);
    expect(failed).toBeGreaterThan(0);
  });

  it('frees every node slot once the dust settles', () => {
    const world = createSimulation(
      chainScenario({
        durationMs: 10_000,
        links: [
          { from: 'client', to: 'lb', latency: 10, lossRate: 0.3 },
          { from: 'lb', to: 'api', latency: 10, lossRate: 0.3 },
          { from: 'api', to: 'db', latency: 10, lossRate: 0.3 },
        ],
        workloads: [constantLoad(20, { deadlineMs: 400, stopAt: 3000 })],
      }),
    );
    world.run();
    for (const node of world.registry.all()) {
      expect(node.state.inFlight, `${node.id} leaked a slot`).toBe(0);
      expect(node.state.queueDepth, `${node.id} leaked a queue entry`).toBe(0);
    }
  });
});

describe('node failure', () => {
  it('stops serving once a node crashes and resumes when it recovers', () => {
    const world = createSimulation(
      chainScenario({ durationMs: 4000, workloads: [constantLoad(20, { deadlineMs: 400 })] }),
    );
    world.start();
    world.simulation.scheduleAt({ type: 'NODE_FAILED', payload: { nodeId: 'api', reason: 'crash' } }, 1000);
    world.simulation.scheduleAt({ type: 'NODE_RECOVERED', payload: { nodeId: 'api' } }, 2500);
    world.run();

    const completed = world.simulation.log.byType('REQUEST_COMPLETED');
    const duringOutage = completed.filter((e) => e.at > 1500 && e.at < 2500);
    expect(duringOutage).toHaveLength(0);

    const afterRecovery = completed.filter((e) => e.at > 2600);
    expect(afterRecovery.length).toBeGreaterThan(10);
    expect(world.registry.require('api').state.status).toBe('healthy');

    // During the outage the load balancer reports failure rather than
    // answering on the dead tier's behalf.
    const outageFailures = world.simulation.log
      .byType('REQUEST_FAILED')
      .filter((e) => e.at > 1500 && e.at < 2500);
    expect(outageFailures.length).toBeGreaterThan(10);
    expect(outageFailures.every((e) => e.payload.reason === 'unreachable')).toBe(true);
  });

  it('abandons the work a crashed node was holding', () => {
    const world = createSimulation(
      chainScenario({ durationMs: 3000, workloads: [constantLoad(50, { deadlineMs: 600 })] }),
    );
    world.start();
    world.simulation.scheduleAt({ type: 'NODE_FAILED', payload: { nodeId: 'api', reason: 'crash' } }, 500);
    world.run();

    const api = world.registry.require('api');
    expect(api.state.inFlight).toBe(0);
    expect(api.state.queueDepth).toBe(0);
    const failures = world.simulation.log.byType('REQUEST_FAILED');
    expect(failures.length).toBeGreaterThan(0);
  });

  it('routes around a failed peer when another is available', () => {
    const world = createSimulation(
      chainScenario({
        durationMs: 3000,
        nodes: [
          { id: 'client', type: 'client' },
          { id: 'lb', type: 'load_balancer', config: { processing: 1 } },
          { id: 'api-a', type: 'api', config: { processing: 5 } },
          { id: 'api-b', type: 'api', config: { processing: 5 } },
        ],
        links: [
          { from: 'client', to: 'lb', latency: 5 },
          { from: 'lb', to: 'api-a', latency: 5 },
          { from: 'lb', to: 'api-b', latency: 5 },
        ],
        workloads: [constantLoad(20, { deadlineMs: 500 })],
      }),
    );
    world.start();
    world.simulation.scheduleAt({ type: 'NODE_FAILED', payload: { nodeId: 'api-a', reason: 'crash' } }, 1000);
    world.run();

    const routed = world.simulation.log.byType('REQUEST_ROUTED').filter((e) => e.payload.from === 'lb');
    // Round robin alternates while both are up...
    const before = routed.filter((e) => e.at < 1000).map((e) => e.payload.to);
    expect(before.slice(0, 4)).toEqual(['api-a', 'api-b', 'api-a', 'api-b']);
    // ...and everything goes to the survivor once one is down.
    expect(routed.filter((e) => e.at > 1100).every((e) => e.payload.to === 'api-b')).toBe(true);
    // Traffic keeps flowing across the failure.
    expect(world.simulation.log.byType('REQUEST_COMPLETED').filter((e) => e.at > 1100).length).toBeGreaterThan(10);
  });
});

describe('capacity and backpressure', () => {
  const saturated = (queueCapacity: number, count: number) =>
    createSimulation(
      chainScenario({
        durationMs: 5000,
        nodes: [
          { id: 'client', type: 'client' },
          { id: 'api', type: 'api', config: { processing: 100, concurrency: 1, queueCapacity } },
        ],
        links: [{ from: 'client', to: 'api', latency: 10 }],
        workloads: [
          {
            id: 'burst',
            clientId: 'client',
            operation: 'HTTP_GET',
            arrival: { kind: 'once', count },
            deadlineMs: 4000,
          },
        ],
      }),
    );

  it('rejects arrivals once the queue is full', () => {
    const world = saturated(0, 3);
    world.run();

    const rejected = world.simulation.log.byType('REQUEST_REJECTED');
    expect(rejected).toHaveLength(2);
    expect(rejected[0]?.payload.reason).toBe('queue_full');
    expect(world.simulation.log.byType('REQUEST_COMPLETED')).toHaveLength(1);

    const failures = world.simulation.log.byType('REQUEST_FAILED');
    expect(failures.map((e) => e.payload.reason)).toEqual(['queue_full', 'queue_full']);
    expect(world.registry.require('api').state.rejected).toBe(2);
  });

  it('queues arrivals that fit and serves them one at a time', () => {
    const world = saturated(5, 3);
    world.run();

    expect(world.simulation.log.byType('REQUEST_REJECTED')).toHaveLength(0);
    const queued = world.simulation.log.byType('REQUEST_QUEUED');
    expect(queued.map((e) => e.payload.queueDepth)).toEqual([1, 2]);

    const completed = world.simulation.log.byType('REQUEST_COMPLETED');
    expect(completed).toHaveLength(3);
    // Serial service: 10ms out, 100ms each, 10ms back.
    expect(completed.map((e) => e.at)).toEqual([120, 220, 320]);
  });

  it('counts a slot as busy for the whole time a request is held, including downstream waits', () => {
    const world = createSimulation(
      chainScenario({
        durationMs: 1000,
        nodes: [
          { id: 'client', type: 'client' },
          { id: 'api', type: 'api', config: { processing: 20, concurrency: 1 } },
          { id: 'db', type: 'database', config: { readLatency: 50 } },
        ],
        links: [
          { from: 'client', to: 'api', latency: 10 },
          { from: 'api', to: 'db', latency: 10 },
        ],
        workloads: [
          { id: 'w', clientId: 'client', operation: 'HTTP_GET', arrival: { kind: 'once', count: 1 } },
        ],
      }),
    );
    world.run();

    // The API holds its slot for its own 20ms plus 10+50+10 waiting on the DB.
    expect(world.registry.require('api').state.busyTime).toBe(90);
    expect(world.registry.require('db').state.busyTime).toBe(50);
    // Utilisation is measured over the time actually simulated: the run ends
    // when the queue drains, well before the configured horizon.
    expect(world.now).toBe(110);
    expect(nodeUtilization(world.registry.require('api'), world.now)).toBeCloseTo(90 / 110, 6);
  });
});

describe('duplicate delivery', () => {
  it('never leaks a worker slot, however many requests are duplicated', () => {
    // Regression: work used to be keyed by span id, which a duplicate shares
    // with its original. Both copies took a slot, one released it, and the
    // node wedged once every slot had leaked.
    const world = createSimulation(
      chainScenario({
        durationMs: 6000,
        nodes: [
          { id: 'client', type: 'client' },
          { id: 'api', type: 'api', config: { processing: 12, concurrency: 4, queueCapacity: 64 } },
        ],
        links: [{ from: 'client', to: 'api', latency: 10, duplicateRate: 0.5 }],
        workloads: [constantLoad(40, { deadlineMs: 2000, stopAt: 5000 })],
      }),
    );
    world.run();
    const created = world.simulation.log.byType('REQUEST_CREATED').length;
    expect(world.simulation.log.byType('REQUEST_COMPLETED')).toHaveLength(created);
    expect(world.registry.require('api').state.inFlight).toBe(0);
    expect(world.registry.require('api').state.queueDepth).toBe(0);
    const started = world.simulation.log.byType('REQUEST_PROCESSING_STARTED').length;
    expect(started).toBeGreaterThan(created * 1.3);
  });

  it("processes a duplicated request twice but settles the client view once", () => {
    const world = createSimulation(
      chainScenario({
        durationMs: 2000,
        nodes: [
          { id: 'client', type: 'client' },
          { id: 'api', type: 'api', config: { processing: 5 } },
        ],
        links: [{ from: 'client', to: 'api', latency: 10, duplicateRate: 1 }],
        workloads: [
          { id: 'w', clientId: 'client', operation: 'HTTP_GET', arrival: { kind: 'once', count: 1 } },
        ],
      }),
    );
    world.run();

    // The API has no idempotency, so it really does the work twice.
    expect(world.simulation.log.byType('REQUEST_PROCESSING_STARTED')).toHaveLength(2);
    // The client asked once and gets exactly one answer.
    expect(world.simulation.log.byType('REQUEST_CREATED')).toHaveLength(1);
    expect(world.simulation.log.byType('REQUEST_COMPLETED')).toHaveLength(1);
  });
});
