import { describe, expect, it } from 'vitest';
import { InvariantError } from '@distlab/shared';
import { SimulationClock } from '../src/clock.js';

describe('SimulationClock', () => {
  it('starts at zero', () => {
    expect(new SimulationClock().now()).toBe(0);
  });

  it('advances to absolute times and by deltas', () => {
    const clock = new SimulationClock();
    clock.advanceTo(100);
    clock.advanceBy(50);
    expect(clock.now()).toBe(150);
  });

  it('allows advancing to the current instant', () => {
    const clock = new SimulationClock();
    clock.advanceTo(100);
    clock.advanceTo(100);
    expect(clock.now()).toBe(100);
  });

  it('refuses to move backwards, because that would break event ordering', () => {
    const clock = new SimulationClock();
    clock.advanceTo(100);
    expect(() => clock.advanceTo(99)).toThrow(InvariantError);
  });

  it('resets to zero', () => {
    const clock = new SimulationClock();
    clock.advanceTo(500);
    clock.reset();
    expect(clock.now()).toBe(0);
  });
});
