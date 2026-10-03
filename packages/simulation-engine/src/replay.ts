import type { SimEvent, SimulationSpec } from '@distlab/shared';
import {
  createSimulation,
  type CreateSimulationOptions,
  type SimulationWorld,
  type WorldState,
} from './world.js';

export interface ReplayOptions extends CreateSimulationOptions {
  /** Take a checkpoint every this many processed events. Grows automatically on long runs. */
  readonly checkpointInterval?: number;
  /** Upper bound on retained checkpoints; past it, every other one is dropped and the interval doubles. */
  readonly maxCheckpoints?: number;
}

/**
 * Time travel over a deterministic run.
 *
 * Because a scenario and its seed fully determine the run, "the state before
 * event #481" never has to be stored — it can always be recomputed. Checkpoints
 * only make that fast: seeking restores the nearest checkpoint at or before the
 * target into a fresh engine and steps forward from there. Stepping backward is
 * a seek. Nothing here records screenshots or UI state; it is all engine state.
 *
 * Checkpoints omit the event log, since the log is identical on every replay:
 * it is kept once, for the furthest point reached, and sliced back in.
 */
export class ReplayController {
  readonly spec: SimulationSpec;
  private readonly options: ReplayOptions;
  private world: SimulationWorld;
  private interval: number;
  private readonly maxCheckpoints: number;
  private readonly checkpoints = new Map<number, WorldState>();
  /** The log of the furthest run reached, which every replay reproduces as a prefix. */
  private furthestLog: readonly SimEvent[] = [];

  constructor(spec: SimulationSpec, options: ReplayOptions = {}) {
    this.spec = spec;
    this.options = options;
    this.interval = Math.max(1, options.checkpointInterval ?? 2500);
    this.maxCheckpoints = Math.max(4, options.maxCheckpoints ?? 64);
    this.world = this.freshWorld();
    this.capture();
  }

  /** The live world at the current position. Replaced on backward seeks — do not hold on to it. */
  get current(): SimulationWorld {
    return this.world;
  }

  /** Events processed so far at the current position. */
  get position(): number {
    return this.world.simulation.eventsProcessed;
  }

  /** The furthest position ever reached; everything up to it is known and replayable. */
  get reachable(): number {
    return Math.max(this.furthestLog.length, this.position);
  }

  get completed(): boolean {
    return this.world.simulation.status === 'completed';
  }

  get checkpointCount(): number {
    return this.checkpoints.size;
  }

  /** Every event known so far, including those beyond the current position after a backward seek. */
  timeline(): readonly SimEvent[] {
    const live = this.world.simulation.log.all();
    return live.length >= this.furthestLog.length ? live : this.furthestLog;
  }

  /** Advances up to `count` events, stopping at the run's end. Returns how many were processed. */
  forward(count: number): number {
    let processed = 0;
    while (processed < count && !this.completed) {
      const toCheckpoint = this.interval - (this.position % this.interval);
      const chunk = Math.min(count - processed, toCheckpoint);
      const result = this.world.simulation.run({ maxEvents: chunk });
      processed += result.eventsProcessed;
      this.afterAdvance();
      if (result.eventsProcessed < chunk) break; // run ended or hit its time horizon
    }
    return processed;
  }

  /** Advances virtual time by `deltaMs` — what real-time playback calls every frame. */
  advanceTime(deltaMs: number): number {
    const target = this.world.now + Math.max(0, deltaMs);
    let processed = 0;
    while (!this.completed) {
      const toCheckpoint = this.interval - (this.position % this.interval);
      const result = this.world.simulation.run({ untilTime: target, maxEvents: toCheckpoint });
      processed += result.eventsProcessed;
      this.afterAdvance();
      // Stopped by the time limit (not the checkpoint budget) or finished.
      if (result.eventsProcessed < toCheckpoint || this.world.now >= target) break;
    }
    return processed;
  }

  /** Runs to the end of the configured duration. */
  toEnd(): number {
    return this.forward(Number.POSITIVE_INFINITY);
  }

  /** Moves to an absolute position (events processed). Clamped to what the run can reach. */
  seek(position: number): void {
    const target = Math.max(0, Math.floor(position));
    if (target === this.position) return;
    if (target > this.position) {
      this.forward(target - this.position);
      return;
    }
    const base = this.nearestCheckpoint(target);
    this.world = this.restore(base);
    if (target > base) this.forward(target - base);
  }

  back(count = 1): void {
    this.seek(this.position - count);
  }

  reset(): void {
    this.seek(0);
  }

  /** The world as it stood immediately before the event at `index` (0-based) was processed. */
  seekBefore(index: number): void {
    this.seek(index);
  }

  /**
   * A separate world at `position`, leaving the current one untouched — for
   * inspecting the past without moving playback.
   */
  peek(position: number): SimulationWorld {
    const target = Math.max(0, Math.min(Math.floor(position), this.reachable));
    const base = this.nearestCheckpoint(target);
    const world = this.restore(base);
    if (target > base) world.simulation.run({ maxEvents: target - base });
    return world;
  }

  private afterAdvance(): void {
    const log = this.world.simulation.log.all();
    if (log.length > this.furthestLog.length) this.furthestLog = log.slice();
    if (this.position % this.interval === 0 && !this.checkpoints.has(this.position)) this.capture();
  }

  private capture(): void {
    const state = this.world.captureState();
    // The log is the same on every replay, so it is restored from furthestLog instead.
    this.checkpoints.set(this.position, { ...state, kernel: { ...state.kernel, log: [] } });
    if (this.checkpoints.size > this.maxCheckpoints) this.thin();
  }

  /** Keeps every other checkpoint (always including position 0) and doubles the spacing. */
  private thin(): void {
    this.interval *= 2;
    for (const position of [...this.checkpoints.keys()]) {
      if (position !== 0 && position % this.interval !== 0) this.checkpoints.delete(position);
    }
  }

  private nearestCheckpoint(target: number): number {
    let best = 0;
    for (const position of this.checkpoints.keys()) {
      if (position <= target && position > best) best = position;
    }
    return best;
  }

  private restore(position: number): SimulationWorld {
    const saved = this.checkpoints.get(position);
    const world = this.freshWorld();
    if (!saved) return world;
    const log = this.furthestLog.slice(0, Math.max(0, position - saved.kernel.logDropped));
    world.restoreState({ ...saved, kernel: { ...saved.kernel, log } });
    return world;
  }

  private freshWorld(): SimulationWorld {
    const world = createSimulation(this.spec, this.options);
    world.start();
    return world;
  }
}
