'use client';

import { useLab } from '@/lib/store';
import { StatTile } from '@/components/charts/StatTile';
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart';
import { BarList } from '@/components/charts/BarList';
import { formatCount, formatMs, formatPercent } from '@/lib/format';

const SLOTS = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-6'];

/** Replication lag, stale reads and caching — shown when the scenario uses them. */
export function DataMetrics() {
  const data = useLab((s) => s.frame?.snapshot.modules.data);
  const now = useLab((s) => s.frame?.now ?? 0);
  const duration = useLab((s) => s.frame?.durationMs ?? 1);
  const spec = useLab((s) => s.spec);
  if (!data) return null;
  const label = (id: string) => spec.nodes.find((n) => n.id === id)?.label ?? id;
  const hasReplicas = data.replicas.length > 0;
  const hasCaches = data.caches.length > 0;
  const storage = Object.entries(data.storageLoad);
  if (!hasReplicas && !hasCaches && data.duplicateWritesApplied + data.duplicateWritesSuppressed === 0 && storage.length < 2) return null;

  return (
    <div className="stack">
      <div className="stat-grid">
        <StatTile label="Reads / writes" value={`${formatCount(data.reads)} / ${formatCount(data.writes)}`} />
        {hasReplicas ? (
          <StatTile
            label="Stale reads"
            value={formatCount(data.staleReads)}
            sub={`${formatPercent(data.reads === 0 ? 0 : data.staleReads / data.reads)} of all reads`}
            {...(data.staleReads > 0 ? { tone: 'warning' as const } : {})}
          />
        ) : null}
        {hasReplicas ? (
          <StatTile label="Worst replication lag" value={formatMs(Math.max(0, ...data.replicas.map((r) => r.maxLagMs)))} />
        ) : null}
        {data.versionRegressions > 0 ? (
          <StatTile label="Version regressions" value={formatCount(data.versionRegressions)} sub="keys rolled back" tone="critical" />
        ) : null}
        {data.duplicateWritesApplied > 0 ? (
          <StatTile label="Writes applied twice" value={formatCount(data.duplicateWritesApplied)} sub="not idempotent" tone="critical" />
        ) : null}
        {data.duplicateWritesSuppressed > 0 ? (
          <StatTile label="Duplicates suppressed" value={formatCount(data.duplicateWritesSuppressed)} sub="idempotency" tone="good" />
        ) : null}
        {data.caches.map((c) => (
          <StatTile key={c.nodeId} label={`${label(c.nodeId)} hit ratio`} value={formatPercent(c.hitRatio)} sub={`${formatCount(c.misses)} misses · ${formatCount(c.coalesced)} coalesced`} />
        ))}
      </div>
      <div className="chart-grid">
        {hasReplicas ? (
          <TimeSeriesChart
            title="Replication lag"
            subtitle="Write-to-visible delay of records applied each second"
            xMax={duration}
            now={now}
            format={(v) => formatMs(v)}
            series={data.replicas.slice(0, SLOTS.length).map((r, i) => ({
              id: r.replicaId,
              label: label(r.replicaId),
              color: `var(${SLOTS[i]})`,
              points: r.lag,
            }))}
          />
        ) : null}
        {hasCaches ? (
          <TimeSeriesChart
            title="Cache hit ratio"
            subtitle="Share of lookups served from cache each second"
            xMax={duration}
            now={now}
            yMax={1}
            format={(v) => formatPercent(v, 0)}
            series={data.caches.slice(0, SLOTS.length).map((c, i) => ({
              id: c.nodeId,
              label: label(c.nodeId),
              color: `var(${SLOTS[i]})`,
              points: c.hitRatioOverTime,
            }))}
          />
        ) : null}
        {storage.length > 1 ? (
          <BarList
            title="Storage load"
            subtitle="Reads and writes each storage node served"
            items={storage
              .sort((a, b) => b[1] - a[1])
              .map(([id, count]) => ({ id, label: label(id), value: count, display: formatCount(count) }))}
          />
        ) : null}
        {hasReplicas ? (
          <BarList
            title="Stale reads by replica"
            subtitle="Share of each replica’s reads that missed a newer write"
            max={1}
            items={data.replicas.map((r) => ({
              id: r.replicaId,
              label: label(r.replicaId),
              value: r.staleRate,
              display: `${formatPercent(r.staleRate)} of ${formatCount(r.reads)}`,
              ...(r.staleRate > 0.05 ? { tone: 'warning' as const } : {}),
            }))}
          />
        ) : null}
      </div>
    </div>
  );
}
