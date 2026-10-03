import {
  CLOSED,
  backoffDelay,
  permit,
  record,
  releaseProbe,
  wouldPermit,
  type BreakerPolicy,
  type BreakerState,
  type BreakerTransition,
} from '@distlab/algorithms';
import {
  RETRYABLE_STATUSES,
  sampleLatency,
  type BulkheadPolicy,
  type EventId,
  type EventPayloadMap,
  type EventType,
  type Message,
  type MessageId,
  type MessageKind,
  type NodeConfig,
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
import type { DataPlane, EmitMeta, Registrar, RoutingExclusionView, RoutingPolicy, SimModule } from './modules/types.js';

/**
 * One downstream call a node is making, across all its attempts. Clients make
 * calls for the requests they originate; servers make them for the work they
 * forward. Both go through the same attempt logic — timeouts, retries and
 * circuit breakers behave identically wherever they are configured.
 */
interface Call {
  /** Attempts made so far; the current one when one is in flight. */
  attempt: number;
  outboundSpan: SpanId | undefined;
  target: NodeId | undefined;
  sentAt: SimTime;
  /** Per-attempt timeout, if the node has a call timeout. */
  callTimer: EventId | undefined;
  /** Pending RETRY event while backing off. */
  retryTimer: EventId | undefined;
  /** Previous backoff delay, which decorrelated jitter grows from. */
  lastDelay: number | undefined;
  /** This attempt is a half-open circuit probe. */
  probe: boolean;
}

/** One delivered request being handled by one node. */
interface WorkItem {
  /**
   * The delivered message's id. Keys the work: a duplicated request arrives as
   * two messages with one span, and each copy is genuinely worked on, so the
   * span alone cannot identify the work.
   */
  readonly workId: MessageId;
  /** The node's server-side span, equal to the inbound message's span id. */
  readonly spanId: SpanId;
  readonly inbound: RequestMessage;
  readonly arrivedAt: SimTime;
  /** When it took a concurrency slot; -1 while still queued. */
  startedAt: SimTime;
  /** The request's end-to-end deadline at this node. */
  timeoutEventId: EventId;
  state: 'queued' | 'processing' | 'deferred' | 'calling' | 'retry_wait';
  /** The bulkhead class it was admitted under, if any. */
  readonly bulkhead: string | undefined;
  call: Call;
}

/** A request the client originated and is still waiting on. */
interface OriginRecord {
  readonly requestId: RequestId;
  readonly traceId: TraceId;
  readonly clientId: NodeId;
  readonly rootSpan: SpanId;
  readonly startedAt: SimTime;
  readonly body: RequestBody;
  readonly sizeBytes: number;
  /** The end-to-end deadline. */
  timeoutEventId: EventId;
  state: 'calling' | 'retry_wait';
  call: Call;
}

class NodeWorker {
  /** Admitted but not yet given a slot, FIFO. */
  readonly waiting: WorkItem[] = [];
  /** Delivered message id -> work. */
  readonly work = new Map<MessageId, WorkItem>();
  /** Outbound span of the current attempt -> the work waiting on it. */
  readonly outbound = new Map<SpanId, MessageId>();
  /** Bulkhead class -> requests holding a slot. */
  readonly active = new Map<string, number>();
  /** Bulkhead class -> requests waiting. */
  readonly queued = new Map<string, number>();
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
    readonly waiting: readonly MessageId[];
    readonly work: readonly WorkItem[];
    readonly outbound: readonly (readonly [SpanId, MessageId])[];
    readonly active: readonly (readonly [string, number])[];
    readonly queued: readonly (readonly [string, number])[];
  }[];
  readonly origins: readonly OriginRecord[];
  readonly breakers: readonly (readonly [string, BreakerState])[];
}

type Caller =
  | { readonly kind: 'origin'; readonly node: SimNode; readonly origin: OriginRecord }
  | { readonly kind: 'work'; readonly node: SimNode; readonly worker: NodeWorker; readonly item: WorkItem };

type RouteOutcome =
  /** Nothing is wired downstream; this node serves the request itself. */
  | { kind: 'terminal' }
  /** A downstream tier exists but none of it is usable right now. */
  | { kind: 'unreachable' }
  /** Usable targets exist, but every one's circuit is open. */
  | { kind: 'circuit_open'; targets: NodeId[] }
  | { kind: 'forward'; target: SimNode };

const DEFAULT_RETRY = {
  backoff: 'exponential' as const,
  baseDelayMs: 50,
  maxDelayMs: 2000,
  multiplier: 2,
  jitter: 'full' as const,
};

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
 * Calls downstream are made in attempts. An attempt ends with a response, a
 * per-call timeout, or abandonment; a failed attempt may be retried after a
 * backoff, possibly on another target, and every outcome feeds the routing
 * policy and the node's circuit breakers. Retries cost real capacity — a late
 * response to an abandoned attempt still consumed the work it took — which is
 * exactly how retry storms happen.
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
  private origins = new Map<RequestId, OriginRecord>();
  /** Outbound span of a client's current attempt -> its request. */
  private originByOutbound = new Map<SpanId, RequestId>();
  /** `${node}|${target}` -> circuit state. */
  private breakers = new Map<string, BreakerState>();

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
    on('RETRY', (event) => this.onRetry(event));
    on('TIMER', (event) => this.onTimer(event));
    on('NODE_FAILED', (event) => this.onNodeFailed(event));
    on('NODE_RECOVERED', (event) => this.onNodeRecovered(event));
    for (const module of this.modules) module.attach(on);
  }

  // --- requests from clients ----------------------------------------------

  /** Creates a request at a client and sends its first attempt. */
  beginRequest(params: BeginRequestParams, causedBy?: EventId): RequestId | undefined {
    const client = this.registry.get(params.clientId);
    if (!client || client.state.status === 'failed') return undefined;

    const requestId = this.context.ids.request();
    const traceId = this.context.ids.trace();
    const rootSpan = this.context.ids.span();
    const now = this.context.now();
    const deadlineAt = now + params.deadlineMs;
    const cause = causedBy !== undefined ? { causedBy } : {};

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
      { nodeId: client.id, traceId, ...cause },
    );

    const body: RequestBody = {
      operation: params.operation,
      workloadId: params.workloadId,
      path: [client.id],
      deadlineAt,
      ...(params.key !== undefined ? { key: params.key } : {}),
    };
    const origin: OriginRecord = {
      requestId,
      traceId,
      clientId: client.id,
      rootSpan,
      startedAt: now,
      body,
      sizeBytes: params.sizeBytes,
      timeoutEventId: this.scheduleTimeout({
        nodeId: client.id,
        requestId,
        spanId: rootSpan,
        scope: 'deadline',
        deadlineAt,
      }),
      state: 'calling',
      call: newCall(),
    };
    this.origins.set(requestId, origin);
    this.startCall({ kind: 'origin', node: client, origin }, causedBy);
    return requestId;
  }

  /**
   * Finishes a request the data plane deferred. Returns false if the request
   * was abandoned in the meantime (deadline, crash), in which case nothing is sent.
   */
  completeDeferred(
    nodeId: NodeId,
    workId: MessageId,
    status: ResponseStatus,
    data?: ResponseData,
    causedBy?: EventId,
  ): boolean {
    const node = this.registry.get(nodeId);
    if (!node || node.state.status === 'failed') return false;
    const worker = this.workerFor(nodeId);
    const item = worker.work.get(workId);
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
        this.onOriginResponse(node, message as ResponseMessage, event.id);
        return;
      }
      const serving = this.byNodeType.get(node.type);
      if (serving) {
        serving.onMessage(node, message, event);
        return;
      }
      this.onWorkResponse(node, message as ResponseMessage, event.id);
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
    const bulkhead = bulkheadFor(node.config, body.workloadId);
    const item: WorkItem = {
      workId: message.id,
      spanId: message.spanId,
      inbound: message,
      arrivedAt: this.context.now(),
      startedAt: -1,
      timeoutEventId: this.scheduleTimeout({
        nodeId: node.id,
        requestId: message.requestId,
        spanId: message.spanId,
        workId: message.id,
        scope: 'deadline',
        deadlineAt: body.deadlineAt,
      }),
      state: 'queued',
      bulkhead: bulkhead?.name,
      call: newCall(),
    };
    worker.work.set(item.workId, item);

    if (this.hasSlot(node, worker, bulkhead)) {
      this.startProcessing(node, worker, item, causedBy);
      return;
    }

    const classQueued = bulkhead ? worker.queued.get(bulkhead.name) ?? 0 : 0;
    const classRoom = !bulkhead || classQueued < (bulkhead.maxQueue ?? node.config.queueCapacity);
    if (node.state.queueDepth < node.config.queueCapacity && classRoom) {
      worker.waiting.push(item);
      node.state.queueDepth += 1;
      if (bulkhead) worker.queued.set(bulkhead.name, classQueued + 1);
      this.emit(
        'REQUEST_QUEUED',
        { requestId: message.requestId, nodeId: node.id, queueDepth: node.state.queueDepth },
        { nodeId: node.id, traceId: message.traceId, causedBy },
      );
      return;
    }

    // Saturated: shed load rather than growing an unbounded backlog. When the
    // node itself has room but this class does not, the bulkhead refused it.
    const bulkheadRefused = bulkhead !== undefined && !classRoom && node.state.queueDepth < node.config.queueCapacity;
    node.state.rejected += 1;
    this.emit(
      'REQUEST_REJECTED',
      {
        requestId: message.requestId,
        nodeId: node.id,
        reason: bulkheadRefused ? 'bulkhead_full' : 'queue_full',
        queueDepth: node.state.queueDepth,
        ...(bulkheadRefused ? { bulkhead: bulkhead.name } : {}),
      },
      { nodeId: node.id, traceId: message.traceId, causedBy },
    );
    this.respond(node, item, 'rejected', body.path, causedBy);
    this.release(node, worker, item);
  }

  private hasSlot(node: SimNode, worker: NodeWorker, bulkhead: BulkheadPolicy | undefined): boolean {
    if (node.state.inFlight >= node.config.concurrency) return false;
    return !bulkhead || (worker.active.get(bulkhead.name) ?? 0) < bulkhead.maxConcurrent;
  }

  private startProcessing(node: SimNode, worker: NodeWorker, item: WorkItem, causedBy: EventId): void {
    const rng = this.context.stream(`node:${node.id}`);
    // An overloaded node does the same work, slower.
    const serviceTime = sampleLatency(this.data.serviceLatency(node, item.inbound.payload), rng) * node.state.slowdown;
    // Drawn now rather than at completion so the scheduled event carries the
    // real outcome; a crash during processing is handled separately.
    const outcome = rng.bool(node.config.failureProbability) ? 'error' : 'ok';

    item.state = 'processing';
    item.startedAt = this.context.now();
    node.state.inFlight += 1;
    if (item.bulkhead) worker.active.set(item.bulkhead, (worker.active.get(item.bulkhead) ?? 0) + 1);

    this.emit(
      'REQUEST_PROCESSING_STARTED',
      { requestId: item.inbound.requestId, nodeId: node.id, spanId: item.spanId, workId: item.workId, serviceTime },
      { nodeId: node.id, traceId: item.inbound.traceId, causedBy },
    );
    this.context.schedule(
      {
        type: 'REQUEST_PROCESSING_COMPLETED',
        payload: {
          requestId: item.inbound.requestId,
          nodeId: node.id,
          spanId: item.spanId,
          workId: item.workId,
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
    const { nodeId, workId, outcome, serviceTime } = event.payload;
    const node = this.registry.get(nodeId);
    if (!node) return;
    const worker = this.workerFor(nodeId);
    const item = worker.work.get(workId);
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
      workId: item.workId,
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

    item.state = 'calling';
    this.startCall({ kind: 'work', node, worker, item }, event.id);
  }

  // --- calls downstream ---------------------------------------------------

  /** Routes and sends the first attempt, or settles the caller if there is nowhere to go. */
  private startCall(caller: Caller, causedBy: EventId | undefined): void {
    const route = this.route(caller.node, bodyOf(caller));
    switch (route.kind) {
      case 'forward':
        this.sendAttempt(caller, route.target, causedBy);
        return;
      case 'terminal':
        if (caller.kind === 'work') {
          // Nothing is wired downstream: this node is where the request is served.
          caller.node.state.processed += 1;
          this.respond(caller.node, caller.item, 'ok', caller.item.inbound.payload.path, causedBy ?? caller.item.timeoutEventId);
          this.release(caller.node, caller.worker, caller.item);
        } else {
          this.finishOrigin(caller.node, caller.origin, { ok: false, status: 'unreachable', reason: 'no_route' }, causedBy);
        }
        return;
      case 'unreachable':
        // There *is* a downstream tier, but none of it can be reached right now.
        // Answering 'ok' here would quietly paper over an outage.
        this.failCall(caller, 'unreachable', undefined, causedBy);
        return;
      case 'circuit_open':
        this.emit(
          'CIRCUIT_REJECTED',
          { nodeId: caller.node.id, requestId: requestIdOf(caller), targets: route.targets },
          { nodeId: caller.node.id, traceId: traceIdOf(caller), ...(causedBy !== undefined ? { causedBy } : {}) },
        );
        this.failCall(caller, 'circuit_open', undefined, causedBy);
        return;
    }
  }

  private sendAttempt(caller: Caller, target: SimNode, causedBy: EventId | undefined): void {
    const node = caller.node;
    const call = callOf(caller);
    const now = this.context.now();
    const body = bodyOf(caller);
    const requestId = requestIdOf(caller);
    const traceId = traceIdOf(caller);
    const cause = causedBy !== undefined ? { causedBy } : {};

    call.attempt += 1;
    call.target = target.id;
    call.sentAt = now;
    call.outboundSpan = this.context.ids.span();
    call.probe = this.admitThroughBreaker(node, target.id, causedBy);

    if (caller.kind === 'origin') {
      caller.origin.state = 'calling';
      this.originByOutbound.set(call.outboundSpan, requestId);
    } else {
      caller.item.state = 'calling';
      caller.worker.outbound.set(call.outboundSpan, caller.item.workId);
    }

    const hop = caller.kind === 'origin' ? 0 : caller.item.inbound.hop + 1;
    this.emit(
      'REQUEST_ROUTED',
      { requestId, from: node.id, to: target.id, hop, strategy: this.routing.strategyName(node) },
      { nodeId: node.id, traceId, ...cause },
    );
    this.routing.onDispatch(node, target.id, { requestId, traceId, ...cause });

    // A call timeout only matters if it would fire before the request's own deadline.
    const callTimeout = node.config.callTimeoutMs;
    if (callTimeout !== undefined && now + callTimeout < body.deadlineAt) {
      call.callTimer = this.scheduleTimeout({
        nodeId: node.id,
        requestId,
        spanId: call.outboundSpan,
        scope: 'call',
        deadlineAt: now + callTimeout,
        waitedFor: target.id,
        attempt: call.attempt,
        ...(caller.kind === 'work' ? { workId: caller.item.workId } : {}),
      });
    }

    this.network.send({
      kind: 'REQUEST',
      source: node.id,
      destination: target.id,
      type: body.operation,
      payload: caller.kind === 'origin' ? body : { ...body, path: [...body.path, node.id] },
      sizeBytes: caller.kind === 'origin' ? caller.origin.sizeBytes : caller.item.inbound.sizeBytes,
      requestId,
      traceId,
      spanId: call.outboundSpan,
      parentSpanId: caller.kind === 'origin' ? caller.origin.rootSpan : caller.item.spanId,
      hop,
      ...cause,
    });
  }

  private onOriginResponse(client: SimNode, message: ResponseMessage, causedBy: EventId): void {
    const requestId = this.originByOutbound.get(message.spanId);
    // No record: a duplicate, or a late reply to an attempt that was abandoned.
    if (requestId === undefined) return;
    const origin = this.origins.get(requestId);
    if (!origin) return;
    this.onAttemptOutcome({ kind: 'origin', node: client, origin }, message.payload.status, message, causedBy);
  }

  private onWorkResponse(node: SimNode, message: ResponseMessage, causedBy: EventId): void {
    const worker = this.workerFor(node.id);
    const workId = worker.outbound.get(message.spanId);
    if (workId === undefined) return;
    const item = worker.work.get(workId);
    if (!item) return;
    this.onAttemptOutcome({ kind: 'work', node, worker, item }, message.payload.status, message, causedBy);
  }

  /** One attempt ended — answered, or timed out. Decide: done, retry, or give up. */
  private onAttemptOutcome(
    caller: Caller,
    status: ResponseStatus,
    response: ResponseMessage | undefined,
    causedBy: EventId,
  ): void {
    const node = caller.node;
    const call = callOf(caller);
    const target = call.target as NodeId;
    this.endAttempt(caller);
    const ok = status === 'ok';
    this.routing.onOutcome(node, target, this.context.now() - call.sentAt, ok);
    this.recordBreaker(node, target, ok, causedBy);

    if (ok) {
      if (caller.kind === 'origin') {
        this.finishOrigin(node, caller.origin, { ok: true, path: response!.payload.path }, causedBy);
      } else {
        node.state.processed += 1;
        const data = this.data.onDownstreamResponse(node, caller.item.inbound.payload, response!, causedBy) ?? response!.payload.data;
        this.respond(node, caller.item, 'ok', response!.payload.path, causedBy, data);
        this.release(node, caller.worker, caller.item);
      }
      return;
    }

    // A node that is not the leader names the one it believes is; callers follow that redirect.
    const hint = status === 'not_leader' ? response?.payload.data?.leaderHint : undefined;
    if (this.scheduleRetry(caller, status, target, causedBy, hint)) return;
    this.failCall(caller, status, response, causedBy);
  }

  /** Settles a call that will not be retried, passing the failure upstream. */
  private failCall(caller: Caller, status: ResponseStatus, response: ResponseMessage | undefined, causedBy: EventId | undefined): void {
    if (caller.kind === 'origin') {
      this.finishOrigin(
        caller.node,
        caller.origin,
        {
          ok: false,
          status,
          reason: failureReasonFor(status),
          ...(response ? { failedAt: response.payload.servedBy } : status === 'circuit_open' || status === 'unreachable' ? { failedAt: caller.node.id } : {}),
        },
        causedBy,
      );
      return;
    }
    const { node, worker, item } = caller;
    node.state.failed += 1;
    const path = response?.payload.path ?? item.inbound.payload.path;
    this.respond(node, item, status, path, causedBy ?? item.timeoutEventId, response?.payload.data);
    this.release(node, worker, item);
  }

  /** Clears the in-flight attempt's bookkeeping so a late reply to it is ignored. */
  private endAttempt(caller: Caller): void {
    const call = callOf(caller);
    if (call.callTimer !== undefined) this.context.cancel(call.callTimer);
    call.callTimer = undefined;
    if (call.outboundSpan !== undefined) {
      if (caller.kind === 'origin') this.originByOutbound.delete(call.outboundSpan);
      else caller.worker.outbound.delete(call.outboundSpan);
    }
    call.outboundSpan = undefined;
  }

  private scheduleRetry(
    caller: Caller,
    status: ResponseStatus,
    previousTarget: NodeId,
    causedBy: EventId,
    redirectTo: NodeId | undefined,
  ): boolean {
    const policy = caller.node.config.retry;
    if (!policy) return false;
    const call = callOf(caller);
    const retriesSoFar = call.attempt - 1;
    if (retriesSoFar >= policy.maxRetries) return false;
    if (!(policy.retryOn ?? RETRYABLE_STATUSES).includes(status)) return false;

    const delay = backoffDelay(
      {
        backoff: policy.backoff ?? DEFAULT_RETRY.backoff,
        baseDelayMs: policy.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs,
        maxDelayMs: policy.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs,
        multiplier: policy.multiplier ?? DEFAULT_RETRY.multiplier,
        jitter: policy.jitter ?? DEFAULT_RETRY.jitter,
      },
      retriesSoFar + 1,
      call.lastDelay,
      this.context.stream(`retry:${caller.node.id}`),
    );
    // A retry that cannot start before the deadline would only waste capacity.
    if (this.context.now() + delay >= bodyOf(caller).deadlineAt) return false;

    call.lastDelay = delay;
    if (caller.kind === 'origin') caller.origin.state = 'retry_wait';
    else caller.item.state = 'retry_wait';
    call.retryTimer = this.context.schedule(
      {
        type: 'RETRY',
        payload: {
          nodeId: caller.node.id,
          requestId: requestIdOf(caller),
          attempt: call.attempt + 1,
          delayMs: delay,
          reason: status,
          previousTarget,
          ...(redirectTo !== undefined && redirectTo !== previousTarget ? { redirectTo } : {}),
          ...(caller.kind === 'work' ? { workId: caller.item.workId } : {}),
        },
        nodeId: caller.node.id,
        traceId: traceIdOf(caller),
        causedBy,
      },
      delay,
    ).id;
    return true;
  }

  private onRetry(event: SimEvent<'RETRY'>): void {
    const caller = this.callerFor(event.payload.nodeId, event.payload.requestId, event.payload.workId);
    if (!caller) return;
    const call = callOf(caller);
    const waiting = caller.kind === 'origin' ? caller.origin.state === 'retry_wait' : caller.item.state === 'retry_wait';
    if (!waiting || call.retryTimer !== event.id) return;
    call.retryTimer = undefined;

    const policy = caller.node.config.retry;
    const preferred = event.payload.redirectTo ?? (policy?.retrySameTarget ? call.target : undefined);
    if (preferred !== undefined) {
      const candidate = this.directTarget(caller, preferred);
      if (candidate) {
        this.sendAttempt(caller, candidate, event.id);
        return;
      }
    }
    const route = this.route(caller.node, bodyOf(caller));
    if (route.kind === 'forward') this.sendAttempt(caller, route.target, event.id);
    else if (route.kind === 'circuit_open') {
      this.emit(
        'CIRCUIT_REJECTED',
        { nodeId: caller.node.id, requestId: requestIdOf(caller), targets: route.targets },
        { nodeId: caller.node.id, traceId: traceIdOf(caller), causedBy: event.id },
      );
      this.failCall(caller, 'circuit_open', undefined, event.id);
    } else this.failCall(caller, 'unreachable', undefined, event.id);
  }

  private finishOrigin(
    client: SimNode,
    origin: OriginRecord,
    outcome:
      | { ok: true; path: readonly NodeId[] }
      | { ok: false; status: ResponseStatus; reason: RequestFailureReason; failedAt?: NodeId },
    causedBy: EventId | undefined,
  ): void {
    this.endAttempt({ kind: 'origin', node: client, origin });
    if (origin.call.retryTimer !== undefined) this.context.cancel(origin.call.retryTimer);
    this.context.cancel(origin.timeoutEventId);
    this.origins.delete(origin.requestId);

    const latency = this.context.now() - origin.startedAt;
    const meta = { nodeId: client.id, traceId: origin.traceId, ...(causedBy !== undefined ? { causedBy } : {}) };
    const attempts = Math.max(1, origin.call.attempt);
    if (outcome.ok) {
      client.state.processed += 1;
      this.emit(
        'REQUEST_COMPLETED',
        {
          requestId: origin.requestId,
          traceId: origin.traceId,
          clientId: client.id,
          latency,
          hops: Math.max(0, outcome.path.length - 1),
          path: outcome.path,
          attempts,
        },
        meta,
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
        status: outcome.status,
        reason: outcome.reason,
        ...(outcome.failedAt !== undefined ? { failedAt: outcome.failedAt } : {}),
        attempts,
      },
      meta,
    );
  }

  // --- timeouts, timers and node lifecycle -------------------------------

  private onTimeout(event: SimEvent<'TIMEOUT'>): void {
    const { nodeId, requestId, workId, scope, spanId } = event.payload;
    const caller = this.callerFor(nodeId, requestId, workId);
    if (!caller) return;

    if (scope === 'call') {
      const call = callOf(caller);
      // A stale timer for an attempt that already ended.
      if (call.outboundSpan !== spanId) return;
      call.callTimer = undefined;
      this.onAttemptOutcome(caller, 'timeout', undefined, event.id);
      return;
    }

    // The request's end-to-end deadline.
    if (caller.kind === 'origin') {
      const call = caller.origin.call;
      if (call.outboundSpan !== undefined && call.target !== undefined) {
        this.routing.onOutcome(caller.node, call.target, this.context.now() - call.sentAt, false);
        this.recordBreaker(caller.node, call.target, false, event.id);
      }
      this.finishOrigin(caller.node, caller.origin, { ok: false, status: 'timeout', reason: 'timeout' }, event.id);
      return;
    }

    // An intermediate hop giving up. It stays silent: the caller holds the same
    // deadline and is abandoning the request at this very instant too.
    const { node, worker, item } = caller;
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

    // Everything in memory is lost with the process: work, queues, in-flight
    // calls and the circuit breakers' memory of who was failing.
    const worker = this.workerFor(node.id);
    for (const item of worker.work.values()) {
      this.context.cancel(item.timeoutEventId);
      this.cancelCallTimers(item.call);
      if (item.call.outboundSpan !== undefined && item.call.target !== undefined) {
        this.routing.onOutcome(node, item.call.target, this.context.now() - item.call.sentAt, false);
      }
    }
    for (const workId of [...worker.work.keys()]) this.data.onWorkReleased(node, workId);
    worker.work.clear();
    worker.outbound.clear();
    worker.waiting.length = 0;
    worker.active.clear();
    worker.queued.clear();
    node.state.inFlight = 0;
    node.state.queueDepth = 0;
    for (const key of [...this.breakers.keys()]) if (key.startsWith(`${node.id}|`)) this.breakers.delete(key);
    // A crashed client abandons its requests; nobody is left to report them.
    for (const origin of [...this.origins.values()]) {
      if (origin.clientId !== node.id) continue;
      this.context.cancel(origin.timeoutEventId);
      this.cancelCallTimers(origin.call);
      if (origin.call.outboundSpan !== undefined) this.originByOutbound.delete(origin.call.outboundSpan);
      this.origins.delete(origin.requestId);
    }

    for (const module of this.modules) module.onNodeFailed(node, event);
  }

  private onNodeRecovered(event: SimEvent<'NODE_RECOVERED'>): void {
    const node = this.registry.get(event.payload.nodeId);
    if (!node || node.state.status !== 'failed') return;
    this.registry.setStatus(node.id, 'healthy', this.context.now());
    for (const module of this.modules) module.onNodeRecovered(node, event);
  }

  // --- circuit breakers ---------------------------------------------------

  private breakerAllows(node: SimNode, target: NodeId): boolean {
    const policy = breakerPolicyOf(node.config);
    if (!policy) return true;
    return wouldPermit(policy, this.breakers.get(`${node.id}|${target}`) ?? CLOSED, this.context.now());
  }

  /** Counts the call against the target's circuit; true when it is a half-open probe. */
  private admitThroughBreaker(node: SimNode, target: NodeId, causedBy: EventId | undefined): boolean {
    const policy = breakerPolicyOf(node.config);
    if (!policy) return false;
    const key = `${node.id}|${target}`;
    const before = this.breakers.get(key) ?? CLOSED;
    const result = permit(policy, before, this.context.now());
    this.breakers.set(key, result.state);
    if (result.transition) this.emitBreaker(node, target, result.transition, policy, causedBy);
    return result.state.mode === 'half_open';
  }

  private recordBreaker(node: SimNode, target: NodeId, ok: boolean, causedBy: EventId | undefined): void {
    const policy = breakerPolicyOf(node.config);
    if (!policy) return;
    const key = `${node.id}|${target}`;
    const result = record(policy, this.breakers.get(key) ?? CLOSED, this.context.now(), ok);
    this.breakers.set(key, result.state);
    if (result.transition) this.emitBreaker(node, target, result.transition, policy, causedBy);
  }

  private emitBreaker(
    node: SimNode,
    target: NodeId,
    transition: BreakerTransition,
    policy: BreakerPolicy,
    causedBy: EventId | undefined,
  ): void {
    const meta = { nodeId: node.id, ...(causedBy !== undefined ? { causedBy } : {}) };
    switch (transition.kind) {
      case 'opened':
        this.emit(
          'CIRCUIT_OPENED',
          {
            nodeId: node.id,
            target,
            failures: transition.failures,
            ...(transition.calls !== undefined ? { calls: transition.calls } : {}),
            reopened: transition.reopened,
            cooldownMs: policy.cooldownMs,
          },
          meta,
        );
        return;
      case 'half_opened':
        this.emit('CIRCUIT_HALF_OPENED', { nodeId: node.id, target, openForMs: transition.openForMs }, meta);
        return;
      case 'closed':
        this.emit('CIRCUIT_CLOSED', { nodeId: node.id, target }, meta);
    }
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
      if (item.bulkhead) worker.active.set(item.bulkhead, Math.max(0, (worker.active.get(item.bulkhead) ?? 0) - 1));
    } else {
      const index = worker.waiting.indexOf(item);
      if (index >= 0) {
        worker.waiting.splice(index, 1);
        node.state.queueDepth = Math.max(0, node.state.queueDepth - 1);
        if (item.bulkhead) worker.queued.set(item.bulkhead, Math.max(0, (worker.queued.get(item.bulkhead) ?? 0) - 1));
      }
    }
    // Abandoning work that is still waiting on a downstream call: that call's
    // outcome will never be seen, so close it out for routing and the breaker.
    const call = item.call;
    if (call.outboundSpan !== undefined && call.target !== undefined) {
      this.routing.onOutcome(node, call.target, this.context.now() - call.sentAt, false);
      if (call.probe) {
        const key = `${node.id}|${call.target}`;
        this.breakers.set(key, releaseProbe(this.breakers.get(key) ?? CLOSED));
      }
      worker.outbound.delete(call.outboundSpan);
      call.outboundSpan = undefined;
    }
    this.cancelCallTimers(call);
    this.context.cancel(item.timeoutEventId);
    worker.work.delete(item.workId);
    this.data.onWorkReleased(node, item.workId);
    this.pump(node, worker);
  }

  /** Starts waiting work while slots allow — the first item whose class has room, not just the head of the queue. */
  private pump(node: SimNode, worker: NodeWorker): void {
    while (node.state.inFlight < node.config.concurrency && worker.waiting.length > 0) {
      const index = worker.waiting.findIndex((item) => this.hasSlot(node, worker, bulkheadNamed(node.config, item.bulkhead)));
      if (index < 0) return;
      const [next] = worker.waiting.splice(index, 1) as [WorkItem];
      node.state.queueDepth = Math.max(0, node.state.queueDepth - 1);
      if (next.bulkhead) worker.queued.set(next.bulkhead, Math.max(0, (worker.queued.get(next.bulkhead) ?? 0) - 1));
      this.startProcessing(node, worker, next, next.timeoutEventId);
    }
  }

  private cancelCallTimers(call: Call): void {
    if (call.callTimer !== undefined) this.context.cancel(call.callTimer);
    if (call.retryTimer !== undefined) this.context.cancel(call.retryTimer);
    call.callTimer = undefined;
    call.retryTimer = undefined;
  }

  /**
   * Where a request goes next.
   *
   * `terminal` and `unreachable` are deliberately separate: a database at the
   * end of the chain serves the request, while a load balancer whose whole
   * pool is down must report failure rather than answer on its behalf.
   */
  private route(node: SimNode, body: RequestBody): RouteOutcome {
    // Requests follow the direction links are drawn, never back upstream, and
    // never to a client — clients originate traffic, they do not serve it —
    // nor to a lock service, which only speaks the lock protocol. A node
    // already on the path is skipped so cycles cannot loop forever.
    const configured = this.network.topology
      .targetsOf(node.id)
      .filter((id) => !body.path.includes(id) && !NOT_SERVERS.has(this.registry.get(id)?.type ?? 'client'));
    if (configured.length === 0) return { kind: 'terminal' };

    const reachable = new Set(this.network.topology.enabledTargetsOf(node.id));
    const excluded: RoutingExclusionView[] = [];
    const healthy: SimNode[] = [];
    for (const id of configured) {
      const candidate = this.registry.get(id);
      if (!candidate) continue;
      if (candidate.state.status === 'failed') excluded.push({ id, reason: 'node_failed' });
      else if (!reachable.has(id)) excluded.push({ id, reason: 'link_down' });
      else healthy.push(candidate);
    }
    const eligible = this.data.filterCandidates(node, body, healthy);
    if (eligible.length !== healthy.length) {
      const kept = new Set(eligible.map((c) => c.id));
      for (const candidate of healthy) if (!kept.has(candidate.id)) excluded.push({ id: candidate.id, reason: 'ineligible' });
    }
    if (eligible.length === 0) return { kind: 'unreachable' };

    // Open circuits take a target out of consideration until it may be probed.
    const candidates = eligible.filter((c) => this.breakerAllows(node, c.id));
    if (candidates.length === 0) return { kind: 'circuit_open', targets: eligible.map((c) => c.id) };

    const target = this.routing.select(node, body, candidates, excluded);
    return target ? { kind: 'forward', target } : { kind: 'unreachable' };
  }

  /** `id` if the caller could send to it right now — wired, reachable, up, and not behind an open circuit. */
  private directTarget(caller: Caller, id: NodeId): SimNode | undefined {
    const node = this.registry.get(id);
    if (!node || node.state.status === 'failed' || node.type === 'client') return undefined;
    if (bodyOf(caller).path.includes(id)) return undefined;
    if (!this.network.topology.enabledTargetsOf(caller.node.id).includes(id)) return undefined;
    return this.breakerAllows(caller.node, id) ? node : undefined;
  }

  private callerFor(nodeId: NodeId, requestId: RequestId, workId: MessageId | undefined): Caller | undefined {
    const node = this.registry.get(nodeId);
    if (!node) return undefined;
    if (workId !== undefined) {
      const worker = this.workerFor(nodeId);
      const item = worker.work.get(workId);
      return item ? { kind: 'work', node, worker, item } : undefined;
    }
    const origin = this.origins.get(requestId);
    return origin && origin.clientId === nodeId ? { kind: 'origin', node, origin } : undefined;
  }

  private scheduleTimeout(payload: EventPayloadMap['TIMEOUT']): EventId {
    return this.context.scheduleAt(
      { type: 'TIMEOUT', payload, nodeId: payload.nodeId },
      Math.max(this.context.now(), payload.deadlineAt),
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
        waiting: worker.waiting.map((item) => item.workId),
        work: [...worker.work.values()].map((item) => ({ ...item, call: { ...item.call } })),
        outbound: [...worker.outbound.entries()],
        active: [...worker.active.entries()],
        queued: [...worker.queued.entries()],
      })),
      origins: [...this.origins.values()].map((origin) => ({ ...origin, call: { ...origin.call } })),
      breakers: [...this.breakers.entries()].map(([key, state]) => [key, { ...state, outcomes: [...state.outcomes] }] as const),
    };
  }

  restoreState(state: NodeRuntimeState): void {
    this.workers = new Map();
    for (const saved of state.workers) {
      const worker = new NodeWorker();
      for (const item of saved.work) worker.work.set(item.workId, { ...item, call: { ...item.call } });
      // Waiting entries must be the same objects as in `work`: release() finds them by identity.
      for (const workId of saved.waiting) {
        const item = worker.work.get(workId);
        if (item) worker.waiting.push(item);
      }
      for (const [outbound, workId] of saved.outbound) worker.outbound.set(outbound, workId);
      for (const [name, count] of saved.active) worker.active.set(name, count);
      for (const [name, count] of saved.queued) worker.queued.set(name, count);
      this.workers.set(saved.nodeId, worker);
    }
    this.origins = new Map(state.origins.map((origin) => [origin.requestId, { ...origin, call: { ...origin.call } }]));
    this.originByOutbound = new Map();
    for (const origin of this.origins.values()) {
      if (origin.call.outboundSpan !== undefined) this.originByOutbound.set(origin.call.outboundSpan, origin.requestId);
    }
    this.breakers = new Map(state.breakers.map(([key, s]) => [key, { ...s, outcomes: [...s.outcomes] }]));
  }

  /** Read-only view for inspection: what each node is holding right now. */
  inspect(nodeId: NodeId): { waiting: number; working: number; calling: number; retrying: number; deferred: number } {
    const worker = this.workers.get(nodeId);
    const counts = { waiting: 0, working: 0, calling: 0, retrying: 0, deferred: 0 };
    if (!worker) return counts;
    counts.waiting = worker.waiting.length;
    for (const item of worker.work.values()) {
      if (item.state === 'processing') counts.working += 1;
      else if (item.state === 'calling') counts.calling += 1;
      else if (item.state === 'retry_wait') counts.retrying += 1;
      else if (item.state === 'deferred') counts.deferred += 1;
    }
    return counts;
  }

  /** Current circuit state from `node` to `target`, for the UI. */
  circuit(node: NodeId, target: NodeId): BreakerState['mode'] {
    return (this.breakers.get(`${node}|${target}`) ?? CLOSED).mode;
  }

  static isRequest(message: Message): message is RequestMessage {
    return message.kind === 'REQUEST';
  }
}

/** Node types that never serve application requests. */
const NOT_SERVERS = new Set<NodeType>(['client', 'lock_service']);

function newCall(): Call {
  return {
    attempt: 0,
    outboundSpan: undefined,
    target: undefined,
    sentAt: 0,
    callTimer: undefined,
    retryTimer: undefined,
    lastDelay: undefined,
    probe: false,
  };
}

function callOf(caller: Caller): Call {
  return caller.kind === 'origin' ? caller.origin.call : caller.item.call;
}

function bodyOf(caller: Caller): RequestBody {
  return caller.kind === 'origin' ? caller.origin.body : caller.item.inbound.payload;
}

function requestIdOf(caller: Caller): RequestId {
  return caller.kind === 'origin' ? caller.origin.requestId : caller.item.inbound.requestId;
}

function traceIdOf(caller: Caller): TraceId {
  return caller.kind === 'origin' ? caller.origin.traceId : caller.item.inbound.traceId;
}

function bulkheadFor(config: NodeConfig, workloadId: string | undefined): BulkheadPolicy | undefined {
  if (!config.bulkheads || workloadId === undefined) return undefined;
  return config.bulkheads.find((b) => b.workloads.includes(workloadId));
}

function bulkheadNamed(config: NodeConfig, name: string | undefined): BulkheadPolicy | undefined {
  return name === undefined ? undefined : config.bulkheads?.find((b) => b.name === name);
}

function breakerPolicyOf(config: NodeConfig): BreakerPolicy | undefined {
  const policy = config.circuitBreaker;
  if (!policy) return undefined;
  return {
    failureThreshold: policy.failureThreshold,
    cooldownMs: policy.cooldownMs,
    halfOpenMaxCalls: policy.halfOpenMaxCalls ?? 1,
    ...(policy.failureRateThreshold !== undefined ? { failureRateThreshold: policy.failureRateThreshold } : {}),
    ...(policy.windowMs !== undefined ? { windowMs: policy.windowMs } : {}),
    minimumRequests: policy.minimumRequests ?? policy.failureThreshold,
  };
}

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
