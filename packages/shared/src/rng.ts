/**
 * Deterministic pseudo-random number generator.
 *
 * Every random decision in DistLab — network jitter, packet loss, service time,
 * arrival times — comes from here. `Math.random()` must never appear in engine
 * code, because the whole premise is that a seed plus a scenario reproduces a
 * run exactly.
 *
 * Algorithm is sfc32 (small fast counter, 128-bit state) seeded through xmur3.
 * It is not cryptographically secure, which does not matter here; what matters
 * is that it is fast, well-distributed, and its entire state is four uint32s
 * that can be serialised into a checkpoint.
 */

export interface RngState {
  readonly seed: string;
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
}

function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

export class Rng {
  readonly seed: string;
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: string | number) {
    this.seed = String(seed);
    const next = xmur3(this.seed);
    this.a = next();
    this.b = next();
    this.c = next();
    this.d = next();
  }

  static fromState(state: RngState): Rng {
    const rng = new Rng(state.seed);
    rng.a = state.a | 0;
    rng.b = state.b | 0;
    rng.c = state.c | 0;
    rng.d = state.d | 0;
    return rng;
  }

  state(): RngState {
    return { seed: this.seed, a: this.a, b: this.b, c: this.c, d: this.d };
  }

  /**
   * An independent child stream, derived from the *seed* rather than the
   * current state. That independence is the point: adding a new consumer (a
   * new link, a new node) must not shift the number sequence every existing
   * consumer sees, or an unrelated config change would silently alter an
   * otherwise identical run.
   */
  derive(label: string): Rng {
    return new Rng(`${this.seed}::${label}`);
  }

  /** Raw 32-bit draw. */
  nextUint32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Uniform in [0, 1). */
  float(): number {
    return this.nextUint32() / 4294967296;
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + this.float() * (max - min);
  }

  /** Uniform integer in [minInclusive, maxExclusive). */
  int(minInclusive: number, maxExclusive: number): number {
    if (maxExclusive <= minInclusive) return minInclusive;
    return minInclusive + Math.floor(this.float() * (maxExclusive - minInclusive));
  }

  /** True with probability `p`. `p <= 0` never fires, `p >= 1` always does. */
  bool(p: number): boolean {
    if (p <= 0) return false;
    if (p >= 1) return true;
    return this.float() < p;
  }

  pick<T>(items: readonly T[]): T {
    invariantNonEmpty(items);
    return items[this.int(0, items.length)] as T;
  }

  /** Fisher-Yates, returning a new array; the input is left untouched. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i + 1);
      const tmp = out[i] as T;
      out[i] = out[j] as T;
      out[j] = tmp;
    }
    return out;
  }

  /** Exponential distribution with the given mean — the arrival process of a Poisson stream. */
  exponential(mean: number): number {
    if (mean <= 0) return 0;
    // float() is in [0, 1), so 1 - u is in (0, 1] and the log is always finite.
    return -mean * Math.log(1 - this.float());
  }

  /**
   * Normal distribution via Box-Muller. The second variate is discarded rather
   * than cached so that the generator's state stays the four sfc32 words and
   * snapshots need no extra bookkeeping.
   */
  normal(mean: number, stddev: number): number {
    if (stddev <= 0) return mean;
    let u1 = this.float();
    while (u1 === 0) u1 = this.float();
    const u2 = this.float();
    return mean + stddev * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}

function invariantNonEmpty(items: readonly unknown[]): void {
  if (items.length === 0) throw new Error('Rng.pick called with an empty array');
}
