import type { NodeId, NodeType, SimulationSpec } from '@distlab/shared';

const COLUMN = 250;
const ROW = 130;

/** Left-to-right order for nodes no path reaches, by role. */
const TYPE_RANK: Readonly<Record<NodeType, number>> = {
  client: 0,
  gateway: 1,
  load_balancer: 1,
  api: 2,
  service: 2,
  lock_service: 2,
  consensus: 2,
  queue: 2,
  worker: 3,
  cache: 3,
  database: 4,
  replica: 5,
};

/**
 * Positions for nodes the scenario has not placed: layered left to right by
 * distance from the clients along links, so traffic reads in the direction it
 * flows. Placed nodes keep their positions.
 */
export function autoLayout(spec: SimulationSpec): Record<NodeId, { x: number; y: number }> {
  const layout: Record<NodeId, { x: number; y: number }> = { ...spec.layout };
  const missing = spec.nodes.filter((n) => !layout[n.id]);
  if (missing.length === 0) return layout;

  const adjacency = new Map<NodeId, NodeId[]>();
  for (const link of spec.links) {
    adjacency.set(link.from, [...(adjacency.get(link.from) ?? []), link.to]);
  }
  const depth = new Map<NodeId, number>();
  const queue = spec.nodes.filter((n) => n.type === 'client').map((n) => n.id);
  for (const id of queue) depth.set(id, 0);
  while (queue.length > 0) {
    const id = queue.shift() as NodeId;
    for (const next of adjacency.get(id) ?? []) {
      if (!depth.has(next)) {
        depth.set(next, (depth.get(id) ?? 0) + 1);
        queue.push(next);
      }
    }
  }

  const columns = new Map<number, NodeId[]>();
  for (const node of spec.nodes) {
    const column = depth.get(node.id) ?? TYPE_RANK[node.type];
    columns.set(column, [...(columns.get(column) ?? []), node.id]);
  }
  for (const [column, ids] of columns) {
    const offset = ((ids.length - 1) * ROW) / 2;
    ids.forEach((id, row) => {
      if (!layout[id]) layout[id] = { x: column * COLUMN, y: row * ROW - offset };
    });
  }
  return layout;
}
