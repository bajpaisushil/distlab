import { describe, expect, it } from 'vitest';
import type { SimulationSpec } from '@distlab/shared';
import { createSimulation, restoreSimulation } from '../src/world.js';
import { chainScenario } from './helpers.js';
import { expectReplayEquivalence, fingerprint } from './replay-harness.js';

const impaired = (): SimulationSpec => ({
  ...chainScenario({
    seed: 'replay',
    durationMs: 6000,
    nodes: [
      { id: 'client', type: 'client' },
      { id: 'lb', type: 'load_balancer', config: { processing: 1 } },
      { id: 'api', type: 'api', config: { processing: { kind: 'normal', mean: 15, stddev: 6 }, concurrency: 2, queueCapacity: 4 } },
      { id: 'db', type: 'database', config: { readLatency: { kind: 'exponential', mean: 12 }, failureProbability: 0.05 } },
    ],
    links: [
      { from: 'client', to: 'lb', latency: { kind: 'uniform', min: 5, max: 15 }, lossRate: 0.03, duplicateRate: 0.02 },
      { from: 'lb', to: 'api', latency: 3, reorderRate: 0.1, reorderDelay: 40, bandwidthBytesPerSec: 200_000 },
      { from: 'api', to: 'db', latency: { kind: 'normal', mean: 4, stddev: 2 } },
    ],
    workloads: [
      { id: 'p', clientId: 'client', operation: 'HTTP_GET', arrival: { kind: 'poisson', ratePerSec: 90 }, deadlineMs: 300, keys: 20, mix: [{ operation: 'DB_READ', weight: 9 }, { operation: 'DB_WRITE', weight: 1 }] },
    ],
  }),
  faults: [
    { kind: 'node_crash', at: 1500, nodeId: 'api', recoverAfter: 700 },
    { kind: 'latency_spike', at: 2500, linkId: 'api->db', latency: 80, durationMs: 900 },
    { kind: 'partition', at: 4000, groups: [['client', 'lb'], ['api', 'db']], healAfter: 400 },
    { kind: 'packet_loss', at: 4800, linkId: 'lb->api', lossRate: 0.5, durationMs: 300 },
  ],
});

describe('checkpoints', () => {
  it('restore-and-continue reproduces an impaired, faulted run exactly', () => {
    expectReplayEquivalence(impaired());
  });

  it('round-trips a checkpoint taken before the first event', () => {
    const spec = impaired();
    const reference = createSimulation(spec);
    reference.run();
    const fresh = createSimulation(spec);
    fresh.start();
    const restored = restoreSimulation(spec, fresh.captureState());
    restored.run();
    expect(fingerprint(restored)).toEqual(fingerprint(reference));
  });

  it('round-trips a checkpoint taken after the run completed', () => {
    const spec = impaired();
    const done = createSimulation(spec);
    done.run();
    const restored = restoreSimulation(spec, done.captureState());
    expect(restored.simulation.status).toBe('completed');
    expect(restored.snapshot()).toEqual(done.snapshot());
    expect(restored.run().eventsProcessed).toBe(0);
  });

  it('survives a JSON round trip, so checkpoints can cross a worker boundary', () => {
    const spec = impaired();
    const reference = createSimulation(spec);
    reference.run();

    const partial = createSimulation(spec);
    partial.start();
    partial.simulation.stepMany(5000);
    const wire = JSON.parse(JSON.stringify(partial.captureState(), (_key, value) =>
      value === Number.POSITIVE_INFINITY ? '__inf' : value === Number.NEGATIVE_INFINITY ? '__-inf' : value,
    ), (_key, value) => (value === '__inf' ? Number.POSITIVE_INFINITY : value === '__-inf' ? Number.NEGATIVE_INFINITY : value));
    const restored = restoreSimulation(spec, wire);
    restored.run();
    expect(fingerprint(restored)).toEqual(fingerprint(reference));
  });
});
