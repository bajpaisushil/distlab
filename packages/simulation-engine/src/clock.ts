import { invariant, type SimTime } from '@distlab/shared';

/**
 * The simulation's virtual clock.
 *
 * It is a monotonic counter advanced only by the event loop, never by
 * `Date.now()`, `performance.now()` or a timer. A simulated hour therefore
 * costs whatever the events cost to process, and replaying the same event
 * sequence lands on exactly the same timestamps.
 *
 * Playback control (pause, resume, step, speed) lives on `Simulation` rather
 * than here: those describe how a *runner* chooses to consume events, while
 * the clock only answers "what time is it in the simulated world".
 */
export class SimulationClock {
  private current: SimTime = 0;

  now(): SimTime {
    return this.current;
  }

  /**
   * Moves virtual time forward. Time never runs backwards — an attempt to do so
   * means an event was scheduled in the past, which would break event ordering
   * and therefore determinism.
   */
  advanceTo(time: SimTime): void {
    invariant(
      time >= this.current,
      `simulation clock cannot move backwards: now=${this.current}, requested=${time}`,
    );
    this.current = time;
  }

  advanceBy(delta: number): void {
    invariant(delta >= 0, `clock delta must be non-negative, received ${delta}`);
    this.current += delta;
  }

  reset(): void {
    this.current = 0;
  }
}
