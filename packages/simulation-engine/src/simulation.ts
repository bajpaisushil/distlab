import {
  IdFactory,
  Rng,
  invariant,
  type Duration,
  type EventDraft,
  type EventId,
  type EventType,
  type SimEvent,
  type SimTime,
  type SimulationContext,
  type SimulationEndReason,
} from '@distlab/shared';
import { EventLog } from './event-log.js';
import { EventQueue } from './event-queue.js';
import { SimulationClock } from './clock.js';

export type SimulationStatus = 'idle' | 'running' | 'paused' | 'completed';

export type EventHandler<T extends EventType> = (event: SimEvent<T>) => void;
export type EventObserver = (event: SimEvent) => void;

export interface SimulationLimits {
  /** Virtual time at which the run ends. */
  readonly durationMs: number;
  /** Hard cap on total processed events, as a runaway guard. */
  readonly maxEvents: number;
}

export interface RunOptions {
  /** Stop once the next event would fire after this virtual time. */
  readonly untilTime?: SimTime;
  /** Budget for this call only — how the UI pulls work in batches without blocking. */
  readonly maxEvents?: number;
}

export interface RunResult {
  readonly reason: SimulationEndReason;
  readonly eventsProcessed: number;
  readonly endedAt: SimTime;
  /** True when the run stopped on a per-call budget and more work remains. */
  readonly hasMore: boolean;
}

/**
 * The deterministic kernel: clock, event queue, random streams and dispatch.
 *
 * It knows nothing about nodes, networks or requests. Those are subsystems that
 * register handlers, which keeps the ordering guarantees testable in isolation
 * and stops domain logic from leaking into the scheduler.
 *
 * The one rule everything else rests on: state changes only in response to a
 * dequeued event, and events are totally ordered by `(at, seq)`.
 */
export class Simulation implements SimulationContext {
  readonly clock = new SimulationClock();
  readonly queue = new EventQueue();
  readonly ids = new IdFactory();
  readonly log: EventLog;
  readonly rng: Rng;
  readonly seed: string;

  private readonly handlers = new Map<EventType, EventHandler<never>[]>();
  private readonly observers: EventObserver[] = [];
  private readonly streams = new Map<string, Rng>();
  private readonly limits: SimulationLimits;

  private sequence = 0;
  private processed = 0;
  private state: SimulationStatus = 'idle';
  private endReason: SimulationEndReason | undefined;
  private stopRequested = false;

  constructor(options: { seed: string | number; limits: SimulationLimits; logCapacity?: number }) {
    this.seed = String(options.seed);
    this.rng = new Rng(this.seed);
    this.limits = options.limits;
    this.log = new EventLog(options.logCapacity ?? Number.POSITIVE_INFINITY);
  }

  get status(): SimulationStatus {
    return this.state;
  }

  get eventsProcessed(): number {
    return this.processed;
  }

  get completionReason(): SimulationEndReason | undefined {
    return this.endReason;
  }

  now(): SimTime {
    return this.clock.now();
  }

  stream(label: string): Rng {
    let stream = this.streams.get(label);
    if (!stream) {
      stream = this.rng.derive(label);
      this.streams.set(label, stream);
    }
    return stream;
  }

  // --- registration -------------------------------------------------------

  /**
   * Handlers run in registration order. That order is part of the determinism
   * contract, so subsystems must be wired in a fixed sequence.
   */
  on<T extends EventType>(type: T, handler: EventHandler<T>): () => void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler as EventHandler<never>);
    this.handlers.set(type, list);
    return () => {
      const current = this.handlers.get(type);
      if (!current) return;
      const index = current.indexOf(handler as EventHandler<never>);
      if (index >= 0) current.splice(index, 1);
    };
  }

  /**
   * Observes every processed event, after its handlers have run — so an
   * observer sees the state the event produced. This is how telemetry attaches
   * without the engine knowing telemetry exists.
   */
  observe(observer: EventObserver): () => void {
    this.observers.push(observer);
    return () => {
      const index = this.observers.indexOf(observer);
      if (index >= 0) this.observers.splice(index, 1);
    };
  }

  // --- scheduling ---------------------------------------------------------

  schedule<T extends EventType>(draft: EventDraft<T>, delay: Duration = 0): SimEvent<T> {
    return this.scheduleAt(draft, this.clock.now() + Math.max(0, delay));
  }

  scheduleAt<T extends EventType>(draft: EventDraft<T>, at: SimTime): SimEvent<T> {
    invariant(
      at >= this.clock.now(),
      `cannot schedule ${draft.type} at ${at}, which is before now=${this.clock.now()}`,
    );
    const event: SimEvent<T> = {
      id: this.ids.event(),
      seq: this.sequence++,
      type: draft.type,
      at,
      createdAt: this.clock.now(),
      payload: draft.payload,
      ...(draft.nodeId !== undefined ? { nodeId: draft.nodeId } : {}),
      ...(draft.traceId !== undefined ? { traceId: draft.traceId } : {}),
      ...(draft.causedBy !== undefined ? { causedBy: draft.causedBy } : {}),
    };
    this.queue.push(event);
    return event;
  }

  cancel(id: EventId): boolean {
    return this.queue.cancel(id);
  }

  // --- execution ----------------------------------------------------------

  /** Processes exactly one event. Returns undefined when the queue is empty. */
  step(): SimEvent | undefined {
    if (this.state === 'completed') return undefined;
    const event = this.queue.pop();
    if (event === undefined) return undefined;
    this.state = 'running';
    this.clock.advanceTo(event.at);
    this.processed += 1;
    this.dispatch(event);
    return event;
  }

  /** Processes up to `count` events, stopping early if the queue drains. */
  stepMany(count: number): SimEvent[] {
    const events: SimEvent[] = [];
    for (let i = 0; i < count; i++) {
      const event = this.step();
      if (!event) break;
      events.push(event);
    }
    return events;
  }

  /**
   * Runs until the queue drains, the time horizon is reached, or a budget is
   * exhausted. There is no real-time pacing here at all: 10,000 events complete
   * as fast as the CPU allows, and animating them is the UI's problem.
   */
  run(options: RunOptions = {}): RunResult {
    const untilTime = options.untilTime ?? this.limits.durationMs;
    const callBudget = options.maxEvents ?? Number.POSITIVE_INFINITY;
    this.stopRequested = false;
    if (this.state === 'completed') {
      return {
        reason: this.endReason ?? 'stopped',
        eventsProcessed: 0,
        endedAt: this.clock.now(),
        hasMore: false,
      };
    }
    this.state = 'running';

    let processedHere = 0;
    for (;;) {
      if (this.stopRequested) {
        this.state = 'paused';
        return { reason: 'stopped', eventsProcessed: processedHere, endedAt: this.clock.now(), hasMore: true };
      }
      if (processedHere >= callBudget) {
        this.state = 'paused';
        return {
          reason: 'stopped',
          eventsProcessed: processedHere,
          endedAt: this.clock.now(),
          hasMore: !this.queue.isEmpty,
        };
      }
      if (this.processed >= this.limits.maxEvents) {
        return this.complete('event_limit', processedHere);
      }
      const next = this.queue.peek();
      if (next === undefined) {
        return this.complete('queue_drained', processedHere);
      }
      if (next.at > untilTime) {
        // Advance to the horizon so metric windows and utilisation cover the
        // full configured duration rather than stopping at the last event.
        this.clock.advanceTo(untilTime);
        return this.complete('duration_reached', processedHere);
      }
      this.step();
      processedHere += 1;
    }
  }

  /** Runs until `predicate` is true for a processed event, or the run ends. */
  runUntil(predicate: (event: SimEvent) => boolean, options: RunOptions = {}): SimEvent | undefined {
    const untilTime = options.untilTime ?? this.limits.durationMs;
    for (;;) {
      const next = this.queue.peek();
      if (next === undefined || next.at > untilTime) return undefined;
      if (this.processed >= this.limits.maxEvents) return undefined;
      const event = this.step();
      if (!event) return undefined;
      if (predicate(event)) return event;
    }
  }

  /** Asks a running loop to stop after the current event. */
  requestStop(): void {
    this.stopRequested = true;
    if (this.state === 'running') this.state = 'paused';
  }

  resume(): void {
    if (this.state === 'paused') this.stopRequested = false;
  }

  /** Ends the run now, emitting `SIMULATION_COMPLETED` so observers see the close. */
  complete(reason: SimulationEndReason, eventsProcessedInCall = 0): RunResult {
    if (this.state === 'completed') {
      return {
        reason: this.endReason ?? reason,
        eventsProcessed: eventsProcessedInCall,
        endedAt: this.clock.now(),
        hasMore: false,
      };
    }
    this.state = 'completed';
    this.endReason = reason;
    this.dispatch({
      id: this.ids.event(),
      seq: this.sequence++,
      type: 'SIMULATION_COMPLETED',
      at: this.clock.now(),
      createdAt: this.clock.now(),
      payload: { reason, eventsProcessed: this.processed, endedAt: this.clock.now() },
    });
    return {
      reason,
      eventsProcessed: eventsProcessedInCall,
      endedAt: this.clock.now(),
      hasMore: !this.queue.isEmpty,
    };
  }

  /** Clears kernel state. Subsystem state is rebuilt by the owning world. */
  reset(): void {
    this.clock.reset();
    this.queue.clear();
    this.log.clear();
    this.ids.restore({});
    this.streams.clear();
    this.sequence = 0;
    this.processed = 0;
    this.state = 'idle';
    this.endReason = undefined;
    this.stopRequested = false;
  }

  private dispatch(event: SimEvent): void {
    this.log.append(event);
    const handlers = this.handlers.get(event.type);
    if (handlers) {
      for (const handler of handlers) (handler as EventHandler<EventType>)(event);
    }
    for (const observer of this.observers) observer(event);
  }
}
