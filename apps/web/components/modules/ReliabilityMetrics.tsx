'use client';

import { useLab } from '@/lib/store';
import { StatTile } from '@/components/charts/StatTile';
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart';
import { BarList } from '@/components/charts/BarList';
import { formatCount } from '@/lib/format';

const CIRCUIT_LABEL = ['closed', 'half-open', 'open'];
const SLOTS = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-6'];

/** Retries, timeouts and circuit breakers — shown only when something used them. */
export function ReliabilityMetrics() {
  const reliability = useLab((s) => s.frame?.snapshot.modules.reliability);
  const now = useLab((s) => s.frame?.now ?? 0);
  const duration = useLab((s) => s.frame?.durationMs ?? 1);
  const spec = useLab((s) => s.spec);
  if (!reliability) return null;
  const used =
    reliability.retries > 0 ||
    reliability.callTimeouts > 0 ||
    reliability.circuits.length > 0 ||
    Object.keys(reliability.bulkheadRejections).length > 0 ||
    spec.nodes.some((n) => n.config?.retry || n.config?.circuitBreaker || n.config?.callTimeoutMs);
  if (!used) return null;
  const label = (id: string) => spec.nodes.find((n) => n.id === id)?.label ?? id;
  const circuits = reliability.circuits.slice(0, SLOTS.length);

  return (
    <div className="stack">
      <div className="stat-grid">
        <StatTile label="Retries" value={formatCount(reliability.retries)} sub={Object.entries(reliability.retriesByReason).map(([r, n]) => `${n} ${r}`).join(' · ') || 'none'} />
        <StatTile label="Attempts per request" value={reliability.attemptsPerRequest.toFixed(2)} sub="1.00 means no retries needed" />
        <StatTile label="Call timeouts" value={formatCount(reliability.callTimeouts)} sub={`${formatCount(reliability.deadlineTimeouts)} deadline timeouts`} />
        <StatTile label="Failed fast" value={formatCount(reliability.fastFails)} sub="refused by an open circuit" />
      </div>
      <div className="chart-grid">
        <TimeSeriesChart
          title="Retries"
          subtitle="Retries scheduled per second, by every caller"
          xMax={duration}
          now={now}
          format={(v) => formatCount(v)}
          series={[{ id: 'retries', label: 'Retries', color: 'var(--series-2)', points: reliability.retriesPerSecond }]}
        />
        {circuits.length > 0 ? (
          <TimeSeriesChart
            title="Circuit breakers"
            subtitle="State of each caller → target circuit over time"
            xMax={duration}
            now={now}
            yMax={2}
            format={(v) => CIRCUIT_LABEL[Math.round(v)] ?? ''}
            series={circuits.map((c, i) => ({
              id: `${c.nodeId}|${c.target}`,
              label: `${label(c.nodeId)} → ${label(c.target)} (opened ${c.opened}×)`,
              color: `var(${SLOTS[i]})`,
              points: c.timeline,
              step: true,
            }))}
          />
        ) : null}
        {Object.keys(reliability.bulkheadRejections).length > 0 ? (
          <BarList
            title="Bulkhead rejections"
            subtitle="Requests refused because their class was at its limit"
            items={Object.entries(reliability.bulkheadRejections).map(([key, count]) => {
              const [nodeId, name] = key.split(':') as [string, string];
              return { id: key, label: `${label(nodeId)} · ${name}`, value: count, display: formatCount(count), tone: 'warning' as const };
            })}
          />
        ) : null}
      </div>
    </div>
  );
}
