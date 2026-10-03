import {
  resolveSimulationSpec,
  validateSimulationSpec,
  type EventId,
  type EventPayloadMap,
  type EventType,
  type NodeId,
  type ResolvedSpec,
  type SimEvent,
  type SimulationSpec,
} from '@distlab/shared';
import { SimulatedNetwork, type NetworkState } from '@distlab/network';
import {
  TelemetryCollector,
  type TelemetryOptions,
  type TelemetrySnapshot,
  type TelemetryState,
} from '@distlab/telemetry';
import { FaultInjector, type FaultInjectorState } from './fault-injector.js';
import { NodeRegistry } from './node-registry.js';
import { NodeRuntime, type NodeRuntimeState } from './node-runtime.js';
import { WorkloadGenerator } from './workload.js';
import { Simulation, type KernelState, type RunOptions, type RunResult } from './simulation.js';
import { createRoutingPolicy } from './modules/routing.js';
import { createDataPlane } from './modules/data.js';
import { createQueueModule } from './modules/queue.js';
import { createConsensusModule } from './modules/consensus.js';
import { createLocksModule } from './modules/locks.js';
import type { DataPlane, EmitMeta, ModuleServices, RoutingPolicy, SimModule } from './modules/types.js';

export interface CreateSimulationOptions {
  /** Bounds the retained event log on long runs. */
  readonly logCapacity?: number;
  /**
   * Observation settings. Deliberately not part of the scenario spec: how
   * closely a run is watched should not change what the run does.
   */
  readonly telemetry?: TelemetryOptions;
}

/** A complete checkpoint: everything needed to resume a run in a fresh engine. */
export interface WorldState {
  readonly started: boolean;
  readonly kernel: KernelState;
  readonly nodes: ReturnType<NodeRegistry['captureState']>;
  readonly network: NetworkState;
  readonly runtime: NodeRuntimeState;
  readonly workload: ReturnType<WorkloadGenerator['captureState']>;
  readonly faults: FaultInjectorState;
  readonly routing: unknown;
  readonly modules: Readonly<Record<string, unknown>>;
  readonly telemetry: TelemetryState;
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
  readonly services: ModuleServices;
  readonly routing: RoutingPolicy;
  readonly data: DataPlane;
  /** Protocol modules, keyed by name, in registration order. */
  readonly modules: ReadonlyMap<string, SimModule>;
  readonly runtime: NodeRuntime;
  readonly workload: WorkloadGenerator;
  readonly faults: FaultInjector;
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

    this.services = this.createServices();
    this.routing = createRoutingPolicy(this.services);
    this.data = createDataPlane(this.services);
    const protocolModules = [
      createQueueModule(this.services),
      createConsensusModule(this.services),
      createLocksModule(this.services),
    ];
    this.modules = new Map([this.data, ...protocolModules].map((m) => [m.name, m]));

    this.runtime = new NodeRuntime({
      context: this.simulation,
      registry: this.registry,
      network: this.network,
      routing: this.routing,
      data: this.data,
      modules: protocolModules,
    });
    this.workload = new WorkloadGenerator({
      context: this.simulation,
      runtime: this.runtime,
      workloads: spec.workloads,
    });
    this.faults = new FaultInjector({
      context: this.simulation,
      network: this.network,
      registry: this.registry,
      control: this.simulation,
      faults: spec.faults,
    });

    // Registration order is part of the determinism contract.
    const on = this.simulation.on.bind(this.simulation);
    this.network.attach(on);
    this.runtime.attach(on);
    this.workload.attach(on);
    this.faults.attach(on);

    this.telemetry = new TelemetryCollector(options.telemetry ?? {});
    this.simulation.observe((event) => this.telemetry.observe(event));
  }

  /** Schedules `SIMULATION_STARTED`, which is what bootstraps workloads, faults and modules. */
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

  // --- checkpoints --------------------------------------------------------

  captureState(): WorldState {
    const modules: Record<string, unknown> = {};
    for (const [name, module] of this.modules) modules[name] = module.captureState();
    return {
      started: this.started,
      kernel: this.simulation.captureState(),
      nodes: this.registry.captureState(),
      network: this.network.captureState(),
      runtime: this.runtime.captureState(),
      workload: this.workload.captureState(),
      faults: this.faults.captureState(),
      routing: this.routing.captureState(),
      modules,
      telemetry: this.telemetry.captureState(),
    };
  }

  /**
   * Loads a checkpoint taken from a world built from the same spec. Afterwards
   * this world continues exactly as the original would have.
   */
  restoreState(state: WorldState): void {
    this.started = state.started;
    this.simulation.restoreState(state.kernel);
    this.registry.restoreState(state.nodes);
    this.network.restoreState(state.network);
    this.runtime.restoreState(state.runtime);
    this.workload.restoreState(state.workload);
    this.faults.restoreState(state.faults);
    this.routing.restoreState(state.routing);
    for (const [name, module] of this.modules) {
      if (name in state.modules) module.restoreState(state.modules[name]);
    }
    this.telemetry.restoreState(state.telemetry);
  }

  private createServices(): ModuleServices {
    const simulation = this.simulation;
    const world = this;
    return {
      context: simulation,
      registry: this.registry,
      network: this.network,
      emit<T extends EventType>(type: T, payload: EventPayloadMap[T], meta: EmitMeta = {}): SimEvent<T> {
        return simulation.schedule(
          {
            type,
            payload,
            ...(meta.nodeId !== undefined ? { nodeId: meta.nodeId } : {}),
            ...(meta.traceId !== undefined ? { traceId: meta.traceId } : {}),
            ...(meta.causedBy !== undefined ? { causedBy: meta.causedBy } : {}),
          },
          0,
        );
      },
      send: (request) => this.network.send(request),
      reply: (node, request, status, data, causedBy) =>
        world.runtime.reply(node, request, status, data, causedBy),
      setTimer: (nodeId, module, name, delay, data, causedBy?: EventId) =>
        simulation.schedule(
          {
            type: 'TIMER',
            payload: {
              nodeId,
              module,
              name,
              incarnation: this.registry.get(nodeId)?.state.incarnation ?? 0,
              ...(data !== undefined ? { data } : {}),
            },
            nodeId,
            ...(causedBy !== undefined ? { causedBy } : {}),
          },
          delay,
        ).id,
      cancelTimer: (id) => simulation.cancel(id),
      rng: (module, nodeId) => simulation.stream(`${module}:${nodeId}`),
      completeDeferred: (nodeId, workId, status, data, causedBy) =>
        world.runtime.completeDeferred(nodeId, workId, status, data, causedBy),
    };
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

/** Builds a fresh world and loads a checkpoint into it. */
export function restoreSimulation(
  spec: SimulationSpec,
  state: WorldState,
  options: CreateSimulationOptions = {},
): SimulationWorld {
  const world = createSimulation(spec, options);
  world.restoreState(state);
  return world;
}
