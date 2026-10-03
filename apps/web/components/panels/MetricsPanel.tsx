'use client';

import { useMemo } from 'react';
import { useLab } from '@/lib/store';
import { StatTile } from '@/components/charts/StatTile';
import { TimeSeriesChart, type ChartMarker } from '@/components/charts/TimeSeriesChart';
import { BarList } from '@/components/charts/BarList';
import { formatCount, formatMs, formatPercent, formatRate } from '@/lib/format';
import { ModuleMetrics } from './ModuleMetrics';

/** Measured results. Every tile and line is computed by the engine from events it processed. */
export function MetricsPanel() {
  const frame = useLab((s) => s.frame);
  const spec = useLab((s) => s.spec);

  const markers = useMemo<ChartMarker[]>(
    () =>
      (frame?.markers ?? [])
        .filter((m) => m.kind === 'fault' || m.kind === 'failure' || m.kind === 'partition')
        .map((m) => ({ t: m.at, label: m.label, color: 'var(--critical)' })),
    [frame?.markers],
  );

  if (!frame) return <div className="empty">Loading the engine…</div>;
  const s = frame.snapshot;
  const settled = s.requests.completed + s.requests.failed;
  const xMax = frame.durationMs;
  const labels = new Map(spec.nodes.map((n) => [n.id, n.label ?? n.id]));
  const servers = frame.nodes.filter((n) => n.type !== 'client');

  return (
    <div className="metrics-body" data-testid="metrics">
      <div className="stat-grid">
        <StatTile label="Requests" value={formatCount(s.requests.created)} sub={`${formatCount(settled)} settled`} />
        <StatTile label="Throughput" value={formatRate(s.requests.throughputPerSec)} sub="completed / virtual s" />
        <StatTile
          label="Success rate"
          value={settled === 0 ? '—' : formatPercent(s.requests.successRate)}
          sub={`${formatCount(s.requests.failed)} failed`}
          {...(settled > 0 ? { tone: s.requests.successRate >= 0.99 ? 'good' : s.requests.successRate >= 0.9 ? 'warning' : 'critical' } as const : {})}
        />
        <StatTile label="p50 latency" value={formatMs(s.latency.p50)} sub={`mean ${formatMs(s.latency.mean)}`} />
        <StatTile label="p95 latency" value={formatMs(s.latency.p95)} />
        <StatTile label="p99 latency" value={formatMs(s.latency.p99)} sub={`max ${formatMs(s.latency.max)}`} />
        <StatTile label="Timeouts" value={formatCount(s.timeouts)} />
        <StatTile
          label="Dropped messages"
          value={formatCount(s.messages.dropped)}
          sub={`${formatCount(s.messages.duplicated)} duplicated`}
        />
        <StatTile label="On the wire" value={formatCount(frame.inFlightTotal)} sub={`${formatCount(s.messages.sent)} sent total`} />
      </div>

      <div className="chart-grid">
        <TimeSeriesChart
          title="Throughput"
          subtitle="Requests settled per virtual second"
          xMax={xMax}
          now={frame.now}
          markers={markers}
          format={(v) => formatCount(v)}
          series={[
            { id: 'ok', label: 'Completed', color: 'var(--series-1)', points: s.throughput.completed },
            { id: 'failed', label: 'Failed', color: 'var(--critical)', points: s.throughput.failed },
          ]}
        />
        <TimeSeriesChart
          title="Latency percentiles"
          subtitle="Of requests completing in each second"
          xMax={xMax}
          now={frame.now}
          markers={markers}
          format={(v) => formatMs(v)}
          series={[
            { id: 'p50', label: 'p50', color: 'var(--p50)', points: s.throughput.percentiles.map((p) => ({ t: p.t, value: p.p50 })) },
            { id: 'p95', label: 'p95', color: 'var(--p95)', points: s.throughput.percentiles.map((p) => ({ t: p.t, value: p.p95 })) },
            { id: 'p99', label: 'p99', color: 'var(--p99)', points: s.throughput.percentiles.map((p) => ({ t: p.t, value: p.p99 })) },
          ]}
        />
        <BarList
          title="Utilisation"
          subtitle="Share of worker time busy since the start, including time waiting on downstream calls"
          max={1}
          items={servers.map((n) => ({
            id: n.id,
            label: labels.get(n.id) ?? n.id,
            value: Math.min(1, n.utilization),
            display: formatPercent(n.utilization, 0),
            ...(n.status === 'failed' ? { tone: 'critical' as const } : n.utilization > 0.85 ? { tone: 'warning' as const } : {}),
          }))}
        />
        <FailureBreakdown />
      </div>

      <ModuleMetrics />

      <PerNodeTable />
    </div>
  );
}

function FailureBreakdown() {
  const snapshot = useLab((s) => s.frame?.snapshot);
  if (!snapshot) return null;
  const failures = Object.entries(snapshot.failuresByReason);
  const drops = Object.entries(snapshot.messages.dropsByReason);
  const items = [
    ...failures.map(([reason, count]) => ({ id: `f-${reason}`, label: `request ${reason.replace(/_/g, ' ')}`, value: count })),
    ...drops.map(([reason, count]) => ({ id: `d-${reason}`, label: `dropped: ${reason.replace(/_/g, ' ')}`, value: count })),
  ].sort((a, b) => b.value - a.value);
  return (
    <BarList
      title="Where things went wrong"
      subtitle="Failed requests by reason, and messages the network discarded"
      items={items.map((i) => ({ ...i, display: formatCount(i.value), tone: 'critical' as const }))}
    />
  );
}

function PerNodeTable() {
  const frame = useLab((s) => s.frame);
  const spec = useLab((s) => s.spec);
  const select = useLab((s) => s.select);
  if (!frame) return null;
  const labels = new Map(spec.nodes.map((n) => [n.id, n.label ?? n.id]));
  return (
    <div className="chart-card" style={{ padding: 0, overflowX: 'auto' }}>
      <table className="table">
        <thead>
          <tr>
            <th>Node</th>
            <th>Status</th>
            <th className="num">In flight</th>
            <th className="num">Queued</th>
            <th className="num">Peak queue</th>
            <th className="num">Served</th>
            <th className="num">Failed</th>
            <th className="num">Rejected</th>
            <th className="num">Utilisation</th>
            <th className="num">Service p50</th>
            <th className="num">Service p99</th>
          </tr>
        </thead>
        <tbody>
          {frame.snapshot.nodes.map((n) => (
            <tr key={n.id} className="clickable" onClick={() => select({ kind: 'node', id: n.id })}>
              <td>{labels.get(n.id) ?? n.id}</td>
              <td>
                <span className={`pill status-${n.status === 'failed' ? 'critical' : 'good'}`}>
                  <span className="dot" />
                  {n.status === 'failed' ? 'down' : n.status}
                </span>
              </td>
              <td className="num">{n.inFlight}</td>
              <td className="num">{n.queueDepth}</td>
              <td className="num">{n.maxQueueDepth}</td>
              <td className="num">{formatCount(n.processed)}</td>
              <td className="num">{formatCount(n.failed)}</td>
              <td className="num">{formatCount(n.rejected)}</td>
              <td className="num">{formatPercent(n.utilization, 0)}</td>
              <td className="num">{n.serviceTime.count ? formatMs(n.serviceTime.p50) : '—'}</td>
              <td className="num">{n.serviceTime.count ? formatMs(n.serviceTime.p99) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
