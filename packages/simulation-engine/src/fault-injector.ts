import {
  describeFault,
  type EventId,
  type EventType,
  type LatencySpec,
  type LinkId,
  type NodeId,
  type ResolvedFaultSpec,
  type SimEvent,
  type SimulationContext,
} from '@distlab/shared';
import type { SimulatedNetwork } from '@distlab/network';
import type { NodeRegistry } from './node-registry.js';
import type { DispatchGate } from './simulation.js';

/** The slice of the kernel the injector needs to pause nodes. */
export interface DispatchControl {
  setDispatchGate(gate: DispatchGate | undefined, onHeld?: (event: SimEvent) => void): void;
  requeue(event: SimEvent, at: number): void;
}

export interface FaultInjectorState {
  readonly crashes: readonly (readonly [NodeId, readonly string[]])[];
  readonly cuts: readonly (readonly [LinkId, readonly string[]])[];
  readonly overrides: readonly (readonly [LinkId, readonly LinkOverride[]])[];
  readonly bases: readonly (readonly [LinkId, LinkBase])[];
}

type Registrar = <T extends EventType>(type: T, handler: (event: SimEvent<T>) => void) => unknown;

interface LinkOverride {
  readonly faultId: string;
  readonly latency?: LatencySpec;
  readonly lossRate?: number;
}

interface LinkBase {
  readonly latency: LatencySpec;
  readonly lossRate: number;
  readonly enabled: boolean;
}

/**
 * Turns scheduled faults into simulation events.
 *
 * Each fault becomes a `FAULT_INJECTED` / `FAULT_CLEARED` pair, and the
 * injector translates those into concrete effects. The indirection exists for
 * overlap: if two crashes on one node overlap, the node must stay down until
 * the *later* one ends, and if two latency spikes overlap on one link, the
 * first one ending must not wipe out the second. Faults are therefore
 * reference-counted per node and stacked per link, and the effect emitted is
 * always the composition of everything still active.
 */
export class FaultInjector {
  private readonly context: SimulationContext;
  private readonly network: SimulatedNetwork;
  private readonly registry: NodeRegistry;
  private readonly control: DispatchControl;
  private readonly faults = new Map<string, ResolvedFaultSpec>();

  private crashes = new Map<NodeId, Set<string>>();
  private cuts = new Map<LinkId, Set<string>>();
  private overrides = new Map<LinkId, LinkOverride[]>();
  private bases = new Map<LinkId, LinkBase>();

  constructor(options: {
    context: SimulationContext;
    network: SimulatedNetwork;
    registry: NodeRegistry;
    control: DispatchControl;
    faults: readonly ResolvedFaultSpec[];
  }) {
    this.context = options.context;
    this.network = options.network;
    this.registry = options.registry;
    this.control = options.control;
    for (const fault of options.faults) this.faults.set(fault.id, fault);
  }

  captureState(): FaultInjectorState {
    return {
      crashes: [...this.crashes.entries()].map(([id, set]) => [id, [...set]] as const),
      cuts: [...this.cuts.entries()].map(([id, set]) => [id, [...set]] as const),
      overrides: [...this.overrides.entries()].map(([id, stack]) => [id, [...stack]] as const),
      bases: [...this.bases.entries()],
    };
  }

  restoreState(state: FaultInjectorState): void {
    this.crashes = new Map(state.crashes.map(([id, list]) => [id, new Set(list)]));
    this.cuts = new Map(state.cuts.map(([id, list]) => [id, new Set(list)]));
    this.overrides = new Map(state.overrides.map(([id, stack]) => [id, [...stack]]));
    this.bases = new Map(state.bases);
  }

  /** Read access for later fault kinds; kept so the constructor contract is stable. */
  protected get handles(): { registry: NodeRegistry; control: DispatchControl } {
    return { registry: this.registry, control: this.control };
  }

  attach(on: Registrar): void {
    on('SIMULATION_STARTED', (event) => this.scheduleAll(event.id));
    on('FAULT_INJECTED', (event) => this.onInjected(event));
    on('FAULT_CLEARED', (event) => this.onCleared(event));
    on('LINK_STATE_CHANGED', (event) => {
      this.network.setLinkEnabled(event.payload.linkId, event.payload.enabled);
    });
    on('LINK_CONFIG_CHANGED', (event) => {
      this.network.topology.updateLink(event.payload.linkId, {
        latency: event.payload.latency,
        lossRate: event.payload.lossRate,
      });
    });
    on('PARTITION_STARTED', (event) => {
      this.network.addPartition({ id: event.payload.partitionId, groups: event.payload.groups });
    });
    on('PARTITION_HEALED', (event) => {
      this.network.removePartition(event.payload.partitionId);
    });
  }

  private scheduleAll(causedBy: EventId): void {
    for (const fault of this.faults.values()) {
      this.context.scheduleAt(
        {
          type: 'FAULT_INJECTED',
          payload: { faultId: fault.id, kind: fault.kind, description: describeFault(fault) },
          causedBy,
        },
        fault.at,
      );
      const duration = durationOf(fault);
      if (duration !== undefined) {
        this.context.scheduleAt(
          { type: 'FAULT_CLEARED', payload: { faultId: fault.id, kind: fault.kind }, causedBy },
          fault.at + duration,
        );
      }
    }
  }

  private onInjected(event: SimEvent<'FAULT_INJECTED'>): void {
    const fault = this.faults.get(event.payload.faultId);
    if (!fault) return;
    const causedBy = event.id;

    switch (fault.kind) {
      case 'node_crash': {
        const active = setFor(this.crashes, fault.nodeId);
        const wasDown = active.size > 0;
        active.add(fault.id);
        if (!wasDown) {
          this.emit(
            'NODE_FAILED',
            { nodeId: fault.nodeId, reason: fault.reason ?? `fault ${fault.id}` },
            causedBy,
            fault.nodeId,
          );
        }
        return;
      }
      case 'link_down': {
        this.captureBase(fault.linkId);
        const active = setFor(this.cuts, fault.linkId);
        const wasDown = active.size > 0;
        active.add(fault.id);
        if (!wasDown) {
          this.emit('LINK_STATE_CHANGED', { linkId: fault.linkId, enabled: false, faultId: fault.id }, causedBy);
        }
        return;
      }
      case 'partition':
        this.emit('PARTITION_STARTED', { partitionId: fault.id, groups: fault.groups }, causedBy);
        return;
      case 'latency_spike':
        this.pushOverride(fault.linkId, { faultId: fault.id, latency: fault.latency }, causedBy);
        return;
      case 'packet_loss':
        this.pushOverride(fault.linkId, { faultId: fault.id, lossRate: fault.lossRate }, causedBy);
        return;
    }
  }

  private onCleared(event: SimEvent<'FAULT_CLEARED'>): void {
    const fault = this.faults.get(event.payload.faultId);
    if (!fault) return;
    const causedBy = event.id;

    switch (fault.kind) {
      case 'node_crash': {
        const active = setFor(this.crashes, fault.nodeId);
        if (!active.delete(fault.id)) return;
        // Recover only when no other crash fault is still holding the node down.
        if (active.size === 0) this.emit('NODE_RECOVERED', { nodeId: fault.nodeId }, causedBy, fault.nodeId);
        return;
      }
      case 'link_down': {
        const active = setFor(this.cuts, fault.linkId);
        if (!active.delete(fault.id)) return;
        const base = this.bases.get(fault.linkId);
        if (active.size === 0 && (base?.enabled ?? true)) {
          this.emit('LINK_STATE_CHANGED', { linkId: fault.linkId, enabled: true, faultId: fault.id }, causedBy);
        }
        return;
      }
      case 'partition':
        this.emit('PARTITION_HEALED', { partitionId: fault.id }, causedBy);
        return;
      case 'latency_spike':
      case 'packet_loss': {
        const stack = this.overrides.get(fault.linkId);
        if (!stack) return;
        const index = stack.findIndex((o) => o.faultId === fault.id);
        if (index < 0) return;
        stack.splice(index, 1);
        this.emitEffective(fault.linkId, fault.id, true, causedBy);
        return;
      }
    }
  }

  private pushOverride(linkId: LinkId, override: LinkOverride, causedBy: EventId): void {
    this.captureBase(linkId);
    const stack = this.overrides.get(linkId) ?? [];
    stack.push(override);
    this.overrides.set(linkId, stack);
    this.emitEffective(linkId, override.faultId, false, causedBy);
  }

  /** The link's base settings with every still-active override applied, latest winning. */
  private emitEffective(linkId: LinkId, faultId: string, restoring: boolean, causedBy: EventId): void {
    const base = this.bases.get(linkId);
    if (!base) return;
    let latency = base.latency;
    let lossRate = base.lossRate;
    for (const override of this.overrides.get(linkId) ?? []) {
      if (override.latency !== undefined) latency = override.latency;
      if (override.lossRate !== undefined) lossRate = override.lossRate;
    }
    this.emit('LINK_CONFIG_CHANGED', { linkId, faultId, restoring, latency, lossRate }, causedBy);
  }

  /** Records a link's configured settings before any fault touches it. */
  private captureBase(linkId: LinkId): void {
    if (this.bases.has(linkId)) return;
    const link = this.network.topology.getLink(linkId);
    if (!link) return;
    this.bases.set(linkId, { latency: link.latency, lossRate: link.lossRate, enabled: link.enabled });
  }

  private emit<T extends EventType>(
    type: T,
    payload: SimEvent<T>['payload'],
    causedBy: EventId,
    nodeId?: NodeId,
  ): void {
    this.context.schedule({ type, payload, causedBy, ...(nodeId !== undefined ? { nodeId } : {}) }, 0);
  }
}

function durationOf(fault: ResolvedFaultSpec): number | undefined {
  switch (fault.kind) {
    case 'node_crash':
      return fault.recoverAfter;
    case 'link_down':
      return fault.restoreAfter;
    case 'partition':
      return fault.healAfter;
    case 'latency_spike':
    case 'packet_loss':
      return fault.durationMs;
  }
}

function setFor<K>(map: Map<K, Set<string>>, key: K): Set<string> {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  return set;
}
