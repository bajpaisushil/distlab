import type { EventId, LinkId, MessageId, NodeId, RequestId, TraceId, WorkloadId } from './ids.js';
import type { DropReason, Message } from './messages.js';
import type { SimTime } from './time.js';
import type { FaultEventPayloads } from './faults.js';
import type { RequestEventPayloads } from './protocols/requests.js';
import type { RoutingEventPayloads } from './protocols/routing.js';
import type { DataEventPayloads } from './protocols/data.js';
import type { QueueEventPayloads } from './protocols/queue.js';
import type { ConsensusEventPayloads } from './protocols/consensus.js';
import type { LockEventPayloads } from './protocols/locks.js';

export type { RequestFailureReason } from './protocols/requests.js';

export type TimerData = Readonly<Record<string, string | number | boolean>>;

export type SimulationEndReason = 'duration_reached' | 'event_limit' | 'queue_drained' | 'stopped';

/** Events every simulation has regardless of which subsystems are in use. */
export interface CoreEventPayloads {
  SIMULATION_STARTED: { seed: string; nodeCount: number; linkCount: number };
  SIMULATION_COMPLETED: { reason: SimulationEndReason; eventsProcessed: number; endedAt: SimTime };

  WORKLOAD_TICK: { workloadId: WorkloadId; clientId: NodeId; emitted: number };

  MESSAGE_SENT: { message: Message; linkId: LinkId };
  MESSAGE_RECEIVED: { message: Message };
  MESSAGE_DROPPED: {
    messageId: MessageId;
    requestId?: RequestId;
    source: NodeId;
    destination: NodeId;
    reason: DropReason;
    linkId?: LinkId;
  };
  MESSAGE_DUPLICATED: { originalId: MessageId; duplicateId: MessageId; linkId: LinkId };

  NODE_FAILED: { nodeId: NodeId; reason: string };
  NODE_RECOVERED: { nodeId: NodeId };

  /**
   * A module's own timer firing at a node: an election timeout, a lease
   * expiry, a visibility timeout. Generic so that every module's timing goes
   * through the same queue, the same ordering and the same pause semantics.
   */
  TIMER: {
    nodeId: NodeId;
    module: string;
    name: string;
    /** The node incarnation the timer was armed in; stale timers are discarded. */
    incarnation: number;
    data?: TimerData;
  };
}

/**
 * Every event payload, by event type.
 *
 * Composed from per-subsystem fragments so each subsystem owns its events in
 * its own file. The union of event names is derived from this map, which
 * means an event cannot exist without a payload type behind it.
 */
export interface EventPayloadMap
  extends CoreEventPayloads,
    RequestEventPayloads,
    FaultEventPayloads,
    RoutingEventPayloads,
    DataEventPayloads,
    QueueEventPayloads,
    ConsensusEventPayloads,
    LockEventPayloads {}

export type EventType = keyof EventPayloadMap;

/**
 * A scheduled simulation event.
 *
 * `at` is when it fires in virtual time; `seq` breaks ties between events
 * scheduled for the identical instant, which is what makes ordering total and
 * therefore reproducible.
 */
export interface SimEvent<T extends EventType = EventType> {
  readonly id: EventId;
  readonly seq: number;
  readonly type: T;
  readonly at: SimTime;
  readonly createdAt: SimTime;
  readonly payload: EventPayloadMap[T];
  readonly nodeId?: NodeId;
  readonly traceId?: TraceId;
  /** Event that caused this one, forming a causality chain for explanations. */
  readonly causedBy?: EventId;
}

/** Discriminated union over every event type, for exhaustive handling. */
export type AnySimEvent = { [K in EventType]: SimEvent<K> }[EventType];

/** What a caller supplies to `schedule`; the engine fills in id, seq and timing. */
export interface EventDraft<T extends EventType = EventType> {
  readonly type: T;
  readonly payload: EventPayloadMap[T];
  readonly nodeId?: NodeId;
  readonly traceId?: TraceId;
  readonly causedBy?: EventId;
}
