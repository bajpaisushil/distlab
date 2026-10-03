'use client';

import { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { NodeConfig, NodeSpec } from '@distlab/shared';
import type { NodeSnapshot } from '@distlab/simulation-engine';
import { NodeGlyph } from '@/components/ui/icons';
import { formatCount, formatPercent } from '@/lib/format';
import { NODE_LABELS } from '@/lib/spec-edit';

export type SimNodeData = {
  spec: NodeSpec;
  config: NodeConfig;
  live?: NodeSnapshot;
  selected: boolean;
  /** Extra one-word facts from subsystems: "leader", "holds lock", "lag 120ms"… */
  badges?: readonly { label: string; tone?: 'good' | 'warning' | 'serious' | 'critical' }[];
};

export type SimFlowNode = Node<SimNodeData, 'sim'>;

type Health = { label: string; tone: 'good' | 'warning' | 'serious' | 'critical' | 'neutral' };

export function healthOf(live: NodeSnapshot | undefined, config: NodeConfig): Health {
  if (!live) return { label: 'Idle', tone: 'neutral' };
  if (live.status === 'failed') return { label: 'Down', tone: 'critical' };
  if (live.paused) return { label: 'Paused', tone: 'warning' };
  if (live.unavailable) return { label: 'Unavailable', tone: 'serious' };
  if (live.slowdown > 1) return { label: `Slow ×${live.slowdown}`, tone: 'warning' };
  if (config.queueCapacity > 0 && live.queueDepth >= config.queueCapacity * 0.8) return { label: 'Saturated', tone: 'serious' };
  if (live.inFlight >= config.concurrency && config.concurrency > 0) return { label: 'Busy', tone: 'warning' };
  return { label: 'Healthy', tone: 'good' };
}

const HANDLES = [Position.Left, Position.Right, Position.Top, Position.Bottom] as const;

/**
 * A node on the canvas. It shows the node's live state — not decoration: the
 * meter is slots in use right now, the numbers are what the engine counted.
 */
function SimNodeViewImpl({ data }: NodeProps<SimFlowNode>) {
  const { spec, config, live, selected, badges } = data;
  const health = healthOf(live, config);
  const occupancy = config.concurrency > 0 && live ? live.inFlight / config.concurrency : 0;
  const isClient = spec.type === 'client';
  const classes = ['sim-node', selected ? 'selected' : '', live?.status === 'failed' ? 'failed' : '', live?.paused ? 'paused' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} data-testid={`node-${spec.id}`}>
      {HANDLES.map((position) => (
        <Handle key={position} id={position} type="source" position={position} className="sim-handle" />
      ))}
      <div className="sim-node-head">
        <span className="node-icon">
          <NodeGlyph type={spec.type} size={15} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="sim-node-title">{spec.label ?? spec.id}</div>
          <div className="sim-node-sub">
            {NODE_LABELS[spec.type]} · <span className="mono">{spec.id}</span>
          </div>
        </div>
      </div>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <span className={`pill status-${health.tone}`}>
          <span className="dot" />
          {health.label}
        </span>
        {badges?.map((b) => (
          <span key={b.label} className={`pill${b.tone ? ` status-${b.tone}` : ''}`}>
            {b.tone ? <span className="dot" /> : null}
            {b.label}
          </span>
        ))}
      </div>
      {!isClient ? (
        <>
          <div
            className={`meter${occupancy >= 1 ? ' hot' : occupancy >= 0.75 ? ' warn' : ''}`}
            title={`${live?.inFlight ?? 0} of ${config.concurrency} slots in use`}
          >
            <span style={{ width: `${Math.min(100, occupancy * 100)}%` }} />
          </div>
          <div className="sim-node-stats">
            <span title="requests in progress / slots">
              {live?.inFlight ?? 0}/{config.concurrency}
            </span>
            <span title="waiting in queue">q {live?.queueDepth ?? 0}</span>
            <span title="average utilisation since the start">{formatPercent(live?.utilization ?? 0, 0)}</span>
          </div>
        </>
      ) : (
        <div className="sim-node-stats">
          <span title="requests completed">✓ {formatCount(live?.processed ?? 0)}</span>
          <span title="requests failed">✗ {formatCount(live?.failed ?? 0)}</span>
        </div>
      )}
    </div>
  );
}

export const SimNodeView = memo(SimNodeViewImpl);
