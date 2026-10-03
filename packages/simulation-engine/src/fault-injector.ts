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
  readonly pauses: readonly (readonly [NodeId, readonly string[]])[];
  readonly pausedSince: readonly (readonly [NodeId, number])[];
  readonly held: readonly (readonly [NodeId, readonly SimEvent[]])[];
  readonly conditions: readonly (readonly [NodeId, readonly NodeCondition[]])[];
}

type Registrar = <T extends EventType>(type: T, handler: (event: SimEvent<T>) => void) => unknown;

interface LinkOverride {
  readonly faultId: string;
  readonly latency?: LatencySpec;
  readonly lossRate?: number;
  readonly duplicateRate?: number;
}

interface LinkBase {
  readonly latency: LatencySpec;
  readonly lossRate: number;
  readonly duplicateRate: number;
  readonly enabled: boolean;
}

/** One fault's contribution to a node's degradation. */
interface NodeCondition {
  readonly faultId: string;
  readonly slowdown?: number;
  readonly unavailable?: boolean;
  readonly replicationStalled?: boolean;
  readonly messageDelay?: LatencySpec;
}

/**
 * Events that still reach a frozen node. Its own crash and recovery, and the
 * fault machinery itself; everything else the node would do waits.
 */
const PASSES_PAUSE = new Set<EventType>([
  'NODE_FAILED',
  'NODE_RECOVERED',
  'NODE_PAUSED',
  'NODE_RESUMED',
  'NODE_CONDITION_CHANGED',
  'FAULT_INJECTED',
  'FAULT_CLEARED',
]);

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
  private pauses = new Map<NodeId, Set<string>>();
  private pausedSince = new Map<NodeId, number>();
  /** Events a frozen node would have handled, in the order they were due. */
  private held = new Map<NodeId, SimEvent[]>();
  private conditions = new Map<NodeId, NodeCondition[]>();

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
    this.control.setDispatchGate(
      (event) => this.admits(event),
      (event) => this.hold(event),
    );
  }

  captureState(): FaultInjectorState {
    return {
      crashes: [...this.crashes.entries()].map(([id, set]) => [id, [...set]] as const),
      cuts: [...this.cuts.entries()].map(([id, set]) => [id, [...set]] as const),
      overrides: [...this.overrides.entries()].map(([id, stack]) => [id, [...stack]] as const),
      bases: [...this.bases.entries()],
      pauses: [...this.pauses.entries()].map(([id, set]) => [id, [...set]] as const),
      pausedSince: [...this.pausedSince.entries()],
      held: [...this.held.entries()].map(([id, events]) => [id, [...events]] as const),
      conditions: [...this.conditions.entries()].map(([id, stack]) => [id, [...stack]] as const),
    };
  }

  restoreState(state: FaultInjectorState): void {
    this.crashes = new Map(state.crashes.map(([id, list]) => [id, new Set(list)]));
    this.cuts = new Map(state.cuts.map(([id, list]) => [id, new Set(list)]));
    this.overrides = new Map(state.overrides.map(([id, stack]) => [id, [...stack]]));
    this.bases = new Map(state.bases);
    this.pauses = new Map(state.pauses.map(([id, list]) => [id, new Set(list)]));
    this.pausedSince = new Map(state.pausedSince);
    this.held = new Map(state.held.map(([id, events]) => [id, [...events]]));
    this.conditions = new Map(state.conditions.map(([id, stack]) => [id, [...stack]]));
  }

  /** How many events are waiting for a frozen node, for inspection. */
  heldFor(nodeId: NodeId): number {
    return this.held.get(nodeId)?.length ?? 0;
  }

  /** A frozen node executes nothing: its events are set aside until it resumes. */
  private admits(event: SimEvent): boolean {
    if (event.nodeId === undefined || PASSES_PAUSE.has(event.type)) return true;
    return !this.registry.get(event.nodeId)?.state.paused;
  }

  private hold(event: SimEvent): void {
    const nodeId = event.nodeId as NodeId;
    const list = this.held.get(nodeId) ?? [];
    list.push(event);
    this.held.set(nodeId, list);
  }

  /** Puts a node's held events back, in their original order, to run now. */
  private release(nodeId: NodeId): number {
    const list = this.held.get(nodeId) ?? [];
    this.held.delete(nodeId);
    const now = this.context.now();
    for (const event of list) this.control.requeue(event, now);
    return list.length;
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
        duplicateRate: event.payload.duplicateRate,
      });
    });
    on('PARTITION_STARTED', (event) => {
      this.network.addPartition({ id: event.payload.partitionId, groups: event.payload.groups });
    });
    on('PARTITION_HEALED', (event) => {
      this.network.removePartition(event.payload.partitionId);
    });
    on('NODE_PAUSED', (event) => {
      const node = this.registry.get(event.payload.nodeId);
      if (!node || node.state.status === 'failed') return;
      node.state.paused = true;
      this.pausedSince.set(node.id, this.context.now());
    });
    on('NODE_RESUMED', (event) => {
      const node = this.registry.get(event.payload.nodeId);
      if (!node) return;
      node.state.paused = false;
      this.pausedSince.delete(node.id);
      this.release(node.id);
    });
    // A crash ends a freeze: the process is gone, and whatever was waiting
    // for it now meets a dead node instead.
    on('NODE_FAILED', (event) => {
      const id = event.payload.nodeId;
      const node = this.registry.get(id);
      if (node) node.state.paused = false;
      this.pausedSince.delete(id);
      this.release(id);
    });
    on('NODE_CONDITION_CHANGED', (event) => {
      const p = event.payload;
      const node = this.registry.get(p.nodeId);
      if (!node) return;
      node.state.slowdown = p.slowdown;
      node.state.unavailable = p.unavailable;
      node.state.replicationStalled = p.replicationStalled;
      this.network.setNodeDelay(p.nodeId, p.messageDelay);
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
      case 'packet_duplication':
        this.pushOverride(fault.linkId, { faultId: fault.id, duplicateRate: fault.duplicateRate }, causedBy);
        return;
      case 'node_pause': {
        const active = setFor(this.pauses, fault.nodeId);
        const wasPaused = active.size > 0;
        active.add(fault.id);
        const node = this.registry.get(fault.nodeId);
        // A dead process cannot freeze.
        if (!wasPaused && node && node.state.status !== 'failed') {
          this.emit('NODE_PAUSED', { nodeId: fault.nodeId, faultId: fault.id }, causedBy, fault.nodeId);
        }
        return;
      }
      case 'node_slowdown':
        this.pushCondition(fault.nodeId, { faultId: fault.id, slowdown: fault.factor }, causedBy);
        return;
      case 'node_unavailable':
        this.pushCondition(fault.nodeId, { faultId: fault.id, unavailable: true }, causedBy);
        return;
      case 'stale_replica':
        this.pushCondition(fault.nodeId, { faultId: fault.id, replicationStalled: true }, causedBy);
        return;
      case 'message_delay':
        this.pushCondition(fault.nodeId, { faultId: fault.id, messageDelay: fault.delay }, causedBy);
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
      case 'packet_loss':
      case 'packet_duplication': {
        const stack = this.overrides.get(fault.linkId);
        if (!stack) return;
        const index = stack.findIndex((o) => o.faultId === fault.id);
        if (index < 0) return;
        stack.splice(index, 1);
        this.emitEffective(fault.linkId, fault.id, true, causedBy);
        return;
      }
      case 'node_pause': {
        const active = setFor(this.pauses, fault.nodeId);
        if (!active.delete(fault.id)) return;
        const node = this.registry.get(fault.nodeId);
        // Resume only when no other pause still holds it, and only if it is still frozen (a crash ends a freeze).
        if (active.size === 0 && node?.state.paused) {
          const since = this.pausedSince.get(fault.nodeId) ?? this.context.now();
          this.emit(
            'NODE_RESUMED',
            {
              nodeId: fault.nodeId,
              faultId: fault.id,
              pausedForMs: this.context.now() - since,
              heldEvents: this.heldFor(fault.nodeId),
            },
            causedBy,
            fault.nodeId,
          );
        }
        return;
      }
      case 'node_slowdown':
      case 'node_unavailable':
      case 'stale_replica':
      case 'message_delay': {
        const stack = this.conditions.get(fault.nodeId);
        if (!stack) return;
        const index = stack.findIndex((c) => c.faultId === fault.id);
        if (index < 0) return;
        stack.splice(index, 1);
        this.emitCondition(fault.nodeId, fault.id, true, causedBy);
        return;
      }
    }
  }

  private pushCondition(nodeId: NodeId, condition: NodeCondition, causedBy: EventId): void {
    const stack = this.conditions.get(nodeId) ?? [];
    stack.push(condition);
    this.conditions.set(nodeId, stack);
    this.emitCondition(nodeId, condition.faultId, false, causedBy);
  }

  /** A node's condition with every still-active fault applied: the worst slowdown, the latest delay. */
  private emitCondition(nodeId: NodeId, faultId: string, restoring: boolean, causedBy: EventId): void {
    let slowdown = 1;
    let unavailable = false;
    let replicationStalled = false;
    let messageDelay: LatencySpec | undefined;
    for (const c of this.conditions.get(nodeId) ?? []) {
      if (c.slowdown !== undefined) slowdown = Math.max(slowdown, c.slowdown);
      if (c.unavailable) unavailable = true;
      if (c.replicationStalled) replicationStalled = true;
      if (c.messageDelay !== undefined) messageDelay = c.messageDelay;
    }
    this.emit(
      'NODE_CONDITION_CHANGED',
      { nodeId, faultId, restoring, slowdown, unavailable, replicationStalled, ...(messageDelay !== undefined ? { messageDelay } : {}) },
      causedBy,
      nodeId,
    );
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
    let duplicateRate = base.duplicateRate;
    for (const override of this.overrides.get(linkId) ?? []) {
      if (override.latency !== undefined) latency = override.latency;
      if (override.lossRate !== undefined) lossRate = override.lossRate;
      if (override.duplicateRate !== undefined) duplicateRate = override.duplicateRate;
    }
    this.emit('LINK_CONFIG_CHANGED', { linkId, faultId, restoring, latency, lossRate, duplicateRate }, causedBy);
  }

  /** Records a link's configured settings before any fault touches it. */
  private captureBase(linkId: LinkId): void {
    if (this.bases.has(linkId)) return;
    const link = this.network.topology.getLink(linkId);
    if (!link) return;
    this.bases.set(linkId, { latency: link.latency, lossRate: link.lossRate, duplicateRate: link.duplicateRate, enabled: link.enabled });
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
    case 'packet_duplication':
    case 'message_delay':
    case 'node_pause':
    case 'node_slowdown':
    case 'node_unavailable':
    case 'stale_replica':
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
