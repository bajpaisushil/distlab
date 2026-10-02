import { Rng, type SimTime } from '@distlab/shared';

/** Monotonic count of something that happened. */
export class Counter {
  private value = 0;
  private readonly labels = new Map<string, number>();

  add(amount = 1, label?: string): void {
    this.value += amount;
    if (label !== undefined) this.labels.set(label, (this.labels.get(label) ?? 0) + amount);
  }

  get total(): number {
    return this.value;
  }

  /** Breakdown by label, e.g. drops by reason. */
  byLabel(): Record<string, number> {
    return Object.fromEntries([...this.labels.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
  }
}

/** Last-written value, plus the extremes it reached. */
export class Gauge {
  private current = 0;
  private peak = 0;
  private trough = 0;

  set(value: number): void {
    this.current = value;
    if (value > this.peak) this.peak = value;
    if (value < this.trough) this.trough = value;
  }

  get value(): number {
    return this.current;
  }

  get max(): number {
    return this.peak;
  }

  get min(): number {
    return this.trough;
  }
}

export interface Percentiles {
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

export const EMPTY_PERCENTILES: Percentiles = {
  count: 0,
  min: 0,
  max: 0,
  mean: 0,
  p50: 0,
  p95: 0,
  p99: 0,
};

/**
 * Latency distribution.
 *
 * Samples are kept and percentiles computed exactly rather than approximated
 * from buckets: p99 is the number people make decisions on, and a simulator
 * that rounds it to the nearest bucket edge is not worth consulting. Above
 * `maxSamples` it falls back to reservoir sampling with its own deterministic
 * generator, so memory stays bounded without the result depending on timing.
 */
export class Histogram {
  private samples: number[] = [];
  private sorted: number[] | undefined;
  private observed = 0;
  private sum = 0;
  private minimum = Number.POSITIVE_INFINITY;
  private maximum = Number.NEGATIVE_INFINITY;
  private readonly rng: Rng;

  constructor(
    readonly name: string,
    private readonly maxSamples = 200_000,
  ) {
    this.rng = new Rng(`histogram::${name}`);
  }

  record(value: number): void {
    this.observed += 1;
    this.sum += value;
    if (value < this.minimum) this.minimum = value;
    if (value > this.maximum) this.maximum = value;
    this.sorted = undefined;

    if (this.samples.length < this.maxSamples) {
      this.samples.push(value);
      return;
    }
    const index = this.rng.int(0, this.observed);
    if (index < this.maxSamples) this.samples[index] = value;
  }

  get count(): number {
    return this.observed;
  }

  percentiles(): Percentiles {
    if (this.observed === 0) return EMPTY_PERCENTILES;
    const sorted = this.sortedSamples();
    return {
      count: this.observed,
      min: this.minimum,
      max: this.maximum,
      mean: this.sum / this.observed,
      p50: quantile(sorted, 0.5),
      p95: quantile(sorted, 0.95),
      p99: quantile(sorted, 0.99),
    };
  }

  private sortedSamples(): number[] {
    if (!this.sorted) this.sorted = [...this.samples].sort((a, b) => a - b);
    return this.sorted;
  }
}

/** Nearest-rank quantile over an ascending array. */
function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(q * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] as number;
}

export interface SeriesPoint {
  /** Start of the window, in virtual milliseconds. */
  readonly t: SimTime;
  readonly count: number;
  readonly sum: number;
}

/** Fixed-width time buckets, for rates and anything plotted against time. */
export class TimeSeries {
  private readonly buckets = new Map<number, { count: number; sum: number }>();

  constructor(readonly windowMs: number) {}

  record(at: SimTime, value = 1): void {
    const index = Math.floor(at / this.windowMs);
    const bucket = this.buckets.get(index);
    if (bucket) {
      bucket.count += 1;
      bucket.sum += value;
    } else {
      this.buckets.set(index, { count: 1, sum: value });
    }
  }

  points(): SeriesPoint[] {
    return [...this.buckets.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, bucket]) => ({ t: index * this.windowMs, count: bucket.count, sum: bucket.sum }));
  }

  /** Per-second rate in each window. */
  ratePerSecond(): { t: SimTime; value: number }[] {
    const scale = 1000 / this.windowMs;
    return this.points().map((point) => ({ t: point.t, value: point.count * scale }));
  }
}

/** Named metric instruments, created on first use. */
export class MetricsRegistry {
  private readonly counters = new Map<string, Counter>();
  private readonly gauges = new Map<string, Gauge>();
  private readonly histograms = new Map<string, Histogram>();
  private readonly series = new Map<string, TimeSeries>();

  constructor(private readonly windowMs = 1000) {}

  counter(name: string): Counter {
    return getOrCreate(this.counters, name, () => new Counter());
  }

  gauge(name: string): Gauge {
    return getOrCreate(this.gauges, name, () => new Gauge());
  }

  histogram(name: string): Histogram {
    return getOrCreate(this.histograms, name, () => new Histogram(name));
  }

  timeSeries(name: string): TimeSeries {
    return getOrCreate(this.series, name, () => new TimeSeries(this.windowMs));
  }

  histogramNames(): string[] {
    return [...this.histograms.keys()].sort();
  }
}

function getOrCreate<T>(map: Map<string, T>, key: string, create: () => T): T {
  let value = map.get(key);
  if (!value) {
    value = create();
    map.set(key, value);
  }
  return value;
}
