import { Rng, type RngState, type SimTime } from '@distlab/shared';

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

  captureState(): CounterState {
    return { value: this.value, labels: [...this.labels.entries()] };
  }

  restoreState(state: CounterState): void {
    this.value = state.value;
    this.labels.clear();
    for (const [label, count] of state.labels) this.labels.set(label, count);
  }
}

export interface CounterState {
  readonly value: number;
  readonly labels: readonly (readonly [string, number])[];
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

  captureState(): GaugeState {
    return { current: this.current, peak: this.peak, trough: this.trough };
  }

  restoreState(state: GaugeState): void {
    this.current = state.current;
    this.peak = state.peak;
    this.trough = state.trough;
  }
}

export interface GaugeState {
  readonly current: number;
  readonly peak: number;
  readonly trough: number;
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
  private rng: Rng;

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

  captureState(): HistogramState {
    return {
      samples: [...this.samples],
      observed: this.observed,
      sum: this.sum,
      minimum: this.minimum,
      maximum: this.maximum,
      rng: this.rng.state(),
    };
  }

  restoreState(state: HistogramState): void {
    this.samples = [...state.samples];
    this.sorted = undefined;
    this.observed = state.observed;
    this.sum = state.sum;
    this.minimum = state.minimum;
    this.maximum = state.maximum;
    this.rng = Rng.fromState(state.rng);
  }
}

export interface HistogramState {
  readonly samples: readonly number[];
  readonly observed: number;
  readonly sum: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly rng: RngState;
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

  /** Mean of recorded values in each window — e.g. average latency per second. */
  meanPerWindow(): { t: SimTime; value: number }[] {
    return this.points().map((point) => ({ t: point.t, value: point.count === 0 ? 0 : point.sum / point.count }));
  }

  captureState(): TimeSeriesState {
    return [...this.buckets.entries()].map(([index, b]) => [index, b.count, b.sum] as const);
  }

  restoreState(state: TimeSeriesState): void {
    this.buckets.clear();
    for (const [index, count, sum] of state) this.buckets.set(index, { count, sum });
  }
}

export type TimeSeriesState = readonly (readonly [number, number, number])[];

/**
 * Exact percentiles per time window — p99 over time, not just p99 overall.
 * Keeps every sample, bucketed by window; memory equals the overall histogram's.
 */
export class WindowedHistogram {
  private readonly windows = new Map<number, number[]>();

  constructor(readonly windowMs: number) {}

  record(at: SimTime, value: number): void {
    const index = Math.floor(at / this.windowMs);
    const bucket = this.windows.get(index);
    if (bucket) bucket.push(value);
    else this.windows.set(index, [value]);
  }

  percentiles(): { t: SimTime; count: number; p50: number; p95: number; p99: number }[] {
    return [...this.windows.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, samples]) => {
        const sorted = [...samples].sort((a, b) => a - b);
        return {
          t: index * this.windowMs,
          count: sorted.length,
          p50: quantile(sorted, 0.5),
          p95: quantile(sorted, 0.95),
          p99: quantile(sorted, 0.99),
        };
      });
  }

  captureState(): readonly (readonly [number, readonly number[]])[] {
    return [...this.windows.entries()].map(([index, samples]) => [index, [...samples]] as const);
  }

  restoreState(state: readonly (readonly [number, readonly number[]])[]): void {
    this.windows.clear();
    for (const [index, samples] of state) this.windows.set(index, [...samples]);
  }
}

export type TimelineValue = number | string | null;

/**
 * A value that changes at discrete instants — the leader of a cluster, the
 * holder of a lock, a queue's depth. Stored as change points so a step chart
 * can be drawn exactly, and so "what was it at time t" has a precise answer.
 */
export class Timeline {
  private changes: { t: SimTime; value: TimelineValue }[] = [];

  record(t: SimTime, value: TimelineValue): void {
    const last = this.changes[this.changes.length - 1];
    if (last && last.value === value) return;
    if (last && last.t === t) {
      last.value = value;
      // Collapsing may make it equal to the value before it.
      const previous = this.changes[this.changes.length - 2];
      if (previous && previous.value === value) this.changes.pop();
      return;
    }
    this.changes.push({ t, value });
  }

  points(): readonly { readonly t: SimTime; readonly value: TimelineValue }[] {
    return this.changes;
  }

  valueAt(t: SimTime): TimelineValue | undefined {
    let result: TimelineValue | undefined;
    for (const change of this.changes) {
      if (change.t > t) break;
      result = change.value;
    }
    return result;
  }

  get last(): TimelineValue | undefined {
    return this.changes[this.changes.length - 1]?.value;
  }

  captureState(): TimelineState {
    return this.changes.map((c) => [c.t, c.value] as const);
  }

  restoreState(state: TimelineState): void {
    this.changes = state.map(([t, value]) => ({ t, value }));
  }
}

export type TimelineState = readonly (readonly [SimTime, TimelineValue])[];

/** A set of string ids that are "currently" something — active faults, open circuits. */
export class TrackedSet {
  private readonly items = new Set<string>();

  add(id: string): void {
    this.items.add(id);
  }

  delete(id: string): boolean {
    return this.items.delete(id);
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  get size(): number {
    return this.items.size;
  }

  values(): IterableIterator<string> {
    return this.items.values();
  }

  captureState(): readonly string[] {
    return [...this.items];
  }

  restoreState(state: readonly string[]): void {
    this.items.clear();
    for (const id of state) this.items.add(id);
  }
}

/** Named metric instruments, created on first use. */
export class MetricsRegistry {
  private readonly counters = new Map<string, Counter>();
  private readonly gauges = new Map<string, Gauge>();
  private readonly histograms = new Map<string, Histogram>();
  private readonly series = new Map<string, TimeSeries>();
  private readonly timelines = new Map<string, Timeline>();
  private readonly sets = new Map<string, TrackedSet>();
  private readonly windowed = new Map<string, WindowedHistogram>();

  constructor(readonly windowMs = 1000) {}

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

  timeline(name: string): Timeline {
    return getOrCreate(this.timelines, name, () => new Timeline());
  }

  set(name: string): TrackedSet {
    return getOrCreate(this.sets, name, () => new TrackedSet());
  }

  windowedHistogram(name: string): WindowedHistogram {
    return getOrCreate(this.windowed, name, () => new WindowedHistogram(this.windowMs));
  }

  histogramNames(): string[] {
    return [...this.histograms.keys()].sort();
  }

  hasHistogram(name: string): boolean {
    return this.histograms.has(name);
  }

  /** Names of every instrument of a kind whose name starts with `prefix`, sorted. */
  names(kind: 'counter' | 'gauge' | 'histogram' | 'series' | 'timeline' | 'set', prefix = ''): string[] {
    const source = {
      counter: this.counters,
      gauge: this.gauges,
      histogram: this.histograms,
      series: this.series,
      timeline: this.timelines,
      set: this.sets,
    }[kind] as Map<string, unknown>;
    return [...source.keys()].filter((name) => name.startsWith(prefix)).sort();
  }

  captureState(): MetricsState {
    const capture = <T extends { captureState(): S }, S>(map: Map<string, T>) =>
      [...map.entries()].map(([name, instrument]) => [name, instrument.captureState()] as const);
    return {
      counters: capture(this.counters),
      gauges: capture(this.gauges),
      histograms: capture(this.histograms),
      series: capture(this.series),
      timelines: capture(this.timelines),
      sets: capture(this.sets),
      windowed: capture(this.windowed),
    };
  }

  restoreState(state: MetricsState): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
    this.series.clear();
    this.timelines.clear();
    this.sets.clear();
    this.windowed.clear();
    for (const [name, s] of state.windowed) this.windowedHistogram(name).restoreState(s);
    for (const [name, s] of state.counters) this.counter(name).restoreState(s);
    for (const [name, s] of state.gauges) this.gauge(name).restoreState(s);
    for (const [name, s] of state.histograms) this.histogram(name).restoreState(s);
    for (const [name, s] of state.series) this.timeSeries(name).restoreState(s);
    for (const [name, s] of state.timelines) this.timeline(name).restoreState(s);
    for (const [name, s] of state.sets) this.set(name).restoreState(s);
  }
}

export interface MetricsState {
  readonly counters: readonly (readonly [string, CounterState])[];
  readonly gauges: readonly (readonly [string, GaugeState])[];
  readonly histograms: readonly (readonly [string, HistogramState])[];
  readonly series: readonly (readonly [string, TimeSeriesState])[];
  readonly timelines: readonly (readonly [string, TimelineState])[];
  readonly sets: readonly (readonly [string, readonly string[]])[];
  readonly windowed: readonly (readonly [string, readonly (readonly [number, readonly number[]])[]])[];
}

function getOrCreate<T>(map: Map<string, T>, key: string, create: () => T): T {
  let value = map.get(key);
  if (!value) {
    value = create();
    map.set(key, value);
  }
  return value;
}
