import { describe, expect, it } from 'vitest';
import { SPEC_VERSION, validateSimulationSpec, type LinkSpec, type NodeSpec, type SimulationSpec } from '@distlab/shared';
import { createSimulation, type SimulationWorld } from '../src/world.js';
import { expectReplayEquivalence } from './replay-harness.js';

function pipeline(options: {
  workers?: number;
  queue?: Record<string, unknown>;
  worker?: Record<string, unknown>;
  rate?: number;
  count?: number;
  durationMs?: number;
  workerLink?: Partial<LinkSpec>;
  extraNodes?: NodeSpec[];
  extraLinks?: LinkSpec[];
  faults?: SimulationSpec['faults'];
}): SimulationSpec {
  const workerCount = options.workers ?? 1;
  const workers: NodeSpec[] = Array.from({ length: workerCount }, (_, i) => ({
    id: `w${i + 1}`,
    type: 'worker',
    config: { processing: 100, concurrency: 1, ...options.worker },
  }));
  return {
    version: SPEC_VERSION,
    id: 'queue',
    name: 'queue',
    seed: 'queue',
    durationMs: options.durationMs ?? 5000,
    nodes: [
      { id: 'producer', type: 'client' },
      { id: 'q', type: 'queue', config: { queue: { capacity: 20, ...options.queue } } },
      ...workers,
      ...(options.extraNodes ?? []),
    ],
    links: [
      { from: 'producer', to: 'q', latency: 5 },
      ...workers.map((w) => ({ from: 'q', to: w.id, latency: 5, ...options.workerLink })),
      ...(options.extraLinks ?? []),
    ],
    workloads: [
      {
        id: 'jobs',
        clientId: 'producer',
        operation: 'ENQUEUE',
        arrival: options.count ? { kind: 'once', count: options.count } : { kind: 'constant', ratePerSec: options.rate ?? 20 },
        deadlineMs: 1000,
      },
    ],
    ...(options.faults ? { faults: options.faults } : {}),
  };
}

const run = (s: SimulationSpec): SimulationWorld => {
  const world = createSimulation(s);
  world.run();
  return world;
};

describe('enqueueing and backpressure', () => {
  it('acknowledges producers at once, independent of processing time', () => {
    const world = run(pipeline({ count: 5 }));
    const completed = world.simulation.log.byType('REQUEST_COMPLETED');
    expect(completed).toHaveLength(5);
    // 5ms there, 5ms back — the 100ms of work happens later.
    for (const e of completed) expect(e.payload.latency).toBe(10);
  });

  it('fills to capacity when producers outpace consumers, then refuses', () => {
    // 20/s in, one worker at 10/s out.
    const world = run(pipeline({ rate: 20, durationMs: 6000 }));
    const rejected = world.simulation.log.byType('QUEUE_REJECTED');
    expect(rejected.length).toBeGreaterThan(10);
    expect(rejected.every((e) => e.payload.held === 20)).toBe(true);
    expect(world.simulation.log.byType('REQUEST_FAILED').every((e) => e.payload.reason === 'queue_full')).toBe(true);
  });

  it('drains with a second worker', () => {
    const one = run(pipeline({ rate: 15, durationMs: 6000 }));
    const two = run(pipeline({ rate: 15, durationMs: 6000, workers: 2 }));
    expect(one.simulation.log.byType('QUEUE_REJECTED').length).toBeGreaterThan(0);
    expect(two.simulation.log.byType('QUEUE_REJECTED')).toHaveLength(0);
    const stats = two.snapshot().modules.queues.queues[0]!;
    expect(Object.keys(stats.byWorker).sort()).toEqual(['w1', 'w2']);
  });
});

describe('delivery guarantees', () => {
  it('redelivers a crashed worker’s items after the visibility timeout', () => {
    const world = run(
      pipeline({
        workers: 2,
        count: 10,
        queue: { visibilityTimeoutMs: 400 },
        faults: [{ kind: 'node_crash', at: 50, nodeId: 'w1' }],
      }),
    );
    const log = world.simulation.log;
    const timedOut = log.byType('QUEUE_REDELIVERED').filter((e) => e.payload.reason === 'visibility_timeout');
    expect(timedOut.length).toBeGreaterThan(0);
    expect(timedOut.every((e) => e.payload.workerId === 'w1')).toBe(true);
    // Every item is eventually consumed, by the surviving worker if need be.
    expect(log.byType('QUEUE_CONSUMED')).toHaveLength(10);
  });

  it('dead-letters a poison message after exactly maxDeliveries attempts', () => {
    const world = run(
      pipeline({
        count: 30,
        workers: 2,
        worker: { processing: 10 },
        queue: { poisonRate: 0.2, maxDeliveries: 3, capacity: 100 },
        extraNodes: [{ id: 'dlq', type: 'queue', config: { queue: { capacity: 100 } } }],
        extraLinks: [{ from: 'q', to: 'dlq', latency: 2 }],
      }),
    );
    const log = world.simulation.log;
    const poisoned = log.byType('QUEUE_MESSAGE').filter((e) => e.payload.queueId === 'q' && e.payload.poison);
    const dead = log.byType('QUEUE_DEAD_LETTERED');
    expect(poisoned.length).toBeGreaterThan(0);
    expect(dead.map((e) => e.payload.itemId).sort()).toEqual(poisoned.map((e) => e.payload.itemId).sort());
    expect(dead.every((e) => e.payload.attempts === 3 && e.payload.lastError === 'poison message')).toBe(true);
  });

  it('forwards dead letters to the dead-letter queue', () => {
    const s = pipeline({
      count: 20,
      worker: { processing: 10 },
      queue: { poisonRate: 0.3, maxDeliveries: 2, capacity: 100, deadLetterQueue: 'dlq' },
      extraNodes: [{ id: 'dlq', type: 'queue', config: { queue: { capacity: 100 } } }],
      extraLinks: [{ from: 'q', to: 'dlq', latency: 2 }],
    });
    const world = run(s);
    const dead = world.simulation.log.byType('QUEUE_DEAD_LETTERED').length;
    expect(dead).toBeGreaterThan(0);
    const inDlq = world.simulation.log.byType('QUEUE_MESSAGE').filter((e) => e.payload.queueId === 'dlq').length;
    expect(inDlq).toBe(dead);
  });

  it('processes an item twice when its ack is lost — at-least-once made visible', () => {
    const world = run(
      pipeline({
        count: 40,
        workers: 2,
        worker: { processing: 20 },
        queue: { visibilityTimeoutMs: 200, capacity: 100 },
        workerLink: { lossRate: 0.2 },
      }),
    );
    const duplicates = world.simulation.log.byType('DUPLICATE_PROCESSING');
    expect(duplicates.length).toBeGreaterThan(0);
    expect(world.snapshot().modules.queues.queues[0]!.duplicates).toBe(duplicates.length);
  });
});

describe('queue crashes', () => {
  const crashing = (durable: boolean) =>
    run(
      pipeline({
        count: 30,
        worker: { processing: 50 },
        queue: { durable, capacity: 100 },
        faults: [{ kind: 'node_crash', at: 300, nodeId: 'q', recoverAfter: 500 }],
      }),
    );

  it('keeps items through a crash when durable', () => {
    expect(crashing(true).simulation.log.byType('QUEUE_CONSUMED').length).toBe(30);
  });

  it('loses them when not', () => {
    expect(crashing(false).simulation.log.byType('QUEUE_CONSUMED').length).toBeLessThan(15);
  });
});

describe('queue configuration', () => {
  it('validates queue and consumer settings', () => {
    const s = pipeline({ queue: { capacity: 0, deadLetterQueue: 'q', poisonRate: 2 } });
    s.nodes.push({ id: 'api', type: 'api', config: { queue: { capacity: 5 } } });
    const paths = validateSimulationSpec(s).errors.map((e) => e.path);
    expect(paths).toEqual(
      expect.arrayContaining(['nodes[1].config.queue.capacity', 'nodes[1].config.queue.deadLetterQueue', 'nodes[1].config.queue.poisonRate', 'nodes[3].config.queue']),
    );
  });
});

describe('queue checkpoints', () => {
  it('replays producers, two workers, a DLQ and a worker crash exactly', () => {
    expectReplayEquivalence(
      pipeline({
        rate: 30,
        workers: 2,
        durationMs: 4000,
        worker: { processing: { kind: 'exponential', mean: 50 }, failureProbability: 0.1, concurrency: 2 },
        queue: { capacity: 40, poisonRate: 0.05, maxDeliveries: 3, visibilityTimeoutMs: 300, redeliveryDelayMs: 50, deadLetterQueue: 'dlq' },
        workerLink: { lossRate: 0.05 },
        extraNodes: [{ id: 'dlq', type: 'queue', config: { queue: { capacity: 100 } } }],
        extraLinks: [{ from: 'q', to: 'dlq', latency: 2 }],
        faults: [{ kind: 'node_crash', at: 1500, nodeId: 'w1', recoverAfter: 700 }],
      }),
    );
  });
});
