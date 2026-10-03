'use client';

export interface BarItem {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly display: string;
  /** Optional status tint for the bar (e.g. a hot node); identity stays in the label. */
  readonly tone?: 'accent' | 'warning' | 'critical';
}

/**
 * Horizontal bars for comparing a handful of values — per-node utilisation,
 * per-backend share. Every bar carries its value as text, so nothing depends
 * on reading bar length or colour alone.
 */
export function BarList({ items, max, title, subtitle }: { items: readonly BarItem[]; max?: number; title?: string; subtitle?: string }) {
  const top = max ?? Math.max(1e-9, ...items.map((i) => i.value));
  return (
    <div className="chart-card">
      {title ? <h4 className="chart-title">{title}</h4> : null}
      {subtitle ? <p className="chart-subtitle">{subtitle}</p> : null}
      <div style={{ display: 'grid', gap: 7, marginTop: title ? 10 : 0 }}>
        {items.length === 0 ? <div className="muted" style={{ fontSize: 12 }}>Nothing to show yet.</div> : null}
        {items.map((item) => (
          <div
            key={item.id}
            style={{ display: 'grid', gridTemplateColumns: 'minmax(70px, 34%) 1fr auto', alignItems: 'center', gap: 8 }}
          >
            <span className="ink-2" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {item.label}
            </span>
            <span style={{ height: 8, background: 'var(--surface-3)', borderRadius: 4, overflow: 'hidden' }}>
              <span
                style={{
                  display: 'block',
                  height: '100%',
                  width: `${Math.max(0, Math.min(100, (item.value / top) * 100))}%`,
                  borderRadius: '0 4px 4px 0',
                  background:
                    item.tone === 'critical' ? 'var(--critical)' : item.tone === 'warning' ? 'var(--warning)' : 'var(--series-1)',
                  transition: 'width 150ms linear',
                }}
              />
            </span>
            <span className="num" style={{ fontSize: 12, minWidth: 48, textAlign: 'right' }}>
              {item.display}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
