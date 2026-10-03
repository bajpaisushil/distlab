import type { TelemetrySnapshot } from '@distlab/telemetry';

export type Direction = 'higher_is_better' | 'lower_is_better' | 'neutral';

export interface MetricDelta {
  readonly id: string;
  readonly label: string;
  readonly a: number;
  readonly b: number;
  /** b − a */
  readonly delta: number;
  /** (b − a) / a, or undefined when a is zero. */
  readonly relative: number | undefined;
  readonly direction: Direction;
  readonly unit: 'ms' | 'ratio' | 'count' | 'rate';
}

const METRICS: readonly {
  id: string;
  label: string;
  unit: MetricDelta['unit'];
  direction: Direction;
  read(s: TelemetrySnapshot): number;
}[] = [
  { id: 'throughput', label: 'Throughput', unit: 'rate', direction: 'higher_is_better', read: (s) => s.requests.throughputPerSec },
  { id: 'success', label: 'Success rate', unit: 'ratio', direction: 'higher_is_better', read: (s) => s.requests.successRate },
  { id: 'errors', label: 'Failed requests', unit: 'count', direction: 'lower_is_better', read: (s) => s.requests.failed },
  { id: 'p50', label: 'p50 latency', unit: 'ms', direction: 'lower_is_better', read: (s) => s.latency.p50 },
  { id: 'p95', label: 'p95 latency', unit: 'ms', direction: 'lower_is_better', read: (s) => s.latency.p95 },
  { id: 'p99', label: 'p99 latency', unit: 'ms', direction: 'lower_is_better', read: (s) => s.latency.p99 },
  { id: 'max', label: 'Max latency', unit: 'ms', direction: 'lower_is_better', read: (s) => s.latency.max },
  { id: 'timeouts', label: 'Timeouts', unit: 'count', direction: 'lower_is_better', read: (s) => s.timeouts },
  { id: 'rejected', label: 'Rejected', unit: 'count', direction: 'lower_is_better', read: (s) => s.requests.rejected },
  { id: 'dropped', label: 'Dropped messages', unit: 'count', direction: 'lower_is_better', read: (s) => s.messages.dropped },
  {
    id: 'peak_queue',
    label: 'Peak queue depth (any node)',
    unit: 'count',
    direction: 'lower_is_better',
    read: (s) => Math.max(0, ...s.nodes.map((n) => n.maxQueueDepth)),
  },
  {
    id: 'peak_utilization',
    label: 'Highest node utilisation',
    unit: 'ratio',
    direction: 'neutral',
    read: (s) => Math.max(0, ...s.nodes.filter((n) => n.utilization > 0).map((n) => n.utilization)),
  },
  { id: 'created', label: 'Requests issued', unit: 'count', direction: 'neutral', read: (s) => s.requests.created },
];

/**
 * Measured differences between two runs. It reports which way each metric
 * moved and leaves the verdict to the reader: whether lower p99 is worth
 * fewer successful requests depends on what the system is for.
 */
export function compareSnapshots(a: TelemetrySnapshot, b: TelemetrySnapshot): MetricDelta[] {
  return METRICS.map((metric) => {
    const va = metric.read(a);
    const vb = metric.read(b);
    return {
      id: metric.id,
      label: metric.label,
      a: va,
      b: vb,
      delta: vb - va,
      relative: va === 0 ? undefined : (vb - va) / va,
      direction: metric.direction,
      unit: metric.unit,
    };
  });
}

/** Whether B moved this metric in its preferred direction, against it, or not meaningfully. */
export function verdictOf(delta: MetricDelta): 'better' | 'worse' | 'same' {
  const meaningful = Math.abs(delta.delta) > 1e-9 && (delta.relative === undefined || Math.abs(delta.relative) >= 0.01);
  if (!meaningful || delta.direction === 'neutral') return 'same';
  const up = delta.delta > 0;
  return (delta.direction === 'higher_is_better') === up ? 'better' : 'worse';
}
