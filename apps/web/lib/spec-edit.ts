import {
  SPEC_VERSION,
  linkIdFor,
  type FaultSpec,
  type LinkId,
  type LinkSpec,
  type NodeConfig,
  type NodeId,
  type NodeSpec,
  type NodeType,
  type SimulationSpec,
  type WorkloadSpec,
} from '@distlab/shared';

/**
 * Pure edits to a scenario. Every change the editor makes goes through one of
 * these, so cascading rules (removing a node removes its links, workloads and
 * faults) live in one tested place rather than in UI handlers.
 */

export const NODE_LABELS: Readonly<Record<NodeType, string>> = {
  client: 'Client',
  load_balancer: 'Load balancer',
  gateway: 'Gateway',
  api: 'API server',
  service: 'Service',
  cache: 'Cache',
  database: 'Database',
  replica: 'Replica',
  queue: 'Queue',
  worker: 'Worker',
  consensus: 'Raft node',
  lock_service: 'Lock service',
};

const ID_PREFIX: Readonly<Record<NodeType, string>> = {
  client: 'client',
  load_balancer: 'lb',
  gateway: 'gateway',
  api: 'api',
  service: 'svc',
  cache: 'cache',
  database: 'db',
  replica: 'replica',
  queue: 'queue',
  worker: 'worker',
  consensus: 'raft',
  lock_service: 'locks',
};

export function uniqueId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

export function emptySpec(): SimulationSpec {
  return {
    version: SPEC_VERSION,
    id: 'untitled',
    name: 'Untitled architecture',
    seed: 'distlab',
    durationMs: 20_000,
    nodes: [],
    links: [],
    workloads: [],
    faults: [],
  };
}

export function addNode(
  spec: SimulationSpec,
  type: NodeType,
  position?: { x: number; y: number },
): { spec: SimulationSpec; id: NodeId } {
  const id = uniqueId(ID_PREFIX[type], spec.nodes.map((n) => n.id));
  const count = spec.nodes.filter((n) => n.type === type).length + 1;
  const node: NodeSpec = { id, type, label: count > 1 ? `${NODE_LABELS[type]} ${count}` : NODE_LABELS[type] };
  const next: SimulationSpec = { ...spec, nodes: [...spec.nodes, node] };
  if (position) next.layout = { ...spec.layout, [id]: position };
  // A replica copies something: attach it to the first database, linked, so it works at once.
  if (type === 'replica') {
    const primary = spec.nodes.find((n) => n.type === 'database');
    if (primary) {
      next.nodes = next.nodes.map((n) => (n.id === id ? { ...n, config: { replicaOf: primary.id, replicationDelay: 50 } } : n));
      next.links = [...spec.links, { id: uniqueId(linkIdFor(primary.id, id), spec.links.map(linkId)), from: primary.id, to: id, latency: 10 }];
    }
  }
  // A worker consumes something: link it to the first queue so it gets deliveries.
  if (type === 'worker') {
    const queue = spec.nodes.find((n) => n.type === 'queue');
    if (queue) next.links = [...(next.links ?? spec.links), { id: uniqueId(linkIdFor(queue.id, id), spec.links.map(linkId)), from: queue.id, to: id, latency: 2 }];
  }
  // A client with nothing to send is inert; give it a modest default workload.
  if (type === 'client') {
    next.workloads = [
      ...spec.workloads,
      {
        id: uniqueId(`${id}-traffic`, spec.workloads.map((w) => w.id)),
        clientId: id,
        operation: 'HTTP_GET',
        arrival: { kind: 'poisson', ratePerSec: 50 },
        deadlineMs: 1000,
      },
    ];
  }
  return { spec: next, id };
}

export interface NodePatch {
  readonly label?: string;
  readonly status?: NodeSpec['status'];
  /** Merged one level deep: nested objects (retry, replication…) replace wholesale. Undefined values delete. */
  readonly config?: Partial<Record<keyof NodeConfig, unknown>>;
}

export function updateNode(spec: SimulationSpec, id: NodeId, patch: NodePatch): SimulationSpec {
  return {
    ...spec,
    nodes: spec.nodes.map((node) => {
      if (node.id !== id) return node;
      const next: NodeSpec = { ...node };
      if (patch.label !== undefined) next.label = patch.label;
      if (patch.status !== undefined) next.status = patch.status;
      if (patch.config) {
        const config: Record<string, unknown> = { ...node.config };
        for (const [key, value] of Object.entries(patch.config)) {
          if (value === undefined) delete config[key];
          else config[key] = value;
        }
        next.config = config as Partial<NodeConfig>;
      }
      return next;
    }),
  };
}

/** Removes a node and everything that only made sense with it. */
export function removeNode(spec: SimulationSpec, id: NodeId): SimulationSpec {
  const links = spec.links.filter((l) => l.from !== id && l.to !== id);
  const removedLinks = new Set(
    spec.links.filter((l) => l.from === id || l.to === id).map((l) => l.id ?? linkIdFor(l.from, l.to)),
  );
  const layout = { ...spec.layout };
  delete layout[id];
  return {
    ...spec,
    nodes: spec.nodes.filter((n) => n.id !== id),
    links,
    workloads: spec.workloads.filter((w) => w.clientId !== id),
    faults: (spec.faults ?? [])
      .filter((f) => !faultTouches(f, id, removedLinks))
      .map((f) =>
        f.kind === 'partition'
          ? {
              ...f,
              groups: f.groups.map((g) => g.filter((member) => member !== id)).filter((g) => g.length > 0),
            }
          : f,
      )
      // A partition with one side left separates nothing.
      .filter((f) => f.kind !== 'partition' || f.groups.length >= 2),
    layout,
  };
}

function faultTouches(fault: FaultSpec, nodeId: NodeId, links: ReadonlySet<LinkId>): boolean {
  const record = fault as unknown as Record<string, unknown>;
  for (const key of ['nodeId', 'replicaId', 'primaryId']) if (record[key] === nodeId) return true;
  return typeof record.linkId === 'string' && links.has(record.linkId);
}

export function linkId(link: LinkSpec): LinkId {
  return link.id ?? linkIdFor(link.from, link.to);
}

/** Connects two nodes. Refuses self-links and duplicates in either direction. */
export function addLink(spec: SimulationSpec, from: NodeId, to: NodeId): { spec: SimulationSpec; id: LinkId } | undefined {
  if (from === to) return undefined;
  const exists = spec.links.some((l) => (l.from === from && l.to === to) || (l.from === to && l.to === from));
  if (exists) return undefined;
  const id = uniqueId(linkIdFor(from, to), spec.links.map(linkId));
  return { spec: { ...spec, links: [...spec.links, { id, from, to, latency: 5 }] }, id };
}

export function updateLink(spec: SimulationSpec, id: LinkId, patch: Partial<LinkSpec>): SimulationSpec {
  return {
    ...spec,
    links: spec.links.map((link) => {
      if (linkId(link) !== id) return link;
      const next: Record<string, unknown> = { ...link, id };
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'from' || key === 'to' || key === 'id') continue;
        if (value === undefined) delete next[key];
        else next[key] = value;
      }
      return next as unknown as LinkSpec;
    }),
  };
}

export function removeLink(spec: SimulationSpec, id: LinkId): SimulationSpec {
  return {
    ...spec,
    links: spec.links.filter((l) => linkId(l) !== id),
    faults: (spec.faults ?? []).filter((f) => (f as unknown as { linkId?: string }).linkId !== id),
  };
}

export function addWorkload(spec: SimulationSpec, clientId: NodeId): { spec: SimulationSpec; id: string } {
  const id = uniqueId(`${clientId}-traffic`, spec.workloads.map((w) => w.id));
  const workload: WorkloadSpec = {
    id,
    clientId,
    operation: 'HTTP_GET',
    arrival: { kind: 'poisson', ratePerSec: 50 },
    deadlineMs: 1000,
  };
  return { spec: { ...spec, workloads: [...spec.workloads, workload] }, id };
}

export function updateWorkload(spec: SimulationSpec, id: string, patch: Partial<WorkloadSpec>): SimulationSpec {
  return {
    ...spec,
    workloads: spec.workloads.map((w) => {
      if (w.id !== id) return w;
      const next: Record<string, unknown> = { ...w };
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'id') continue;
        if (value === undefined) delete next[key];
        else next[key] = value;
      }
      return next as unknown as WorkloadSpec;
    }),
  };
}

export function removeWorkload(spec: SimulationSpec, id: string): SimulationSpec {
  return { ...spec, workloads: spec.workloads.filter((w) => w.id !== id) };
}

/** Faults get stable ids on insertion so the editor can address them. */
export function addFault(spec: SimulationSpec, fault: FaultSpec): { spec: SimulationSpec; id: string } {
  const faults = withFaultIds(spec.faults ?? []);
  const id = fault.id ?? uniqueId(`${fault.kind.replace(/_/g, '-')}`, faults.map((f) => f.id as string));
  return { spec: { ...spec, faults: [...faults, { ...fault, id } as FaultSpec] }, id };
}

export function updateFault(spec: SimulationSpec, id: string, patch: Record<string, unknown>): SimulationSpec {
  return {
    ...spec,
    faults: withFaultIds(spec.faults ?? []).map((f) => {
      if (f.id !== id) return f;
      const next: Record<string, unknown> = { ...f };
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'id' || key === 'kind') continue;
        if (value === undefined) delete next[key];
        else next[key] = value;
      }
      return next as unknown as FaultSpec;
    }),
  };
}

export function removeFault(spec: SimulationSpec, id: string): SimulationSpec {
  return { ...spec, faults: withFaultIds(spec.faults ?? []).filter((f) => f.id !== id) };
}

function withFaultIds(faults: readonly FaultSpec[]): FaultSpec[] {
  const used = new Set(faults.map((f) => f.id).filter((id): id is string => id !== undefined));
  return faults.map((fault, index) => {
    if (fault.id !== undefined) return fault;
    const id = uniqueId(`fault-${index + 1}`, used);
    used.add(id);
    return { ...fault, id } as FaultSpec;
  });
}

export function moveNode(spec: SimulationSpec, id: NodeId, position: { x: number; y: number }): SimulationSpec {
  return { ...spec, layout: { ...spec.layout, [id]: position } };
}

/** True when two specs differ only in presentation, so the simulation need not be rebuilt. */
export function sameSimulation(a: SimulationSpec, b: SimulationSpec): boolean {
  const strip = ({ layout: _layout, ...rest }: SimulationSpec) => rest;
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}
