import type { MessageId, NodeId, RequestId, SpanId, TraceId } from './ids.js';
import type { SimTime } from './time.js';
import type { DataMessageKind, DataMessagePayload } from './protocols/data.js';
import type { QueueMessageKind, QueueMessagePayload } from './protocols/queue.js';
import type { ConsensusMessageKind, ConsensusMessagePayload } from './protocols/consensus.js';
import type { LockMessageKind, LockMessagePayload } from './protocols/locks.js';

/**
 * What a message is for. Request/response is the RPC path every node speaks;
 * the rest are protocol messages owned by individual subsystems (replication,
 * queues, consensus, locks), each defined in its own protocol file.
 */
export type MessageKind =
  | 'REQUEST'
  | 'RESPONSE'
  | DataMessageKind
  | QueueMessageKind
  | ConsensusMessageKind
  | LockMessageKind;

export type MessageStatus = 'in_flight' | 'delivered' | 'dropped';

/** Why the network discarded a message. Surfaced in logs and metrics. */
export type DropReason =
  | 'packet_loss'
  | 'no_link'
  | 'link_down'
  | 'partitioned'
  | 'destination_failed'
  | 'source_failed';

/** Application-level operation a request carries. Free-form so scenarios can add their own. */
export type OperationType =
  | 'HTTP_GET'
  | 'HTTP_POST'
  | 'HTTP_PUT'
  | 'DB_READ'
  | 'DB_WRITE'
  | 'RPC'
  | 'ENQUEUE'
  | (string & {});

export type ResponseStatus =
  | 'ok'
  | 'error'
  | 'rejected'
  | 'unreachable'
  | 'timeout'
  | 'unavailable'
  | 'circuit_open'
  | 'not_leader';

export interface RequestBody {
  readonly operation: OperationType;
  /** Set by the originating workload; lets a scenario tag traffic classes. */
  readonly workloadId?: string;
  /** Nodes already visited, oldest first. Prevents routing loops and gives the UI the request's path. */
  readonly path: readonly NodeId[];
  /**
   * Absolute virtual time after which the request is abandoned.
   *
   * Every hop honours the same deadline, so a request always terminates even
   * when a message is silently lost. Configurable per-call timeouts, retries
   * and backoff are a later phase; this is the floor that keeps the system
   * from leaking capacity.
   */
  readonly deadlineAt: SimTime;
  /** Data key for storage operations, chosen by the workload. */
  readonly key?: string;
}

/** What a response carries back besides its status. Every field is optional and subsystem-specific. */
export interface ResponseData {
  readonly key?: string;
  /** Version of the key that was read or written. */
  readonly version?: number;
  /** A replica answered with a version older than the primary's at that instant. */
  readonly stale?: boolean;
  readonly cache?: 'hit' | 'miss';
  /** Where a non-leader thinks the leader is. */
  readonly leaderHint?: NodeId;
}

export interface ResponseBody {
  readonly status: ResponseStatus;
  /** Nodes the request traversed, oldest first. */
  readonly path: readonly NodeId[];
  readonly error?: string;
  /** Node that actually produced the response, which may be deep in the graph. */
  readonly servedBy: NodeId;
  readonly data?: ResponseData;
}

export type MessagePayload =
  | RequestBody
  | ResponseBody
  | DataMessagePayload
  | QueueMessagePayload
  | ConsensusMessagePayload
  | LockMessagePayload;

/**
 * A message in flight on the simulated network.
 *
 * Nodes never call each other directly: a node hands a message to the network,
 * and the network decides whether, when, and how many times it arrives.
 */
export interface Message<P extends MessagePayload = MessagePayload> {
  readonly id: MessageId;
  readonly kind: MessageKind;
  readonly source: NodeId;
  readonly destination: NodeId;
  readonly type: OperationType;
  readonly payload: P;
  readonly sizeBytes: number;
  readonly createdAt: SimTime;
  /** Virtual time the network expects to deliver it. */
  readonly deliverAt: SimTime;
  readonly status: MessageStatus;
  /**
   * Request correlation. Always present on REQUEST/RESPONSE; protocol traffic
   * (heartbeats, replication, lock leases) belongs to no client request.
   */
  readonly requestId?: RequestId;
  readonly traceId?: TraceId;
  readonly spanId?: SpanId;
  readonly parentSpanId?: SpanId;
  /** Hop count from the originating client, starting at 0. */
  readonly hop: number;
  /** Set when the network duplicated an earlier message to produce this one. */
  readonly duplicateOf?: MessageId;
}

/** Request/response traffic always carries its correlation ids. */
type Correlated = { readonly requestId: RequestId; readonly traceId: TraceId; readonly spanId: SpanId };

export type RequestMessage = Message<RequestBody> & Correlated;
export type ResponseMessage = Message<ResponseBody> & Correlated;

export function isRequest(message: Message): message is RequestMessage {
  return message.kind === 'REQUEST';
}

export function isResponse(message: Message): message is ResponseMessage {
  return message.kind === 'RESPONSE';
}

export function isWriteOperation(operation: OperationType): boolean {
  return operation === 'DB_WRITE' || operation === 'HTTP_POST' || operation === 'HTTP_PUT' || operation === 'WRITE';
}
