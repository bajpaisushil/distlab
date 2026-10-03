import { expect } from 'vitest';
import type { SimEvent, SimulationSpec } from '@distlab/shared';
import { createSimulation, restoreSimulation, type SimulationWorld } from '../src/world.js';

/** Everything observable about a processed event, so any divergence shows up. */
export function fingerprint(world: SimulationWorld): string[] {
  return world.simulation.log.all().map(describeEvent);
}

function describeEvent(event: SimEvent): string {
  return `${event.id}|${event.seq}|${event.at}|${event.type}|${event.causedBy ?? ''}|${JSON.stringify(event.payload)}`;
}

/**
 * Proves a scenario's checkpoints are complete.
 *
 * For each checkpoint position: run part way, capture, restore into a brand
 * new engine, and finish. The restored run must reproduce the uninterrupted
 * run exactly — every event, every payload, every metric. It also restores
 * the same checkpoint twice, which catches a restore that keeps references
 * into the checkpoint and mutates it, and keeps running the original after
 * capturing, which catches a capture that disturbs the live run.
 *
 * Any state a subsystem forgets to capture makes this fail.
 */
export function expectReplayEquivalence(
  spec: SimulationSpec,
  options: { fractions?: readonly number[] } = {},
): void {
  const reference = createSimulation(spec);
  reference.run();
  const expectedLog = fingerprint(reference);
  const expectedSnapshot = reference.snapshot();
  const total = reference.simulation.eventsProcessed;
  expect(total).toBeGreaterThan(10);

  for (const fraction of options.fractions ?? [0.1, 0.37, 0.5, 0.83]) {
    const position = Math.max(1, Math.floor(total * fraction));

    const original = createSimulation(spec);
    original.start();
    original.simulation.stepMany(position);
    const checkpoint = original.captureState();

    for (const attempt of ['first restore', 'second restore'] as const) {
      const restored = restoreSimulation(spec, checkpoint);
      restored.run();
      expect(fingerprint(restored), `${attempt} at event ${position} diverged`).toEqual(expectedLog);
      expect(restored.snapshot(), `${attempt} at event ${position}: telemetry diverged`).toEqual(expectedSnapshot);
    }

    original.run();
    expect(fingerprint(original), `capturing at ${position} disturbed the live run`).toEqual(expectedLog);
  }
}
