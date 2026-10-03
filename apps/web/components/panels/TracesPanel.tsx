'use client';

import { useEffect, useRef, useState } from 'react';
import type { Trace } from '@distlab/telemetry';
import { useLab } from '@/lib/store';
import { formatClock, formatMs } from '@/lib/format';
import { Waterfall } from './Waterfall';

type Sort = 'slowest' | 'failed' | 'recent';

/** Distributed traces: pick one to see its waterfall. */
export function TracesPanel() {
  const frame = useLab((s) => s.frame);
  const query = useLab((s) => s.query);
  const selection = useLab((s) => s.selection);
  const select = useLab((s) => s.select);
  const [sort, setSort] = useState<Sort>('slowest');
  const [traces, setTraces] = useState<readonly Trace[]>([]);
  const lastFetch = useRef(0);

  useEffect(() => {
    const now = performance.now();
    if (frame?.playing && now - lastFetch.current < 700) return;
    lastFetch.current = now;
    void query({ kind: 'traces', sort, limit: 80 }).then(setTraces).catch(() => {});
  }, [frame?.position, sort, query, frame?.playing]);

  const selectedId = selection?.kind === 'trace' ? selection.id : traces[0]?.traceId;
  const selected = traces.find((t) => t.traceId === selectedId);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 38%) 1fr', height: '100%', minHeight: 0 }}>
      <div style={{ borderRight: '1px solid var(--border)', display: 'grid', gridTemplateRows: 'auto minmax(0,1fr)', minHeight: 0 }}>
        <div className="row" style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)' }}>
          <div className="seg" role="group" aria-label="Sort traces">
            {(['slowest', 'failed', 'recent'] as const).map((s) => (
              <button key={s} aria-pressed={sort === s} onClick={() => setSort(s)}>
                {s}
              </button>
            ))}
          </div>
        </div>
        <div style={{ overflowY: 'auto', minHeight: 0 }}>
          {traces.length === 0 ? <div className="empty">No traces yet.</div> : null}
          <table className="table">
            <tbody>
              {traces.map((t) => (
                <tr
                  key={t.traceId}
                  className={`clickable${t.traceId === selectedId ? ' selected' : ''}`}
                  onClick={() => select({ kind: 'trace', id: t.traceId })}
                >
                  <td className="mono">{t.traceId}</td>
                  <td>
                    <span className={`pill status-${t.status === 'ok' ? 'good' : t.status === 'open' ? 'neutral' : 'critical'}`}>
                      <span className="dot" />
                      {t.status}
                    </span>
                  </td>
                  <td className="num">{t.duration !== undefined ? formatMs(t.duration) : '…'}</td>
                  <td className="num muted">{formatClock(t.startedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div style={{ overflowY: 'auto', padding: 12, minHeight: 0 }}>
        {selected ? (
          <div className="stack">
            <div className="row">
              <strong className="mono">{selected.traceId}</strong>
              <span className="muted">
                {selected.operation} from {selected.clientId} · {selected.spans.length} spans ·{' '}
                {selected.duration !== undefined ? formatMs(selected.duration) : 'in progress'}
              </span>
            </div>
            <Waterfall trace={selected} />
            <div className="field-hint">Gaps between a span and its parent are time on the network.</div>
          </div>
        ) : (
          <div className="empty">Select a trace to see its waterfall.</div>
        )}
      </div>
    </div>
  );
}
