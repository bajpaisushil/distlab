'use client';

import { useLab } from '@/lib/store';
import { StatTile } from '@/components/charts/StatTile';
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart';
import { formatClock, formatCount, formatMs } from '@/lib/format';

const LEADER_COLOURS = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-7'];

/** Who led, when, in which term — and when more than one node believed it did. */
export function ConsensusMetrics() {
  const consensus = useLab((s) => s.frame?.snapshot.modules.consensus);
  const now = useLab((s) => s.frame?.now ?? 0);
  const duration = useLab((s) => s.frame?.durationMs ?? 1);
  const spec = useLab((s) => s.spec);
  if (!consensus || consensus.clusters.length === 0) return null;
  const label = (id: string) => spec.nodes.find((n) => n.id === id)?.label ?? id;

  return (
    <div className="stack">
      {consensus.clusters.map((cluster) => {
        const leaders = [...new Set(cluster.leadership.map((l) => l.leaderId))];
        const colour = (id: string) => `var(${LEADER_COLOURS[leaders.indexOf(id) % LEADER_COLOURS.length]})`;
        return (
          <div key={cluster.clusterId} className="stack">
            <div className="stat-grid">
              <StatTile label={`Leader · ${cluster.clusterId}`} value={cluster.leader ? label(cluster.leader) : 'none'} sub={`term ${cluster.term}`} {...(cluster.leader ? {} : { tone: 'serious' as const })} />
              <StatTile label="Elections" value={formatCount(cluster.elections)} sub={`${cluster.failedElections} split or lost`} />
              <StatTile label="Without a leader" value={formatMs(cluster.unavailableMs)} sub="no commits possible" {...(cluster.unavailableMs > 0 ? { tone: 'warning' as const } : {})} />
              <StatTile label="Committed entries" value={formatCount(cluster.commits)} />
              {cluster.maxBelievedLeaders > 1 ? (
                <StatTile label="Split brain" value={`${cluster.maxBelievedLeaders} leaders`} sub="believed at once" tone="critical" />
              ) : null}
            </div>
            <div className="chart-card">
              <h4 className="chart-title">Leadership</h4>
              <p className="chart-subtitle">Who the cluster’s latest leader was over time; gaps are periods with no leader</p>
              <div style={{ position: 'relative', height: 26, marginTop: 10, background: 'var(--surface-2)', borderRadius: 4, overflow: 'hidden' }}>
                {cluster.leadership.map((l) => {
                  const left = (l.from / duration) * 100;
                  const width = (((l.to ?? now) - l.from) / duration) * 100;
                  return (
                    <span
                      key={`${l.leaderId}-${l.from}`}
                      title={`${label(l.leaderId)} · term ${l.term} · ${formatClock(l.from)}–${l.to === null ? 'now' : formatClock(l.to)}`}
                      style={{ position: 'absolute', left: `${left}%`, width: `${Math.max(0.3, width)}%`, top: 3, bottom: 3, borderRadius: 3, background: colour(l.leaderId) }}
                    />
                  );
                })}
              </div>
              <div className="legend">
                {leaders.map((id) => (
                  <span key={id} className="legend-key">
                    <span className="legend-line" style={{ background: colour(id), height: 8, width: 12 }} />
                    {label(id)}
                  </span>
                ))}
              </div>
            </div>
            <div className="chart-grid">
              <TimeSeriesChart
                title="Nodes that believe they lead"
                subtitle="Above 1 means a deposed leader has not yet learned it was replaced"
                xMax={duration}
                now={now}
                format={(v) => String(Math.round(v))}
                series={[{ id: 'believers', label: 'Believers', color: 'var(--series-2)', points: cluster.believedLeaders, step: true }]}
              />
              <TimeSeriesChart
                title="Term"
                subtitle="Each election increments it"
                xMax={duration}
                now={now}
                format={(v) => String(Math.round(v))}
                series={[{ id: 'term', label: 'Term', color: 'var(--series-1)', points: cluster.terms, step: true }]}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
