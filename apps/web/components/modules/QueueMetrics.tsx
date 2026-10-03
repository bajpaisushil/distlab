'use client';

import { useLab } from '@/lib/store';
import { StatTile } from '@/components/charts/StatTile';
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart';
import { formatCount, formatMs } from '@/lib/format';

const SLOTS = ['--series-1', '--series-2', '--series-3', '--series-4'];

/** Queue depth, throughput and the delivery guarantees' side effects. */
export function QueueMetrics() {
  const queues = useLab((s) => s.frame?.snapshot.modules.queues.queues);
  const now = useLab((s) => s.frame?.now ?? 0);
  const duration = useLab((s) => s.frame?.durationMs ?? 1);
  const spec = useLab((s) => s.spec);
  if (!queues || queues.length === 0) return null;
  const label = (id: string) => spec.nodes.find((n) => n.id === id)?.label ?? id;
  const shown = queues.slice(0, SLOTS.length);

  return (
    <div className="stack">
      <div className="stat-grid">
        {queues.map((q) => (
          <StatTile
            key={q.queueId}
            label={`${label(q.queueId)}`}
            value={`${formatCount(q.consumed)} / ${formatCount(q.enqueued)}`}
            sub={`consumed / enqueued · p95 ${formatMs(q.latency.p95)}`}
          />
        ))}
        {queues.some((q) => q.rejected > 0) ? (
          <StatTile label="Refused (backpressure)" value={formatCount(queues.reduce((a, q) => a + q.rejected, 0))} tone="warning" sub="queue full" />
        ) : null}
        {queues.some((q) => q.redelivered > 0) ? (
          <StatTile label="Redeliveries" value={formatCount(queues.reduce((a, q) => a + q.redelivered, 0))} />
        ) : null}
        {queues.some((q) => q.deadLettered > 0) ? (
          <StatTile label="Dead-lettered" value={formatCount(queues.reduce((a, q) => a + q.deadLettered, 0))} tone="critical" />
        ) : null}
        {queues.some((q) => q.duplicates > 0) ? (
          <StatTile label="Processed twice" value={formatCount(queues.reduce((a, q) => a + q.duplicates, 0))} tone="warning" sub="at-least-once delivery" />
        ) : null}
      </div>
      <div className="chart-grid">
        <TimeSeriesChart
          title="Queue depth"
          subtitle="Items waiting for a worker"
          xMax={duration}
          now={now}
          format={(v) => formatCount(v)}
          series={shown.map((q, i) => ({ id: q.queueId, label: label(q.queueId), color: `var(${SLOTS[i]})`, points: q.depth, step: true }))}
        />
        <TimeSeriesChart
          title="Consumer lag"
          subtitle="How long items waited before delivery, per second"
          xMax={duration}
          now={now}
          format={(v) => formatMs(v)}
          series={shown.map((q, i) => ({ id: q.queueId, label: label(q.queueId), color: `var(${SLOTS[i]})`, points: q.waitMs }))}
        />
        <TimeSeriesChart
          title="Consumed"
          subtitle="Items acknowledged per second"
          xMax={duration}
          now={now}
          format={(v) => formatCount(v)}
          series={shown.map((q, i) => ({ id: q.queueId, label: label(q.queueId), color: `var(${SLOTS[i]})`, points: q.consumedPerSecond }))}
        />
      </div>
    </div>
  );
}
