'use client';

import { useEffect, useState } from 'react';
import type { SimEvent } from '@distlab/shared';
import { useLab } from '@/lib/store';
import type { EventDetail } from '@/lib/engine/protocol';
import { formatClock, humanize } from '@/lib/format';
import { Icon } from '@/components/ui/icons';
import { describeEvent, eventTone } from '@/components/panels/event-text';
import { Header, Section } from './common';

/**
 * One event: what it was, why it happened (its causal ancestors, back to the
 * root), what it caused, and every node's state immediately before it.
 */
export function EventInspector({ id }: { id: string }) {
  const specId = useLab((s) => s.frame?.specId);
  const reachable = useLab((s) => s.frame?.reachable ?? 0);
  const query = useLab((s) => s.query);
  const lab = useLab.getState();
  const [detail, setDetail] = useState<EventDetail | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    setDetail(undefined);
    void query({ kind: 'eventDetail', eventId: id })
      .then((d) => live && setDetail(d))
      .catch(() => live && setDetail(null));
    return () => {
      live = false;
    };
    // The timeline only grows; re-query when it has grown past an unknown event.
  }, [id, specId, query, detail === null ? reachable : 0]); // eslint-disable-line react-hooks/exhaustive-deps

  if (detail === undefined) return <div className="empty">Loading event…</div>;
  if (detail === null) return <div className="empty">This event is not in the current run. It may belong to an earlier version of the scenario.</div>;

  const { event } = detail;
  const row = (e: SimEvent) => (
    <div key={e.id} className={`list-item${e.id === id ? ' selected' : ''}`} onClick={() => lab.select({ kind: 'event', id: e.id })}>
      <span className={`dot status-dot status-${eventTone(e.type)}`} />
      <span className="mono num muted" style={{ width: 70, flex: 'none' }}>
        {formatClock(e.at)}
      </span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{describeEvent(e)}</span>
    </div>
  );

  return (
    <>
      <Header
        title={humanize(event.type)}
        subtitle={
          <>
            <span className="mono">{event.id}</span> · #{detail.index + 1} · {formatClock(event.at)}
          </>
        }
        onClose={() => lab.select(null)}
        actions={
          <>
            <button className="btn" onClick={() => lab.seek(detail.index)} title="Restore the exact state right before this event">
              <Icon name="stepBack" size={13} /> Jump to just before
            </button>
            <button className="btn" onClick={() => lab.seek(detail.index + 1)}>
              Just after
            </button>
            <button className="btn" onClick={() => lab.setBottomTab('explain')}>
              <Icon name="sparkles" size={13} /> Explain
            </button>
          </>
        }
      />
      <Section title="What happened">
        <div className="fact">{detail.description}</div>
        {event.traceId ? (
          <button className="btn ghost" style={{ justifySelf: 'start' }} onClick={() => lab.select({ kind: 'trace', id: event.traceId! })}>
            <Icon name="waterfall" size={13} /> Trace {event.traceId}
          </button>
        ) : null}
      </Section>
      <Section title={`Why — ${detail.chain.length - 1} cause${detail.chain.length === 2 ? '' : 's'}`}>
        <div className="field-hint">Each event below was caused by the one above it.</div>
        {detail.chain.map(row)}
      </Section>
      <Section title={`What it caused — ${detail.effects.length}`} open={detail.effects.length > 0}>
        {detail.effects.length === 0 ? <div className="muted">Nothing directly.</div> : detail.effects.slice(0, 40).map(row)}
      </Section>
      <Section title="State just before" open={false}>
        <table className="table">
          <thead>
            <tr>
              <th>Node</th>
              <th>Status</th>
              <th className="num">Busy</th>
              <th className="num">Queued</th>
            </tr>
          </thead>
          <tbody>
            {detail.nodesBefore.map((n) => (
              <tr key={n.id} className={n.id === event.nodeId ? 'selected' : ''}>
                <td>{n.label}</td>
                <td>{n.status}</td>
                <td className="num">{n.inFlight}</td>
                <td className="num">{n.queueDepth}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section title="Payload" open={false}>
        <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11 }}>
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      </Section>
    </>
  );
}
