import { afterFailure, nextConsumer } from '@distlab/algorithms';
import {
  sampleLatency,
  type EventId,
  type Message,
  type NodeId,
  type OperationType,
  type QueueAckPayload,
  type QueueDeliverPayload,
  type RequestBody,
  type RequestId,
  type RequestMessage,
  type SimEvent,
  type SimNode,
  type TraceId,
} from '@distlab/shared';
import type { ModuleServices, SimModule } from './types.js';

const MODULE = 'queue';
const DEFAULT_MAX_DELIVERIES = 5;
const DEFAULT_VISIBILITY_MS = 1000;

interface Item {
  readonly itemId: string;
  readonly requestId: RequestId;
  readonly traceId: TraceId | undefined;
  readonly enqueuedAt: number;
  readonly operation: OperationType;
  readonly poison: boolean;
  attempts: number;
  lastError: string | undefined;
}

interface Delivery {
  readonly itemId: string;
  readonly attempt: number;
  readonly workerId: NodeId;
  readonly deliveredAt: number;
  readonly timer: EventId;
}

interface QueueState {
  counter: number;
  /** Every item held — waiting, in flight, or waiting out a redelivery delay. Insertion order is enqueue order. */
  items: Map<string, Item>;
  /** Deliverable now, FIFO. */
  ready: string[];
  /** `${itemId}@${attempt}` -> delivery. */
  deliveries: Map<string, Delivery>;
  /** Item -> the delivery that counts; any other delivery of it is stale. */
  current: Map<string, string>;
  workerInFlight: Map<NodeId, number>;
  lastConsumer: NodeId | undefined;
  /** Dead-lettered with nowhere to go. */
  deadList: string[];
}

interface Processing {
  readonly queueId: NodeId;
  readonly itemId: string;
  readonly attempt: number;
  readonly startedAt: number;
  readonly traceId: TraceId | undefined;
}

interface WorkerState {
  processing: Map<string, Processing>;
  /** Deliveries received while every worker slot was busy. In memory only. */
  backlog: { queueId: NodeId; delivery: QueueDeliverPayload; traceId: TraceId | undefined }[];
}

interface QueueModuleState {
  readonly queues: readonly (readonly [NodeId, {
    counter: number;
    items: Item[];
    ready: string[];
    deliveries: Delivery[];
    current: (readonly [string, string])[];
    workerInFlight: (readonly [NodeId, number])[];
    lastConsumer: NodeId | undefined;
    deadList: string[];
  }])[];
  readonly workers: readonly (readonly [NodeId, {
    processing: (readonly [string, Processing])[];
    backlog: WorkerState['backlog'];
  }])[];
  readonly completions: readonly (readonly [string, number])[];
}

/**
 * Message queues and their consumers.
 *
 * A request reaching a queue node is an enqueue: stored and acknowledged at
 * once, or refused when the queue is full — backpressure the producer can see.
 * The queue pushes deliveries to linked workers, each holding at most its
 * prefetch unacknowledged, and waits for an ack. A delivery not acknowledged
 * within the visibility timeout is presumed lost and delivered again — so a
 * worker that finished but whose ack was lost, or that was merely slow, means
 * the item is processed twice. That is at-least-once delivery, and the module
 * reports every duplicate it causes. Items that keep failing are dead-lettered.
 */
export function createQueueModule(services: ModuleServices): SimModule {
  let queues = new Map<NodeId, QueueState>();
  let workers = new Map<NodeId, WorkerState>();
  /** `${queueId}|${itemId}` -> successful completions, for measuring duplicates. */
  let completions = new Map<string, number>();

  const now = () => services.context.now();

  const queueOf = (id: NodeId): QueueState => {
    let state = queues.get(id);
    if (!state) {
      state = {
        counter: 0,
        items: new Map(),
        ready: [],
        deliveries: new Map(),
        current: new Map(),
        workerInFlight: new Map(),
        lastConsumer: undefined,
        deadList: [],
      };
      queues.set(id, state);
    }
    return state;
  };

  const workerOf = (id: NodeId): WorkerState => {
    let state = workers.get(id);
    if (!state) {
      state = { processing: new Map(), backlog: [] };
      workers.set(id, state);
    }
    return state;
  };

  /** Configured consumers, or every worker linked to the queue in either direction. */
  const consumersOf = (queue: SimNode): NodeId[] => {
    const explicit = queue.config.queue?.consumers;
    if (explicit) return [...explicit].sort();
    return services.network.topology
      .neighboursOf(queue.id)
      .filter((id) => services.registry.get(id)?.type === 'worker')
      .sort();
  };

  const syncQueueState = (queue: SimNode, state: QueueState) => {
    queue.state.queueDepth = state.ready.length;
    queue.state.inFlight = state.deliveries.size;
  };

  const dispatch = (queue: SimNode, causedBy?: EventId) => {
    if (queue.state.status === 'failed') return;
    const state = queueOf(queue.id);
    const reachable = new Set(services.network.topology.downstreamOf(queue.id));
    const consumers = consumersOf(queue);
    while (state.ready.length > 0) {
      const slots = consumers.map((id) => {
        const worker = services.registry.get(id);
        return {
          id,
          inFlight: state.workerInFlight.get(id) ?? 0,
          prefetch: worker?.config.consumer?.prefetch ?? worker?.config.concurrency ?? 1,
          available: worker !== undefined && worker.state.status !== 'failed' && reachable.has(id),
        };
      });
      const workerId = nextConsumer(slots, state.lastConsumer);
      if (workerId === undefined) break;
      state.lastConsumer = workerId;
      const itemId = state.ready.shift()!;
      const item = state.items.get(itemId);
      if (!item) continue;
      item.attempts += 1;
      const key = `${itemId}@${item.attempts}`;
      const timer = services.setTimer(
        queue.id,
        MODULE,
        'visibility',
        queue.config.queue?.visibilityTimeoutMs ?? DEFAULT_VISIBILITY_MS,
        { itemId, attempt: item.attempts },
        causedBy,
      );
      state.deliveries.set(key, { itemId, attempt: item.attempts, workerId, deliveredAt: now(), timer });
      state.current.set(itemId, key);
      state.workerInFlight.set(workerId, (state.workerInFlight.get(workerId) ?? 0) + 1);
      const payload: QueueDeliverPayload = {
        itemId,
        attempt: item.attempts,
        enqueuedAt: item.enqueuedAt,
        operation: item.operation,
        poison: item.poison,
        requestId: item.requestId,
      };
      services.emit(
        'QUEUE_DELIVERED',
        { queueId: queue.id, workerId, itemId, attempt: item.attempts, waitedMs: now() - item.enqueuedAt, depth: state.ready.length },
        { nodeId: queue.id, ...(item.traceId !== undefined ? { traceId: item.traceId } : {}), ...(causedBy !== undefined ? { causedBy } : {}) },
      );
      services.send({
        kind: 'QUEUE_DELIVER',
        source: queue.id,
        destination: workerId,
        type: item.operation,
        payload,
        sizeBytes: 512,
        hop: 0,
        ...(item.traceId !== undefined ? { traceId: item.traceId } : {}),
        ...(causedBy !== undefined ? { causedBy } : {}),
      });
    }
    syncQueueState(queue, state);
  };

  const enqueue = (queue: SimNode, request: RequestMessage, event: SimEvent<'MESSAGE_RECEIVED'>) => {
    const state = queueOf(queue.id);
    const policy = queue.config.queue;
    const capacity = policy?.capacity ?? queue.config.queueCapacity;
    if (state.items.size >= capacity) {
      queue.state.rejected += 1;
      services.emit(
        'QUEUE_REJECTED',
        { queueId: queue.id, requestId: request.requestId, held: state.items.size, capacity },
        { nodeId: queue.id, traceId: request.traceId, causedBy: event.id },
      );
      services.reply(queue, request, 'rejected', undefined, event.id);
      return;
    }
    state.counter += 1;
    const itemId = `${queue.id}#${state.counter}`;
    const poison = services.rng(MODULE, queue.id).bool(policy?.poisonRate ?? 0);
    state.items.set(itemId, {
      itemId,
      requestId: request.requestId,
      traceId: request.traceId,
      enqueuedAt: now(),
      operation: request.payload.operation,
      poison,
      attempts: 0,
      lastError: undefined,
    });
    state.ready.push(itemId);
    queue.state.processed += 1;
    services.emit(
      'QUEUE_MESSAGE',
      { queueId: queue.id, itemId, requestId: request.requestId, depth: state.ready.length, poison },
      { nodeId: queue.id, traceId: request.traceId, causedBy: event.id },
    );
    services.reply(queue, request, 'ok', undefined, event.id);
    dispatch(queue, event.id);
  };

  const failItem = (queue: SimNode, item: Item, causedBy: EventId) => {
    const state = queueOf(queue.id);
    const policy = queue.config.queue;
    if (afterFailure(item.attempts, policy?.maxDeliveries ?? DEFAULT_MAX_DELIVERIES) === 'dead_letter') {
      state.items.delete(item.itemId);
      const dlq = policy?.deadLetterQueue;
      services.emit(
        'QUEUE_DEAD_LETTERED',
        {
          queueId: queue.id,
          itemId: item.itemId,
          attempts: item.attempts,
          ...(dlq !== undefined ? { deadLetterQueue: dlq } : {}),
          lastError: item.lastError ?? 'unknown',
        },
        { nodeId: queue.id, ...(item.traceId !== undefined ? { traceId: item.traceId } : {}), causedBy },
      );
      if (dlq !== undefined && item.traceId !== undefined) {
        const body: RequestBody = { operation: 'ENQUEUE', path: [queue.id], deadlineAt: now() + 60_000 };
        services.send({
          kind: 'REQUEST',
          source: queue.id,
          destination: dlq,
          type: 'ENQUEUE',
          payload: body,
          sizeBytes: 512,
          requestId: item.requestId,
          traceId: item.traceId,
          spanId: services.context.ids.span(),
          hop: 0,
          causedBy,
        });
      } else {
        state.deadList.push(item.itemId);
      }
      return;
    }
    const delay = policy?.redeliveryDelayMs ?? 0;
    if (delay > 0) services.setTimer(queue.id, MODULE, 'requeue', delay, { itemId: item.itemId }, causedBy);
    else state.ready.push(item.itemId);
  };

  /** A delivery ended — acknowledged, refused, or presumed lost. */
  const settleDelivery = (
    queue: SimNode,
    itemId: string,
    attempt: number,
    outcome: { kind: 'ack' } | { kind: 'nack'; error: string } | { kind: 'timeout' },
    causedBy: EventId,
  ) => {
    const state = queueOf(queue.id);
    const key = `${itemId}@${attempt}`;
    const delivery = state.deliveries.get(key);
    if (!delivery) return dispatch(queue, causedBy);
    state.deliveries.delete(key);
    if (outcome.kind !== 'timeout') services.cancelTimer(delivery.timer);
    state.workerInFlight.set(delivery.workerId, Math.max(0, (state.workerInFlight.get(delivery.workerId) ?? 0) - 1));

    // A stale delivery: the item was already redelivered (or consumed). The
    // worker's slot is freed, and nothing else changes.
    if (state.current.get(itemId) !== key) return dispatch(queue, causedBy);
    state.current.delete(itemId);
    const item = state.items.get(itemId);
    if (!item) return dispatch(queue, causedBy);

    if (outcome.kind === 'ack') {
      state.items.delete(itemId);
      services.emit(
        'QUEUE_CONSUMED',
        { queueId: queue.id, workerId: delivery.workerId, itemId, attempts: item.attempts, latencyMs: now() - item.enqueuedAt, depth: state.ready.length },
        { nodeId: queue.id, ...(item.traceId !== undefined ? { traceId: item.traceId } : {}), causedBy },
      );
    } else {
      if (outcome.kind === 'nack') item.lastError = outcome.error;
      else item.lastError = item.lastError ?? 'no acknowledgement within the visibility timeout';
      services.emit(
        'QUEUE_REDELIVERED',
        {
          queueId: queue.id,
          itemId,
          attempt,
          reason: outcome.kind === 'nack' ? 'nack' : 'visibility_timeout',
          workerId: delivery.workerId,
          ...(outcome.kind === 'nack' ? { error: outcome.error } : {}),
        },
        { nodeId: queue.id, ...(item.traceId !== undefined ? { traceId: item.traceId } : {}), causedBy },
      );
      failItem(queue, item, causedBy);
    }
    dispatch(queue, causedBy);
  };

  // --- workers ------------------------------------------------------------

  const startWork = (worker: SimNode, queueId: NodeId, delivery: QueueDeliverPayload, traceId: TraceId | undefined, causedBy: EventId) => {
    const state = workerOf(worker.id);
    const rng = services.rng(MODULE, worker.id);
    const serviceTime = sampleLatency(worker.config.processing, rng) * worker.state.slowdown;
    const failed = delivery.poison || rng.bool(worker.config.failureProbability);
    state.processing.set(`${queueId}|${delivery.itemId}@${delivery.attempt}`, {
      queueId,
      itemId: delivery.itemId,
      attempt: delivery.attempt,
      startedAt: now(),
      traceId,
    });
    worker.state.inFlight = state.processing.size;
    services.setTimer(
      worker.id,
      MODULE,
      'process',
      serviceTime,
      { queue: queueId, itemId: delivery.itemId, attempt: delivery.attempt, outcome: failed ? 'error' : 'ok', poison: delivery.poison, serviceTime },
      causedBy,
    );
  };

  const onDeliver = (worker: SimNode, message: Message, event: SimEvent<'MESSAGE_RECEIVED'>) => {
    const delivery = message.payload as QueueDeliverPayload;
    const state = workerOf(worker.id);
    if (state.processing.size < worker.config.concurrency) {
      startWork(worker, message.source, delivery, message.traceId, event.id);
    } else {
      state.backlog.push({ queueId: message.source, delivery, traceId: message.traceId });
      worker.state.queueDepth = state.backlog.length;
    }
  };

  const finishWork = (worker: SimNode, event: SimEvent<'TIMER'>) => {
    const data = event.payload.data!;
    const queueId = String(data.queue);
    const itemId = String(data.itemId);
    const attempt = Number(data.attempt);
    const state = workerOf(worker.id);
    const key = `${queueId}|${itemId}@${attempt}`;
    const entry = state.processing.get(key);
    if (!entry) return;
    state.processing.delete(key);
    worker.state.busyTime += now() - entry.startedAt;
    worker.state.inFlight = state.processing.size;
    const ok = data.outcome === 'ok';
    const meta = { nodeId: worker.id, ...(entry.traceId !== undefined ? { traceId: entry.traceId } : {}), causedBy: event.id };

    services.emit(
      'WORKER_PROCESSED',
      {
        workerId: worker.id,
        queueId,
        itemId,
        attempt,
        outcome: ok ? 'ok' : 'error',
        serviceTime: Number(data.serviceTime),
        ...(entry.traceId !== undefined ? { traceId: entry.traceId } : {}),
      },
      meta,
    );
    if (ok) {
      worker.state.processed += 1;
      const completed = (completions.get(`${queueId}|${itemId}`) ?? 0) + 1;
      completions.set(`${queueId}|${itemId}`, completed);
      if (completed > 1) services.emit('DUPLICATE_PROCESSING', { queueId, itemId, workerId: worker.id, times: completed }, meta);
    } else {
      worker.state.failed += 1;
    }
    const ack: QueueAckPayload = {
      itemId,
      attempt,
      ...(ok ? {} : { error: data.poison ? 'poison message' : 'processing failed' }),
    };
    services.send({
      kind: ok ? 'QUEUE_ACK' : 'QUEUE_NACK',
      source: worker.id,
      destination: queueId,
      type: 'ACK',
      payload: ack,
      sizeBytes: 64,
      hop: 0,
      ...(entry.traceId !== undefined ? { traceId: entry.traceId } : {}),
      causedBy: event.id,
    });

    while (state.backlog.length > 0 && state.processing.size < worker.config.concurrency) {
      const next = state.backlog.shift()!;
      startWork(worker, next.queueId, next.delivery, next.traceId, event.id);
    }
    worker.state.queueDepth = state.backlog.length;
  };

  return {
    name: MODULE,
    messageKinds: ['QUEUE_DELIVER', 'QUEUE_ACK', 'QUEUE_NACK'],
    servesNodeTypes: ['queue'],

    attach() {},

    onMessage(node, message, event) {
      switch (message.kind) {
        case 'REQUEST':
          if (node.type === 'queue') enqueue(node, message as RequestMessage, event);
          return;
        case 'RESPONSE':
          // An answer from a dead-letter queue we forwarded to: nothing to do.
          return;
        case 'QUEUE_DELIVER':
          if (node.type === 'worker') onDeliver(node, message, event);
          return;
        case 'QUEUE_ACK':
        case 'QUEUE_NACK': {
          if (node.type !== 'queue') return;
          const ack = message.payload as QueueAckPayload;
          settleDelivery(
            node,
            ack.itemId,
            ack.attempt,
            message.kind === 'QUEUE_ACK' ? { kind: 'ack' } : { kind: 'nack', error: ack.error ?? 'processing failed' },
            event.id,
          );
          return;
        }
        default:
          return;
      }
    },

    onTimer(node, event) {
      const data = event.payload.data ?? {};
      switch (event.payload.name) {
        case 'visibility':
          settleDelivery(node, String(data.itemId), Number(data.attempt), { kind: 'timeout' }, event.id);
          return;
        case 'requeue': {
          const state = queueOf(node.id);
          if (state.items.has(String(data.itemId))) state.ready.push(String(data.itemId));
          dispatch(node, event.id);
          return;
        }
        case 'process':
          finishWork(node, event);
          return;
      }
    },

    onNodeFailed(node) {
      if (node.type === 'worker') {
        // Work in progress dies with the process; the queue redelivers it when
        // the visibility timeouts expire.
        workers.delete(node.id);
        return;
      }
      if (node.type === 'queue') {
        const state = queues.get(node.id);
        if (!state) return;
        if (node.config.queue?.durable === false) {
          queues.delete(node.id);
          return;
        }
        // Durable: items survive on disk; in-memory delivery tracking does not.
        state.deliveries.clear();
        state.current.clear();
        state.workerInFlight.clear();
      }
    },

    onNodeRecovered(node, event) {
      if (node.type !== 'queue') return;
      const state = queues.get(node.id);
      if (!state) return;
      // Everything not acknowledged before the crash becomes deliverable again,
      // in the order it was enqueued.
      state.ready = [...state.items.keys()];
      dispatch(node, event.id);
    },

    captureState(): QueueModuleState {
      return {
        queues: [...queues.entries()].map(([id, q]) => [
          id,
          {
            counter: q.counter,
            items: [...q.items.values()].map((item) => ({ ...item })),
            ready: [...q.ready],
            deliveries: [...q.deliveries.values()].map((d) => ({ ...d })),
            current: [...q.current.entries()],
            workerInFlight: [...q.workerInFlight.entries()],
            lastConsumer: q.lastConsumer,
            deadList: [...q.deadList],
          },
        ]),
        workers: [...workers.entries()].map(([id, w]) => [
          id,
          {
            processing: [...w.processing.entries()].map(([k, p]) => [k, { ...p }] as const),
            backlog: w.backlog.map((b) => ({ ...b, delivery: { ...b.delivery } })),
          },
        ]),
        completions: [...completions.entries()],
      };
    },

    restoreState(raw: unknown) {
      const state = raw as QueueModuleState;
      queues = new Map(
        (state.queues ?? []).map(([id, q]) => [
          id,
          {
            counter: q.counter,
            items: new Map(q.items.map((item) => [item.itemId, { ...item }])),
            ready: [...q.ready],
            deliveries: new Map(q.deliveries.map((d) => [`${d.itemId}@${d.attempt}`, { ...d }])),
            current: new Map(q.current),
            workerInFlight: new Map(q.workerInFlight),
            lastConsumer: q.lastConsumer,
            deadList: [...q.deadList],
          },
        ]),
      );
      workers = new Map(
        (state.workers ?? []).map(([id, w]) => [
          id,
          {
            processing: new Map(w.processing.map(([k, p]) => [k, { ...p }])),
            backlog: w.backlog.map((b) => ({ ...b, delivery: { ...b.delivery } })),
          },
        ]),
      );
      completions = new Map(state.completions ?? []);
    },
  };
}
