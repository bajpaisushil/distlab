'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SimEvent } from '@distlab/shared';
import { useLab } from '@/lib/store';
import { VirtualList } from '@/components/ui/VirtualList';
import { formatClock, humanize } from '@/lib/format';
import { describeEvent, eventTone } from './event-text';

const PAGE = 400;

const QUICK_FILTERS: readonly { id: string; label: string; types?: readonly string[] }[] = [
  { id: 'all', label: 'All' },
  { id: 'requests', label: 'Requests', types: ['REQUEST_CREATED', 'REQUEST_COMPLETED', 'REQUEST_FAILED', 'REQUEST_REJECTED', 'TIMEOUT'] },
  { id: 'failures', label: 'Failures', types: ['REQUEST_FAILED', 'REQUEST_REJECTED', 'MESSAGE_DROPPED', 'TIMEOUT', 'NODE_FAILED'] },
  { id: 'network', label: 'Network', types: ['MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_DROPPED', 'MESSAGE_DUPLICATED'] },
  {
    id: 'faults',
    label: 'Faults',
    types: ['FAULT_INJECTED', 'FAULT_CLEARED', 'NODE_FAILED', 'NODE_RECOVERED', 'LINK_STATE_CHANGED', 'LINK_CONFIG_CHANGED', 'PARTITION_STARTED', 'PARTITION_HEALED'],
  },
];

/**
 * Every event the engine processed, up to the current replay position. Click
 * one to see why it happened and what it caused.
 */
export function EventsPanel() {
  const frame = useLab((s) => s.frame);
  const spec = useLab((s) => s.spec);
  const selection = useLab((s) => s.selection);
  const select = useLab((s) => s.select);
  const query = useLab((s) => s.query);
  const [quick, setQuick] = useState('all');
  const [nodeId, setNodeId] = useState('');
  const [text, setText] = useState('');
  const [page, setPage] = useState<{ offset: number; rows: readonly SimEvent[]; total: number }>({ offset: 0, rows: [], total: 0 });
  const range = useRef({ start: 0, end: 0 });
  const lastFetch = useRef(0);

  const filter = useMemo(() => {
    const types = QUICK_FILTERS.find((q) => q.id === quick)?.types;
    return {
      ...(types ? { types: types as never } : {}),
      ...(nodeId ? { nodeId } : {}),
      ...(text.trim() ? { text: text.trim() } : {}),
    };
  }, [quick, nodeId, text]);

  const fetchPage = useCallback(
    (start: number) => {
      const offset = Math.max(0, start - 50);
      void query({ kind: 'events', filter, offset, limit: PAGE })
        .then((result) => setPage({ offset: result.offset, rows: result.items, total: result.total }))
        .catch(() => {});
    },
    [query, filter],
  );

  // Refresh as the run moves, throttled — a query scans the timeline.
  useEffect(() => {
    const now = performance.now();
    if (frame?.playing && now - lastFetch.current < 400) return;
    lastFetch.current = now;
    const followStart = Math.max(0, (page.total || 0) - 60);
    fetchPage(range.current.end >= page.total - 2 ? followStart : range.current.start);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame?.position, filter]);

  const onRange = useCallback(
    (start: number, end: number) => {
      range.current = { start, end };
      if (start < page.offset || end > page.offset + page.rows.length) fetchPage(start);
    },
    [page.offset, page.rows.length, fetchPage],
  );

  const header = (
    <div className="row" style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
      <div className="seg" role="group" aria-label="Event filter">
        {QUICK_FILTERS.map((q) => (
          <button key={q.id} aria-pressed={quick === q.id} onClick={() => setQuick(q.id)}>
            {q.label}
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
      <input
        className="input"
        style={{ width: 200 }}
        placeholder="Search events…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Search events"
      />
      <span className="spacer" />
      <span className="muted num">{page.total.toLocaleString('en-US')} events</span>
    </div>
  );

  return (
    <VirtualList
      header={header}
      items={{ offset: page.offset, rows: page.rows }}
      total={page.total}
      follow
      onRange={onRange}
      render={(event) => {
        const selected = selection?.kind === 'event' && selection.id === event.id;
        return (
          <div
            className={`list-item${selected ? ' selected' : ''}`}
            style={{ borderRadius: 0, height: 24, padding: '0 10px', gap: 10, fontSize: 12 }}
            onClick={() => select({ kind: 'event', id: event.id })}
            data-testid="event-row"
          >
            <span className="mono num muted" style={{ width: 78, flex: 'none' }}>
              {formatClock(event.at)}
            </span>
            <span className={`dot status-dot status-${eventTone(event.type)}`} />
            <span style={{ width: 190, flex: 'none', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {humanize(event.type)}
            </span>
            <span className="ink-2" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {describeEvent(event)}
            </span>
          </div>
        );
      }}
    />
  );
}
