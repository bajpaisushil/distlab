import type {
  ArrivalSpec,
  EventId,
  EventType,
  ResolvedWorkloadSpec,
  SimEvent,
  SimulationContext,
  WorkloadId,
} from '@distlab/shared';
import type { NodeRuntime } from './node-runtime.js';

type Registrar = <T extends EventType>(type: T, handler: (event: SimEvent<T>) => void) => unknown;

/**
 * Turns workload specs into request traffic.
 *
 * Arrivals are scheduled events like everything else, so traffic shape is
 * reproducible: a Poisson workload with a given seed produces the same bursts
 * every run, which is what makes "the same load against two architectures"
 * a meaningful comparison rather than an approximate one.
 */
export class WorkloadGenerator {
  private readonly context: SimulationContext;
  private readonly runtime: NodeRuntime;
  private readonly workloads = new Map<WorkloadId, ResolvedWorkloadSpec>();
  private readonly emitted = new Map<WorkloadId, number>();

  constructor(options: {
    context: SimulationContext;
    runtime: NodeRuntime;
    workloads: readonly ResolvedWorkloadSpec[];
  }) {
    this.context = options.context;
    this.runtime = options.runtime;
    for (const workload of options.workloads) {
      this.workloads.set(workload.id, workload);
      this.emitted.set(workload.id, 0);
    }
  }

  attach(on: Registrar): void {
    on('SIMULATION_STARTED', (event) => this.bootstrap(event.id));
    on('WORKLOAD_TICK', (event) => this.onTick(event));
  }

  /** Requests emitted so far, per workload. */
  counts(): Record<WorkloadId, number> {
    return Object.fromEntries(this.emitted);
  }

  private bootstrap(causedBy: EventId): void {
    for (const workload of this.workloads.values()) {
      this.context.scheduleAt(
        {
          type: 'WORKLOAD_TICK',
          payload: { workloadId: workload.id, clientId: workload.clientId, emitted: 0 },
          nodeId: workload.clientId,
          causedBy,
        },
        workload.startAt,
      );
    }
  }

  private onTick(event: SimEvent<'WORKLOAD_TICK'>): void {
    const workload = this.workloads.get(event.payload.workloadId);
    if (!workload) return;

    const now = this.context.now();
    if (workload.stopAt !== undefined && now > workload.stopAt) return;

    let emitted = this.emitted.get(workload.id) ?? 0;
    const batch = batchSize(workload.arrival);
    for (let i = 0; i < batch && emitted < workload.maxRequests; i++) {
      const key = this.pickKey(workload);
      this.runtime.beginRequest(
        {
          clientId: workload.clientId,
          workloadId: workload.id,
          operation: this.pickOperation(workload),
          sizeBytes: workload.sizeBytes,
          deadlineMs: workload.deadlineMs,
          ...(key !== undefined ? { key } : {}),
        },
        event.id,
      );
      emitted += 1;
    }
    this.emitted.set(workload.id, emitted);

    if (emitted >= workload.maxRequests) return;

    const gap = this.nextGap(workload);
    if (gap === undefined) return;

    const nextAt = now + gap;
    if (workload.stopAt !== undefined && nextAt > workload.stopAt) return;

    this.context.scheduleAt(
      {
        type: 'WORKLOAD_TICK',
        payload: { workloadId: workload.id, clientId: workload.clientId, emitted },
        nodeId: workload.clientId,
        causedBy: event.id,
      },
      nextAt,
    );
  }

  /** Weighted choice from the workload's mix, on its own stream so it cannot shift arrival times. */
  private pickOperation(workload: ResolvedWorkloadSpec): string {
    const mix = workload.mix;
    if (mix.length === 1) return (mix[0] as { operation: string }).operation;
    const total = mix.reduce((sum, entry) => sum + entry.weight, 0);
    let roll = this.context.stream(`workload:${workload.id}:mix`).float() * total;
    for (const entry of mix) {
      roll -= entry.weight;
      if (roll < 0) return entry.operation;
    }
    return (mix[mix.length - 1] as { operation: string }).operation;
  }

  private pickKey(workload: ResolvedWorkloadSpec): string | undefined {
    if (workload.keys <= 0) return undefined;
    const rng = this.context.stream(`workload:${workload.id}:keys`);
    if (workload.hotKeyShare > 0 && rng.bool(workload.hotKeyShare)) return 'key-0';
    return `key-${rng.int(0, workload.keys)}`;
  }

  captureState(): readonly (readonly [WorkloadId, number])[] {
    return [...this.emitted.entries()];
  }

  restoreState(state: readonly (readonly [WorkloadId, number])[]): void {
    this.emitted.clear();
    for (const [id, count] of state) this.emitted.set(id, count);
  }

  /** Virtual time until the next arrival, or undefined when the workload is finished. */
  private nextGap(workload: ResolvedWorkloadSpec): number | undefined {
    const arrival = workload.arrival;
    switch (arrival.kind) {
      case 'once':
        return undefined;
      case 'constant':
        return 1000 / arrival.ratePerSec;
      case 'poisson':
        // Exponential gaps are what make a Poisson process bursty: the mean
        // rate is right, but requests clump, which is how real traffic breaks
        // systems that only ever saw evenly spaced load tests.
        return this.context.stream(`workload:${workload.id}`).exponential(1000 / arrival.ratePerSec);
      case 'burst':
        return arrival.everyMs;
    }
  }
}

function batchSize(arrival: ArrivalSpec): number {
  switch (arrival.kind) {
    case 'once':
    case 'burst':
      return arrival.count;
    case 'constant':
    case 'poisson':
      return 1;
  }
}
