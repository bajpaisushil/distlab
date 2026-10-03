import type { EventId, EventType, SimEvent, TraceId } from '@distlab/shared';

/**
 * The ordered record of every event the simulation has processed.
 *
 * This is the substrate for replay and time travel: because the engine is
 * deterministic, the log plus the seed is a complete description of what
 * happened, and "the state before event #481" is answerable by replaying the
 * first 480 entries rather than by storing 481 copies of the world.
 */
export class EventLog {
  private entries: SimEvent[] = [];
  private byId = new Map<EventId, SimEvent>();
  private dropped = 0;

  /** `capacity` bounds memory on very long runs; the oldest entries fall off. */
  constructor(private readonly capacity: number = Number.POSITIVE_INFINITY) {}

  get size(): number {
    return this.entries.length;
  }

  /** How many entries were discarded to stay within capacity. */
  get droppedCount(): number {
    return this.dropped;
  }

  /** Total processed events, including ones no longer retained. */
  get totalAppended(): number {
    return this.dropped + this.entries.length;
  }

  append(event: SimEvent): void {
    this.entries.push(event);
    this.byId.set(event.id, event);
    while (this.entries.length > this.capacity) {
      const removed = this.entries.shift();
      if (removed) this.byId.delete(removed.id);
      this.dropped += 1;
    }
  }

  /** The n-th processed event, counted from the start of the run. */
  at(index: number): SimEvent | undefined {
    const offset = index - this.dropped;
    if (offset < 0 || offset >= this.entries.length) return undefined;
    return this.entries[offset];
  }

  find(id: EventId): SimEvent | undefined {
    return this.byId.get(id);
  }

  all(): readonly SimEvent[] {
    return this.entries;
  }

  slice(from: number, to?: number): readonly SimEvent[] {
    return this.entries.slice(from - this.dropped, to === undefined ? undefined : to - this.dropped);
  }

  byType<T extends EventType>(type: T): SimEvent<T>[] {
    return this.entries.filter((e): e is SimEvent<T> => e.type === type);
  }

  byTrace(traceId: TraceId): SimEvent[] {
    return this.entries.filter((e) => e.traceId === traceId);
  }

  /** Walks `causedBy` links back to the root, oldest first. */
  causalChain(id: EventId): SimEvent[] {
    const chain: SimEvent[] = [];
    let current = this.byId.get(id);
    const seen = new Set<EventId>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      chain.push(current);
      current = current.causedBy ? this.byId.get(current.causedBy) : undefined;
    }
    return chain.reverse();
  }

  clear(): void {
    this.entries = [];
    this.byId.clear();
    this.dropped = 0;
  }

  /** Replaces the log wholesale — events are immutable, so they are shared, not copied. */
  restore(entries: readonly SimEvent[], dropped: number): void {
    this.entries = [...entries];
    this.byId = new Map(entries.map((e) => [e.id, e]));
    this.dropped = dropped;
  }
}
