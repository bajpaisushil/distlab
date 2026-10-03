import type {
  Duration,
  EventId,
  EventPayloadMap,
  EventType,
  LatencySpec,
  Message,
  MessageId,
  MessageKind,
  NodeId,
  NodeType,
  RequestBody,
  RequestMessage,
  ResponseData,
  ResponseMessage,
  ResponseStatus,
  Rng,
  SimEvent,
  SimNode,
  SimulationContext,
  SpanId,
  TimerData,
  TraceId,
} from '@distlab/shared';
import type { SendRequest, SimulatedNetwork } from '@distlab/network';
import type { NodeRegistry } from '../node-registry.js';

export type Registrar = <T extends EventType>(type: T, handler: (event: SimEvent<T>) => void) => unknown;

export interface EmitMeta {
  readonly nodeId?: NodeId;
  readonly traceId?: TraceId;
  readonly causedBy?: EventId;
}

/**
 * What the engine offers a subsystem module. Modules never reach into each
 * other or into the kernel directly — everything goes through here, so every
 * effect is a scheduled event or a message on the simulated network.
 */
export interface ModuleServices {
  readonly context: SimulationContext;
  readonly registry: NodeRegistry;
  readonly network: SimulatedNetwork;
  /** Schedules an event for the current instant. */
  emit<T extends EventType>(type: T, payload: EventPayloadMap[T], meta?: EmitMeta): SimEvent<T>;
  /** Hands a message to the network. Undefined when no link exists at all. */
  send(request: SendRequest): Message | undefined;
  /** Answers a request on behalf of `node`, closing its trace span correctly. */
  reply(
    node: SimNode,
    request: RequestMessage,
    status: ResponseStatus,
    data?: ResponseData,
    causedBy?: EventId,
  ): void;
  /**
   * Arms a module timer at a node. It fires as a `TIMER` event, is dropped if
   * the node has crashed since, and is deferred while the node is paused.
   */
  setTimer(
    nodeId: NodeId,
    module: string,
    name: string,
    delay: Duration,
    data?: TimerData,
    causedBy?: EventId,
  ): EventId;
  cancelTimer(id: EventId): boolean;
  /** An independent random stream for one module at one node. */
  rng(module: string, nodeId: NodeId): Rng;
  /**
   * Finishes a request the data plane deferred (`serve` returned `defer`).
   * Returns false when the request was already abandoned — its deadline
   * passed or the node crashed — in which case nothing is sent.
   */
  completeDeferred(
    nodeId: NodeId,
    workId: MessageId,
    status: ResponseStatus,
    data?: ResponseData,
    causedBy?: EventId,
  ): boolean;
}

/**
 * A subsystem that speaks its own protocol: replication, queues, consensus,
 * locks. The runtime routes messages to it by kind, and request/response
 * traffic to it for the node types it serves.
 */
export interface SimModule {
  readonly name: string;
  /** Protocol message kinds this module receives. */
  readonly messageKinds: readonly MessageKind[];
  /** Node types whose request/response traffic this module handles instead of the default path. */
  readonly servesNodeTypes: readonly NodeType[];
  /** Registers any extra handlers (e.g. SIMULATION_STARTED to arm initial timers). */
  attach(on: Registrar): void;
  onMessage(node: SimNode, message: Message, event: SimEvent<'MESSAGE_RECEIVED'>): void;
  onTimer(node: SimNode, event: SimEvent<'TIMER'>): void;
  /** The process died: drop everything volatile. Durable state (e.g. a log on disk) may survive. */
  onNodeFailed(node: SimNode, event: SimEvent<'NODE_FAILED'>): void;
  onNodeRecovered(node: SimNode, event: SimEvent<'NODE_RECOVERED'>): void;
  /** Plain data only — no closures, no class instances — so a checkpoint can be restored into a fresh engine. */
  captureState(): unknown;
  restoreState(state: unknown): void;
}

export type ServeDecision =
  /** The node answers the request itself. */
  | { readonly kind: 'respond'; readonly status: ResponseStatus; readonly data?: ResponseData }
  /** Continue to downstream routing. */
  | { readonly kind: 'forward' }
  /** The answer comes later, via `ModuleServices.completeDeferred`. The worker slot stays held. */
  | { readonly kind: 'defer' };

export interface ServeRequest {
  readonly node: SimNode;
  readonly message: RequestMessage;
  readonly body: RequestBody;
  /** The node's server-side span for this request. */
  readonly spanId: SpanId;
  /** This delivery of the request — the key for `completeDeferred`. Distinct per duplicate copy. */
  readonly workId: MessageId;
  /** How long local processing took, already elapsed. */
  readonly serviceTime: number;
  readonly causedBy: EventId;
}

/**
 * Storage semantics on the request path: what a database, replica or cache
 * does with a request once it has been processed, and how requests are
 * steered between primaries and replicas.
 */
export interface DataPlane extends SimModule {
  /** Local processing time for this request at this node (read and write paths differ). */
  serviceLatency(node: SimNode, body: RequestBody): LatencySpec;
  /** Called once local processing finishes. */
  serve(request: ServeRequest): ServeDecision;
  /** Narrows routing candidates — writes only to primaries, reads by read preference. */
  filterCandidates(node: SimNode, body: RequestBody, candidates: readonly SimNode[]): readonly SimNode[];
  /** A forwarded request's response arrived, before it is relayed upstream. Returns data to attach. */
  onDownstreamResponse(
    node: SimNode,
    body: RequestBody,
    response: ResponseMessage,
    causedBy: EventId,
  ): ResponseData | undefined;
}

/**
 * Load balancing. The runtime asks it to choose and tells it what happened,
 * so stateful strategies (least connections, latency-aware) see exactly the
 * traffic the node actually sent.
 */
export interface RoutingPolicy {
  /** The strategy a node uses, as reported in REQUEST_ROUTED. */
  strategyName(node: SimNode): string;
  select(node: SimNode, body: RequestBody, candidates: readonly SimNode[]): SimNode | undefined;
  /** A request was sent from `node` to `target`. */
  onDispatch(node: SimNode, target: NodeId): void;
  /** That request finished — answered, failed or abandoned. */
  onOutcome(node: SimNode, target: NodeId, latencyMs: number, ok: boolean): void;
  captureState(): unknown;
  restoreState(state: unknown): void;
}
