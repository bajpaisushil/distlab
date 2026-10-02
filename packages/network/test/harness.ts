import {
  IdFactory,
  Rng,
  type Duration,
  type EventDraft,
  type EventId,
  type EventType,
  type Message,
  type RequestId,
  type SimEvent,
  type SimTime,
  type SimulationContext,
  type SpanId,
  type TraceId,
} from '@distlab/shared';
import type { SendRequest } from '../src/network.js';

/**
 * A minimal event loop implementing `SimulationContext`.
 *
 * The network package depends on that interface and nothing else, so it can be
 * exercised without the engine at all. If this harness ever stops compiling,
 * the network has grown a dependency it should not have.
 */
export class TestContext implements SimulationContext {
  readonly ids = new IdFactory();
  private readonly rng = new Rng('harness');
  private readonly streams = new Map<string, Rng>();
  private readonly handlers = new Map<EventType, ((event: SimEvent<never>) => void)[]>();
  private queue: SimEvent[] = [];
  private cancelled = new Set<EventId>();
  private clock: SimTime = 0;
  private sequence = 0;
  readonly processed: SimEvent[] = [];

  now(): SimTime {
    return this.clock;
  }

  stream(label: string): Rng {
    let stream = this.streams.get(label);
    if (!stream) {
      stream = this.rng.derive(label);
      this.streams.set(label, stream);
    }
    return stream;
  }

  schedule<T extends EventType>(draft: EventDraft<T>, delay: Duration = 0): SimEvent<T> {
    return this.scheduleAt(draft, this.clock + Math.max(0, delay));
  }

  scheduleAt<T extends EventType>(draft: EventDraft<T>, at: SimTime): SimEvent<T> {
    const event = {
      id: this.ids.event(),
      seq: this.sequence++,
      type: draft.type,
      at,
      createdAt: this.clock,
      payload: draft.payload,
    } as SimEvent<T>;
    this.queue.push(event);
    return event;
  }

  cancel(id: EventId): boolean {
    this.cancelled.add(id);
    return true;
  }

  on<T extends EventType>(type: T, handler: (event: SimEvent<T>) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler as (event: SimEvent<never>) => void);
    this.handlers.set(type, list);
  }

  /** Processes every event in `(at, seq)` order until the queue drains. */
  drain(limit = 10_000): void {
    for (let i = 0; i < limit; i++) {
      this.queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.queue.shift();
      if (!next) return;
      if (this.cancelled.has(next.id)) continue;
      this.clock = Math.max(this.clock, next.at);
      this.processed.push(next);
      for (const handler of this.handlers.get(next.type) ?? []) {
        (handler as (event: SimEvent) => void)(next);
      }
    }
    throw new Error('drain limit exceeded');
  }

  eventsOfType<T extends EventType>(type: T): SimEvent<T>[] {
    return this.processed.filter((e): e is SimEvent<T> => e.type === type);
  }

  received(): Message[] {
    return this.eventsOfType('MESSAGE_RECEIVED').map((e) => e.payload.message);
  }
}

let counter = 0;

export function request(overrides: Partial<SendRequest> = {}): SendRequest {
  counter += 1;
  return {
    kind: 'REQUEST',
    source: 'a',
    destination: 'b',
    type: 'HTTP_GET',
    payload: { operation: 'HTTP_GET', path: ['a'], deadlineAt: 1_000_000 },
    sizeBytes: 512,
    requestId: `r-${counter}` as RequestId,
    traceId: `t-${counter}` as TraceId,
    spanId: `s-${counter}` as SpanId,
    hop: 0,
    ...overrides,
  };
}
