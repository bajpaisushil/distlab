/**
 * Virtual simulation time, in milliseconds since the start of the run.
 *
 * This is never derived from `Date.now()` or any wall-clock source. The engine
 * advances it only by processing scheduled events, which is what lets a
 * 10-minute simulated run finish in milliseconds and replay identically.
 */
export type SimTime = number;

/** Milliseconds of virtual time. */
export type Duration = number;

export const seconds = (n: number): Duration => n * 1000;
export const minutes = (n: number): Duration => n * 60_000;

/** Human-readable virtual timestamp, e.g. `00:05.250`. */
export function formatSimTime(t: SimTime): string {
  const sign = t < 0 ? '-' : '';
  const abs = Math.abs(t);
  const ms = Math.floor(abs % 1000);
  const totalSeconds = Math.floor(abs / 1000);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60);
  return `${sign}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}
