import type { Duration, SimTime } from './time.js';
import type { EventDraft, EventType, SimEvent } from './events.js';
import type { EventId, IdFactory } from './ids.js';
import type { Rng } from './rng.js';

/**
 * The services the kernel offers to subsystems (network, telemetry, node
 * behaviours).
 *
 * Subsystems depend on this interface rather than on the `Simulation` class,
 * which is what keeps the package graph acyclic: `@distlab/network` needs to
 * schedule events without knowing the engine that will run them.
 */
export interface SimulationContext {
  now(): SimTime;
  /** Schedules an event `delay` milliseconds of virtual time from now. */
  schedule<T extends EventType>(draft: EventDraft<T>, delay: Duration): SimEvent<T>;
  /** Schedules an event at an absolute virtual time, which must not be in the past. */
  scheduleAt<T extends EventType>(draft: EventDraft<T>, at: SimTime): SimEvent<T>;
  /** Removes a pending event. Returns false if it already fired or never existed. */
  cancel(id: EventId): boolean;
  readonly ids: IdFactory;
  /**
   * A named, independent random stream. Deriving per subsystem (and per link,
   * per node) means adding one consumer cannot shift the draws every other
   * consumer sees.
   */
  stream(label: string): Rng;
}
