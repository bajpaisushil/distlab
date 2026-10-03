import { describe, expect, it } from 'vitest';
import type { SimulationSpec } from '@distlab/shared';
import { createSimulation } from '../src/world.js';
import { ReplayController } from '../src/replay.js';
import { chainScenario } from './helpers.js';
import { fingerprint } from './replay-harness.js';

const scenario = (): SimulationSpec => ({
  ...chainScenario({
    seed: 'time-travel',
    durationMs: 5000,
    links: [
      { from: 'client', to: 'lb', latency: { kind: 'uniform', min: 4, max: 12 }, lossRate: 0.02 },
      { from: 'lb', to: 'api', latency: 3, duplicateRate: 0.03 },
      { from: 'api', to: 'db', latency: { kind: 'normal', mean: 5, stddev: 2 } },
    ],
    workloads: [
      { id: 'p', clientId: 'client', operation: 'HTTP_GET', arrival: { kind: 'poisson', ratePerSec: 80 }, deadlineMs: 400 },
    ],
  }),
  faults: [{ kind: 'node_crash', at: 2000, nodeId: 'api', recoverAfter: 600 }],
});

/** The reference: the same scenario stepped straight to `position`. */
function straightTo(spec: SimulationSpec, position: number) {
  const world = createSimulation(spec);
  world.start();
  world.simulation.run({ maxEvents: position });
  return world;
}

describe('ReplayController', () => {
  it('runs forward to the same result as a plain run', () => {
    const spec = scenario();
    const plain = createSimulation(spec);
    plain.run();

    const replay = new ReplayController(spec, { checkpointInterval: 500 });
    replay.toEnd();
    expect(fingerprint(replay.current)).toEqual(fingerprint(plain));
    expect(replay.current.snapshot()).toEqual(plain.snapshot());
    expect(replay.completed).toBe(true);
  });

  it('seeks backward to exactly the state a straight run has at that position', () => {
    const spec = scenario();
    const replay = new ReplayController(spec, { checkpointInterval: 700 });
    replay.toEnd();
    const end = replay.position;

    for (const target of [0, 1, 481, 699, 700, 701, 2222, Math.floor(end / 2), end - 1]) {
      replay.seek(target);
      expect(replay.position).toBe(target);
      const reference = straightTo(spec, target);
      expect(fingerprint(replay.current), `log at ${target}`).toEqual(fingerprint(reference));
      expect(replay.current.snapshot(), `telemetry at ${target}`).toEqual(reference.snapshot());
      expect(replay.current.registry.snapshot(replay.current.now)).toEqual(reference.registry.snapshot(reference.now));
    }
  });

  it('continues identically after travelling back', () => {
    const spec = scenario();
    const plain = createSimulation(spec);
    plain.run();

    const replay = new ReplayController(spec, { checkpointInterval: 400 });
    replay.forward(3000);
    replay.seek(1234);
    replay.back(10);
    replay.toEnd();
    expect(fingerprint(replay.current)).toEqual(fingerprint(plain));
  });

  it('steps backward one event at a time', () => {
    const spec = scenario();
    const replay = new ReplayController(spec, { checkpointInterval: 50 });
    replay.forward(120);
    const timeline = replay.timeline();
    for (let i = 0; i < 5; i++) replay.back();
    expect(replay.position).toBe(115);
    expect(replay.current.simulation.log.at(114)?.id).toBe(timeline[114]?.id);
    // The future is still known after travelling back.
    expect(replay.reachable).toBe(120);
    expect(replay.timeline()[119]?.id).toBe(timeline[119]?.id);
  });

  it('answers "what was the state immediately before event #481"', () => {
    const spec = scenario();
    const replay = new ReplayController(spec, { checkpointInterval: 300 });
    replay.toEnd();
    const event481 = replay.timeline()[480];
    replay.seekBefore(480);
    expect(replay.current.simulation.log.size).toBe(480);
    expect(replay.current.simulation.queue.peek()?.id).toBe(event481?.id);
  });

  it('advances by virtual time in slices to the same run as going straight through', () => {
    const spec = scenario();
    const plain = createSimulation(spec);
    plain.run();

    const replay = new ReplayController(spec, { checkpointInterval: 333 });
    while (!replay.completed) replay.advanceTime(37);
    expect(fingerprint(replay.current)).toEqual(fingerprint(plain));
    expect(replay.current.now).toBe(5000);
  });

  it('bounds memory by thinning checkpoints on long runs', () => {
    const spec = scenario();
    const replay = new ReplayController(spec, { checkpointInterval: 10, maxCheckpoints: 8 });
    replay.toEnd();
    expect(replay.checkpointCount).toBeLessThanOrEqual(8);
    replay.seek(replay.position - 1);
    const reference = straightTo(spec, replay.position);
    expect(fingerprint(replay.current)).toEqual(fingerprint(reference));
  });
});
