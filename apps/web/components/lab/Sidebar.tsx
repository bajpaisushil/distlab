'use client';

import { NODE_TYPES, type NodeType } from '@distlab/shared';
import { useLab } from '@/lib/store';
import { NODE_LABELS } from '@/lib/spec-edit';
import { NodeGlyph, Icon } from '@/components/ui/icons';
import { DRAG_MIME } from '@/components/canvas/Canvas';

const GROUPS: readonly { title: string; types: readonly NodeType[] }[] = [
  { title: 'Traffic', types: ['client', 'gateway', 'load_balancer'] },
  { title: 'Compute', types: ['api', 'service', 'worker'] },
  { title: 'Data', types: ['cache', 'database', 'replica', 'queue'] },
  { title: 'Coordination', types: ['consensus', 'lock_service'] },
];

export function Sidebar() {
  const spec = useLab((s) => s.spec);
  const selection = useLab((s) => s.selection);
  const issues = useLab((s) => s.issues);
  const lab = useLab.getState();

  return (
    <aside className="sidebar" aria-label="Components and outline">
      <div className="panel-section">
        <h3 className="panel-title">Components</h3>
        <div className="stack" style={{ gap: 10 }}>
          {GROUPS.map((group) => (
            <div key={group.title}>
              <div className="muted" style={{ fontSize: 10.5, margin: '0 0 3px 8px' }}>
                {group.title}
              </div>
              <div className="palette">
                {group.types.map((type) => (
                  <button
                    key={type}
                    className="palette-item"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(DRAG_MIME, type);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onClick={() => lab.addNode(type)}
                    title={`Drag onto the canvas, or click to add a ${NODE_LABELS[type].toLowerCase()}`}
                    data-testid={`palette-${type}`}
                  >
                    <span className="node-icon">
                      <NodeGlyph type={type} size={14} />
                    </span>
                    {NODE_LABELS[type]}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        {NODE_TYPES.length === 0 ? null : null}
      </div>

      {issues.length > 0 ? (
        <div className="panel-section">
          <h3 className="panel-title status-critical">
            <span className="dot status-dot" /> {issues.length} problem{issues.length === 1 ? '' : 's'}
          </h3>
          <div className="issues">
            {issues.slice(0, 12).map((issue, i) => (
              <div key={i} className="issue">
                <Icon name="alert" size={12} />
                <span>
                  <code>{issue.path || 'scenario'}</code> {issue.message}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="panel-section">
        <h3 className="panel-title">Workloads</h3>
        {spec.workloads.length === 0 ? <div className="muted">No traffic. Add a client.</div> : null}
        {spec.workloads.map((w) => (
          <div
            key={w.id}
            className={`list-item${selection?.kind === 'workload' && selection.id === w.id ? ' selected' : ''}`}
            onClick={() => lab.select({ kind: 'workload', id: w.id })}
          >
            <Icon name="activity" size={14} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.id}</span>
          </div>
        ))}
      </div>

      <div className="panel-section">
        <div className="row">
          <h3 className="panel-title" style={{ margin: 0 }}>
            Faults
          </h3>
          <span className="spacer" />
          <button className="btn ghost" style={{ height: 22, padding: '0 6px' }} onClick={() => lab.select({ kind: 'scenario' })}>
            <Icon name="plus" size={12} /> Add
          </button>
        </div>
        <div style={{ marginTop: 6 }}>
          {(spec.faults ?? []).length === 0 ? <div className="muted">None scheduled.</div> : null}
          {(spec.faults ?? []).map((f, i) => {
            const id = f.id ?? `fault-${i + 1}`;
            return (
              <div
                key={id}
                className={`list-item${selection?.kind === 'fault' && selection.id === id ? ' selected' : ''}`}
                onClick={() => lab.select({ kind: 'fault', id })}
              >
                <Icon name="bolt" size={14} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {f.kind.replace(/_/g, ' ')} @ {(f.at / 1000).toFixed(1)}s
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
