/**
 * Identifier types.
 *
 * Engine-generated identifiers are branded: they are only ever produced by
 * `IdFactory`, so branding catches real mix-ups (passing a span id where a
 * message id belongs) without making hand-authored JSON awkward.
 *
 * Author-supplied identifiers (`NodeId`, `LinkId`, `WorkloadId`) are plain
 * strings because they come straight out of a scenario file.
 */

declare const brand: unique symbol;
type Branded<T, B extends string> = T & { readonly [brand]: B };

export type NodeId = string;
export type LinkId = string;
export type WorkloadId = string;

export type EventId = Branded<string, 'EventId'>;
export type MessageId = Branded<string, 'MessageId'>;
export type RequestId = Branded<string, 'RequestId'>;
export type TraceId = Branded<string, 'TraceId'>;
export type SpanId = Branded<string, 'SpanId'>;

/**
 * Deterministic identifier source.
 *
 * Ids are monotonic counters rather than random values: two runs of the same
 * scenario with the same seed must produce byte-identical event logs, and a
 * random id generator would break that even when the simulation itself is
 * deterministic.
 */
export class IdFactory {
  private counters = new Map<string, number>();

  next(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}-${n}`;
  }

  event(): EventId {
    return this.next('e') as EventId;
  }

  message(): MessageId {
    return this.next('m') as MessageId;
  }

  request(): RequestId {
    return this.next('r') as RequestId;
  }

  trace(): TraceId {
    return this.next('t') as TraceId;
  }

  span(): SpanId {
    return this.next('s') as SpanId;
  }

  /** Current counter values, for snapshotting and replay. */
  snapshot(): Record<string, number> {
    return Object.fromEntries([...this.counters.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }

  restore(snapshot: Record<string, number>): void {
    this.counters = new Map(Object.entries(snapshot));
  }
}
