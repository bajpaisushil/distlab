'use client';

import { compareSnapshots, verdictOf, type MetricDelta } from '@distlab/scenarios';
import type { TelemetrySnapshot } from '@distlab/telemetry';
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart';
import { formatCount, formatMs, formatPercent, formatRate } from '@/lib/format';

function show(delta: MetricDelta, value: number): string {
  switch (delta.unit) {
    case 'ms':
      return formatMs(value);
    case 'ratio':
      return formatPercent(value);
    case 'rate':
      return formatRate(value);
    default:
      return formatCount(value);
  }
}

/**
 * Two runs side by side. It reports what moved and in which direction, and
 * deliberately stops there: which trade-off is acceptable is the reader's call.
 */
export function RunComparison({
  a,
  b,
  labelA,
  labelB,
  durationMs,
}: {
  a: TelemetrySnapshot;
  b: TelemetrySnapshot;
  labelA: string;
  labelB: string;
  durationMs: number;
}) {
  const deltas = compareSnapshots(a, b);
  return (
    <div className="stack" data-testid="comparison">
      <div className="chart-card" style={{ padding: 0, overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th>Metric</th>
              <th className="num">{labelA}</th>
              <th className="num">{labelB}</th>
              <th className="num">Change</th>
              <th>Direction</th>
            </tr>
          </thead>
          <tbody>
            {deltas.map((d) => {
              const verdict = verdictOf(d);
              return (
                <tr key={d.id}>
                  <td>{d.label}</td>
                  <td className="num">{show(d, d.a)}</td>
                  <td className="num">{show(d, d.b)}</td>
                  <td className="num">
                    {d.relative === undefined ? (d.delta === 0 ? '—' : show(d, d.delta)) : `${d.relative > 0 ? '+' : ''}${(d.relative * 100).toFixed(1)}%`}
                  </td>
                  <td>
                    {verdict === 'same' ? (
                      <span className="muted">no meaningful change</span>
                    ) : (
                      <span className={`pill status-${verdict === 'better' ? 'good' : 'critical'}`}>
                        <span className="dot" />
                        {verdict === 'better' ? 'improved' : 'regressed'}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="chart-grid">
        <TimeSeriesChart
          title="Throughput"
          subtitle="Completed requests per second"
          xMax={durationMs}
          format={(v) => formatCount(v)}
          series={[
            { id: 'a', label: labelA, color: 'var(--series-1)', points: a.throughput.completed },
            { id: 'b', label: labelB, color: 'var(--series-2)', points: b.throughput.completed },
          ]}
        />
        <TimeSeriesChart
          title="p99 latency"
          subtitle="Of requests completing in each second"
          xMax={durationMs}
          format={(v) => formatMs(v)}
          series={[
            { id: 'a', label: labelA, color: 'var(--series-1)', points: a.throughput.percentiles.map((p) => ({ t: p.t, value: p.p99 })) },
            { id: 'b', label: labelB, color: 'var(--series-2)', points: b.throughput.percentiles.map((p) => ({ t: p.t, value: p.p99 })) },
          ]}
        />
        <TimeSeriesChart
          title="Failures"
          subtitle="Failed requests per second"
          xMax={durationMs}
          format={(v) => formatCount(v)}
          series={[
            { id: 'a', label: labelA, color: 'var(--series-1)', points: a.throughput.failed },
            { id: 'b', label: labelB, color: 'var(--series-2)', points: b.throughput.failed },
          ]}
        />
      </div>
      <div className="field-hint">
        Same seed, same workload: differences come from the configuration, not from luck. Measured results under this
        workload only — neither design is “better” in general.
      </div>
    </div>
  );
}
