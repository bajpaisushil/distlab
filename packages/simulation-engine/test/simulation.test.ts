import { describe, expect, it } from 'vitest';
import { InvariantError, type SimEvent } from '@distlab/shared';
import { Simulation } from '../src/simulation.js';

const makeSim = (overrides: Partial<{ seed: string; durationMs: number; maxEvents: number }> = {}) =>
  new Simulation({
    seed: overrides.seed ?? 'kernel-test',
    limits: {
      durationMs: overrides.durationMs ?? 10_000,
      maxEvents: overrides.maxEvents ?? 1_000_000,
    },
  });

/** A self-perpetuating event chain, the shape most subsystems actually use. */
function scheduleChain(sim: Simulation, every: number, times: number): void {
  let remaining = times;
  sim.on('NODE_RECOVERED', (event) => {
    if (--remaining > 0) {
      sim.schedule({ type: 'NODE_RECOVERED', payload: { nodeId: 'n' }, causedBy: event.id }, every);
    }
  });
  sim.schedule({ type: 'NODE_RECOVERED', payload: { nodeId: 'n' } }, every);
}

describe('Simulation scheduling', () => {
  it('advances virtual time to each event as it is processed', () => {
    const sim = makeSim();
    sim.schedule({ type: 'NODE_FAILED', payload: { nodeId: 'a', reason: 'test' } }, 250);
    expect(sim.now()).toBe(0);
    sim.step();
    expect(sim.now()).toBe(250);
  });

  it('processes same-timestamp events in scheduling order', () => {
    const sim = makeSim();
    const seen: string[] = [];
    sim.on('NODE_FAILED', (e) => seen.push(e.payload.nodeId));
    for (const id of ['a', 'b', 'c']) {
      sim.schedule({ type: 'NODE_FAILED', payload: { nodeId: id, reason: 'test' } }, 100);
    }
    sim.run();
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('runs an event scheduled with zero delay after the current event, not during it', () => {
    const sim = makeSim();
    const seen: string[] = [];
    sim.on('NODE_FAILED', (e) => {
      seen.push(`failed:${e.payload.nodeId}`);
      if (e.payload.nodeId === 'a') {
        sim.schedule({ type: 'NODE_RECOVERED', payload: { nodeId: 'a' } }, 0);
      }
    });
    sim.on('NODE_RECOVERED', (e) => seen.push(`recovered:${e.payload.nodeId}`));
    sim.schedule({ type: 'NODE_FAILED', payload: { nodeId: 'a', reason: 'test' } }, 10);
    sim.schedule({ type: 'NODE_FAILED', payload: { nodeId: 'b', reason: 'test' } }, 10);
    sim.run();
    expect(seen).toEqual(['failed:a', 'failed:b', 'recovered:a']);
  });

  it('refuses to schedule into the past', () => {
    const sim = makeSim();
    sim.schedule({ type: 'NODE_RECOVERED', payload: { nodeId: 'n' } }, 500);
    sim.step();
    expect(() => sim.scheduleAt({ type: 'NODE_RECOVERED', payload: { nodeId: 'n' } }, 100)).toThrow(
      InvariantError,
    );
  });

  it('does not run cancelled events', () => {
    const sim = makeSim();
    const seen: string[] = [];
    sim.on('NODE_RECOVERED', (e) => seen.push(e.payload.nodeId));
    sim.schedule({ type: 'NODE_RECOVERED', payload: { nodeId: 'keep' } }, 10);
    const doomed = sim.schedule({ type: 'NODE_RECOVERED', payload: { nodeId: 'drop' } }, 20);
    expect(sim.cancel(doomed.id)).toBe(true);
    sim.run();
    expect(seen).toEqual(['keep']);
  });
});

describe('Simulation execution control', () => {
  it('steps one event at a time', () => {
    const sim = makeSim();
    scheduleChain(sim, 100, 5);
    expect(sim.step()?.at).toBe(100);
    expect(sim.step()?.at).toBe(200);
    expect(sim.eventsProcessed).toBe(2);
  });

  it('returns undefined when stepping an empty queue', () => {
    expect(makeSim().step()).toBeUndefined();
  });

  it('stops at the configured time horizon and advances the clock to it', () => {
    const sim = makeSim({ durationMs: 450 });
    scheduleChain(sim, 100, 100);
    const result = sim.run();
    expect(result.reason).toBe('duration_reached');
    expect(result.eventsProcessed).toBe(4); // 100, 200, 300, 400
    expect(sim.now()).toBe(450);
    expect(sim.status).toBe('completed');
  });

  it('stops when the queue drains', () => {
    const sim = makeSim();
    scheduleChain(sim, 100, 3);
    expect(sim.run().reason).toBe('queue_drained');
  });

  it('enforces the global event cap', () => {
    const sim = makeSim({ maxEvents: 25 });
    scheduleChain(sim, 1, 10_000);
    const result = sim.run();
    expect(result.reason).toBe('event_limit');
    expect(sim.eventsProcessed).toBe(25);
  });

  it('honours a per-call budget and reports that work remains', () => {
    const sim = makeSim();
    scheduleChain(sim, 10, 1000);
    const first = sim.run({ maxEvents: 50 });
    expect(first.eventsProcessed).toBe(50);
    expect(first.hasMore).toBe(true);
    expect(sim.status).toBe('paused');
    const second = sim.run({ maxEvents: 50 });
    expect(second.eventsProcessed).toBe(50);
    expect(sim.eventsProcessed).toBe(100);
  });

  it('runs until a predicate matches, leaving the rest queued', () => {
    const sim = makeSim();
    scheduleChain(sim, 100, 50);
    const hit = sim.runUntil((e) => e.at >= 1000);
    expect(hit?.at).toBe(1000);
    expect(sim.queue.size).toBe(1);
  });

  it('emits SIMULATION_COMPLETED exactly once', () => {
    const sim = makeSim();
    const completions: SimEvent[] = [];
    sim.on('SIMULATION_COMPLETED', (e) => completions.push(e));
    scheduleChain(sim, 100, 2);
    sim.run();
    sim.run();
    expect(completions).toHaveLength(1);
    expect(completions[0]?.payload).toMatchObject({ reason: 'queue_drained' });
  });

  it('executes ten thousand events without any real-time pacing', () => {
    const sim = makeSim({ durationMs: 1_000_000 });
    scheduleChain(sim, 1, 10_000);
    const started = Date.now();
    sim.run();
    expect(sim.eventsProcessed).toBe(10_000);
    // Generous bound: the point is that virtual time is not real time.
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('Simulation determinism', () => {
  /** Uses randomness in a way that is sensitive to both draw order and stream identity. */
  function randomizedRun(seed: string): string[] {
    const sim = makeSim({ seed, durationMs: 5000 });
    const trace: string[] = [];
    sim.on('NODE_FAILED', (event) => {
      const jitter = sim.stream('faults').float();
      trace.push(`${event.at}:${event.payload.nodeId}:${jitter.toFixed(6)}`);
      if (event.at < 4000) {
        sim.schedule(
          { type: 'NODE_FAILED', payload: { nodeId: event.payload.nodeId, reason: 'cascade' }, causedBy: event.id },
          10 + sim.stream('schedule').float() * 100,
        );
      }
    });
    for (const id of ['a', 'b', 'c']) {
      sim.schedule({ type: 'NODE_FAILED', payload: { nodeId: id, reason: 'seed' } }, 10);
    }
    sim.run();
    return trace;
  }

  it('reproduces a run exactly for the same seed', () => {
    expect(randomizedRun('alpha')).toEqual(randomizedRun('alpha'));
  });

  it('produces a different run for a different seed', () => {
    expect(randomizedRun('alpha')).not.toEqual(randomizedRun('beta'));
  });

  it('gives identical event ids across identical runs', () => {
    const ids = (seed: string) => {
      const sim = makeSim({ seed });
      scheduleChain(sim, 100, 20);
      sim.run();
      return sim.log.all().map((e) => e.id);
    };
    expect(ids('ids')).toEqual(ids('ids'));
  });

  it('returns a reset simulation to its initial state', () => {
    const sim = makeSim();
    scheduleChain(sim, 100, 10);
    sim.run();
    sim.reset();
    expect(sim.now()).toBe(0);
    expect(sim.eventsProcessed).toBe(0);
    expect(sim.log.size).toBe(0);
    expect(sim.status).toBe('idle');
  });
});

describe('Simulation dispatch', () => {
  it('runs handlers in registration order, then observers', () => {
    const sim = makeSim();
    const calls: string[] = [];
    sim.on('NODE_RECOVERED', () => calls.push('handler-1'));
    sim.on('NODE_RECOVERED', () => calls.push('handler-2'));
    sim.observe(() => calls.push('observer'));
    sim.schedule({ type: 'NODE_RECOVERED', payload: { nodeId: 'n' } }, 1);
    sim.step();
    expect(calls).toEqual(['handler-1', 'handler-2', 'observer']);
  });

  it('stops calling a handler once it is unsubscribed', () => {
    const sim = makeSim();
    let count = 0;
    const off = sim.on('NODE_RECOVERED', () => count++);
    sim.schedule({ type: 'NODE_RECOVERED', payload: { nodeId: 'n' } }, 1);
    sim.step();
    off();
    sim.schedule({ type: 'NODE_RECOVERED', payload: { nodeId: 'n' } }, 1);
    sim.step();
    expect(count).toBe(1);
  });

  it('records every processed event in the log with a causal chain', () => {
    const sim = makeSim();
    scheduleChain(sim, 50, 4);
    sim.run();
    const log = sim.log;
    expect(log.byType('NODE_RECOVERED')).toHaveLength(4);
    const last = log.byType('NODE_RECOVERED').at(-1);
    expect(last).toBeDefined();
    expect(log.causalChain(last!.id).map((e) => e.at)).toEqual([50, 100, 150, 200]);
  });

  it('indexes the log by processed position', () => {
    const sim = makeSim();
    scheduleChain(sim, 10, 6);
    sim.run();
    expect(sim.log.at(0)?.at).toBe(10);
    expect(sim.log.at(3)?.at).toBe(40);
    expect(sim.log.at(99)).toBeUndefined();
  });
});
