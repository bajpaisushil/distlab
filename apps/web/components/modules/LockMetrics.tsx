'use client';

import { useLab } from '@/lib/store';
import { StatTile } from '@/components/charts/StatTile';
import { BarList } from '@/components/charts/BarList';
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart';
import { formatClock, formatCount, formatMs } from '@/lib/format';

const HOLDER_COLOURS = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-7'];

/** Who held each lock and when, how long others waited, and whether a stale holder got a write through. */
export function LockMetrics() {
  const locks = useLab((s) => s.frame?.snapshot.modules.locks);
  const now = useLab((s) => s.frame?.now ?? 0);
  const duration = useLab((s) => s.frame?.durationMs ?? 1);
  const spec = useLab((s) => s.spec);
  if (!locks || locks.resources.length === 0) return null;
  const label = (id: string) => spec.nodes.find((n) => n.id === id)?.label ?? id;

  return (
    <div className="stack">
      {locks.resources.map((lock) => {
        // Colour follows the client, in a fixed order — the configured holders, not who happened to hold first.
        const holders = spec.nodes.filter((n) => n.config?.lockClient?.resource === lock.resource).map((n) => n.id);
        for (const o of lock.ownership) if (!holders.includes(o.holder)) holders.push(o.holder);
        const colour = (id: string) => `var(${HOLDER_COLOURS[holders.indexOf(id) % HOLDER_COLOURS.length]})`;
        const fencingOn = spec.nodes.some((n) => n.config?.fencing === true);
        return (
          <div key={lock.resource} className="stack">
            <div className="stat-grid">
              <StatTile
                label={`Holder · ${lock.resource}`}
                value={lock.holder ? label(lock.holder) : 'free'}
                sub={lock.holder ? `token ${lock.token}${lock.waiting > 0 ? ` · ${lock.waiting} waiting` : ''}` : `${lock.waiting} waiting`}
              />
              <StatTile label="Acquisitions" value={formatCount(lock.acquisitions)} sub={`${lock.renewals} renewals`} />
              <StatTile label="Wait p95" value={formatMs(lock.wait.p95)} sub={`p50 ${formatMs(lock.wait.p50)} · max ${formatMs(lock.wait.max)}`} />
              <StatTile
                label="Leases expired"
                value={formatCount(lock.expirations)}
                sub="holder went quiet"
                {...(lock.expirations > 0 ? { tone: 'warning' as const } : {})}
              />
              {lock.maxBelievedHolders > 1 ? (
                <StatTile label="Believed holders" value={`${lock.maxBelievedHolders} at once`} sub="one was stale" tone="serious" />
              ) : null}
              {lock.safetyViolations > 0 ? (
                <StatTile label="Safety violations" value={formatCount(lock.safetyViolations)} sub="stale writes kept" tone="critical" />
              ) : null}
              {lock.fencedRejections > 0 || fencingOn ? (
                <StatTile label="Fenced writes" value={formatCount(lock.fencedRejections)} sub="stale writes refused" tone="good" />
              ) : null}
            </div>
            <div className="chart-card">
              <h4 className="chart-title">Ownership</h4>
              <p className="chart-subtitle">Who held “{lock.resource}” in the lock service’s view; gaps are hand-offs and expiries</p>
              <div style={{ position: 'relative', height: 26, marginTop: 10, background: 'var(--surface-2)', borderRadius: 4, overflow: 'hidden' }}>
                {lock.ownership.map((o) => {
                  const end = o.to ?? now;
                  return (
                    <span
                      key={`${o.token}-${o.from}`}
                      title={`${label(o.holder)} · token ${o.token} · ${formatClock(o.from)}–${o.to === null ? 'now' : formatClock(o.to)}`}
                      style={{
                        position: 'absolute',
                        left: `${(o.from / duration) * 100}%`,
                        width: `${Math.max(0.2, ((end - o.from) / duration) * 100)}%`,
                        top: 3,
                        bottom: 3,
                        borderRadius: 2,
                        background: colour(o.holder),
                        boxShadow: '1px 0 0 var(--surface-2)',
                      }}
                    />
                  );
                })}
              </div>
              <div className="legend">
                {holders.map((id) => (
                  <span key={id} className="legend-key">
                    <span className="legend-line" style={{ background: colour(id), height: 8, width: 12 }} />
                    {label(id)}
                  </span>
                ))}
              </div>
            </div>
            <div className="chart-grid">
              <TimeSeriesChart
                title="Clients that believe they hold it"
                subtitle="Above 1: a holder whose lease ran out is still working"
                xMax={duration}
                now={now}
                format={(v) => String(Math.round(v))}
                series={[{ id: 'believers', label: 'Believers', color: 'var(--series-2)', points: lock.believedHolders, step: true }]}
              />
              <BarList
                title="Turns per client"
                subtitle="First come, first served keeps this even"
                items={holders.map((id) => ({
                  id,
                  label: label(id),
                  value: lock.acquisitionsByClient[id] ?? 0,
                  display: formatCount(lock.acquisitionsByClient[id] ?? 0),
                }))}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
