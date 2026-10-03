/**
 * Message queue, consumer and dead-letter contracts.
 *
 * A producer's request to a queue node is an enqueue: the queue stores it and
 * answers at once (or refuses when full — backpressure). The queue then pushes
 * deliveries to worker consumers, each allowed a limited number unacknowledged
 * at a time. A delivery not acknowledged within the visibility timeout is
 * delivered again, which is how at-least-once delivery — and duplicate
 * processing — arise. An item that keeps failing is dead-lettered.
 */
import type { NodeId, RequestId, TraceId } from '../ids.js';
import type { OperationType } from '../messages.js';
import type { SimTime } from '../time.js';
import {
  checkInteger,
  checkNodeRef,
  checkNonNegative,
  checkPositive,
  checkProbability,
  type IssueReporter,
  type SpecValidationContext,
} from '../validation.js';

export interface QueuePolicy {
  /** Items held (waiting plus in flight) before enqueues are refused. */
  capacity: number;
  /** Deliveries before an item is dead-lettered. Default 5. */
  maxDeliveries?: number;
  /** Unacknowledged this long, a delivery is presumed lost and redelivered. Default 1000ms. */
  visibilityTimeoutMs?: number;
  /** Wait before a failed item becomes deliverable again. Default 0. */
  redeliveryDelayMs?: number;
  /** Another queue node that receives items which exhaust their deliveries. */
  deadLetterQueue?: NodeId;
  /** Survives a crash. Default true. */
  durable?: boolean;
  /** Share of enqueued items that can never be processed. Default 0. */
  poisonRate?: number;
  /** Explicit consumers; by default every linked worker. */
  consumers?: NodeId[];
}

export interface ConsumerPolicy {
  /** Deliveries a worker may hold unacknowledged. Default its concurrency. */
  prefetch?: number;
}

export interface QueueNodeConfig {
  queue?: QueuePolicy;
  consumer?: ConsumerPolicy;
}

export type QueueMessageKind = 'QUEUE_DELIVER' | 'QUEUE_ACK' | 'QUEUE_NACK';

export interface QueueDeliverPayload {
  readonly itemId: string;
  readonly attempt: number;
  readonly enqueuedAt: SimTime;
  readonly operation: OperationType;
  readonly poison: boolean;
  readonly requestId: RequestId;
}

export interface QueueAckPayload {
  readonly itemId: string;
  readonly attempt: number;
  readonly error?: string;
}

export type QueueMessagePayload = QueueDeliverPayload | QueueAckPayload;

export interface QueueEventPayloads {
  QUEUE_MESSAGE: { queueId: NodeId; itemId: string; requestId: RequestId; depth: number; poison: boolean };
  /** Backpressure: the queue was full and refused the item. */
  QUEUE_REJECTED: { queueId: NodeId; requestId: RequestId; held: number; capacity: number };
  QUEUE_DELIVERED: { queueId: NodeId; workerId: NodeId; itemId: string; attempt: number; waitedMs: number; depth: number };
  QUEUE_CONSUMED: { queueId: NodeId; workerId: NodeId; itemId: string; attempts: number; latencyMs: number; depth: number };
  QUEUE_REDELIVERED: {
    queueId: NodeId;
    itemId: string;
    /** The delivery attempt that failed. */
    attempt: number;
    reason: 'nack' | 'visibility_timeout';
    workerId: NodeId;
    error?: string;
  };
  QUEUE_DEAD_LETTERED: { queueId: NodeId; itemId: string; attempts: number; deadLetterQueue?: NodeId; lastError: string };
  /** An item finished processing more than once — at-least-once delivery made visible. */
  DUPLICATE_PROCESSING: { queueId: NodeId; itemId: string; workerId: NodeId; times: number };
  /** A worker started or finished an item. */
  WORKER_PROCESSED: {
    workerId: NodeId;
    queueId: NodeId;
    itemId: string;
    attempt: number;
    outcome: 'ok' | 'error';
    serviceTime: number;
    traceId?: TraceId;
  };
}

export function validateQueueConfig(
  config: QueueNodeConfig,
  path: string,
  push: IssueReporter,
  context: SpecValidationContext,
): void {
  const raw = config as Record<string, unknown>;
  if (raw.queue !== undefined) {
    const queue = raw.queue as Record<string, unknown>;
    const at = `${path}.queue`;
    if (typeof queue !== 'object' || queue === null) {
      push(at, 'must be an object');
    } else {
      if (context.self && context.self.type !== 'queue') push(at, 'only queue nodes have queue settings');
      checkInteger(queue.capacity, `${at}.capacity`, push, 1);
      if (queue.capacity === undefined) push(`${at}.capacity`, 'is required');
      checkInteger(queue.maxDeliveries, `${at}.maxDeliveries`, push, 1);
      checkPositive(queue.visibilityTimeoutMs, `${at}.visibilityTimeoutMs`, push, true);
      checkNonNegative(queue.redeliveryDelayMs, `${at}.redeliveryDelayMs`, push);
      checkProbability(queue.poisonRate, `${at}.poisonRate`, push);
      checkNodeRef(queue.deadLetterQueue, `${at}.deadLetterQueue`, push, context, ['queue']);
      if (queue.deadLetterQueue !== undefined && queue.deadLetterQueue === context.self?.id) {
        push(`${at}.deadLetterQueue`, 'a queue cannot be its own dead-letter queue');
      }
      if (queue.consumers !== undefined) {
        if (!Array.isArray(queue.consumers)) push(`${at}.consumers`, 'must be an array of worker ids');
        else queue.consumers.forEach((id, i) => checkNodeRef(id, `${at}.consumers[${i}]`, push, context, ['worker']));
      }
    }
  }
  if (raw.consumer !== undefined) {
    const consumer = raw.consumer as Record<string, unknown>;
    if (typeof consumer !== 'object' || consumer === null) push(`${path}.consumer`, 'must be an object');
    else checkInteger(consumer.prefetch, `${path}.consumer.prefetch`, push, 1);
  }
}
