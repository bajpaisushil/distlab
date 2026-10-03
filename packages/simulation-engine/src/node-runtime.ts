import {
  sampleLatency,
  type EventId,
  type EventPayloadMap,
  type EventType,
  type Message,
  type MessageKind,
  type NodeId,
  type NodeType,
  type OperationType,
  type RequestBody,
  type RequestFailureReason,
  type RequestId,
  type RequestMessage,
  type ResponseData,
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
import type { DataPlane, EmitMeta, Registrar, RoutingPolicy, SimModule } from './modules/types.js';

/** One inbound request being handled by one node. */
interface WorkItem {
  /** The node's server-side span, equal to the inbound message's span id. */
  readonly spanId: SpanId;
  readonly inbound: RequestMessage;
  readonly arrivedAt: SimTime;
  /** When it took a concurrency slot; -1 while still queued. */
  startedAt: SimTime;
  timeoutEventId: EventId;
  state: 'queued' | 'processing' | 'deferred' | 'awaiting_downstream';
  outboundSpan: SpanId | undefined;
  /** Downstream node the current call went to, and when — for routing feedback. */
  target: NodeId | undefined;
  dispatchedAt: SimTime;
}

/** A request the client originated and is still waiting on. */
interface OriginRecord {
  readonly requestId: RequestId;
  readonly traceId: TraceId;
  readonly clientId: NodeId;
  readonly startedAt: SimTime;
  readonly target: NodeId;
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
  readonly key?: string;
}

export interface NodeRuntimeOptions {
  readonly context: SimulationContext;
  readonly registry: NodeRegistry;
  readonly network: SimulatedNetwork;
  readonly routing: RoutingPolicy;
  readonly data: DataPlane;
  /** Protocol modules, in the fixed order they are consulted. */
  readonly modules: readonly SimModule[];
}

/** Plain-data form of the runtime's state, for checkpoints. */
export interface NodeRuntimeState {
  readonly workers: readonly {
    readonly nodeId: NodeId;
    readonly waiting: readonly SpanId[];
    readonly work: readonly WorkItem[];
    readonly outbound: readonly (readonly [SpanId, SpanId])[];
  }[];
  readonly origins: readonly (readonly [SpanId, OriginRecord])[];
}

/**
 * Turns messages into work and work into messages.
 *
 * The model is a bounded worker pool per node: a request occupies a slot from
 * the moment it is admitted until the moment the node answers, *including*
 * the time it spends waiting on a downstream call. That is what makes
 * thread-pool exhaustion and backpressure emerge on their own instead of
 * having to be special-cased — a slow database really does consume the API
 * tier's capacity.
 *
 * What a node *does* with a request is delegated: the data plane decides
 * whether storage answers it, the routing policy picks the next hop, and
 * protocol modules own their own message kinds and node types. Nodes never
 * invoke each other; every hop goes through `SimulatedNetwork`.
 */
export class NodeRuntime {
  private readonly context: SimulationContext;
  private readonly registry: NodeRegistry;
  private readonly network: SimulatedNetwork;
  private readonly routing: RoutingPolicy;
  private readonly data: DataPlane;
  private readonly modules: readonly SimModule[];
  private readonly byKind = new Map<MessageKind, SimModule>();
  private readonly byNodeType = new Map<NodeType, SimModule>();
  private readonly byName = new Map<string, SimModule>();

  private workers = new Map<NodeId, NodeWorker>();
  /** Client-side outbound span -> the request it represents. */
  private origins = new Map<SpanId, OriginRecord>();

  constructor(options: NodeRuntimeOptions) {
    this.context = options.context;
    this.registry = options.registry;
    this.network = options.network;
    this.routing = options.routing;
    this.data = options.data;
    this.modules = [options.data, ...options.modules];
    for (const module of this.modules) {
      this.byName.set(module.name, module);
      for (const kind of module.messageKinds) this.byKind.set(kind, module);
      for (const type of module.servesNodeTypes) this.byNodeType.set(type, module);
    }
  }

  attach(on: Registrar): void {
    on('MESSAGE_RECEIVED', (event) => this.onMessageReceived(event));
    on('REQUEST_PROCESSING_COMPLETED', (event) => this.onProcessingCompleted(event));
    on('TIMEOUT', (event) => this.onTimeout(event));
    on('TIMER', (event) => this.onTimer(event));
    on('NODE_FAILED', (event) => this.onNodeFailed(event));
    on('NODE_RECOVERED', (event) => this.onNodeRecovered(event));
    for (const module of this.modules) module.attach(on);
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
        ...(params.key !== undefined ? { key: params.key } : {}),
      },
      { nodeId: client.id, traceId, ...(causedBy !== undefined ? { causedBy } : {}) },
    );

    const body: RequestBody = {
      operation: params.operation,
      workloadId: params.workloadId,
      path: [client.id],
      deadlineAt,
      ...(params.key !== undefined ? { key: params.key } : {}),
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
        { nodeId: client.id, traceId, ...(causedBy !== undefined ? { causedBy } : {}) },
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
      target: target.id,
      timeoutEventId,
      settled: false,
    });

    this.emit(
      'REQUEST_ROUTED',
      { requestId, from: client.id, to: target.id, hop: 0, strategy: this.routing.strategyName(client) },
      { nodeId: client.id, traceId, ...(causedBy !== undefined ? { causedBy } : {}) },
    );
    this.routing.onDispatch(client, target.id);

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

  /**
   * Finishes a request the data plane deferred. Returns false if the request
   * was abandoned in the meantime (deadline, crash), in which case nothing is sent.
   */
  completeDeferred(
    nodeId: NodeId,
    spanId: SpanId,
    status: ResponseStatus,
    data?: ResponseData,
    causedBy?: EventId,
  ): boolean {
    const node = this.registry.get(nodeId);
    if (!node || node.state.status === 'failed') return false;
    const worker = this.workerFor(nodeId);
    const item = worker.work.get(spanId);
    if (!item || item.state !== 'deferred') return false;
    if (status === 'ok') node.state.processed += 1;
    else node.state.failed += 1;
    this.respond(node, item, status, item.inbound.payload.path, causedBy ?? item.timeoutEventId, data);
    this.release(node, worker, item);
    return true;
  }

  /** Sends a response for `request` from `node`, outside the worker-pool path (used by protocol modules). */
  reply(
    node: SimNode,
    request: RequestMessage,
    status: ResponseStatus,
    data?: ResponseData,
    causedBy?: EventId,
  ): void {
    this.network.send({
      kind: 'RESPONSE',
      source: node.id,
      destination: request.source,
      type: request.type,
      payload: {
        status,
        servedBy: node.id,
        path: request.payload.path.includes(node.id) ? request.payload.path : [...request.payload.path, node.id],
        ...(data !== undefined ? { data } : {}),
      },
      sizeBytes: request.sizeBytes,
      requestId: request.requestId,
      traceId: request.traceId,
      spanId: request.spanId,
      ...(request.parentSpanId !== undefined ? { parentSpanId: request.parentSpanId } : {}),
      hop: request.hop,
      ...(causedBy !== undefined ? { causedBy } : {}),
    });
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
          ...(message.requestId !== undefined ? { requestId: message.requestId } : {}),
          source: message.source,
          destination: message.destination,
          reason: 'destination_failed',
        },
        { nodeId: node.id, ...(message.traceId !== undefined ? { traceId: message.traceId } : {}), causedBy: event.id },
      );
      return;
    }

    // Protocol traffic goes to the module that owns its kind.
    const protocol = this.byKind.get(message.kind);
    if (protocol) {
      protocol.onMessage(node, message, event);
      return;
    }

    if (message.kind === 'RESPONSE') {
      if (node.type === 'client') {
        this.settleOrigin(node, message as ResponseMessage, event.id);
        return;
      }
      const serving = this.byNodeType.get(node.type);
      if (serving) {
        serving.onMessage(node, message, event);
        return;
      }
      this.onResponse(node, message as ResponseMessage, event.id);
      return;
    }

    if (message.kind !== 'REQUEST') return;
    const request = message as RequestMessage;

    // Up but refusing work: answer at once, without taking a slot.
    if (node.state.unavailable && node.type !== 'client') {
      node.state.rejected += 1;
      this.emit(
        'REQUEST_REJECTED',
        { requestId: request.requestId, nodeId: node.id, reason: 'unavailable', queueDepth: node.state.queueDepth },
        { nodeId: node.id, traceId: request.traceId, causedBy: event.id },
      );
      this.reply(node, request, 'unavailable', undefined, event.id);
      return;
    }

    const serving = this.byNodeType.get(node.type);
    if (serving) {
      serving.onMessage(node, message, event);
      return;
    }
    this.onRequest(node, request, event.id);
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
      state: 'queued',
      outboundSpan: undefined,
      target: undefined,
      dispatchedAt: -1,
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
    // An overloaded node does the same work, slower.
    const serviceTime = sampleLatency(this.data.serviceLatency(node, item.inbound.payload), rng) * node.state.slowdown;
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
    const { nodeId, spanId, outcome, serviceTime } = event.payload;
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

    if (outcome === 'error') {
      node.state.failed += 1;
      this.respond(node, item, 'error', body.path, event.id);
      this.release(node, worker, item);
      return;
    }

    const decision = this.data.serve({
      node,
      message: item.inbound,
      body,
      spanId: item.spanId,
      serviceTime,
      causedBy: event.id,
    });
    if (decision.kind === 'respond') {
      if (decision.status === 'ok') node.state.processed += 1;
      else node.state.failed += 1;
      this.respond(node, item, decision.status, body.path, event.id, decision.data);
      this.release(node, worker, item);
      return;
    }
    if (decision.kind === 'defer') {
      // The slot stays held until the data plane completes it.
      item.state = 'deferred';
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
    this.forward(node, worker, item, route.target, event.id);
  }

  private forward(node: SimNode, worker: NodeWorker, item: WorkItem, target: SimNode, causedBy: EventId): void {
    const body = item.inbound.payload;
    const outboundSpan = this.context.ids.span();
    item.outboundSpan = outboundSpan;
    item.target = target.id;
    item.dispatchedAt = this.context.now();
    item.state = 'awaiting_downstream';
    worker.outbound.set(outboundSpan, item.spanId);

    this.emit(
      'REQUEST_ROUTED',
      {
        requestId: item.inbound.requestId,
        from: node.id,
        to: target.id,
        hop: item.inbound.hop + 1,
        strategy: this.routing.strategyName(node),
      },
      { nodeId: node.id, traceId: item.inbound.traceId, causedBy },
    );
    this.routing.onDispatch(node, target.id);

    this.network.send({
      kind: 'REQUEST',
      source: node.id,
      destination: target.id,
      type: body.operation,
      payload: { ...body, path: [...body.path, node.id] },
      sizeBytes: item.inbound.sizeBytes,
      requestId: item.inbound.requestId,
      traceId: item.inbound.traceId,
      spanId: outboundSpan,
      parentSpanId: item.spanId,
      hop: item.inbound.hop + 1,
      causedBy,
    });
  }

  private onResponse(node: SimNode, message: ResponseMessage, causedBy: EventId): void {
    const worker = this.workerFor(node.id);
    const inboundSpan = worker.outbound.get(message.spanId);
    // No record means a duplicate or late reply to work already settled.
    if (inboundSpan === undefined) return;
    worker.outbound.delete(message.spanId);

    const item = worker.work.get(inboundSpan);
    if (!item) return;

    const ok = message.payload.status === 'ok';
    if (item.target !== undefined) {
      this.routing.onOutcome(node, item.target, this.context.now() - item.dispatchedAt, ok);
      item.target = undefined;
    }
    if (ok) node.state.processed += 1;
    else node.state.failed += 1;

    const data = this.data.onDownstreamResponse(node, item.inbound.payload, message, causedBy) ?? message.payload.data;
    this.respond(node, item, message.payload.status, message.payload.path, causedBy, data);
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
    const ok = message.payload.status === 'ok';
    this.routing.onOutcome(client, origin.target, latency, ok);

    if (ok) {
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

  // --- timeouts, timers and node lifecycle -------------------------------

  private onTimeout(event: SimEvent<'TIMEOUT'>): void {
    const { nodeId, spanId } = event.payload;
    const origin = this.origins.get(spanId);
    if (origin && !origin.settled) {
      origin.settled = true;
      this.origins.delete(spanId);
      const client = this.registry.get(origin.clientId);
      if (client) {
        client.state.failed += 1;
        this.routing.onOutcome(client, origin.target, this.context.now() - origin.startedAt, false);
      }
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
    if (item.target !== undefined) {
      this.routing.onOutcome(node, item.target, this.context.now() - item.dispatchedAt, false);
    }
    node.state.failed += 1;
    this.release(node, worker, item);
  }

  private onTimer(event: SimEvent<'TIMER'>): void {
    const node = this.registry.get(event.payload.nodeId);
    if (!node || node.state.status === 'failed') return;
    // Armed before a crash: it belongs to a process that no longer exists.
    if (event.payload.incarnation !== node.state.incarnation) return;
    this.byName.get(event.payload.module)?.onTimer(node, event);
  }

  private onNodeFailed(event: SimEvent<'NODE_FAILED'>): void {
    const node = this.registry.get(event.payload.nodeId);
    if (!node || node.state.status === 'failed') return;
    this.registry.setStatus(node.id, 'failed', this.context.now());
    node.state.incarnation += 1;
    node.state.paused = false;

    // Everything in memory is lost with the process. Slots and queues reset.
    const worker = this.workerFor(node.id);
    for (const item of worker.work.values()) {
      this.context.cancel(item.timeoutEventId);
      if (item.target !== undefined) {
        this.routing.onOutcome(node, item.target, this.context.now() - item.dispatchedAt, false);
      }
    }
    worker.work.clear();
    worker.outbound.clear();
    worker.waiting.length = 0;
    node.state.inFlight = 0;
    node.state.queueDepth = 0;

    for (const module of this.modules) module.onNodeFailed(node, event);
  }

  private onNodeRecovered(event: SimEvent<'NODE_RECOVERED'>): void {
    const node = this.registry.get(event.payload.nodeId);
    if (!node || node.state.status !== 'failed') return;
    this.registry.setStatus(node.id, 'healthy', this.context.now());
    for (const module of this.modules) module.onNodeRecovered(node, event);
  }

  // --- helpers ------------------------------------------------------------

  private respond(
    node: SimNode,
    item: WorkItem,
    status: ResponseStatus,
    path: readonly NodeId[],
    causedBy: EventId,
    data?: ResponseData,
  ): void {
    this.network.send({
      kind: 'RESPONSE',
      source: node.id,
      destination: item.inbound.source,
      type: item.inbound.type,
      payload: {
        status,
        servedBy: node.id,
        path: path.includes(node.id) ? path : [...path, node.id],
        ...(data !== undefined ? { data } : {}),
      },
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
    // The node a request arrived from is never a valid next hop.
    const configured = this.network.topology
      .neighboursOf(node.id)
      .filter((id) => !body.path.includes(id));
    if (configured.length === 0) return { kind: 'terminal' };

    const reachable = new Set(this.network.topology.downstreamOf(node.id));
    const healthy = configured
      .filter((id) => reachable.has(id))
      .map((id) => this.registry.get(id))
      .filter((candidate): candidate is SimNode => candidate !== undefined && candidate.state.status !== 'failed');
    const candidates = this.data.filterCandidates(node, body, healthy);
    if (candidates.length === 0) return { kind: 'unreachable' };

    const target = this.routing.select(node, body, candidates);
    return target ? { kind: 'forward', target } : { kind: 'unreachable' };
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

  private emit<T extends EventType>(type: T, payload: EventPayloadMap[T], meta: EmitMeta = {}): void {
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

  // --- checkpoints --------------------------------------------------------

  captureState(): NodeRuntimeState {
    return {
      workers: [...this.workers.entries()].map(([nodeId, worker]) => ({
        nodeId,
        waiting: worker.waiting.map((item) => item.spanId),
        work: [...worker.work.values()].map((item) => ({ ...item })),
        outbound: [...worker.outbound.entries()],
      })),
      origins: [...this.origins.entries()].map(([span, origin]) => [span, { ...origin }] as const),
    };
  }

  restoreState(state: NodeRuntimeState): void {
    this.workers = new Map();
    for (const saved of state.workers) {
      const worker = new NodeWorker();
      for (const item of saved.work) worker.work.set(item.spanId, { ...item });
      // Waiting entries must be the same objects as in `work`: release() finds them by identity.
      for (const span of saved.waiting) {
        const item = worker.work.get(span);
        if (item) worker.waiting.push(item);
      }
      for (const [outbound, inbound] of saved.outbound) worker.outbound.set(outbound, inbound);
      this.workers.set(saved.nodeId, worker);
    }
    this.origins = new Map(state.origins.map(([span, origin]) => [span, { ...origin }]));
  }

  /** Read-only views for inspection: what each node is holding right now. */
  inspect(nodeId: NodeId): { waiting: number; working: number; awaiting: number; deferred: number } {
    const worker = this.workers.get(nodeId);
    if (!worker) return { waiting: 0, working: 0, awaiting: 0, deferred: 0 };
    let working = 0;
    let awaiting = 0;
    let deferred = 0;
    for (const item of worker.work.values()) {
      if (item.state === 'processing') working += 1;
      else if (item.state === 'awaiting_downstream') awaiting += 1;
      else if (item.state === 'deferred') deferred += 1;
    }
    return { waiting: worker.waiting.length, working, awaiting, deferred };
  }

  /** Messages a module wants answered on the normal request path are rare; this keeps the type public. */
  static isRequest(message: Message): message is RequestMessage {
    return message.kind === 'REQUEST';
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
    case 'unavailable':
      return 'unavailable';
    case 'circuit_open':
      return 'circuit_open';
    case 'not_leader':
      return 'not_leader';
    default:
      return 'processing_error';
  }
}
