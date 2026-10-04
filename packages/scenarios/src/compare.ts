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

const hasTraffic = (s: TelemetrySnapshot) => s.requests.created > 0;
const sum = <T>(items: readonly T[], read: (item: T) => number) => items.reduce((total, item) => total + read(item), 0);
const maxOf = <T>(items: readonly T[], read: (item: T) => number) => Math.max(0, ...items.map(read));

const METRICS: readonly {
  id: string;
  label: string;
  unit: MetricDelta['unit'];
  direction: Direction;
  read(s: TelemetrySnapshot): number;
  /** Shown only when either run uses the subsystem. Core request metrics always apply. */
  applies?(s: TelemetrySnapshot): boolean;
}[] = [
  { id: 'throughput', label: 'Throughput', unit: 'rate', direction: 'higher_is_better', read: (s) => s.requests.throughputPerSec, applies: hasTraffic },
  { id: 'success', label: 'Success rate', unit: 'ratio', direction: 'higher_is_better', read: (s) => s.requests.successRate, applies: hasTraffic },
  { id: 'errors', label: 'Failed requests', unit: 'count', direction: 'lower_is_better', read: (s) => s.requests.failed, applies: hasTraffic },
  { id: 'p50', label: 'p50 latency', unit: 'ms', direction: 'lower_is_better', read: (s) => s.latency.p50, applies: hasTraffic },
  { id: 'p95', label: 'p95 latency', unit: 'ms', direction: 'lower_is_better', read: (s) => s.latency.p95, applies: hasTraffic },
  { id: 'p99', label: 'p99 latency', unit: 'ms', direction: 'lower_is_better', read: (s) => s.latency.p99, applies: hasTraffic },
  { id: 'max', label: 'Max latency', unit: 'ms', direction: 'lower_is_better', read: (s) => s.latency.max, applies: hasTraffic },
  { id: 'timeouts', label: 'Timeouts', unit: 'count', direction: 'lower_is_better', read: (s) => s.timeouts, applies: hasTraffic },
  { id: 'rejected', label: 'Rejected', unit: 'count', direction: 'lower_is_better', read: (s) => s.requests.rejected, applies: hasTraffic },
  { id: 'dropped', label: 'Dropped messages', unit: 'count', direction: 'lower_is_better', read: (s) => s.messages.dropped },
  {
    id: 'peak_queue',
    label: 'Peak queue depth (any node)',
    unit: 'count',
    direction: 'lower_is_better',
    read: (s) => Math.max(0, ...s.nodes.map((n) => n.maxQueueDepth)),
    applies: hasTraffic,
  },
  {
    id: 'peak_utilization',
    label: 'Highest node utilisation',
    unit: 'ratio',
    direction: 'neutral',
    read: (s) => Math.max(0, ...s.nodes.filter((n) => n.utilization > 0).map((n) => n.utilization)),
    applies: hasTraffic,
  },
  { id: 'created', label: 'Requests issued', unit: 'count', direction: 'neutral', read: (s) => s.requests.created, applies: hasTraffic },

  // Subsystems — only when in use.
  {
    id: 'retries',
    label: 'Retries',
    unit: 'count',
    direction: 'lower_is_better',
    read: (s) => s.modules.reliability.retries,
    applies: (s) => s.modules.reliability.retries > 0 || s.modules.reliability.circuits.length > 0,
  },
  {
    id: 'replication_lag_max',
    label: 'Max replication lag',
    unit: 'ms',
    direction: 'lower_is_better',
    read: (s) => maxOf(s.modules.data.replicas, (r) => r.maxLagMs),
    applies: (s) => s.modules.data.replicas.length > 0,
  },
  {
    id: 'replication_lag_mean',
    label: 'Mean replication lag (worst replica)',
    unit: 'ms',
    direction: 'lower_is_better',
    read: (s) => maxOf(s.modules.data.replicas, (r) => r.meanLagMs),
    applies: (s) => s.modules.data.replicas.length > 0,
  },
  {
    id: 'stale_reads',
    label: 'Stale reads',
    unit: 'count',
    direction: 'lower_is_better',
    read: (s) => s.modules.data.staleReads,
    applies: (s) => s.modules.data.replicas.length > 0,
  },
  {
    id: 'version_regressions',
    label: 'Version regressions',
    unit: 'count',
    direction: 'lower_is_better',
    read: (s) => s.modules.data.versionRegressions,
    applies: (s) => s.modules.data.replicas.length > 0,
  },
  {
    id: 'duplicate_writes',
    label: 'Duplicate writes applied',
    unit: 'count',
    direction: 'lower_is_better',
    read: (s) => s.modules.data.duplicateWritesApplied,
    applies: (s) => s.modules.data.duplicateWritesApplied + s.modules.data.duplicateWritesSuppressed > 0,
  },
  {
    id: 'dead_lettered',
    label: 'Dead-lettered messages',
    unit: 'count',
    direction: 'lower_is_better',
    read: (s) => sum(s.modules.queues.queues, (q) => q.deadLettered),
    applies: (s) => s.modules.queues.queues.length > 0,
  },
  {
    id: 'redelivered',
    label: 'Redeliveries',
    unit: 'count',
    direction: 'lower_is_better',
    read: (s) => sum(s.modules.queues.queues, (q) => q.redelivered),
    applies: (s) => s.modules.queues.queues.length > 0,
  },
  {
    id: 'elections',
    label: 'Leader elections',
    unit: 'count',
    direction: 'lower_is_better',
    read: (s) => sum(s.modules.consensus.clusters, (c) => c.elections),
    applies: (s) => s.modules.consensus.clusters.length > 0,
  },
  {
    id: 'leaderless',
    label: 'Time without a leader',
    unit: 'ms',
    direction: 'lower_is_better',
    read: (s) => sum(s.modules.consensus.clusters, (c) => c.unavailableMs),
    applies: (s) => s.modules.consensus.clusters.length > 0,
  },
  {
    id: 'commits',
    label: 'Committed entries',
    unit: 'count',
    direction: 'higher_is_better',
    read: (s) => sum(s.modules.consensus.clusters, (c) => c.commits),
    applies: (s) => s.modules.consensus.clusters.length > 0,
  },
  {
    id: 'lock_acquisitions',
    label: 'Lock acquisitions',
    unit: 'count',
    direction: 'higher_is_better',
    read: (s) => sum(s.modules.locks.resources, (r) => r.acquisitions),
    applies: (s) => s.modules.locks.resources.length > 0,
  },
  {
    id: 'lock_wait_p95',
    label: 'Lock wait p95 (worst lock)',
    unit: 'ms',
    direction: 'lower_is_better',
    read: (s) => maxOf(s.modules.locks.resources, (r) => r.wait.p95),
    applies: (s) => s.modules.locks.resources.length > 0,
  },
  {
    id: 'lease_expiries',
    label: 'Lock leases expired',
    unit: 'count',
    direction: 'lower_is_better',
    read: (s) => sum(s.modules.locks.resources, (r) => r.expirations),
    applies: (s) => s.modules.locks.resources.length > 0,
  },
  {
    id: 'fenced',
    label: 'Stale writes refused by fencing',
    unit: 'count',
    direction: 'neutral',
    read: (s) => sum(s.modules.locks.resources, (r) => r.fencedRejections),
    applies: (s) => s.modules.locks.resources.length > 0,
  },
  {
    id: 'safety_violations',
    label: 'Safety violations',
    unit: 'count',
    direction: 'lower_is_better',
    read: (s) => sum(s.modules.locks.resources, (r) => r.safetyViolations),
    applies: (s) => s.modules.locks.resources.length > 0,
  },
];

/**
 * Measured differences between two runs. It reports which way each metric
 * moved and leaves the verdict to the reader: whether lower p99 is worth
 * fewer successful requests depends on what the system is for.
 */
export function compareSnapshots(a: TelemetrySnapshot, b: TelemetrySnapshot): MetricDelta[] {
  return METRICS.filter((metric) => !metric.applies || metric.applies(a) || metric.applies(b)).map((metric) => {
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
