'use client';

import type { Span, Trace } from '@distlab/telemetry';
import { formatMs } from '@/lib/format';

const TONE: Record<string, string> = {
  ok: 'var(--series-1)',
  open: 'var(--muted)',
  error: 'var(--critical)',
  rejected: 'var(--serious)',
  unreachable: 'var(--critical)',
  timeout: 'var(--serious)',
  unavailable: 'var(--serious)',
  circuit_open: 'var(--serious)',
  not_leader: 'var(--warning)',
};

/**
 * A trace as nested spans on a shared time axis. Gaps between a parent span
 * starting and its child starting are network time; a span that never closed
 * cleanly is shown in its failure state.
 */
export function Waterfall({ trace, onSpan }: { trace: Trace; onSpan?(span: Span): void }) {
  const total = Math.max(1, trace.duration ?? 1);
  const depth = new Map<string, number>();
  for (const span of trace.spans) {
    depth.set(span.spanId, span.parentSpanId ? (depth.get(span.parentSpanId) ?? 0) + 1 : 0);
  }
  return (
    <div style={{ display: 'grid', gap: 3 }} data-testid="waterfall">
      {trace.spans.map((span, index) => {
        const offset = ((span.startedAt - trace.startedAt) / total) * 100;
        const width = (((span.duration ?? total - (span.startedAt - trace.startedAt))) / total) * 100;
        return (
          <div
            key={`${span.spanId}-${index}`}
            style={{ display: 'grid', gridTemplateColumns: 'minmax(110px, 30%) 1fr 64px', alignItems: 'center', gap: 8, cursor: onSpan ? 'pointer' : 'default' }}
            onClick={() => onSpan?.(span)}
            title={`${span.name} — ${span.status}`}
          >
            <span
              className="mono"
              style={{ fontSize: 11.5, paddingLeft: (depth.get(span.spanId) ?? 0) * 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {span.nodeId}
              {span.attributes.duplicate ? <span className="muted"> (dup)</span> : null}
            </span>
            <span style={{ position: 'relative', height: 12, background: 'var(--surface-2)', borderRadius: 3 }}>
              <span
                style={{
                  position: 'absolute',
                  left: `${offset}%`,
                  width: `${Math.max(0.6, width)}%`,
                  top: 0,
                  bottom: 0,
                  borderRadius: 3,
                  background: TONE[span.status] ?? 'var(--series-1)',
                  opacity: span.kind === 'client' ? 0.55 : 1,
                }}
              />
            </span>
            <span className="num mono" style={{ fontSize: 11, textAlign: 'right' }}>
              {span.duration !== undefined ? formatMs(span.duration) : '…'}
            </span>
          </div>
        );
      })}
    </div>
  );
}
