import {
  sampleLatency,
  type DropReason,
  type EventId,
  type LinkConfig,
  type LinkId,
  type Message,
  type MessageKind,
  type MessagePayload,
  type NodeId,
  type PartitionSpec,
  type OperationType,
  type RequestId,
  type SimEvent,
  type SimTime,
  type SimulationContext,
  type SpanId,
  type TraceId,
} from '@distlab/shared';
import { Topology } from './topology.js';

export interface SendRequest {
  readonly kind: MessageKind;
  readonly source: NodeId;
  readonly destination: NodeId;
  readonly type: OperationType;
  readonly payload: MessagePayload;
  readonly sizeBytes: number;
  readonly requestId: RequestId;
  readonly traceId: TraceId;
  readonly spanId: SpanId;
  readonly parentSpanId?: SpanId;
  readonly hop: number;
  readonly causedBy?: EventId;
}

export interface NetworkOptions {
  readonly context: SimulationContext;
  readonly links: readonly LinkConfig[];
  readonly partitions?: readonly PartitionSpec[];
  /**
   * Whether a node is up. The network asks rather than tracks, because node
   * liveness belongs to the engine; a crashed host still has packets arrive at
   * it, and the network's job is only to decide whether they get there.
   */
  readonly isNodeUp?: (id: NodeId) => boolean;
}


export interface NetworkStats {
  sent: number;
  delivered: number;
  dropped: number;
  duplicated: number;
  reordered: number;
  bytesTransferred: number;
}

/**
 * The simulated network.
 *
 * Nodes hand messages here instead of calling each other. Everything that makes
 * distributed systems hard — a message arriving late, twice, or not at all —
 * happens in this one place, driven entirely by per-link random streams so that
 * a seed reproduces the exact same pattern of misfortune.
 *
 * Delivery is event-sourced: `send` schedules `MESSAGE_SENT`, and the handler
 * for that event rolls the impairments and schedules `MESSAGE_RECEIVED` or
 * `MESSAGE_DROPPED`. No node is ever invoked directly by another.
 */
export class SimulatedNetwork {
  readonly topology: Topology;
  readonly stats: NetworkStats = {
    sent: 0,
    delivered: 0,
    dropped: 0,
    duplicated: 0,
    reordered: 0,
    bytesTransferred: 0,
  };

  private readonly context: SimulationContext;
  private readonly isNodeUp: (id: NodeId) => boolean;
  /** Per direction: when the link finishes transmitting what it already holds. */
  private readonly busyUntil = new Map<string, SimTime>();

  constructor(options: NetworkOptions) {
    this.context = options.context;
    this.topology = new Topology(options.links, options.partitions ?? []);
    this.isNodeUp = options.isNodeUp ?? (() => true);
  }

  /** Registers the delivery pipeline. Call once, before the simulation runs. */
  attach(on: <T extends 'MESSAGE_SENT'>(type: T, handler: (event: SimEvent<T>) => void) => unknown): void {
    on('MESSAGE_SENT', (event) => this.handleSent(event));
  }

  /**
   * Hands a message to the network. Returns the message as it was admitted, or
   * undefined when there is no link at all between the two nodes — the one
   * failure the sender can know about synchronously, because it is a
   * configuration error rather than a runtime event.
   */
  send(request: SendRequest): Message | undefined {
    const link = this.topology.linkFor(request.source, request.destination);
    const message = this.buildMessage(request, this.context.now());

    if (!link) {
      this.drop(message, 'no_link', undefined, request.causedBy);
      return undefined;
    }

    this.stats.sent += 1;
    this.context.schedule(
      {
        type: 'MESSAGE_SENT',
        payload: { message, linkId: link.id },
        nodeId: request.source,
        traceId: request.traceId,
        ...(request.causedBy !== undefined ? { causedBy: request.causedBy } : {}),
      },
      0,
    );
    return message;
  }

  setLinkEnabled(linkId: LinkId, enabled: boolean): boolean {
    return this.topology.updateLink(linkId, { enabled }) !== undefined;
  }

  addPartition(partition: PartitionSpec): void {
    this.topology.addPartition(partition);
  }

  removePartition(id: string): boolean {
    return this.topology.removePartition(id);
  }

  private handleSent(event: SimEvent<'MESSAGE_SENT'>): void {
    const { message, linkId } = event.payload;
    const link = this.topology.getLink(linkId);
    if (!link) {
      this.drop(message, 'no_link', linkId, event.id);
      return;
    }

    const blocked = this.blockedReason(link, message);
    if (blocked) {
      this.drop(message, blocked, linkId, event.id);
      return;
    }

    // One stream per link: adding or removing a link must not perturb the
    // sequence of misfortune on any other link.
    const rng = this.context.stream(`network:${linkId}`);

    if (rng.bool(link.lossRate)) {
      this.drop(message, 'packet_loss', linkId, event.id);
      return;
    }

    const direction = `${linkId}|${message.source}->${message.destination}`;
    const transmit = this.transmissionDelay(link, direction, message.sizeBytes);
    let delay = transmit + sampleLatency(link.latency, rng);

    const reordered = rng.bool(link.reorderRate);
    if (reordered) {
      // An extra delay is what reordering physically is: this message now lands
      // behind one that left later. Nothing is swapped by hand.
      delay += sampleLatency(link.reorderDelay, rng);
      this.stats.reordered += 1;
    }

    this.deliver(message, delay, event.id);

    if (rng.bool(link.duplicateRate)) {
      const copy = this.buildMessage(
        {
          kind: message.kind,
          source: message.source,
          destination: message.destination,
          type: message.type,
          payload: message.payload,
          sizeBytes: message.sizeBytes,
          requestId: message.requestId,
          traceId: message.traceId,
          spanId: message.spanId,
          ...(message.parentSpanId !== undefined ? { parentSpanId: message.parentSpanId } : {}),
          hop: message.hop,
        },
        message.createdAt,
        message.id,
      );
      const duplicateDelay =
        this.transmissionDelay(link, direction, copy.sizeBytes) + sampleLatency(link.latency, rng);
      this.stats.duplicated += 1;
      this.context.schedule(
        {
          type: 'MESSAGE_DUPLICATED',
          payload: { originalId: message.id, duplicateId: copy.id, linkId },
          traceId: message.traceId,
          causedBy: event.id,
        },
        0,
      );
      this.deliver(copy, duplicateDelay, event.id);
    }
  }

  /** Reasons a link refuses to carry a message, checked in order of specificity. */
  private blockedReason(link: LinkConfig, message: Message): DropReason | undefined {
    if (!link.enabled) return 'link_down';
    if (this.topology.isPartitioned(message.source, message.destination)) return 'partitioned';
    if (!this.isNodeUp(message.source)) return 'source_failed';
    if (!this.isNodeUp(message.destination)) return 'destination_failed';
    return undefined;
  }

  /**
   * Store-and-forward serialisation. With a bandwidth limit, messages queue
   * behind each other on the wire, so a burst of large messages genuinely
   * congests the link instead of all arriving at the same instant.
   */
  private transmissionDelay(link: LinkConfig, direction: string, sizeBytes: number): number {
    if (link.bandwidthBytesPerSec <= 0) return 0;
    const now = this.context.now();
    const serialization = (sizeBytes / link.bandwidthBytesPerSec) * 1000;
    const start = Math.max(now, this.busyUntil.get(direction) ?? now);
    this.busyUntil.set(direction, start + serialization);
    return start - now + serialization;
  }

  private deliver(message: Message, delay: number, causedBy: EventId): void {
    const deliverAt = this.context.now() + Math.max(0, delay);
    const delivered: Message = { ...message, deliverAt, status: 'delivered' };
    this.stats.delivered += 1;
    this.stats.bytesTransferred += message.sizeBytes;
    this.context.scheduleAt(
      {
        type: 'MESSAGE_RECEIVED',
        payload: { message: delivered },
        nodeId: message.destination,
        traceId: message.traceId,
        causedBy,
      },
      deliverAt,
    );
  }

  private drop(message: Message, reason: DropReason, linkId: LinkId | undefined, causedBy?: EventId): void {
    this.stats.dropped += 1;
    this.context.schedule(
      {
        type: 'MESSAGE_DROPPED',
        payload: {
          messageId: message.id,
          requestId: message.requestId,
          source: message.source,
          destination: message.destination,
          reason,
          ...(linkId !== undefined ? { linkId } : {}),
        },
        nodeId: message.source,
        traceId: message.traceId,
        ...(causedBy !== undefined ? { causedBy } : {}),
      },
      0,
    );
  }

  private buildMessage(request: Omit<SendRequest, 'causedBy'>, createdAt: SimTime, duplicateOf?: Message['id']): Message {
    return {
      id: this.context.ids.message(),
      kind: request.kind,
      source: request.source,
      destination: request.destination,
      type: request.type,
      payload: request.payload,
      sizeBytes: request.sizeBytes,
      createdAt,
      deliverAt: createdAt,
      status: 'in_flight',
      requestId: request.requestId,
      traceId: request.traceId,
      spanId: request.spanId,
      ...(request.parentSpanId !== undefined ? { parentSpanId: request.parentSpanId } : {}),
      hop: request.hop,
      ...(duplicateOf !== undefined ? { duplicateOf } : {}),
    };
  }
}
