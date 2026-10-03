'use client';

import { useEffect, useState } from 'react';
import type { SimEvent } from '@distlab/shared';
import type { Trace } from '@distlab/telemetry';
import { useLab } from '@/lib/store';
import { formatClock, formatMs } from '@/lib/format';
import { Icon } from '@/components/ui/icons';
import { Waterfall } from '@/components/panels/Waterfall';
import { describeEvent, eventTone } from '@/components/panels/event-text';
import { Header, Section } from './common';

export function TraceInspector({ id }: { id: string }) {
  const query = useLab((s) => s.query);
  const position = useLab((s) => s.frame?.position ?? 0);
  const lab = useLab.getState();
  const [trace, setTrace] = useState<Trace | null>(null);
  const [events, setEvents] = useState<readonly SimEvent[]>([]);

  useEffect(() => {
    void query({ kind: 'trace', traceId: id }).then(setTrace).catch(() => setTrace(null));
    void query({ kind: 'events', filter: { traceId: id }, offset: 0, limit: 500 })
      .then((page) => setEvents(page.items))
      .catch(() => setEvents([]));
  }, [id, query, position]);

  return (
    <>
      <Header
        icon={
          <span className="node-icon">
            <Icon name="waterfall" size={15} />
          </span>
        }
        title={`Trace ${id}`}
        subtitle={trace ? `${trace.operation} from ${trace.clientId} · ${trace.status} · ${trace.duration !== undefined ? formatMs(trace.duration) : 'in progress'}` : 'Not in view at this position'}
        onClose={() => lab.select(null)}
        actions={
          <button className="btn" onClick={() => lab.setBottomTab('explain')}>
            <Icon name="sparkles" size={13} /> Explain this request
          </button>
        }
      />
      {trace ? (
        <Section title="Waterfall">
          <Waterfall trace={trace} />
        </Section>
      ) : null}
      <Section title={`Events — ${events.length}`}>
        {events.map((e) => (
          <div key={e.id} className="list-item" onClick={() => lab.select({ kind: 'event', id: e.id })}>
            <span className={`dot status-dot status-${eventTone(e.type)}`} />
            <span className="mono num muted" style={{ width: 70, flex: 'none' }}>
              {formatClock(e.at)}
            </span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{describeEvent(e)}</span>
          </div>
        ))}
      </Section>
    </>
  );
}
