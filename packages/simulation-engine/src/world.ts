import {
  resolveSimulationSpec,
  validateSimulationSpec,
  type NodeId,
  type ResolvedSpec,
  type SimEvent,
  type SimulationSpec,
} from '@distlab/shared';
import { SimulatedNetwork } from '@distlab/network';
import { TelemetryCollector, type TelemetryOptions, type TelemetrySnapshot } from '@distlab/telemetry';
import { NodeRegistry } from './node-registry.js';
import { NodeRuntime } from './node-runtime.js';
import { WorkloadGenerator } from './workload.js';
import { Simulation, type RunOptions, type RunResult } from './simulation.js';
import type { DownstreamSelector } from './routing.js';

export interface CreateSimulationOptions {
  /** Load-balancing seam. Defaults to first-available. */
  readonly selector?: DownstreamSelector;
  /** Bounds the retained event log on long runs. */
  readonly logCapacity?: number;
  /**
   * Observation settings. Deliberately not part of the scenario spec: how
   * closely a run is watched should not change what the run does.
   */
  readonly telemetry?: TelemetryOptions;
}

/**
 * Everything a running simulation consists of, wired together.
 *
 * This is the composition root. Subsystems are registered in a fixed order
 * because handler order is part of the determinism contract, and nothing here
 * knows about React, workers or rendering.
 */
export class SimulationWorld {
  readonly spec: ResolvedSpec;
  readonly simulation: Simulation;
  readonly registry: NodeRegistry;
  readonly network: SimulatedNetwork;
  readonly runtime: NodeRuntime;
  readonly workload: WorkloadGenerator;
  readonly telemetry: TelemetryCollector;

  private started = false;

  constructor(spec: ResolvedSpec, options: CreateSimulationOptions = {}) {
    this.spec = spec;
    this.simulation = new Simulation({
      seed: spec.seed,
      limits: { durationMs: spec.durationMs, maxEvents: spec.maxEvents },
      ...(options.logCapacity !== undefined ? { logCapacity: options.logCapacity } : {}),
    });
    this.registry = new NodeRegistry(spec.nodes);
    this.network = new SimulatedNetwork({
      context: this.simulation,
      links: spec.links,
      partitions: spec.partitions,
      isNodeUp: (id: NodeId) => this.registry.isUp(id),
    });
    this.runtime = new NodeRuntime({
      context: this.simulation,
      registry: this.registry,
      network: this.network,
      ...(options.selector !== undefined ? { selector: options.selector } : {}),
    });
    this.workload = new WorkloadGenerator({
      context: this.simulation,
      runtime: this.runtime,
      workloads: spec.workloads,
    });

    // Registration order is part of the determinism contract.
    const on = this.simulation.on.bind(this.simulation);
    this.network.attach(on);
    this.runtime.attach(on);
    this.workload.attach(on);

    this.telemetry = new TelemetryCollector(options.telemetry ?? {});
    this.simulation.observe((event) => this.telemetry.observe(event));
  }

  /** Schedules `SIMULATION_STARTED`, which is what bootstraps the workloads. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.simulation.scheduleAt(
      {
        type: 'SIMULATION_STARTED',
        payload: {
          seed: this.spec.seed,
          nodeCount: this.spec.nodes.length,
          linkCount: this.spec.links.length,
        },
      },
      0,
    );
  }

  run(options?: RunOptions): RunResult {
    this.start();
    return this.simulation.run(options);
  }

  step(): SimEvent | undefined {
    this.start();
    return this.simulation.step();
  }

  get now(): number {
    return this.simulation.now();
  }

  /** Measured results for the run so far. Every figure comes from an event. */
  snapshot(): TelemetrySnapshot {
    const elapsed = this.simulation.now();
    return this.telemetry.snapshot(elapsed, this.registry.snapshot(elapsed));
  }
}

/** Builds a world from a scenario spec, validating it first. */
export function createSimulation(
  spec: SimulationSpec,
  options: CreateSimulationOptions = {},
): SimulationWorld {
  const validation = validateSimulationSpec(spec);
  if (!validation.valid) {
    const detail = validation.errors.map((e) => `  ${e.path || '<root>'}: ${e.message}`).join('\n');
    throw new Error(`invalid simulation spec:\n${detail}`);
  }
  return new SimulationWorld(resolveSimulationSpec(spec), options);
}
