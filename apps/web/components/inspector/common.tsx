'use client';

import { Icon } from '@/components/ui/icons';

export function Header({
  title,
  subtitle,
  icon,
  onClose,
  actions,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  onClose?(): void;
  actions?: React.ReactNode;
}) {
  return (
    <div className="inspector-header">
      <div className="row">
        {icon}
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 className="panel-heading">{title}</h2>
          {subtitle ? <div className="muted" style={{ fontSize: 11.5 }}>{subtitle}</div> : null}
        </div>
        {onClose ? (
          <button className="btn icon ghost" onClick={onClose} aria-label="Close">
            <Icon name="x" size={14} />
          </button>
        ) : null}
      </div>
      {actions ? <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>{actions}</div> : null}
    </div>
  );
}

export function Section({ title, children, open = true }: { title: string; children: React.ReactNode; open?: boolean }) {
  return (
    <div className="panel-section">
      <details className="details" open={open}>
        <summary>
          <Icon name="chevronRight" size={12} className="chev" />
          <span className="panel-title" style={{ margin: 0 }}>
            {title}
          </span>
        </summary>
        <div className="details-body stack">{children}</div>
      </details>
    </div>
  );
}

export function KV({ rows }: { rows: readonly (readonly [string, React.ReactNode])[] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
