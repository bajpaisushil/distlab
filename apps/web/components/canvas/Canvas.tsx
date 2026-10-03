'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  applyNodeChanges,
  useReactFlow,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { resolveSimulationSpec, type NodeType } from '@distlab/shared';
import { useLab } from '@/lib/store';
import { linkId } from '@/lib/spec-edit';
import { SimNodeView, type SimFlowNode } from './SimNodeView';
import { LinkEdge, type LinkFlowEdge } from './LinkEdge';
import { MessageLayer } from './MessageLayer';
import { nodeBadges } from './badges';

const nodeTypes = { sim: SimNodeView };
const edgeTypes = { link: LinkEdge };

export const DRAG_MIME = 'application/distlab-node';

/**
 * The architecture editor. It edits the scenario spec and nothing else; the
 * live colours, counts and moving messages are read from engine frames. No
 * simulation logic lives in here.
 */
export function Canvas() {
  const spec = useLab((s) => s.spec);
  const selection = useLab((s) => s.selection);
  const liveNodes = useLab((s) => s.frame?.nodes);
  const liveLinks = useLab((s) => s.frame?.links);
  const partitions = useLab((s) => s.frame?.partitions);
  const moduleTelemetry = useLab((s) => s.frame?.snapshot.modules);
  const select = useLab((s) => s.select);
  const moveNode = useLab((s) => s.moveNode);
  const connectNodes = useLab((s) => s.connectNodes);
  const addNode = useLab((s) => s.addNode);
  const { screenToFlowPosition, fitView } = useReactFlow();

  const configs = useMemo(() => {
    const resolved = resolveSimulationSpec(spec);
    return new Map(resolved.nodes.map((n) => [n.id, n.config]));
  }, [spec]);

  const [nodes, setNodes] = useState<SimFlowNode[]>([]);

  useEffect(() => {
    const live = new Map((liveNodes ?? []).map((n) => [n.id, n]));
    setNodes((previous) => {
      const before = new Map(previous.map((n) => [n.id, n]));
      return spec.nodes.map((node) => {
        const old = before.get(node.id);
        const selected = selection?.kind === 'node' && selection.id === node.id;
        return {
          ...(old ?? {}),
          id: node.id,
          type: 'sim' as const,
          // A node being dragged keeps its local position until the drop commits it.
          position: old?.dragging ? old.position : spec.layout?.[node.id] ?? old?.position ?? { x: 0, y: 0 },
          selected,
          data: {
            spec: node,
            config: configs.get(node.id)!,
            ...(live.has(node.id) ? { live: live.get(node.id)! } : {}),
            selected,
            badges: nodeBadges(node, moduleTelemetry),
          },
        };
      });
    });
  }, [spec, configs, liveNodes, selection, moduleTelemetry]);

  const edges = useMemo<LinkFlowEdge[]>(() => {
    const states = new Map((liveLinks ?? []).map((l) => [l.id, l]));
    return spec.links.map((link) => {
      const id = linkId(link);
      const cut = (partitions ?? []).some((p) => {
        const a = p.groups.findIndex((g) => g.includes(link.from));
        const b = p.groups.findIndex((g) => g.includes(link.to));
        return a >= 0 && b >= 0 && a !== b;
      });
      const selected = selection?.kind === 'link' && selection.id === id;
      const latency = typeof link.latency === 'number' ? link.latency : 5;
      return {
        id,
        source: link.from,
        target: link.to,
        type: 'link' as const,
        selected,
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: 'var(--axis)' },
        data: {
          ...(states.has(id) ? { state: states.get(id)! } : {}),
          configuredLatency: latency,
          cut,
          selected,
        },
      };
    });
  }, [spec.links, liveLinks, partitions, selection]);

  const onNodesChange = useCallback(
    (changes: NodeChange<SimFlowNode>[]) => setNodes((current) => applyNodeChanges(changes, current)),
    [],
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      const type = event.dataTransfer.getData(DRAG_MIME) as NodeType;
      if (!type) return;
      event.preventDefault();
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      addNode(type, { x: Math.round(position.x - 84), y: Math.round(position.y - 40) });
    },
    [screenToFlowPosition, addNode],
  );

  /**
   * Releasing a new link anywhere on another node connects to it — not just
   * on its small handle dots, which are hard to hit. A drop that React Flow
   * already turned into a connection is left alone.
   */
  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: { isValid: boolean | null; fromNode: { id: string } | null }) => {
      if (state.isValid || !state.fromNode) return;
      const point = 'changedTouches' in event ? event.changedTouches[0] : event;
      if (!point) return;
      const target = document.elementFromPoint(point.clientX, point.clientY)?.closest('.react-flow__node');
      const targetId = target?.getAttribute('data-id');
      if (targetId && targetId !== state.fromNode.id) connectNodes(state.fromNode.id, targetId);
    },
    [connectNodes],
  );

  // Frame the whole architecture whenever a different scenario is loaded.
  useEffect(() => {
    const timer = setTimeout(() => fitView({ padding: 0.2, duration: 250 }), 60);
    return () => clearTimeout(timer);
  }, [spec.id, fitView]);

  return (
    <div className="canvas-wrap" onDragOver={(e) => e.preventDefault()} onDrop={onDrop} data-testid="canvas">
      <ReactFlow<SimFlowNode, LinkFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_, node) => select({ kind: 'node', id: node.id })}
        onEdgeClick={(_, edge) => select({ kind: 'link', id: edge.id })}
        onPaneClick={() => select(null)}
        onNodeDragStop={(_, node) => moveNode(node.id, { x: Math.round(node.position.x), y: Math.round(node.position.y) })}
        onConnect={(connection) => {
          if (connection.source && connection.target) connectNodes(connection.source, connection.target);
        }}
        onConnectEnd={onConnectEnd}
        connectionMode={ConnectionMode.Loose}
        connectionRadius={36}
        deleteKeyCode={null}
        multiSelectionKeyCode={null}
        minZoom={0.2}
        maxZoom={2.5}
        fitView
        fitViewOptions={{ padding: 0.2 }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--axis)" />
        <Controls showInteractive={false} position="bottom-left" />
        {/* Only large graphs need a map; on small ones it would just cover nodes. */}
        {spec.nodes.length > 12 ? (
          <MiniMap
            pannable
            zoomable
            position="top-right"
            className="hide-narrow"
            style={{ width: 150, height: 96 }}
            nodeColor={(n) => {
              const live = (n.data as SimFlowNode['data']).live;
              return live?.status === 'failed' ? 'var(--critical)' : 'var(--axis)';
            }}
          />
        ) : null}
      </ReactFlow>
      <MessageLayer />
      {spec.nodes.length === 0 ? (
        <div className="canvas-hint">
          <div>
            <strong>Empty architecture</strong>
            <div>Drag components in from the left, or open the scenario library.</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
