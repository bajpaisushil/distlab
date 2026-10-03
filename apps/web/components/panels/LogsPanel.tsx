'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LogLevel, LogRecord } from '@distlab/telemetry';
import { useLab } from '@/lib/store';
import { VirtualList } from '@/components/ui/VirtualList';
import { formatClock } from '@/lib/format';

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
const LEVEL_TONE: Record<LogLevel, string> = {
  debug: 'status-neutral',
  info: 'status-good',
  warn: 'status-warning',
  error: 'status-critical',
};

/** The structured log the engine writes for every event, filterable by level, node and text. */
export function LogsPanel() {
  const frame = useLab((s) => s.frame);
  const spec = useLab((s) => s.spec);
  const select = useLab((s) => s.select);
  const query = useLab((s) => s.query);
  const [minLevel, setMinLevel] = useState<LogLevel>('info');
  const [nodeId, setNodeId] = useState('');
  const [text, setText] = useState('');
  const [page, setPage] = useState<{ offset: number; rows: readonly LogRecord[]; total: number }>({ offset: 0, rows: [], total: 0 });
  const range = useRef({ start: 0, end: 0 });
  const lastFetch = useRef(0);

  const fetchPage = useCallback(
    (start: number) => {
      void query({
        kind: 'logs',
        filter: { minLevel, ...(nodeId ? { nodeId } : {}), ...(text.trim() ? { text: text.trim() } : {}) },
        offset: Math.max(0, start - 50),
        limit: 400,
      })
        .then((r) => setPage({ offset: r.offset, rows: r.items, total: r.total }))
        .catch(() => {});
    },
    [query, minLevel, nodeId, text],
  );

  useEffect(() => {
    const now = performance.now();
    if (frame?.playing && now - lastFetch.current < 400) return;
    lastFetch.current = now;
    fetchPage(range.current.end >= page.total - 2 ? Math.max(0, page.total - 60) : range.current.start);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame?.position, minLevel, nodeId, text]);

  const onRange = useCallback(
    (start: number, end: number) => {
      range.current = { start, end };
      if (start < page.offset || end > page.offset + page.rows.length) fetchPage(start);
    },
    [page.offset, page.rows.length, fetchPage],
  );

  return (
    <VirtualList
      header={
        <div className="row" style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
          <div className="seg" role="group" aria-label="Minimum level">
            {LEVELS.map((level) => (
              <button key={level} aria-pressed={minLevel === level} onClick={() => setMinLevel(level)}>
                {level}+
              </button>
            ))}
          </div>
          <select className="select" style={{ width: 140 }} value={nodeId} onChange={(e) => setNodeId(e.target.value)} aria-label="Node">
            <option value="">All nodes</option>
            {spec.nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label ?? n.id}
              </option>
            ))}
          </select>
          <input className="input" style={{ width: 220 }} placeholder="Search logs…" value={text} onChange={(e) => setText(e.target.value)} />
          <span className="spacer" />
          <span className="muted num">{page.total.toLocaleString('en-US')} lines</span>
        </div>
      }
      items={{ offset: page.offset, rows: page.rows }}
      total={page.total}
      follow
      onRange={onRange}
      render={(record) => (
        <div
          className="list-item mono"
          style={{ borderRadius: 0, height: 24, padding: '0 10px', gap: 10, fontSize: 11.5 }}
          onClick={() => select({ kind: 'event', id: record.eventId })}
        >
          <span className="num muted" style={{ width: 78, flex: 'none' }}>
            {formatClock(record.t)}
          </span>
          <span className={`pill ${LEVEL_TONE[record.level]}`} style={{ width: 52, justifyContent: 'center', flex: 'none' }}>
            {record.level}
          </span>
          <span className="muted" style={{ width: 80, flex: 'none', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {record.nodeId ?? ''}
          </span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{record.message}</span>
        </div>
      )}
    />
  );
}
