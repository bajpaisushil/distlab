'use client';

import { useEffect, useState } from 'react';
import { resolveSimulationSpec, validateSimulationSpec } from '@distlab/shared';
import {
  REQUEST_CONTEXT_TYPES,
  explainArchitecture,
  explainEvent,
  explainRequest,
  type Explanation,
  type FactKind,
} from '@distlab/ai';
import { useLab } from '@/lib/store';
import { Icon } from '@/components/ui/icons';

const KIND_LABEL: Record<FactKind, string> = { measured: 'measured', configured: 'configured', derived: 'derived' };
const KIND_TONE: Record<FactKind, string> = { measured: 'status-good', configured: 'status-neutral', derived: 'status-warning' };

/**
 * Plain-language explanations built only from what the simulation recorded
 * and what the scenario configured. Every fact says which it is; measured
 * facts link to the events that show them. No AI service is involved.
 */
export function ExplainPanel() {
  const selection = useLab((s) => s.selection);
  const spec = useLab((s) => s.spec);
  const position = useLab((s) => s.frame?.position ?? 0);
  const query = useLab((s) => s.query);
  const select = useLab((s) => s.select);
  const [explanation, setExplanation] = useState<Explanation | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    if (!validateSimulationSpec(spec).valid) {
      setExplanation(null);
      setError('Fix the scenario’s problems first.');
      return;
    }
    const resolved = resolveSimulationSpec(spec);
    const run = async (): Promise<Explanation> => {
      if (selection?.kind === 'event') {
        const detail = await query({ kind: 'eventDetail', eventId: selection.id });
        if (!detail) throw new Error('That event is not part of the current run.');
        if (detail.event.traceId && (detail.event.type === 'REQUEST_FAILED' || detail.event.type === 'REQUEST_COMPLETED')) {
          return explainTrace(detail.event.traceId);
        }
        return explainEvent({ ...detail, spec: resolved });
      }
      if (selection?.kind === 'trace') return explainTrace(selection.id);
      return explainArchitecture(resolved);
    };
    const explainTrace = async (traceId: string): Promise<Explanation> => {
      const page = await query({ kind: 'events', filter: { traceId }, offset: 0, limit: 2000 });
      const first = page.items[0]?.at ?? 0;
      const last = page.items[page.items.length - 1]?.at ?? first;
      const context = await query({
        kind: 'events',
        filter: { types: REQUEST_CONTEXT_TYPES as never, fromTime: first, toTime: last },
        offset: 0,
        limit: 500,
      });
      return explainRequest({ events: page.items, context: context.items, spec: resolved });
    };
    run()
      .then((result) => live && setExplanation(result))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [selection, spec, position, query]);

  return (
    <div style={{ padding: 14, display: 'grid', gap: 12, maxWidth: 920 }} data-testid="explain">
      <div className="row muted" style={{ fontSize: 12 }}>
        <Icon name="info" size={13} />
        {selection?.kind === 'event' || selection?.kind === 'trace'
          ? 'Explaining the selected item.'
          : 'Select an event, a trace or a failed request to explain it. With nothing selected, this reviews the architecture.'}
      </div>
      {error ? <div className="callout">{error}</div> : null}
      {explanation ? (
        <>
          <div>
            <h3 style={{ margin: '0 0 4px', fontSize: 15 }}>{explanation.title}</h3>
            <p className="prose" style={{ margin: 0, color: 'var(--ink)' }}>
              {explanation.summary}
            </p>
          </div>
          {explanation.facts.length > 0 ? (
            <div className="stack" style={{ gap: 6 }}>
              <div className="panel-title" style={{ margin: 0 }}>
                Facts
              </div>
              {explanation.facts.map((fact, i) => (
                <div key={i} className={`fact ${KIND_TONE[fact.kind]}`} style={{ display: 'grid', gap: 3 }}>
                  <span>{fact.text}</span>
                  <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    <span className="tag">{KIND_LABEL[fact.kind]}</span>
                    {fact.eventIds.slice(0, 6).map((id) => (
                      <button key={id} className="tag mono" style={{ border: 0, cursor: 'pointer' }} onClick={() => select({ kind: 'event', id })}>
                        {id}
                      </button>
                    ))}
                    {fact.eventIds.length > 6 ? <span className="muted">+{fact.eventIds.length - 6}</span> : null}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {explanation.interpretation.length > 0 ? (
            <div className="callout">
              <strong>Interpretation</strong> — a reading of the facts above, not a measurement:
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {explanation.interpretation.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {explanation.suggestions.length > 0 ? (
            <div className="stack" style={{ gap: 4 }}>
              <div className="panel-title" style={{ margin: 0 }}>
                Try next
              </div>
              {explanation.suggestions.map((s) => (
                <div key={s} className="row ink-2">
                  <Icon name="flask" size={13} /> {s}
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
