/**
 * Request lifecycle and reliability contracts: the events a request emits on
 * its way through the system, and the per-node policies (timeouts, retries,
 * circuit breakers, bulkheads) that shape that journey.
 */
import type { NodeId, RequestId, SpanId, TraceId, WorkloadId } from '../ids.js';
import type { OperationType, ResponseStatus } from '../messages.js';
import type { SimTime } from '../time.js';
import type { IssueReporter, SpecValidationContext } from '../validation.js';

export type RequestFailureReason =
  | 'node_failed'
  | 'queue_full'
  | 'processing_error'
  | 'unreachable'
  | 'timeout'
  | 'no_route'
  | 'unavailable'
  | 'circuit_open'
  | 'bulkhead_full'
  | 'not_leader';

export interface ReliabilityNodeConfig {}

export interface RequestEventPayloads {
  REQUEST_CREATED: {
    requestId: RequestId;
    traceId: TraceId;
    clientId: NodeId;
    operation: OperationType;
    workloadId: WorkloadId;
    /** Root span of the trace: the client's own view of the whole request. */
    spanId: SpanId;
    key?: string;
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
  /** A hop gave up: the request's deadline passed while this node held it. */
  TIMEOUT: { nodeId: NodeId; requestId: RequestId; spanId: SpanId; deadlineAt: SimTime; waitedFor?: NodeId };
}

export function validateReliabilityConfig(
  _config: ReliabilityNodeConfig,
  _path: string,
  _push: IssueReporter,
  _context: SpecValidationContext,
): void {}
