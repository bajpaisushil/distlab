import type { EventId, SimEvent } from '@distlab/shared';
import { invariant } from '@distlab/shared';

/**
 * Priority queue of pending simulation events.
 *
 * Ordering is `(at, seq)`. The sequence number is what makes the ordering
 * *total*: many events land on the same virtual millisecond, and without a
 * deterministic tie-break the heap's internal layout would decide their order —
 * stable within one run, but not necessarily across runs or engine versions.
 *
 * Implemented as a binary min-heap with lazy deletion: cancelling marks an id
 * and the entry is discarded when it surfaces, so cancellation is O(1) and the
 * common path (push/pop) stays O(log n).
 */
export class EventQueue {
  private heap: SimEvent[] = [];
  private pending = new Set<EventId>();
  private cancelled = new Set<EventId>();

  /** Number of live (non-cancelled) events waiting. */
  get size(): number {
    return this.pending.size;
  }

  get isEmpty(): boolean {
    return this.pending.size === 0;
  }

  push(event: SimEvent): void {
    invariant(!this.pending.has(event.id), `event ${event.id} is already queued`);
    this.pending.add(event.id);
    this.heap.push(event);
    this.siftUp(this.heap.length - 1);
  }

  /** The next event without removing it, or undefined when nothing is left. */
  peek(): SimEvent | undefined {
    this.discardCancelledRoot();
    return this.heap[0];
  }

  pop(): SimEvent | undefined {
    this.discardCancelledRoot();
    const top = this.heap[0];
    if (top === undefined) return undefined;
    this.removeRoot();
    this.pending.delete(top.id);
    return top;
  }

  cancel(id: EventId): boolean {
    if (!this.pending.has(id)) return false;
    this.pending.delete(id);
    this.cancelled.add(id);
    return true;
  }

  has(id: EventId): boolean {
    return this.pending.has(id);
  }

  clear(): void {
    this.heap = [];
    this.pending.clear();
    this.cancelled.clear();
  }

  /**
   * Live events in the exact order they will be processed. For inspection and
   * tests; O(n log n), so not for the hot path.
   */
  toSortedArray(): SimEvent[] {
    return this.heap.filter((e) => this.pending.has(e.id)).sort(compareEvents);
  }

  private discardCancelledRoot(): void {
    while (this.heap.length > 0) {
      const top = this.heap[0] as SimEvent;
      if (!this.cancelled.has(top.id)) return;
      this.cancelled.delete(top.id);
      this.removeRoot();
    }
  }

  private removeRoot(): void {
    const last = this.heap.pop() as SimEvent;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.siftDown(0);
    }
  }

  private siftUp(startIndex: number): void {
    let index = startIndex;
    const item = this.heap[index] as SimEvent;
    while (index > 0) {
      const parentIndex = (index - 1) >> 1;
      const parent = this.heap[parentIndex] as SimEvent;
      if (compareEvents(item, parent) >= 0) break;
      this.heap[index] = parent;
      index = parentIndex;
    }
    this.heap[index] = item;
  }

  private siftDown(startIndex: number): void {
    let index = startIndex;
    const length = this.heap.length;
    const item = this.heap[index] as SimEvent;
    for (;;) {
      const left = 2 * index + 1;
      if (left >= length) break;
      const right = left + 1;
      const childIndex =
        right < length && compareEvents(this.heap[right] as SimEvent, this.heap[left] as SimEvent) < 0
          ? right
          : left;
      const child = this.heap[childIndex] as SimEvent;
      if (compareEvents(child, item) >= 0) break;
      this.heap[index] = child;
      index = childIndex;
    }
    this.heap[index] = item;
  }
}

/** Total order over events: virtual time first, insertion sequence as tie-break. */
export function compareEvents(a: SimEvent, b: SimEvent): number {
  if (a.at !== b.at) return a.at - b.at;
  return a.seq - b.seq;
}
