/**
 * Request lifecycle and reliability contracts: the events a request emits on
 * its way through the system, and the per-node policies (timeouts, retries,
 * circuit breakers, bulkheads) that shape that journey.
 */
import type { MessageId, NodeId, RequestId, SpanId, TraceId, WorkloadId } from '../ids.js';
import type { OperationType, ResponseStatus } from '../messages.js';
import type { SimTime } from '../time.js';
import {
  checkInteger,
  checkNonNegative,
  checkOneOf,
  checkPositive,
  checkProbability,
  type IssueReporter,
  type SpecValidationContext,
} from '../validation.js';

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

export type BackoffKind = 'none' | 'fixed' | 'exponential';
export type JitterKind = 'none' | 'full' | 'equal' | 'decorrelated';

export const BACKOFF_KINDS: readonly BackoffKind[] = ['none', 'fixed', 'exponential'];
export const JITTER_KINDS: readonly JitterKind[] = ['none', 'full', 'equal', 'decorrelated'];
export const RETRYABLE_STATUSES: readonly ResponseStatus[] = ['error', 'timeout', 'unreachable', 'rejected', 'unavailable'];

/** How a caller retries a failed downstream call. */
export interface RetryPolicy {
  /** Extra attempts after the first. */
  maxRetries: number;
  /** Default exponential. */
  backoff?: BackoffKind;
  /** First retry delay before jitter. Default 50ms. */
  baseDelayMs?: number;
  /** Ceiling on any one delay. Default 2000ms. */
  maxDelayMs?: number;
  /** Growth per retry for exponential backoff. Default 2. */
  multiplier?: number;
  /** Default full — spreading retries out is what stops them arriving as a synchronised wave. */
  jitter?: JitterKind;
  /** Which response statuses are worth retrying. Default: everything but success. */
  retryOn?: ResponseStatus[];
  /** Retry the same target instead of letting the balancer choose again. */
  retrySameTarget?: boolean;
}

/** Stops calling a target that keeps failing, and probes it before trusting it again. */
export interface CircuitBreakerPolicy {
  /** Consecutive failures that open the circuit (count mode). */
  failureThreshold: number;
  /** Open while this long, then let probes through. */
  cooldownMs: number;
  /** Probes allowed while half-open. Default 1. */
  halfOpenMaxCalls?: number;
  /** Rate mode: open when this share of calls in the window failed… */
  failureRateThreshold?: number;
  /** …over this sliding window… */
  windowMs?: number;
  /** …once at least this many calls are in it. Default failureThreshold. */
  minimumRequests?: number;
}

/** Caps how much of a node one class of traffic may use. */
export interface BulkheadPolicy {
  name: string;
  /** Workload ids in this class. */
  workloads: string[];
  maxConcurrent: number;
  /** Waiting room for this class; beyond it requests are rejected. Default the node's queue capacity. */
  maxQueue?: number;
}

/**
 * Reliability settings. They apply to the calls a node makes downstream —
 * including client nodes, which is where retry storms usually begin.
 */
export interface ReliabilityNodeConfig {
  /** Give up on one attempt after this long (bounded by the request's deadline). */
  callTimeoutMs?: number;
  retry?: RetryPolicy;
  circuitBreaker?: CircuitBreakerPolicy;
  bulkheads?: BulkheadPolicy[];
}

export type CircuitState = 'closed' | 'open' | 'half_open';

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
  REQUEST_REJECTED: {
    requestId: RequestId;
    nodeId: NodeId;
    reason: RequestFailureReason;
    queueDepth: number;
    /** The bulkhead whose limit was hit, for reason "bulkhead_full". */
    bulkhead?: string;
  };
  REQUEST_PROCESSING_STARTED: {
    requestId: RequestId;
    nodeId: NodeId;
    spanId: SpanId;
    /** The delivered message being worked on — distinct for each copy of a duplicated request. */
    workId: MessageId;
    serviceTime: number;
  };
  REQUEST_PROCESSING_COMPLETED: {
    requestId: RequestId;
    nodeId: NodeId;
    spanId: SpanId;
    workId: MessageId;
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
    /** Attempts the client made, including the first. */
    attempts: number;
  };
  REQUEST_FAILED: {
    requestId: RequestId;
    traceId: TraceId;
    clientId: NodeId;
    latency: number;
    status: ResponseStatus;
    reason: RequestFailureReason;
    failedAt?: NodeId;
    attempts: number;
  };
  /**
   * A node stopped waiting. Scope "deadline": the request's end-to-end budget
   * ran out while this node held it. Scope "call": one attempt at a downstream
   * call took longer than the node's call timeout.
   */
  TIMEOUT: {
    nodeId: NodeId;
    requestId: RequestId;
    spanId: SpanId;
    scope: 'deadline' | 'call';
    /** Which delivered copy timed out at a server; absent for a client. */
    workId?: MessageId;
    deadlineAt: SimTime;
    waitedFor?: NodeId;
    attempt?: number;
  };
  /** A failed call will be tried again after a backoff delay. */
  RETRY: {
    nodeId: NodeId;
    requestId: RequestId;
    /** The attempt about to be made: 2 is the first retry. */
    attempt: number;
    delayMs: number;
    reason: ResponseStatus;
    previousTarget: NodeId;
    workId?: MessageId;
  };
  CIRCUIT_OPENED: {
    nodeId: NodeId;
    target: NodeId;
    /** Consecutive failures, or failures in the window in rate mode. */
    failures: number;
    calls?: number;
    /** A failed probe re-opened a half-open circuit. */
    reopened: boolean;
    cooldownMs: number;
  };
  CIRCUIT_HALF_OPENED: { nodeId: NodeId; target: NodeId; openForMs: number };
  CIRCUIT_CLOSED: { nodeId: NodeId; target: NodeId };
  /** Every candidate's circuit was open, so the call failed without being made. */
  CIRCUIT_REJECTED: { nodeId: NodeId; requestId: RequestId; targets: readonly NodeId[] };
}

export function validateReliabilityConfig(
  config: ReliabilityNodeConfig,
  path: string,
  push: IssueReporter,
  _context: SpecValidationContext,
): void {
  const raw = config as Record<string, unknown>;
  checkPositive(raw.callTimeoutMs, `${path}.callTimeoutMs`, push, true);

  if (raw.retry !== undefined) {
    const retry = raw.retry as Record<string, unknown>;
    const at = `${path}.retry`;
    if (typeof retry !== 'object' || retry === null) push(at, 'must be an object');
    else {
      if (retry.maxRetries === undefined) push(`${at}.maxRetries`, 'is required');
      checkInteger(retry.maxRetries, `${at}.maxRetries`, push, 0);
      checkOneOf(retry.backoff, BACKOFF_KINDS, `${at}.backoff`, push);
      checkOneOf(retry.jitter, JITTER_KINDS, `${at}.jitter`, push);
      checkNonNegative(retry.baseDelayMs, `${at}.baseDelayMs`, push);
      checkNonNegative(retry.maxDelayMs, `${at}.maxDelayMs`, push);
      if (retry.multiplier !== undefined && (typeof retry.multiplier !== 'number' || !(retry.multiplier >= 1))) {
        push(`${at}.multiplier`, 'must be a number of at least 1');
      }
      if (retry.retryOn !== undefined) {
        if (!Array.isArray(retry.retryOn)) push(`${at}.retryOn`, 'must be an array of statuses');
        else retry.retryOn.forEach((status, i) => checkOneOf(status, RETRYABLE_STATUSES, `${at}.retryOn[${i}]`, push));
      }
    }
  }

  if (raw.circuitBreaker !== undefined) {
    const breaker = raw.circuitBreaker as Record<string, unknown>;
    const at = `${path}.circuitBreaker`;
    if (typeof breaker !== 'object' || breaker === null) push(at, 'must be an object');
    else {
      if (breaker.failureThreshold === undefined) push(`${at}.failureThreshold`, 'is required');
      checkInteger(breaker.failureThreshold, `${at}.failureThreshold`, push, 1);
      checkPositive(breaker.cooldownMs, `${at}.cooldownMs`, push, false);
      checkInteger(breaker.halfOpenMaxCalls, `${at}.halfOpenMaxCalls`, push, 1);
      checkProbability(breaker.failureRateThreshold, `${at}.failureRateThreshold`, push);
      checkPositive(breaker.windowMs, `${at}.windowMs`, push, true);
      checkInteger(breaker.minimumRequests, `${at}.minimumRequests`, push, 1);
      if (breaker.failureRateThreshold !== undefined && breaker.windowMs === undefined) {
        push(`${at}.windowMs`, 'is required with failureRateThreshold');
      }
    }
  }

  if (raw.bulkheads !== undefined) {
    if (!Array.isArray(raw.bulkheads)) push(`${path}.bulkheads`, 'must be an array');
    else {
      const names = new Set<string>();
      (raw.bulkheads as Record<string, unknown>[]).forEach((bulkhead, i) => {
        const at = `${path}.bulkheads[${i}]`;
        if (typeof bulkhead?.name !== 'string' || bulkhead.name.length === 0) push(`${at}.name`, 'must be a non-empty string');
        else if (names.has(bulkhead.name)) push(`${at}.name`, `duplicate bulkhead "${bulkhead.name}"`);
        else names.add(bulkhead.name);
        if (!Array.isArray(bulkhead?.workloads) || bulkhead.workloads.length === 0) push(`${at}.workloads`, 'must list at least one workload id');
        checkInteger(bulkhead?.maxConcurrent, `${at}.maxConcurrent`, push, 1);
        if (bulkhead?.maxConcurrent === undefined) push(`${at}.maxConcurrent`, 'is required');
        checkInteger(bulkhead?.maxQueue, `${at}.maxQueue`, push, 0);
      });
    }
  }
}
