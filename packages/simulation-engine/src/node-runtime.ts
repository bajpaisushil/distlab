import {
  isWriteOperation,
  sampleLatency,
  type EventId,
  type EventType,
  type LatencySpec,
  type NodeId,
  type OperationType,
  type RequestBody,
  type RequestFailureReason,
  type RequestId,
  type RequestMessage,
  type ResponseBody,
  type ResponseMessage,
  type ResponseStatus,
  type SimEvent,
  type SimNode,
  type SimTime,
  type SimulationContext,
  type SpanId,
  type TraceId,
  type WorkloadId,
} from '@distlab/shared';
import type { SimulatedNetwork } from '@distlab/network';
import type { NodeRegistry } from './node-registry.js';
import { firstAvailable, type DownstreamSelector } from './routing.js';

/** One inbound request being handled by one node. */
interface WorkItem {
  /** The node's server-side span, equal to the inbound message's span id. */
  readonly spanId: SpanId;
  readonly inbound: RequestMessage;
  readonly arrivedAt: SimTime;
  /** When it took a concurrency slot; -1 while still queued. */
  startedAt: SimTime;
  timeoutEventId: EventId;
  outboundSpan: SpanId | undefined;
  state: 'queued' | 'processing' | 'awaiting_downstream';
}

/** A request the client originated and is still waiting on. */
interface OriginRecord {
  readonly requestId: RequestId;
  readonly traceId: TraceId;
  readonly clientId: NodeId;
  readonly startedAt: SimTime;
  timeoutEventId: EventId;
  settled: boolean;
}

class NodeWorker {
  /** Admitted but not yet given a slot, FIFO. */
  readonly waiting: WorkItem[] = [];
  /** Inbound span -> work. */
  readonly work = new Map<SpanId, WorkItem>();
  /** Outbound span -> the inbound span waiting on it. */
  readonly outbound = new Map<SpanId, SpanId>();
}

export interface BeginRequestParams {
  readonly clientId: NodeId;
  readonly workloadId: WorkloadId;
  readonly operation: OperationType;
  readonly sizeBytes: number;
  readonly deadlineMs: number;
}

export interface NodeRuntimeOptions {
  readonly context: SimulationContext;
  readonly registry: NodeRegistry;
  readonly network: SimulatedNetwork;
  readonly selector?: DownstreamSelector;
}

type Registrar = <T extends EventType>(type: T, handler: (event: SimEvent<T>) => void) => unknown;

/**
 * Turns messages into work and work into messages.
 *
 * The model is a bounded worker pool per node: a request occupies a slot from
 * the moment it is admitted until the moment the node answers, *including* the
 * time it spends waiting on a downstream call. That is what makes thread-pool
 * exhaustion and backpressure emerge on their own instead of having to be
 * special-cased — a slow database really does consume the API tier's capacity.
 *
 * Nodes never invoke each other. Every hop goes through `SimulatedNetwork`,
 * and every state change here is the result of a dequeued event.
 */
export class NodeRuntime {
  private readonly context: SimulationContext;
  private readonly registry: NodeRegistry;
  private readonly network: SimulatedNetwork;
  private readonly selector: DownstreamSelector;
  private readonly workers = new Map<NodeId, NodeWorker>();
  /** Client-side outbound span -> the request it represents. */
  private readonly origins = new Map<SpanId, OriginRecord>();

  constructor(options: NodeRuntimeOptions) {
    this.context = options.context;
    this.registry = options.registry;
    this.network = options.network;
    this.selector = options.selector ?? firstAvailable;
  }

  attach(on: Registrar): void {
    on('MESSAGE_RECEIVED', (event) => this.onMessageReceived(event));
    on('REQUEST_PROCESSING_COMPLETED', (event) => this.onProcessingCompleted(event));
    on('TIMEOUT', (event) => this.onTimeout(event));
    on('NODE_FAILED', (event) => this.onNodeFailed(event));
    on('NODE_RECOVERED', (event) => this.onNodeRecovered(event));
  }

  /** Creates a request at a client and sends it to its first hop. */
  beginRequest(params: BeginRequestParams, causedBy?: EventId): RequestId | undefined {
    const client = this.registry.get(params.clientId);
    if (!client || client.state.status === 'failed') return undefined;

    const requestId = this.context.ids.request();
    const traceId = this.context.ids.trace();
    const rootSpan = this.context.ids.span();
    const now = this.context.now();
    const deadlineAt = now + params.deadlineMs;

    this.emit(
      'REQUEST_CREATED',
      {
        requestId,
        traceId,
        clientId: client.id,
        operation: params.operation,
        workloadId: params.workloadId,
        spanId: rootSpan,
      },
      { nodeId: client.id, traceId, causedBy },
    );

    const body: RequestBody = {
      operation: params.operation,
      workloadId: params.workloadId,
      path: [client.id],
      deadlineAt,
    };
    const route = this.route(client, body);
    if (route.kind !== 'forward') {
      this.emit(
        'REQUEST_FAILED',
        {
          requestId,
          traceId,
          clientId: client.id,
          latency: 0,
          status: 'unreachable',
          reason: route.kind === 'terminal' ? 'no_route' : 'unreachable',
        },
        { nodeId: client.id, traceId, causedBy },
      );
      return requestId;
    }

    const target = route.target;
    const outboundSpan = this.context.ids.span();
    const timeoutEventId = this.scheduleTimeout(client.id, requestId, outboundSpan, deadlineAt, target.id);
    this.origins.set(outboundSpan, {
      requestId,
      traceId,
      clientId: client.id,
      startedAt: now,
      timeoutEventId,
      settled: false,
    });

    this.emit(
      'REQUEST_ROUTED',
      { requestId, from: client.id, to: target.id, hop: 0, strategy: this.selector.name },
      { nodeId: client.id, traceId, causedBy },
    );

    this.network.send({
      kind: 'REQUEST',
      source: client.id,
      destination: target.id,
      type: params.operation,
      payload: body,
      sizeBytes: params.sizeBytes,
      requestId,
      traceId,
      spanId: outboundSpan,
      parentSpanId: rootSpan,
      hop: 0,
      ...(causedBy !== undefined ? { causedBy } : {}),
    });
    return requestId;
  }

  // --- message handling ---------------------------------------------------

  private onMessageReceived(event: SimEvent<'MESSAGE_RECEIVED'>): void {
    const message = event.payload.message;
    const node = this.registry.get(message.destination);
    if (!node) return;

    if (node.state.status === 'failed') {
      // The host crashed while the message was in flight. It arrives and is
      // refused; nobody is told, which is exactly why deadlines exist.
      this.emit(
        'MESSAGE_DROPPED',
        {
          messageId: message.id,
          requestId: message.requestId,
          source: message.source,
          destination: message.destination,
          reason: 'destination_failed',
        },
        { nodeId: node.id, traceId: message.traceId, causedBy: event.id },
      );
      return;
    }

    if (message.kind === 'RESPONSE') {
      this.onResponse(node, message as ResponseMessage, event.id);
    } else {
      this.onRequest(node, message as RequestMessage, event.id);
    }
  }

  private onRequest(node: SimNode, message: RequestMessage, causedBy: EventId): void {
    // A client is a traffic source, not a server; inbound requests there mean
    // the topology is wired backwards.
    if (node.type === 'client') return;

    const worker = this.workerFor(node.id);
    const body = message.payload;
    const item: WorkItem = {
      spanId: message.spanId,
      inbound: message,
      arrivedAt: this.context.now(),
      startedAt: -1,
      timeoutEventId: this.scheduleTimeout(node.id, message.requestId, message.spanId, body.deadlineAt),
      outboundSpan: undefined,
      state: 'queued',
    };
    worker.work.set(item.spanId, item);

    if (node.state.inFlight < node.config.concurrency) {
      this.startProcessing(node, item, causedBy);
      return;
    }

    if (node.state.queueDepth < node.config.queueCapacity) {
      worker.waiting.push(item);
      node.state.queueDepth += 1;
      this.emit(
        'REQUEST_QUEUED',
        { requestId: message.requestId, nodeId: node.id, queueDepth: node.state.queueDepth },
        { nodeId: node.id, traceId: message.traceId, causedBy },
      );
      return;
    }

    // Saturated: shed load rather than growing an unbounded backlog.
    node.state.rejected += 1;
    this.emit(
      'REQUEST_REJECTED',
      {
        requestId: message.requestId,
        nodeId: node.id,
        reason: 'queue_full',
        queueDepth: node.state.queueDepth,
      },
      { nodeId: node.id, traceId: message.traceId, causedBy },
    );
    this.respond(node, item, 'rejected', body.path, causedBy);
    this.release(node, worker, item);
  }

  private startProcessing(node: SimNode, item: WorkItem, causedBy: EventId): void {
    const rng = this.context.stream(`node:${node.id}`);
    const operation = item.inbound.payload.operation;
    const serviceTime = sampleLatency(this.latencyFor(node, operation), rng);
    // Drawn now rather than at completion so the scheduled event carries the
    // real outcome; a crash during processing is handled separately.
    const outcome = rng.bool(node.config.failureProbability) ? 'error' : 'ok';

    item.state = 'processing';
    item.startedAt = this.context.now();
    node.state.inFlight += 1;

    this.emit(
      'REQUEST_PROCESSING_STARTED',
      { requestId: item.inbound.requestId, nodeId: node.id, spanId: item.spanId, serviceTime },
      { nodeId: node.id, traceId: item.inbound.traceId, causedBy },
    );
    this.context.schedule(
      {
        type: 'REQUEST_PROCESSING_COMPLETED',
        payload: {
          requestId: item.inbound.requestId,
          nodeId: node.id,
          spanId: item.spanId,
          serviceTime,
          outcome,
        },
        nodeId: node.id,
        traceId: item.inbound.traceId,
        causedBy,
      },
      serviceTime,
    );
  }

  private onProcessingCompleted(event: SimEvent<'REQUEST_PROCESSING_COMPLETED'>): void {
    const { nodeId, spanId, outcome, serviceTime, requestId } = event.payload;
    const node = this.registry.get(nodeId);
    if (!node) return;
    const worker = this.workerFor(nodeId);
    const item = worker.work.get(spanId);
    if (!item || item.state !== 'processing') return; // already timed out or abandoned

    const body = item.inbound.payload;

    if (node.state.status === 'failed') {
      // Crashed mid-request: the work is simply lost, and no reply is sent.
      this.release(node, worker, item);
      return;
    }

    if (node.type === 'database' || node.type === 'replica') {
      this.emit(
        isWriteOperation(body.operation) ? 'DB_WRITE' : 'DB_READ',
        { nodeId: node.id, requestId, latency: serviceTime },
        { nodeId: node.id, traceId: item.inbound.traceId, causedBy: event.id },
      );
    }

    if (outcome === 'error') {
      node.state.failed += 1;
      this.respond(node, item, 'error', body.path, event.id);
      this.release(node, worker, item);
      return;
    }

    const route = this.route(node, body);
    if (route.kind === 'terminal') {
      // Nothing is wired downstream: this node is where the request is served.
      node.state.processed += 1;
      this.respond(node, item, 'ok', body.path, event.id);
      this.release(node, worker, item);
      return;
    }
    if (route.kind === 'unreachable') {
      // There *is* a downstream tier, but none of it can be reached right now.
      // Answering 'ok' here would quietly paper over an outage.
      node.state.failed += 1;
      this.respond(node, item, 'unreachable', body.path, event.id);
      this.release(node, worker, item);
      return;
    }
    const target = route.target;

    const outboundSpan = this.context.ids.span();
    item.outboundSpan = outboundSpan;
    item.state = 'awaiting_downstream';
    worker.outbound.set(outboundSpan, item.spanId);

    this.emit(
      'REQUEST_ROUTED',
      {
        requestId,
        from: node.id,
        to: target.id,
        hop: item.inbound.hop + 1,
        strategy: this.selector.name,
      },
      { nodeId: node.id, traceId: item.inbound.traceId, causedBy: event.id },
    );

    this.network.send({
      kind: 'REQUEST',
      source: node.id,
      destination: target.id,
      type: body.operation,
      payload: { ...body, path: [...body.path, node.id] },
      sizeBytes: item.inbound.sizeBytes,
      requestId,
      traceId: item.inbound.traceId,
      spanId: outboundSpan,
      parentSpanId: item.spanId,
      hop: item.inbound.hop + 1,
      causedBy: event.id,
    });
  }

  private onResponse(node: SimNode, message: ResponseMessage, causedBy: EventId): void {
    if (node.type === 'client') {
      this.settleOrigin(node, message, causedBy);
      return;
    }

    const worker = this.workerFor(node.id);
    const inboundSpan = worker.outbound.get(message.spanId);
    // No record means a duplicate or late reply to work already settled.
    if (inboundSpan === undefined) return;
    worker.outbound.delete(message.spanId);

    const item = worker.work.get(inboundSpan);
    if (!item) return;

    if (message.payload.status === 'ok') node.state.processed += 1;
    else node.state.failed += 1;

    this.respond(node, item, message.payload.status, message.payload.path, causedBy);
    this.release(node, worker, item);
  }

  private settleOrigin(client: SimNode, message: ResponseMessage, causedBy: EventId): void {
    const origin = this.origins.get(message.spanId);
    if (!origin || origin.settled) return; // duplicate delivery of an answered request
    origin.settled = true;
    this.origins.delete(message.spanId);
    this.context.cancel(origin.timeoutEventId);

    const latency = this.context.now() - origin.startedAt;
    const path = message.payload.path;

    if (message.payload.status === 'ok') {
      client.state.processed += 1;
      this.emit(
        'REQUEST_COMPLETED',
        {
          requestId: origin.requestId,
          traceId: origin.traceId,
          clientId: client.id,
          latency,
          hops: Math.max(0, path.length - 1),
          path,
        },
        { nodeId: client.id, traceId: origin.traceId, causedBy },
      );
      return;
    }

    client.state.failed += 1;
    this.emit(
      'REQUEST_FAILED',
      {
        requestId: origin.requestId,
        traceId: origin.traceId,
        clientId: client.id,
        latency,
        status: message.payload.status,
        reason: failureReasonFor(message.payload.status),
        failedAt: message.payload.servedBy,
      },
      { nodeId: client.id, traceId: origin.traceId, causedBy },
    );
  }

  // --- timeouts and node lifecycle ---------------------------------------

  private onTimeout(event: SimEvent<'TIMEOUT'>): void {
    const { nodeId, spanId } = event.payload;
    const origin = this.origins.get(spanId);
    if (origin && !origin.settled) {
      origin.settled = true;
      this.origins.delete(spanId);
      const client = this.registry.get(origin.clientId);
      if (client) client.state.failed += 1;
      this.emit(
        'REQUEST_FAILED',
        {
          requestId: origin.requestId,
          traceId: origin.traceId,
          clientId: origin.clientId,
          latency: this.context.now() - origin.startedAt,
          status: 'timeout',
          reason: 'timeout',
        },
        { nodeId: origin.clientId, traceId: origin.traceId, causedBy: event.id },
      );
      return;
    }

    // An intermediate hop giving up. It stays silent: the caller holds the same
    // deadline and is abandoning the request at this very instant too.
    const node = this.registry.get(nodeId);
    if (!node) return;
    const worker = this.workerFor(nodeId);
    const item = worker.work.get(spanId);
    if (!item) return;
    node.state.failed += 1;
    this.release(node, worker, item);
  }

  private onNodeFailed(event: SimEvent<'NODE_FAILED'>): void {
    const node = this.registry.get(event.payload.nodeId);
    if (!node || node.state.status === 'failed') return;
    this.registry.setStatus(node.id, 'failed', this.context.now());

    // Everything in memory is lost with the process. Slots and queues reset.
    const worker = this.workerFor(node.id);
    for (const item of worker.work.values()) this.context.cancel(item.timeoutEventId);
    worker.work.clear();
    worker.outbound.clear();
    worker.waiting.length = 0;
    node.state.inFlight = 0;
    node.state.queueDepth = 0;
  }

  private onNodeRecovered(event: SimEvent<'NODE_RECOVERED'>): void {
    const node = this.registry.get(event.payload.nodeId);
    if (!node) return;
    this.registry.setStatus(node.id, 'healthy', this.context.now());
  }

  // --- helpers ------------------------------------------------------------

  private respond(
    node: SimNode,
    item: WorkItem,
    status: ResponseStatus,
    path: readonly NodeId[],
    causedBy: EventId,
  ): void {
    const payload: ResponseBody = {
      status,
      servedBy: node.id,
      path: path.includes(node.id) ? path : [...path, node.id],
    };
    this.network.send({
      kind: 'RESPONSE',
      source: node.id,
      destination: item.inbound.source,
      type: item.inbound.type,
      payload,
      sizeBytes: item.inbound.sizeBytes,
      requestId: item.inbound.requestId,
      traceId: item.inbound.traceId,
      spanId: item.spanId,
      ...(item.inbound.parentSpanId !== undefined ? { parentSpanId: item.inbound.parentSpanId } : {}),
      hop: item.inbound.hop,
      causedBy,
    });
  }

  /** Frees the slot, records occupancy, and admits the next waiting request. */
  private release(node: SimNode, worker: NodeWorker, item: WorkItem): void {
    if (item.startedAt >= 0) {
      node.state.inFlight = Math.max(0, node.state.inFlight - 1);
      node.state.busyTime += this.context.now() - item.startedAt;
    } else {
      const index = worker.waiting.indexOf(item);
      if (index >= 0) {
        worker.waiting.splice(index, 1);
        node.state.queueDepth = Math.max(0, node.state.queueDepth - 1);
      }
    }
    this.context.cancel(item.timeoutEventId);
    worker.work.delete(item.spanId);
    if (item.outboundSpan) worker.outbound.delete(item.outboundSpan);
    this.pump(node, worker);
  }

  private pump(node: SimNode, worker: NodeWorker): void {
    while (node.state.inFlight < node.config.concurrency && worker.waiting.length > 0) {
      const next = worker.waiting.shift() as WorkItem;
      node.state.queueDepth = Math.max(0, node.state.queueDepth - 1);
      this.startProcessing(node, next, next.timeoutEventId);
    }
  }

  /**
   * Where a request goes next.
   *
   * `terminal` and `unreachable` are deliberately separate: a database at the
   * end of the chain serves the request, while a load balancer whose whole
   * pool is down must report failure rather than answer on its behalf.
   */
  private route(node: SimNode, body: RequestBody): RouteOutcome {
    if (node.type === 'database' || node.type === 'replica' || node.type === 'cache') {
      return { kind: 'terminal' };
    }
    // The node a request arrived from is never a valid next hop.
    const configured = this.network.topology
      .neighboursOf(node.id)
      .filter((id) => !body.path.includes(id));
    if (configured.length === 0) return { kind: 'terminal' };

    const reachable = new Set(this.network.topology.downstreamOf(node.id));
    const candidates = configured
      .filter((id) => reachable.has(id))
      .map((id) => this.registry.get(id))
      .filter((candidate): candidate is SimNode => candidate !== undefined && candidate.state.status !== 'failed');
    if (candidates.length === 0) return { kind: 'unreachable' };

    const target = this.selector.select({
      node,
      request: body,
      candidates,
      rng: this.context.stream(`routing:${node.id}`),
    });
    return target ? { kind: 'forward', target } : { kind: 'unreachable' };
  }

  private latencyFor(node: SimNode, operation: OperationType): LatencySpec {
    if (node.type === 'database' || node.type === 'replica') {
      const specific = isWriteOperation(operation) ? node.config.writeLatency : node.config.readLatency;
      if (specific !== undefined) return specific;
    }
    return node.config.processing;
  }

  private scheduleTimeout(
    nodeId: NodeId,
    requestId: RequestId,
    spanId: SpanId,
    deadlineAt: SimTime,
    waitedFor?: NodeId,
  ): EventId {
    return this.context.scheduleAt(
      {
        type: 'TIMEOUT',
        payload: {
          nodeId,
          requestId,
          spanId,
          deadlineAt,
          ...(waitedFor !== undefined ? { waitedFor } : {}),
        },
        nodeId,
      },
      Math.max(this.context.now(), deadlineAt),
    ).id;
  }

  private workerFor(id: NodeId): NodeWorker {
    let worker = this.workers.get(id);
    if (!worker) {
      worker = new NodeWorker();
      this.workers.set(id, worker);
    }
    return worker;
  }

  private emit<T extends EventType>(
    type: T,
    payload: SimEvent<T>['payload'],
    meta: { nodeId?: NodeId; traceId?: TraceId; causedBy?: EventId } = {},
  ): void {
    this.context.schedule(
      {
        type,
        payload,
        ...(meta.nodeId !== undefined ? { nodeId: meta.nodeId } : {}),
        ...(meta.traceId !== undefined ? { traceId: meta.traceId } : {}),
        ...(meta.causedBy !== undefined ? { causedBy: meta.causedBy } : {}),
      },
      0,
    );
  }
}

type RouteOutcome =
  /** Nothing is wired downstream; this node serves the request itself. */
  | { kind: 'terminal' }
  /** A downstream tier exists but none of it is usable right now. */
  | { kind: 'unreachable' }
  | { kind: 'forward'; target: SimNode };

function failureReasonFor(status: ResponseStatus): RequestFailureReason {
  switch (status) {
    case 'rejected':
      return 'queue_full';
    case 'unreachable':
      return 'unreachable';
    case 'timeout':
      return 'timeout';
    default:
      return 'processing_error';
  }
}
