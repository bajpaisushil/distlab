import { describe, expect, it } from 'vitest';
import type { EventId, SimEvent } from '@distlab/shared';
import { EventQueue, compareEvents } from '../src/event-queue.js';

let counter = 0;
function event(at: number, seq = counter++): SimEvent<'NODE_RECOVERED'> {
  return {
    id: `e-${at}-${seq}` as EventId,
    seq,
    type: 'NODE_RECOVERED',
    at,
    createdAt: 0,
    payload: { nodeId: 'n' },
  };
}

describe('EventQueue ordering', () => {
  it('pops events in virtual-time order regardless of insertion order', () => {
    const queue = new EventQueue();
    for (const at of [50, 10, 90, 30, 70, 20]) queue.push(event(at));
    const order: number[] = [];
    for (let e = queue.pop(); e; e = queue.pop()) order.push(e.at);
    expect(order).toEqual([10, 20, 30, 50, 70, 90]);
  });

  it('breaks ties on the same timestamp by insertion sequence', () => {
    const queue = new EventQueue();
    const a = event(100, 7);
    const b = event(100, 3);
    const c = event(100, 5);
    queue.push(a);
    queue.push(b);
    queue.push(c);
    expect([queue.pop()?.seq, queue.pop()?.seq, queue.pop()?.seq]).toEqual([3, 5, 7]);
  });

  it('orders a large randomised batch identically to a sort of the same batch', () => {
    const queue = new EventQueue();
    const events: SimEvent[] = [];
    // Deliberately heavy on duplicate timestamps so the tie-break is exercised.
    for (let i = 0; i < 2000; i++) events.push(event((i * 7919) % 50, i));
    for (const e of events) queue.push(e);
    const popped: SimEvent[] = [];
    for (let e = queue.pop(); e; e = queue.pop()) popped.push(e);
    expect(popped.map((e) => e.id)).toEqual([...events].sort(compareEvents).map((e) => e.id));
  });

  it('peek does not consume', () => {
    const queue = new EventQueue();
    queue.push(event(10));
    expect(queue.peek()?.at).toBe(10);
    expect(queue.peek()?.at).toBe(10);
    expect(queue.size).toBe(1);
  });

  it('reports empty state', () => {
    const queue = new EventQueue();
    expect(queue.isEmpty).toBe(true);
    expect(queue.pop()).toBeUndefined();
    expect(queue.peek()).toBeUndefined();
  });
});

describe('EventQueue cancellation', () => {
  it('skips cancelled events and keeps the rest in order', () => {
    const queue = new EventQueue();
    const first = event(10);
    const second = event(20);
    const third = event(30);
    queue.push(first);
    queue.push(second);
    queue.push(third);

    expect(queue.cancel(second.id)).toBe(true);
    expect(queue.size).toBe(2);

    const order: number[] = [];
    for (let e = queue.pop(); e; e = queue.pop()) order.push(e.at);
    expect(order).toEqual([10, 30]);
  });

  it('cancels the head of the queue', () => {
    const queue = new EventQueue();
    const head = event(1);
    queue.push(head);
    queue.push(event(2));
    queue.cancel(head.id);
    expect(queue.peek()?.at).toBe(2);
  });

  it('returns false for events that are not pending', () => {
    const queue = new EventQueue();
    const e = event(10);
    queue.push(e);
    expect(queue.cancel('missing' as EventId)).toBe(false);
    queue.pop();
    expect(queue.cancel(e.id)).toBe(false);
  });

  it('clears everything, including cancellations', () => {
    const queue = new EventQueue();
    const e = event(10);
    queue.push(e);
    queue.cancel(e.id);
    queue.clear();
    expect(queue.size).toBe(0);
    expect(queue.pop()).toBeUndefined();
  });

  it('exposes the live schedule in processing order', () => {
    const queue = new EventQueue();
    const a = event(30);
    const b = event(10);
    const c = event(20);
    queue.push(a);
    queue.push(b);
    queue.push(c);
    queue.cancel(c.id);
    expect(queue.toSortedArray().map((e) => e.at)).toEqual([10, 30]);
  });
});
