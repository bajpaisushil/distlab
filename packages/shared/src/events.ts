import type { EventId, LinkId, MessageId, NodeId, RequestId, SpanId, TraceId, WorkloadId } from './ids.js';
import type { DropReason, Message, OperationType, ResponseStatus } from './messages.js';
import type { SimTime } from './time.js';

/**
 * Every event type the engine can process.
 *
 * The list is deliberately limited to what is implemented today. Consensus,
 * queue, circuit-breaker and replication events belong to later phases and
 * will be added with the handlers that give them meaning — an event name with
 * no handler is just a lie in the type system.
 */
export type EventType =
  | 'SIMULATION_STARTED'
  | 'SIMULATION_COMPLETED'
  | 'WORKLOAD_TICK'
  | 'REQUEST_CREATED'
  | 'REQUEST_ROUTED'
  | 'REQUEST_QUEUED'
  | 'REQUEST_REJECTED'
  | 'REQUEST_PROCESSING_STARTED'
  | 'REQUEST_PROCESSING_COMPLETED'
  | 'REQUEST_COMPLETED'
  | 'REQUEST_FAILED'
  | 'MESSAGE_SENT'
  | 'MESSAGE_RECEIVED'
  | 'MESSAGE_DROPPED'
  | 'MESSAGE_DUPLICATED'
  | 'TIMEOUT'
  | 'NODE_FAILED'
  | 'NODE_RECOVERED'
  | 'DB_READ'
  | 'DB_WRITE';

export type SimulationEndReason = 'duration_reached' | 'event_limit' | 'queue_drained' | 'stopped';

export type RequestFailureReason =
  | 'node_failed'
  | 'queue_full'
  | 'processing_error'
  | 'unreachable'
  | 'timeout'
  | 'no_route';

export interface EventPayloadMap {
  SIMULATION_STARTED: { seed: string; nodeCount: number; linkCount: number };
  SIMULATION_COMPLETED: { reason: SimulationEndReason; eventsProcessed: number; endedAt: SimTime };

  WORKLOAD_TICK: { workloadId: WorkloadId; clientId: NodeId; emitted: number };

  REQUEST_CREATED: {
    requestId: RequestId;
    traceId: TraceId;
    clientId: NodeId;
    operation: OperationType;
    workloadId: WorkloadId;
    /** Root span of the trace: the client's own view of the whole request. */
    spanId: SpanId;
  };
  REQUEST_ROUTED: { requestId: RequestId; from: NodeId; to: NodeId; hop: number; strategy: string };
  REQUEST_QUEUED: { requestId: RequestId; nodeId: NodeId; queueDepth: number };
  REQUEST_REJECTED: { requestId: RequestId; nodeId: NodeId; reason: RequestFailureReason; queueDepth: number };
  REQUEST_PROCESSING_STARTED: { requestId: RequestId; nodeId: NodeId; spanId: SpanId; serviceTime: number };
  REQUEST_PROCESSING_COMPLETED: {
    requestId: RequestId;
    nodeId: NodeId;
    spanId: SpanId;
    serviceTime: number;
    outcome: 'ok' | 'error';
  };
  REQUEST_COMPLETED: {
    requestId: RequestId;
    traceId: TraceId;
    clientId: NodeId;
    latency: number;
    hops: number;
    path: readonly NodeId[];
  };
  REQUEST_FAILED: {
    requestId: RequestId;
    traceId: TraceId;
    clientId: NodeId;
    latency: number;
    status: ResponseStatus;
    reason: RequestFailureReason;
    failedAt?: NodeId;
  };

  MESSAGE_SENT: { message: Message; linkId: LinkId };
  MESSAGE_RECEIVED: { message: Message };
  MESSAGE_DROPPED: {
    messageId: MessageId;
    requestId: RequestId;
    source: NodeId;
    destination: NodeId;
    reason: DropReason;
    linkId?: LinkId;
  };
  MESSAGE_DUPLICATED: { originalId: MessageId; duplicateId: MessageId; linkId: LinkId };

  /** A hop gave up: the request's deadline passed while this node held it. */
  TIMEOUT: { nodeId: NodeId; requestId: RequestId; spanId: SpanId; deadlineAt: SimTime; waitedFor?: NodeId };

  NODE_FAILED: { nodeId: NodeId; reason: string };
  NODE_RECOVERED: { nodeId: NodeId };

  DB_READ: { nodeId: NodeId; requestId: RequestId; latency: number };
  DB_WRITE: { nodeId: NodeId; requestId: RequestId; latency: number };
}

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
