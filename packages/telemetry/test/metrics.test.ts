import { describe, expect, it } from 'vitest';
import { Counter, Gauge, Histogram, MetricsRegistry, TimeSeries } from '../src/metrics.js';

describe('Counter', () => {
  it('totals increments and breaks them down by label', () => {
    const counter = new Counter();
    counter.add(1, 'packet_loss');
    counter.add(2, 'partitioned');
    counter.add(1, 'packet_loss');
    counter.add(5);
    expect(counter.total).toBe(9);
    expect(counter.byLabel()).toEqual({ packet_loss: 2, partitioned: 2 });
  });
});

describe('Gauge', () => {
  it('tracks the current value and the extremes it reached', () => {
    const gauge = new Gauge();
    for (const value of [3, 9, 2, 7]) gauge.set(value);
    expect(gauge.value).toBe(7);
    expect(gauge.max).toBe(9);
  });
});

describe('Histogram', () => {
  it('computes exact percentiles over a known distribution', () => {
    const histogram = new Histogram('latency');
    for (let i = 1; i <= 100; i++) histogram.record(i);
    const p = histogram.percentiles();
    expect(p.count).toBe(100);
    expect(p.min).toBe(1);
    expect(p.max).toBe(100);
    expect(p.mean).toBeCloseTo(50.5, 6);
    expect(p.p50).toBe(50);
    expect(p.p95).toBe(95);
    expect(p.p99).toBe(99);
  });

  it('is unaffected by the order samples arrive in', () => {
    const ascending = new Histogram('a');
    const descending = new Histogram('b');
    for (let i = 1; i <= 500; i++) ascending.record(i);
    for (let i = 500; i >= 1; i--) descending.record(i);
    expect(ascending.percentiles()).toEqual(descending.percentiles());
  });

  it('reports zeros rather than NaN when nothing was recorded', () => {
    expect(new Histogram('empty').percentiles()).toEqual({
      count: 0,
      min: 0,
      max: 0,
      mean: 0,
      p50: 0,
      p95: 0,
      p99: 0,
    });
  });

  it('keeps counting beyond its sample cap and stays deterministic', () => {
    const build = () => {
      const histogram = new Histogram('capped', 100);
      for (let i = 0; i < 5000; i++) histogram.record(i % 250);
      return histogram;
    };
    const first = build();
    const second = build();
    expect(first.count).toBe(5000);
    expect(first.percentiles()).toEqual(second.percentiles());
  });

  it('handles a single sample', () => {
    const histogram = new Histogram('one');
    histogram.record(42);
    const p = histogram.percentiles();
    expect([p.p50, p.p95, p.p99, p.mean]).toEqual([42, 42, 42, 42]);
  });
});

describe('TimeSeries', () => {
  it('buckets by window and converts to a per-second rate', () => {
    const series = new TimeSeries(1000);
    for (const t of [0, 100, 900, 1200, 1800, 5000]) series.record(t);
    expect(series.points()).toEqual([
      { t: 0, count: 3, sum: 3 },
      { t: 1000, count: 2, sum: 2 },
      { t: 5000, count: 1, sum: 1 },
    ]);
    expect(series.ratePerSecond()).toEqual([
      { t: 0, value: 3 },
      { t: 1000, value: 2 },
      { t: 5000, value: 1 },
    ]);
  });

  it('scales the rate to the window size', () => {
    const series = new TimeSeries(250);
    for (let i = 0; i < 5; i++) series.record(i);
    expect(series.ratePerSecond()).toEqual([{ t: 0, value: 20 }]);
  });
});

describe('MetricsRegistry', () => {
  it('returns the same instrument for a repeated name', () => {
    const registry = new MetricsRegistry();
    registry.counter('a').add(2);
    registry.counter('a').add(3);
    expect(registry.counter('a').total).toBe(5);
    expect(registry.histogram('h')).toBe(registry.histogram('h'));
  });
});
