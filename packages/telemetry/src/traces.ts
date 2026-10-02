import type {
  NodeId,
  OperationType,
  RequestId,
  SimEvent,
  SimTime,
  SpanId,
  TraceId,
} from '@distlab/shared';

export type SpanStatus = 'open' | 'ok' | 'error' | 'rejected' | 'unreachable' | 'timeout';

export interface Span {
  readonly traceId: TraceId;
  readonly spanId: SpanId;
  readonly parentSpanId?: SpanId;
  readonly name: string;
  readonly nodeId: NodeId;
  /** `client` is the originator's view of the whole request; `server` is one hop handling it. */
  readonly kind: 'client' | 'server';
  readonly startedAt: SimTime;
  endedAt?: SimTime;
  duration?: number;
  status: SpanStatus;
  readonly attributes: Record<string, string | number | boolean>;
}

export interface Trace {
  readonly traceId: TraceId;
  readonly requestId: RequestId;
  readonly clientId: NodeId;
  readonly operation: OperationType;
  readonly startedAt: SimTime;
  endedAt?: SimTime;
  duration?: number;
  status: SpanStatus;
  /** In start order, which is also the order a waterfall renders them. */
  readonly spans: Span[];
}

/**
 * Builds distributed traces from the event stream.
 *
 * Spans are derived from message events rather than declared by nodes: a server
 * span opens when a node receives a request and closes when it sends the reply,
 * so the gap between a parent span starting and its child starting *is* the
 * network time. Nothing has to be instrumented by hand, and a span can never
 * disagree with what the simulation actually did.
 */
export class TraceCollector {
  private readonly traces = new Map<TraceId, Trace>();

  constructor(private readonly capacity = 5000) {}

  observe(event: SimEvent): void {
    switch (event.type) {
      case 'REQUEST_CREATED':
        return this.onCreated(event as SimEvent<'REQUEST_CREATED'>);
      case 'MESSAGE_RECEIVED':
        return this.onReceived(event as SimEvent<'MESSAGE_RECEIVED'>);
      case 'MESSAGE_SENT':
        return this.onSent(event as SimEvent<'MESSAGE_SENT'>);
      case 'REQUEST_COMPLETED':
        return this.close(
          (event as SimEvent<'REQUEST_COMPLETED'>).payload.traceId,
          'ok',
          event.at,
        );
      case 'REQUEST_FAILED': {
        const payload = (event as SimEvent<'REQUEST_FAILED'>).payload;
        return this.close(payload.traceId, payload.status as SpanStatus, event.at);
      }
      default:
        return;
    }
  }

  get(traceId: TraceId): Trace | undefined {
    return this.traces.get(traceId);
  }

  all(): readonly Trace[] {
    return [...this.traces.values()];
  }

  /** Slowest finished traces first — the ones worth opening. */
  slowest(limit = 20): Trace[] {
    return this.all()
      .filter((trace) => trace.duration !== undefined)
      .sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))
      .slice(0, limit);
  }

  failed(): Trace[] {
    return this.all().filter((trace) => trace.status !== 'ok' && trace.status !== 'open');
  }

  clear(): void {
    this.traces.clear();
  }

  private onCreated(event: SimEvent<'REQUEST_CREATED'>): void {
    const { traceId, requestId, clientId, operation, spanId } = event.payload;
    const trace: Trace = {
      traceId,
      requestId,
      clientId,
      operation,
      startedAt: event.at,
      status: 'open',
      spans: [
        {
          traceId,
          spanId,
          name: `${operation} ${clientId}`,
          nodeId: clientId,
          kind: 'client',
          startedAt: event.at,
          status: 'open',
          attributes: { operation },
        },
      ],
    };
    this.traces.set(traceId, trace);
    this.evict();
  }

  private onReceived(event: SimEvent<'MESSAGE_RECEIVED'>): void {
    const message = event.payload.message;
    if (message.kind !== 'REQUEST') return;
    const trace = this.traces.get(message.traceId);
    if (!trace) return;
    trace.spans.push({
      traceId: message.traceId,
      spanId: message.spanId,
      ...(message.parentSpanId !== undefined ? { parentSpanId: message.parentSpanId } : {}),
      name: `${message.type} ${message.destination}`,
      nodeId: message.destination,
      kind: 'server',
      startedAt: event.at,
      status: 'open',
      attributes: {
        hop: message.hop,
        from: message.source,
        ...(message.duplicateOf !== undefined ? { duplicate: true } : {}),
      },
    });
  }

  private onSent(event: SimEvent<'MESSAGE_SENT'>): void {
    const message = event.payload.message;
    if (message.kind !== 'RESPONSE') return;
    const trace = this.traces.get(message.traceId);
    if (!trace) return;
    // The first still-open span with this id: a duplicated request opens two,
    // and they close in the order they were answered.
    const span = trace.spans.find((s) => s.spanId === message.spanId && s.status === 'open');
    if (!span) return;
    const status = (message.payload as { status: SpanStatus }).status;
    finish(span, event.at, status);
  }

  private close(traceId: TraceId, status: SpanStatus, at: SimTime): void {
    const trace = this.traces.get(traceId);
    if (!trace) return;
    trace.status = status;
    trace.endedAt = at;
    trace.duration = at - trace.startedAt;
    // Spans still open when the request settled were abandoned — a lost message
    // or a hop that timed out. They end here, marked with the trace's outcome.
    for (const span of trace.spans) {
      if (span.status === 'open') finish(span, at, status);
    }
  }

  private evict(): void {
    while (this.traces.size > this.capacity) {
      const oldest = this.traces.keys().next();
      if (oldest.done) return;
      this.traces.delete(oldest.value);
    }
  }
}

function finish(span: Span, at: SimTime, status: SpanStatus): void {
  span.endedAt = at;
  span.duration = at - span.startedAt;
  span.status = status;
}
