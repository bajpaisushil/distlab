'use client';

import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, useInternalNode, type Edge, type EdgeProps } from '@xyflow/react';
import type { LinkState } from '@/lib/engine/protocol';
import { formatMs } from '@/lib/format';
import { linkSegment } from './geometry';

export type LinkEdgeData = {
  state?: LinkState;
  configuredLatency: number;
  /** A partition currently separates the two ends. */
  cut: boolean;
  selected: boolean;
};

export type LinkFlowEdge = Edge<LinkEdgeData, 'link'>;

/** A network link, drawn border to border between the two nodes it joins. */
function LinkEdgeImpl({ id, source, target, data, markerEnd }: EdgeProps<LinkFlowEdge>) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  if (!sourceNode || !targetNode || !data) return null;

  const box = (n: typeof sourceNode) => ({
    x: n.internals.positionAbsolute.x,
    y: n.internals.positionAbsolute.y,
    width: n.measured.width ?? 168,
    height: n.measured.height ?? 90,
  });
  const { from, to } = linkSegment(box(sourceNode), box(targetNode));
  const path = `M${from.x},${from.y}L${to.x},${to.y}`;
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;

  const down = data.state ? !data.state.enabled : false;
  const broken = down || data.cut;
  const loss = data.state?.lossRate ?? 0;
  const latency = data.state?.meanLatency ?? data.configuredLatency;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        interactionWidth={18}
        style={{
          stroke: broken ? 'var(--critical)' : data.selected ? 'var(--accent)' : 'var(--axis)',
          strokeWidth: data.selected ? 2.5 : 1.75,
          strokeDasharray: broken ? '6 5' : undefined,
        }}
      />
      <EdgeLabelRenderer>
        <div
          className={`edge-label${broken ? ' down' : ''}`}
          // Sits just above the line so packets and drop marks on the link stay visible.
          style={{ transform: `translate(-50%, -50%) translate(${midX}px, ${midY - 11}px)` }}
          data-testid={`link-${id}`}
        >
          {down ? 'down' : data.cut ? 'partitioned' : formatMs(latency)}
          {!broken && loss > 0 ? ` · ${(loss * 100).toFixed(loss < 0.01 ? 1 : 0)}% loss` : ''}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export const LinkEdge = memo(LinkEdgeImpl);
